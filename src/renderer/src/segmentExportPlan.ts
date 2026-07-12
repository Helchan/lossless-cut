export type SegmentExportIntent = 'separate' | 'merge';

export interface SegmentExportSnapshot {
  readonly segId: string;
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly tags?: Readonly<Record<string, string>> | undefined;
  readonly originalIndex: number;
}

export interface PlannedSegmentExport extends SegmentExportSnapshot {
  readonly duration: number;
}

export interface SegmentExportPlan {
  readonly intent: SegmentExportIntent;
  readonly sourceDuration: number;
  readonly segments: readonly PlannedSegmentExport[];
  readonly expectedDuration: number;
}

export interface BuildSegmentExportPlanInput {
  readonly intent: SegmentExportIntent;
  readonly sourceDuration: number;
  readonly segments: readonly SegmentExportSnapshot[];
}

export type SegmentExportPlanErrorCode =
  | 'invalid-intent'
  | 'invalid-source-duration'
  | 'empty-segments'
  | 'invalid-segment-id'
  | 'invalid-original-index'
  | 'invalid-segment-range';

export class SegmentExportPlanError extends Error {
  readonly code: SegmentExportPlanErrorCode;

  readonly segmentInputIndex?: number | undefined;

  constructor(code: SegmentExportPlanErrorCode, message: string, segmentInputIndex?: number) {
    super(message);
    this.name = 'SegmentExportPlanError';
    this.code = code;
    this.segmentInputIndex = segmentInputIndex;
  }
}

function validateIntent(intent: SegmentExportIntent) {
  if (intent !== 'separate' && intent !== 'merge') {
    throw new SegmentExportPlanError('invalid-intent', `Unsupported segment export intent: ${String(intent)}`);
  }
}

function validateSourceDuration(sourceDuration: number) {
  if (!Number.isFinite(sourceDuration) || sourceDuration < 0) {
    throw new SegmentExportPlanError('invalid-source-duration', 'Source duration must be a finite, non-negative number.');
  }
}

function validateSegment(segment: SegmentExportSnapshot, sourceDuration: number, segmentInputIndex: number) {
  if (segment.segId.length === 0) {
    throw new SegmentExportPlanError('invalid-segment-id', `Segment ${segmentInputIndex} must have a non-empty segId.`, segmentInputIndex);
  }

  if (!Number.isSafeInteger(segment.originalIndex) || segment.originalIndex < 0) {
    throw new SegmentExportPlanError('invalid-original-index', `Segment ${segmentInputIndex} must have a non-negative integer originalIndex.`, segmentInputIndex);
  }

  const hasFiniteRange = Number.isFinite(segment.start) && Number.isFinite(segment.end);
  const hasValidRange = hasFiniteRange
    && segment.start >= 0
    && segment.start < segment.end
    && segment.end <= sourceDuration;

  if (!hasValidRange) {
    throw new SegmentExportPlanError(
      'invalid-segment-range',
      `Segment ${segmentInputIndex} must satisfy 0 <= start < end <= sourceDuration.`,
      segmentInputIndex,
    );
  }
}

/**
 * Builds an immutable-value export plan from an explicit segment selection.
 *
 * The planner deliberately has no implicit whole-file fallback and does not
 * consult export settings. Merge remains the requested intent for one segment;
 * the executor can promote that one planned segment without running concat.
 */
export function buildSegmentExportPlan({ intent, sourceDuration, segments }: BuildSegmentExportPlanInput): SegmentExportPlan {
  validateIntent(intent);
  validateSourceDuration(sourceDuration);

  if (segments.length === 0) {
    throw new SegmentExportPlanError('empty-segments', 'At least one explicitly selected segment is required.');
  }

  const plannedSegments = segments
    .map((segment, inputIndex) => {
      validateSegment(segment, sourceDuration, inputIndex);
      return segment;
    })
    .map((segment) => ({
      segId: segment.segId,
      start: segment.start,
      end: segment.end,
      name: segment.name,
      ...(segment.tags != null && { tags: { ...segment.tags } }),
      originalIndex: segment.originalIndex,
      duration: segment.end - segment.start,
    }));

  return {
    intent,
    sourceDuration,
    segments: plannedSegments,
    expectedDuration: plannedSegments.reduce((total, segment) => total + segment.duration, 0),
  };
}
