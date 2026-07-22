import { describe, expect, it } from 'vitest';

import { MergeTransitionPlanError, type MergeTransitionSegmentPlan } from './mergeTransition';
import {
  buildLastFrameReadWindow,
  buildSnappedMergeTransitionPreflight,
  buildTransitionIdrSearchPlan,
  getLastFrameOffset,
  normalizeFramePts,
  resolveMergeTransitionExportDecision,
} from './mergeTransitionExport';


describe('resolveMergeTransitionExportDecision', () => {
  it('forces precise export for an enabled multi-segment merge', () => {
    expect(resolveMergeTransitionExportDecision({
      intent: 'merge',
      snapshot: { enabled: true, totalDuration: 0.46 },
      segmentCount: 2,
      accurateCut: false,
      areWeCutting: false,
    })).toEqual({ transitionApplies: true, shouldUseAccurateCut: true });
  });

  it.each([
    { intent: 'merge' as const, enabled: false, segmentCount: 2 },
    { intent: 'merge' as const, enabled: true, segmentCount: 1 },
    { intent: 'separate' as const, enabled: true, segmentCount: 2 },
  ])('does not force precise export for a non-applicable transition', ({ intent, enabled, segmentCount }) => {
    expect(resolveMergeTransitionExportDecision({
      intent,
      snapshot: { enabled, totalDuration: 0.46 },
      segmentCount,
      accurateCut: false,
      areWeCutting: false,
    })).toEqual({ transitionApplies: false, shouldUseAccurateCut: false });
  });

  it.each([
    { accurateCut: true, areWeCutting: false },
    { accurateCut: false, areWeCutting: true },
  ])('preserves the existing precise-export decision independently of transitions', ({ accurateCut, areWeCutting }) => {
    expect(resolveMergeTransitionExportDecision({
      intent: 'separate',
      snapshot: { enabled: false, totalDuration: 0.46 },
      segmentCount: 2,
      accurateCut,
      areWeCutting,
    })).toEqual({ transitionApplies: false, shouldUseAccurateCut: true });
  });
});

describe('buildSnappedMergeTransitionPreflight', () => {
  it('builds the transition only from already-snapped spans', () => {
    const plan = buildSnappedMergeTransitionPreflight({
      intent: 'merge',
      snapshot: { enabled: true, totalDuration: 0.46 },
      spans: [{ start: 1.1, end: 3.1 }, { start: 4.9, end: 7.6 }],
    });

    expect(plan.applied).toBe(true);
    expect(plan.expectedDuration).toBeCloseTo(4.7, 12);
    expect(plan.joinOutputTimes).toEqual([2]);
    expect(plan.segments[0]).toMatchObject({ fadeInDuration: 0, fadeOutDuration: 0.23 });
    expect(plan.segments[1]).toMatchObject({ fadeInDuration: 0.23, fadeOutDuration: 0 });
  });

  it.each([
    { spans: [{ start: 0, end: 0.22 }, { start: 1, end: 2 }], segmentIndex: 0 },
    { spans: [{ start: 0, end: 1 }, { start: 2, end: 2.22 }], segmentIndex: 1 },
    { spans: [{ start: 0, end: 1 }, { start: 2, end: 2.45 }, { start: 3, end: 4 }], segmentIndex: 1 },
  ])('synchronously rejects a snapped segment that cannot contain its effects', ({ spans, segmentIndex }) => {
    expect(() => buildSnappedMergeTransitionPreflight({
      intent: 'merge',
      snapshot: { enabled: true, totalDuration: 0.46 },
      spans,
    })).toThrowError(expect.objectContaining({
      code: 'segment-too-short',
      segmentIndex,
    } satisfies Partial<MergeTransitionPlanError>));
  });
});

describe('buildTransitionIdrSearchPlan', () => {
  const baseSegment: MergeTransitionSegmentPlan = {
    start: 2,
    end: 8,
    fadeInDuration: 0.23,
    fadeOutDuration: 0.23,
    copyStartAtOrAfter: 2.23,
    copyEndAtOrBefore: 7.77,
  };

  it.each([
    { name: 'first', segment: { ...baseSegment, fadeInDuration: 0, copyStartAtOrAfter: 2 } },
    { name: 'middle', segment: baseSegment },
    { name: 'last', segment: { ...baseSegment, fadeOutDuration: 0, copyEndAtOrBefore: 8 } },
  ])('keeps $name segment IDR searches inside its absolute source range', ({ segment }) => {
    expect(buildTransitionIdrSearchPlan({ segment, sourceStartTime: 5 })).toEqual({
      fullyEncode: false,
      after: { time: 5 + segment.copyStartAtOrAfter, searchStart: 7, searchEnd: 13 },
      before: { time: 5 + segment.copyEndAtOrBefore, searchStart: 7, searchEnd: 13 },
    });
  });

  it('skips IDR searches when the copy targets touch', () => {
    expect(buildTransitionIdrSearchPlan({
      sourceStartTime: 5,
      segment: {
        ...baseSegment,
        start: 2,
        end: 2.46,
        copyStartAtOrAfter: 2.23,
        copyEndAtOrBefore: 2.23,
      },
    })).toEqual({ fullyEncode: true });
  });
});

describe('last-frame timing', () => {
  it('uses the final real VFR presentation timestamp before the half-open segment end', () => {
    expect(getLastFrameOffset({
      segment: { start: 0, end: 10 },
      framePts: [9.91, 9.96],
    })).toBeCloseTo(0.04, 12);
  });

  it('rejects unreliable frame timing', () => {
    expect(() => getLastFrameOffset({ segment: { start: 0, end: 10 }, framePts: [] })).toThrow(/frame/i);
    expect(() => getLastFrameOffset({ segment: { start: 0, end: 10 }, framePts: [-0.1, 9.96] })).toThrow(/range/i);
    expect(() => getLastFrameOffset({ segment: { start: 0, end: 10 }, framePts: [10] })).toThrow(/range|offset/i);
  });

  it('reads absolute timestamps and normalizes a non-zero container start', () => {
    const segment = { start: 0, end: 10 };
    expect(buildLastFrameReadWindow({ segment, sourceStartTime: 5, windowDuration: 2 }))
      .toEqual({ from: 13, to: 15 });

    const framePts = normalizeFramePts({ absoluteFramePts: [14.91, 14.96], sourceStartTime: 5 });
    expect(framePts).toEqual([9.91, 9.96]);
    expect(getLastFrameOffset({ segment, framePts })).toBeCloseTo(0.04, 12);
  });
});
