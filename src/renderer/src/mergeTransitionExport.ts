import type { SegmentExportIntent } from './segmentExportPlan';
import {
  buildMergeTransitionPlan,
  isMergeTransitionApplicable,
  type MergeTransitionPlan,
  type MergeTransitionSegmentPlan,
  type MergeTransitionSpan,
} from './mergeTransition.ts';


export interface MergeTransitionSnapshot {
  enabled: boolean,
  totalDuration: number,
}

const transitionTimeTolerance = 1e-9;

function validateSpan({ start, end }: MergeTransitionSpan) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Merge transition span must satisfy 0 <= start < end');
  }
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
