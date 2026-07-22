import { describe, expect, it } from 'vitest';

import { MergeTransitionPlanError, type MergeTransitionSegmentPlan } from './mergeTransition';
import {
  buildLastFrameReadWindow,
  buildSnappedMergeTransitionPreflight,
  buildTransitionIdrSearchPlan,
  getLastFrameOffset,
  isSourcePreservingIdrCandidateTime,
  MergeTransitionFrameTimingError,
  normalizeFramePts,
  prepareMergeTransitionExportSegments,
  resolveMergeTransitionExportDecision,
  snapSourceTimeToFramePtsWithReliability,
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

  it('does not accept a wrong-side IDR through the legacy one-microsecond tolerance', () => {
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 0,
      targetTime: 0.000001,
      mode: 'after',
      effectDuration: 0.000001,
    })).toBe(false);
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 0.000001,
      targetTime: 0.000001,
      mode: 'after',
      effectDuration: 0.000001,
    })).toBe(true);
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 0.0000009995,
      targetTime: 0.000001,
      mode: 'after',
      effectDuration: 0.000001,
    })).toBe(true);
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 0.999999,
      targetTime: 0.999999,
      mode: 'before',
      effectDuration: 0.000001,
    })).toBe(true);
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 1,
      targetTime: 0.999999,
      mode: 'before',
      effectDuration: 0.000001,
    })).toBe(false);
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 0.9999990005,
      targetTime: 0.999999,
      mode: 'before',
      effectDuration: 0.000001,
    })).toBe(true);
  });

  it('retains the legacy candidate tolerance when no effect touches that edge', () => {
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 0.9999995,
      targetTime: 1,
      mode: 'after',
      effectDuration: 0,
    })).toBe(true);
    expect(isSourcePreservingIdrCandidateTime({
      candidateTime: 1.0000005,
      targetTime: 1,
      mode: 'before',
      effectDuration: 0,
    })).toBe(true);
  });
});

describe('reliable boundary snapping', () => {
  it('marks a boundary reliable only when it finds a real source frame timestamp', async () => {
    const windows: { from: number, to: number }[] = [];
    const result = await snapSourceTimeToFramePtsWithReliability({
      sourceTime: 5,
      sourceStartTime: 3,
      sourceDuration: 12,
      requireReliable: true,
      readAbsoluteFramePts: async (window) => {
        windows.push(window);
        return [7.91, 8.04];
      },
    });

    expect(windows).toEqual([{ from: 7, to: 9 }]);
    expect(result.reliable).toBe(true);
    expect(result.snappedTime).toBeCloseTo(5.04, 12);
  });

  it('rejects an applied transition without moving the boundary to a distant frame', async () => {
    const windows: { from: number, to: number }[] = [];
    await expect(snapSourceTimeToFramePtsWithReliability({
      sourceTime: 5,
      sourceStartTime: 3,
      sourceDuration: 12,
      requireReliable: true,
      readAbsoluteFramePts: async (window) => {
        windows.push(window);
        return [];
      },
    })).rejects.toBeInstanceOf(MergeTransitionFrameTimingError);

    expect(windows).toEqual([{ from: 7, to: 9 }]);
  });

  it('requires real timing when a reordered fade-in starts at the source start', async () => {
    const windows: { from: number, to: number }[] = [];
    let error: unknown;
    try {
      await prepareMergeTransitionExportSegments({
        intent: 'merge',
        snapshot: { enabled: true, totalDuration: 0.46 },
        spans: [{ start: 2, end: 8 }, { start: 0, end: 1 }],
        sourceStartTime: 0,
        sourceDuration: 10,
        readAbsoluteFramePts: async (window) => {
          windows.push(window);
          return window.from <= 8 && window.to >= 8 ? [8] : [];
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MergeTransitionFrameTimingError);
    expect(error).toMatchObject({ segmentIndex: 1, boundary: 'start' });
    expect(windows).toContainEqual({ from: 0, to: 1 });
  });

  it('requires real timing when a reordered fade-out ends at the source end', async () => {
    const windows: { from: number, to: number }[] = [];
    let error: unknown;
    try {
      await prepareMergeTransitionExportSegments({
        intent: 'merge',
        snapshot: { enabled: true, totalDuration: 0.46 },
        spans: [{ start: 0, end: 10 }, { start: 2, end: 4 }],
        sourceStartTime: 3,
        sourceDuration: 10,
        readAbsoluteFramePts: async (window) => {
          windows.push(window);
          return window.from <= 5 && window.to >= 5 ? [5] : [];
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MergeTransitionFrameTimingError);
    expect(error).toMatchObject({ segmentIndex: 0, boundary: 'end' });
    expect(windows).toContainEqual({ from: 12, to: 13 });
  });

  it('keeps legacy snapping for a non-effect start just above zero', async () => {
    const windows: { from: number, to: number }[] = [];
    await expect(snapSourceTimeToFramePtsWithReliability({
      sourceTime: 0.0000005,
      sourceStartTime: 3,
      sourceDuration: 12,
      requireReliable: false,
      readAbsoluteFramePts: async (window) => {
        windows.push(window);
        return [3];
      },
    })).resolves.toEqual({ snappedTime: 0, reliable: true });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.from).toBe(3);
    expect(windows[0]?.to).toBeCloseTo(4.0000005, 12);
  });

  it('preserves the legacy one-window fallback when a transition does not apply', async () => {
    const windows: { from: number, to: number }[] = [];
    await expect(snapSourceTimeToFramePtsWithReliability({
      sourceTime: 5,
      sourceStartTime: 3,
      sourceDuration: 12,
      requireReliable: false,
      readAbsoluteFramePts: async (window) => {
        windows.push(window);
        return [];
      },
    })).resolves.toEqual({ snappedTime: 5, reliable: false });

    expect(windows).toEqual([{ from: 7, to: 9 }]);
  });

  it('prepares applied transition spans from real frame timestamps', async () => {
    const absoluteFramePts = [0.1, 3.1, 4.9, 7.6];
    const prepared = await prepareMergeTransitionExportSegments({
      intent: 'merge',
      snapshot: { enabled: true, totalDuration: 0.46 },
      spans: [{ start: 0.11, end: 3.09 }, { start: 4.91, end: 7.59 }],
      sourceStartTime: 0,
      sourceDuration: 8,
      readAbsoluteFramePts: async ({ from, to }) => absoluteFramePts.filter((pts) => pts >= from && pts <= to),
    });

    expect(prepared.snappedSpans).toEqual([{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }]);
    expect(prepared.snappedCutPointCount).toBe(4);
    expect(prepared.plan.applied).toBe(true);
  });

  it.each([
    { missingPts: 3.1, segmentIndex: 0, boundary: 'end' as const },
    { missingPts: 4.9, segmentIndex: 1, boundary: 'start' as const },
  ])('rejects an unreliable $boundary effect boundary before export planning', async ({ missingPts, segmentIndex, boundary }) => {
    const absoluteFramePts = [0.1, 3.1, 4.9, 7.6].filter((pts) => pts !== missingPts);
    let error: unknown;
    try {
      await prepareMergeTransitionExportSegments({
        intent: 'merge',
        snapshot: { enabled: true, totalDuration: 0.46 },
        spans: [{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }],
        sourceStartTime: 0,
        sourceDuration: 8,
        readAbsoluteFramePts: async ({ from, to }) => absoluteFramePts.filter((pts) => pts >= from && pts <= to),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MergeTransitionFrameTimingError);
    expect(error).toMatchObject({ segmentIndex, boundary });
  });

  it('does not require timing for the first start or final end because no effect touches them', async () => {
    const absoluteFramePts = [3.1, 4.9];
    const prepared = await prepareMergeTransitionExportSegments({
      intent: 'merge',
      snapshot: { enabled: true, totalDuration: 0.46 },
      spans: [{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }],
      sourceStartTime: 0,
      sourceDuration: 8,
      readAbsoluteFramePts: async ({ from, to }) => absoluteFramePts.filter((pts) => pts >= from && pts <= to),
    });

    expect(prepared.snappedSpans).toEqual([{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }]);
    expect(prepared.plan.applied).toBe(true);
  });

  it.each([
    { intent: 'merge' as const, enabled: false, spans: [{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }] },
    { intent: 'merge' as const, enabled: true, spans: [{ start: 0.1, end: 3.1 }] },
    { intent: 'separate' as const, enabled: true, spans: [{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }] },
  ])('preserves fallback timing for a non-applicable $intent route', async ({ intent, enabled, spans }) => {
    const prepared = await prepareMergeTransitionExportSegments({
      intent,
      snapshot: { enabled, totalDuration: Number.NaN },
      spans,
      sourceStartTime: 0,
      sourceDuration: 8,
      readAbsoluteFramePts: async () => [],
    });

    expect(prepared.snappedSpans).toEqual(spans);
    expect(prepared.plan.applied).toBe(false);
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
