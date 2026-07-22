import type { SegmentExportIntent } from './segmentExportPlan.js';
import {
  buildMergeTransitionPlan,
  isMergeTransitionApplicable,
  type MergeTransitionPlan,
  type MergeTransitionSegmentPlan,
  type MergeTransitionSpan,
} from './mergeTransition.ts';
import { snapSourceTimeToFramePts } from './timelineSegments.ts';


export interface MergeTransitionSnapshot {
  enabled: boolean,
  totalDuration: number,
}

const transitionTimeTolerance = 1e-9;
const legacyBoundaryTolerance = 1e-6;

export class MergeTransitionFrameTimingError extends Error {
  readonly segmentIndex?: number | undefined;

  readonly boundary?: 'start' | 'end' | undefined;

  constructor(details?: { segmentIndex: number, boundary: 'start' | 'end' } | undefined) {
    super('Fade-through-black transition requires reliable source frame timing');
    this.name = 'MergeTransitionFrameTimingError';
    this.segmentIndex = details?.segmentIndex;
    this.boundary = details?.boundary;
  }
}

export class SnappedSourceSegmentError extends Error {
  readonly segmentIndex: number;

  constructor(segmentIndex: number) {
    super('A selected segment is shorter than one source frame after frame snapping');
    this.name = 'SnappedSourceSegmentError';
    this.segmentIndex = segmentIndex;
  }
}

function validateSpan({ start, end }: MergeTransitionSpan) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Merge transition span must satisfy 0 <= start < end');
  }
}

export function isSourcePreservingIdrCandidateTime({
  candidateTime,
  targetTime,
  mode,
  effectDuration,
}: {
  candidateTime: number,
  targetTime: number,
  mode: 'before' | 'after',
  effectDuration: number,
}) {
  if (!Number.isFinite(candidateTime) || !Number.isFinite(targetTime)
    || !Number.isFinite(effectDuration) || effectDuration < 0) {
    return false;
  }
  const tolerance = effectDuration > 0 ? transitionTimeTolerance : legacyBoundaryTolerance;
  return mode === 'after'
    ? candidateTime >= targetTime - tolerance
    : candidateTime <= targetTime + tolerance;
}

export async function snapSourceTimeToFramePtsWithReliability({
  sourceTime,
  sourceStartTime,
  sourceDuration,
  requireReliable,
  readAbsoluteFramePts,
}: {
  sourceTime: number,
  sourceStartTime: number,
  sourceDuration: number,
  requireReliable: boolean,
  readAbsoluteFramePts: (window: { from: number, to: number }) => Promise<readonly number[]>,
}): Promise<{ snappedTime: number, reliable: boolean }> {
  if (!Number.isFinite(sourceTime) || !Number.isFinite(sourceStartTime)
    || !Number.isFinite(sourceDuration) || sourceDuration <= 0
    || sourceTime < -legacyBoundaryTolerance || sourceTime > sourceDuration + legacyBoundaryTolerance) {
    throw new Error('Source frame snapping requires finite times within a positive source duration');
  }
  if (Math.abs(sourceTime) <= legacyBoundaryTolerance
    || Math.abs(sourceTime - sourceDuration) <= legacyBoundaryTolerance) {
    return { snappedTime: sourceTime, reliable: true };
  }

  const relativeFrom = Math.max(sourceTime - 1, 0);
  const relativeTo = Math.min(sourceTime + 1, sourceDuration);
  const absoluteWindow = {
    from: sourceStartTime + relativeFrom,
    to: sourceStartTime + relativeTo,
  };
  const normalizedFramePts = (await readAbsoluteFramePts(absoluteWindow))
    .filter((pts) => Number.isFinite(pts))
    .map((pts) => pts - sourceStartTime)
    .filter((pts) => pts >= relativeFrom - transitionTimeTolerance && pts <= relativeTo + transitionTimeTolerance);
  if (normalizedFramePts.length > 0) {
    return {
      snappedTime: snapSourceTimeToFramePts(sourceTime, normalizedFramePts),
      reliable: true,
    };
  }
  if (requireReliable) throw new MergeTransitionFrameTimingError();
  return { snappedTime: sourceTime, reliable: false };
}

async function snapPreparedBoundary({
  sourceTime,
  sourceStartTime,
  sourceDuration,
  requireReliable,
  readAbsoluteFramePts,
  segmentIndex,
  boundary,
}: {
  sourceTime: number,
  sourceStartTime: number,
  sourceDuration: number,
  requireReliable: boolean,
  readAbsoluteFramePts: (window: { from: number, to: number }) => Promise<readonly number[]>,
  segmentIndex: number,
  boundary: 'start' | 'end',
}) {
  try {
    return await snapSourceTimeToFramePtsWithReliability({
      sourceTime,
      sourceStartTime,
      sourceDuration,
      requireReliable,
      readAbsoluteFramePts,
    });
  } catch (err) {
    if (err instanceof MergeTransitionFrameTimingError) {
      throw new MergeTransitionFrameTimingError({ segmentIndex, boundary });
    }
    throw err;
  }
}

export async function prepareMergeTransitionExportSegments({
  intent,
  snapshot,
  spans,
  sourceStartTime,
  sourceDuration,
  readAbsoluteFramePts,
}: {
  intent: SegmentExportIntent,
  snapshot: MergeTransitionSnapshot,
  spans: readonly MergeTransitionSpan[],
  sourceStartTime: number,
  sourceDuration: number,
  readAbsoluteFramePts: (window: { from: number, to: number }) => Promise<readonly number[]>,
}) {
  const transitionApplies = isMergeTransitionApplicable({
    intent,
    enabled: snapshot.enabled,
    segmentCount: spans.length,
  });
  let snappedCutPointCount = 0;
  const snappedSpans: MergeTransitionSpan[] = [];

  for (const [segmentIndex, span] of spans.entries()) {
    validateSpan(span);
    const startResult = await snapPreparedBoundary({
      sourceTime: span.start,
      sourceStartTime,
      sourceDuration,
      requireReliable: transitionApplies && segmentIndex > 0,
      readAbsoluteFramePts,
      segmentIndex,
      boundary: 'start',
    });
    const endResult = await snapPreparedBoundary({
      sourceTime: span.end,
      sourceStartTime,
      sourceDuration,
      requireReliable: transitionApplies && segmentIndex < spans.length - 1,
      readAbsoluteFramePts,
      segmentIndex,
      boundary: 'end',
    });
    if (Math.abs(startResult.snappedTime - span.start) > legacyBoundaryTolerance) snappedCutPointCount += 1;
    if (Math.abs(endResult.snappedTime - span.end) > legacyBoundaryTolerance) snappedCutPointCount += 1;
    const { snappedTime: start } = startResult;
    const { snappedTime: end } = endResult;
    if (end <= start) throw new SnappedSourceSegmentError(segmentIndex);
    snappedSpans.push({ start, end });
  }

  const plan = buildMergeTransitionPlan({
    intent,
    enabled: snapshot.enabled,
    totalDuration: snapshot.totalDuration,
    spans: snappedSpans,
  });
  return { snappedSpans, snappedCutPointCount, plan };
}

export function resolveMergeTransitionExportDecision({
  intent,
  snapshot,
  segmentCount,
  accurateCut,
  areWeCutting,
}: {
  intent: SegmentExportIntent,
  snapshot: MergeTransitionSnapshot,
  segmentCount: number,
  accurateCut: boolean,
  areWeCutting: boolean,
}) {
  const transitionApplies = isMergeTransitionApplicable({
    intent,
    enabled: snapshot.enabled,
    segmentCount,
  });
  return {
    transitionApplies,
    shouldUseAccurateCut: accurateCut || areWeCutting || transitionApplies,
  };
}

export function buildSnappedMergeTransitionPreflight({
  intent,
  snapshot,
  spans,
}: {
  intent: SegmentExportIntent,
  snapshot: MergeTransitionSnapshot,
  spans: readonly MergeTransitionSpan[],
}): MergeTransitionPlan {
  return buildMergeTransitionPlan({
    intent,
    enabled: snapshot.enabled,
    totalDuration: snapshot.totalDuration,
    spans,
  });
}

export function buildTransitionIdrSearchPlan({
  segment,
  sourceStartTime,
}: {
  segment: MergeTransitionSegmentPlan,
  sourceStartTime: number,
}) {
  validateSpan(segment);
  if (!Number.isFinite(sourceStartTime)) throw new Error('Source start time must be finite');
  if (!Number.isFinite(segment.copyStartAtOrAfter)
    || !Number.isFinite(segment.copyEndAtOrBefore)
    || segment.copyStartAtOrAfter < segment.start - transitionTimeTolerance
    || segment.copyStartAtOrAfter > segment.end + transitionTimeTolerance
    || segment.copyEndAtOrBefore < segment.start - transitionTimeTolerance
    || segment.copyEndAtOrBefore > segment.end + transitionTimeTolerance) {
    throw new Error('Merge transition copy targets must stay inside the segment');
  }

  if (segment.copyStartAtOrAfter >= segment.copyEndAtOrBefore - transitionTimeTolerance) {
    return { fullyEncode: true as const };
  }

  const searchStart = sourceStartTime + segment.start;
  const searchEnd = sourceStartTime + segment.end;
  return {
    fullyEncode: false as const,
    after: {
      time: sourceStartTime + segment.copyStartAtOrAfter,
      searchStart,
      searchEnd,
    },
    before: {
      time: sourceStartTime + segment.copyEndAtOrBefore,
      searchStart,
      searchEnd,
    },
  };
}

export function getLastFrameOffset({
  segment,
  framePts,
}: {
  segment: MergeTransitionSpan,
  framePts: readonly number[],
}) {
  validateSpan(segment);
  if (framePts.length === 0) throw new Error('Last frame offset requires at least one frame timestamp');
  if (framePts.some((pts) => !Number.isFinite(pts)
    || pts < segment.start
    || pts >= segment.end - transitionTimeTolerance)) {
    throw new Error('Frame timestamp is outside the half-open segment range');
  }

  const lastFramePts = Math.max(...framePts);
  const offset = segment.end - lastFramePts;
  if (!Number.isFinite(offset) || offset <= 0 || offset > segment.end - segment.start) {
    throw new Error('Last frame offset must be positive and within the segment duration');
  }
  return offset;
}

export function buildLastFrameReadWindow({
  segment,
  sourceStartTime,
  windowDuration,
}: {
  segment: MergeTransitionSpan,
  sourceStartTime: number,
  windowDuration: number,
}) {
  validateSpan(segment);
  if (!Number.isFinite(sourceStartTime)) throw new Error('Source start time must be finite');
  if (!Number.isFinite(windowDuration) || windowDuration <= 0) {
    throw new Error('Last-frame read window duration must be positive and finite');
  }
  return {
    from: sourceStartTime + Math.max(segment.start, segment.end - windowDuration),
    to: sourceStartTime + segment.end,
  };
}

export function normalizeFramePts({
  absoluteFramePts,
  sourceStartTime,
}: {
  absoluteFramePts: readonly number[],
  sourceStartTime: number,
}) {
  if (!Number.isFinite(sourceStartTime) || absoluteFramePts.some((pts) => !Number.isFinite(pts))) {
    throw new Error('Frame timestamps and source start time must be finite');
  }
  return absoluteFramePts.map((pts) => pts - sourceStartTime);
}
