import { describe, expect, it } from 'vitest';

import {
  defaultMergeTransitionDuration,
  defaultMergeTransitionEnabled,
  minimumMergeTransitionDuration,
  parseMergeTransitionDuration,
} from '../../common/mergeTransition.ts';
import {
  buildMergeTransitionPlan,
  isMergeTransitionApplicable,
  MergeTransitionPlanError,
  type MergeTransitionSpan,
} from './mergeTransition';


const spans: MergeTransitionSpan[] = [
  { start: 1, end: 4 },
  { start: 8, end: 12 },
];

describe('merge transition defaults', () => {
  it('uses the measured reference timing by default', () => {
    expect(defaultMergeTransitionEnabled).toBe(true);
    expect(defaultMergeTransitionDuration).toBe(0.46);
    expect(minimumMergeTransitionDuration).toBe(0.000002);
  });

  it('accepts only finite durations that FFmpeg can split into microsecond sides', () => {
    expect(parseMergeTransitionDuration('0.72')).toBe(0.72);
    expect(parseMergeTransitionDuration(minimumMergeTransitionDuration)).toBe(minimumMergeTransitionDuration);

    ['', '0.72x', 0, 0.000001, -1, Number.NaN, Number.POSITIVE_INFINITY].forEach((value) => {
      expect(parseMergeTransitionDuration(value)).toBeUndefined();
    });
  });
});

describe('buildMergeTransitionPlan', () => {
  it('splits a two-segment transition evenly without changing duration', () => {
    expect(buildMergeTransitionPlan({
      intent: 'merge',
      enabled: true,
      totalDuration: 0.46,
      spans,
    })).toEqual({
      applied: true,
      totalDuration: 0.46,
      sideDuration: 0.23,
      expectedDuration: 7,
      joinOutputTimes: [3],
      segments: [
        {
          start: 1,
          end: 4,
          fadeInDuration: 0,
          fadeOutDuration: 0.23,
          copyStartAtOrAfter: 1,
          copyEndAtOrBefore: 3.77,
        },
        {
          start: 8,
          end: 12,
          fadeInDuration: 0.23,
          fadeOutDuration: 0,
          copyStartAtOrAfter: 8.23,
          copyEndAtOrBefore: 12,
        },
      ],
    });
  });

  it('gives middle segments non-overlapping fade-in and fade-out windows', () => {
    const plan = buildMergeTransitionPlan({
      intent: 'merge',
      enabled: true,
      totalDuration: 0.46,
      spans: [
        { start: 0, end: 1 },
        { start: 3, end: 3.46 },
        { start: 7, end: 8 },
      ],
    });

    expect(plan.expectedDuration).toBeCloseTo(2.46, 12);
    expect(plan.joinOutputTimes).toEqual([1, 1.46]);
    expect(plan.segments[1]).toEqual({
      start: 3,
      end: 3.46,
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
      copyStartAtOrAfter: 3.23,
      copyEndAtOrBefore: 3.23,
    });
  });

  it.each([
    { name: 'disabled merge', intent: 'merge' as const, enabled: false, testSpans: spans },
    { name: 'separate export', intent: 'separate' as const, enabled: true, testSpans: spans },
    { name: 'single merge segment', intent: 'merge' as const, enabled: true, testSpans: [spans[0]!] },
  ])('keeps $name on the no-effect path', ({ intent, enabled, testSpans }) => {
    const plan = buildMergeTransitionPlan({ intent, enabled, totalDuration: Number.NaN, spans: testSpans });

    expect(plan.applied).toBe(false);
    expect(plan.totalDuration).toBe(0);
    expect(plan.sideDuration).toBe(0);
    expect(plan.expectedDuration).toBe(testSpans.reduce((total, span) => total + span.end - span.start, 0));
    expect(plan.joinOutputTimes).toEqual([]);
    expect(plan.segments).toEqual(testSpans.map((span) => ({
      ...span,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      copyStartAtOrAfter: span.start,
      copyEndAtOrBefore: span.end,
    })));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 0.000001, -0.1])('rejects invalid applied duration %s', (totalDuration) => {
    expect(() => buildMergeTransitionPlan({ intent: 'merge', enabled: true, totalDuration, spans }))
      .toThrowError(expect.objectContaining({ code: 'invalid-duration' }));
  });

  it.each([
    {
      name: 'first segment',
      testSpans: [{ start: 0, end: 0.229 }, { start: 1, end: 2 }],
      segmentIndex: 0,
      actualDuration: 0.229,
      requiredDuration: 0.23,
    },
    {
      name: 'last segment',
      testSpans: [{ start: 0, end: 1 }, { start: 2, end: 2.229 }],
      segmentIndex: 1,
      actualDuration: 0.229,
      requiredDuration: 0.23,
    },
    {
      name: 'middle segment',
      testSpans: [{ start: 0, end: 1 }, { start: 2, end: 2.459 }, { start: 3, end: 4 }],
      segmentIndex: 1,
      actualDuration: 0.459,
      requiredDuration: 0.46,
    },
  ])('rejects a short $name with structured details', ({ testSpans, segmentIndex, actualDuration, requiredDuration }) => {
    let error: unknown;
    try {
      buildMergeTransitionPlan({ intent: 'merge', enabled: true, totalDuration: 0.46, spans: testSpans });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MergeTransitionPlanError);
    expect(error).toMatchObject({ code: 'segment-too-short', segmentIndex });
    expect((error as MergeTransitionPlanError).actualDuration).toBeCloseTo(actualDuration, 12);
    expect((error as MergeTransitionPlanError).requiredDuration).toBeCloseTo(requiredDuration, 12);
  });

  it('accepts segments exactly as long as their required fade windows', () => {
    const plan = buildMergeTransitionPlan({
      intent: 'merge',
      enabled: true,
      totalDuration: 0.46,
      spans: [{ start: 0, end: 0.23 }, { start: 1, end: 1.46 }, { start: 2, end: 2.23 }],
    });

    expect(plan.applied).toBe(true);
    expect(plan.segments).toHaveLength(3);
  });

  it('preserves input order without mutating the spans', () => {
    const input = [{ start: 9, end: 10 }, { start: 1, end: 2 }];
    const before = structuredClone(input);

    const plan = buildMergeTransitionPlan({ intent: 'merge', enabled: true, totalDuration: 0.46, spans: input });

    expect(plan.segments.map(({ start }) => start)).toEqual([9, 1]);
    expect(input).toEqual(before);
  });

  it('rejects invalid source spans even on a no-effect path', () => {
    expect(() => buildMergeTransitionPlan({
      intent: 'separate',
      enabled: false,
      totalDuration: 0.46,
      spans: [{ start: 2, end: 2 }],
    })).toThrowError(expect.objectContaining({ code: 'invalid-segment', segmentIndex: 0 }));
  });
});

describe('isMergeTransitionApplicable', () => {
  it('requires an enabled multi-segment merge', () => {
    expect(isMergeTransitionApplicable({ intent: 'merge', enabled: true, segmentCount: 2 })).toBe(true);
    expect(isMergeTransitionApplicable({ intent: 'merge', enabled: false, segmentCount: 2 })).toBe(false);
    expect(isMergeTransitionApplicable({ intent: 'merge', enabled: true, segmentCount: 1 })).toBe(false);
    expect(isMergeTransitionApplicable({ intent: 'separate', enabled: true, segmentCount: 2 })).toBe(false);
  });

  it.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid segment count %s', (segmentCount) => {
    expect(isMergeTransitionApplicable({ intent: 'merge', enabled: true, segmentCount })).toBe(false);
  });
});
