import { minimumMergeTransitionDuration } from '../../common/mergeTransition.ts';
import type { SegmentExportIntent } from './segmentExportPlan';


export interface MergeTransitionSpan {
  start: number,
  end: number,
}

export interface MergeTransitionSegmentPlan extends MergeTransitionSpan {
  fadeInDuration: number,
  fadeOutDuration: number,
  copyStartAtOrAfter: number,
  copyEndAtOrBefore: number,
}

export interface MergeTransitionPlan {
  applied: boolean,
  totalDuration: number,
  sideDuration: number,
  expectedDuration: number,
  segments: MergeTransitionSegmentPlan[],
  joinOutputTimes: number[],
}

export type MergeTransitionPlanErrorCode =
  | 'invalid-duration'
  | 'invalid-segment'
  | 'segment-too-short';

interface MergeTransitionPlanErrorDetails {
  segmentIndex?: number | undefined,
  actualDuration?: number | undefined,
  requiredDuration?: number | undefined,
}

export class MergeTransitionPlanError extends Error {
  readonly code: MergeTransitionPlanErrorCode;

  readonly segmentIndex?: number | undefined;

  readonly actualDuration?: number | undefined;

  readonly requiredDuration?: number | undefined;

  constructor(code: MergeTransitionPlanErrorCode, message: string, details: MergeTransitionPlanErrorDetails = {}) {
    super(message);
    this.name = 'MergeTransitionPlanError';
    this.code = code;
    if (details.segmentIndex != null) this.segmentIndex = details.segmentIndex;
    if (details.actualDuration != null) this.actualDuration = details.actualDuration;
    if (details.requiredDuration != null) this.requiredDuration = details.requiredDuration;
  }
}

const transitionTolerance = 1e-9;

function getSpanDuration({ start, end }: MergeTransitionSpan) {
  return end - start;
}

export function isMergeTransitionApplicable({ intent, enabled, segmentCount }: {
  intent: SegmentExportIntent,
  enabled: boolean,
  segmentCount: number,
}) {
  return Number.isSafeInteger(segmentCount)
    && segmentCount >= 2
    && intent === 'merge'
    && enabled === true;
}

export function buildMergeTransitionPlan({ intent, enabled, totalDuration, spans }: {
  intent: SegmentExportIntent,
  enabled: boolean,
  totalDuration: number,
  spans: readonly MergeTransitionSpan[],
}): MergeTransitionPlan {
  spans.forEach(({ start, end }, segmentIndex) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new MergeTransitionPlanError(
        'invalid-segment',
        `Merge transition segment ${segmentIndex} must satisfy 0 <= start < end.`,
        { segmentIndex },
      );
    }
  });

  const expectedDuration = spans.reduce((sum, span) => sum + getSpanDuration(span), 0);
  const applied = isMergeTransitionApplicable({ intent, enabled, segmentCount: spans.length });
  if (!applied) {
    return {
      applied: false,
      totalDuration: 0,
      sideDuration: 0,
      expectedDuration,
      joinOutputTimes: [],
      segments: spans.map((span) => ({
        ...span,
        fadeInDuration: 0,
        fadeOutDuration: 0,
        copyStartAtOrAfter: span.start,
        copyEndAtOrBefore: span.end,
      })),
    };
  }

  if (!Number.isFinite(totalDuration) || totalDuration < minimumMergeTransitionDuration) {
    throw new MergeTransitionPlanError(
      'invalid-duration',
      `Merge transition duration must be at least ${minimumMergeTransitionDuration} seconds.`,
    );
  }

  const sideDuration = totalDuration / 2;
  const segments = spans.map((span, segmentIndex): MergeTransitionSegmentPlan => {
    const fadeInDuration = segmentIndex > 0 ? sideDuration : 0;
    const fadeOutDuration = segmentIndex < spans.length - 1 ? sideDuration : 0;
    const actualDuration = getSpanDuration(span);
    const requiredDuration = fadeInDuration + fadeOutDuration;
    if (actualDuration + transitionTolerance < requiredDuration) {
      throw new MergeTransitionPlanError(
        'segment-too-short',
        `Merge transition segment ${segmentIndex} is shorter than ${requiredDuration} seconds.`,
        { segmentIndex, actualDuration, requiredDuration },
      );
    }

    return {
      ...span,
      fadeInDuration,
      fadeOutDuration,
      copyStartAtOrAfter: span.start + fadeInDuration,
      copyEndAtOrBefore: span.end - fadeOutDuration,
    };
  });

  let elapsed = 0;
  const joinOutputTimes = spans.slice(0, -1).map((span) => {
    elapsed += getSpanDuration(span);
    return elapsed;
  });

  return {
    applied: true,
    totalDuration,
    sideDuration,
    expectedDuration,
    segments,
    joinOutputTimes,
  };
}
