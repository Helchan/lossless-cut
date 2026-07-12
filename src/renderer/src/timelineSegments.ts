import type { SegmentExportSnapshot } from './segmentExportPlan.ts';

export interface TimelineStateSegment {
  start: number;
  end?: number | undefined;
  name: string;
  segId: string;
  tags?: Record<string, string> | undefined;
  initial?: true;
  selected: boolean;
  segColorIndex: number;
}


export type TimelineBoundaryBias = 'next' | 'previous';

export interface TimelineRange {
  start: number;
  end: number;
}

export interface TimelineProjectionItem {
  sourceSegment: TimelineStateSegment & { end: number };
  displaySegment: TimelineStateSegment & { end: number };
  originalIndex: number;
  source: TimelineRange;
  display: TimelineRange;
}

export interface TimelineProjection {
  sourceDuration: number;
  displayDuration: number;
  items: TimelineProjectionItem[];
}

export type SplitSegmentPart = 'before' | 'after';

export interface RemoveSourceSegmentsResult {
  segments: TimelineStateSegment[];
  activeIndex: number;
  normalizedSourceTime?: number | undefined;
}

export function snapSourceTimeToFramePts(sourceTime: number, frameTimes: readonly number[]) {
  if (!Number.isFinite(sourceTime)) throw new RangeError('Source time must be finite');
  const validFrameTimes = frameTimes.filter((time) => Number.isFinite(time));
  if (validFrameTimes.length === 0) return sourceTime;

  return validFrameTimes.reduce((nearest, candidate) => (
    Math.abs(candidate - sourceTime) < Math.abs(nearest - sourceTime) ? candidate : nearest
  ));
}

function assertSourceDuration(sourceDuration: number) {
  if (!Number.isFinite(sourceDuration) || sourceDuration < 0) {
    throw new RangeError('Source duration must be a finite non-negative number');
  }
}

function assertSourcePosition(position: number, sourceDuration: number, label: string) {
  if (!Number.isFinite(position) || position < 0 || position > sourceDuration) {
    throw new RangeError(`${label} must be finite and within the source duration`);
  }
}

function assertSourceRange(range: TimelineRange, sourceDuration: number, label: string) {
  assertSourcePosition(range.start, sourceDuration, `${label} start`);
  assertSourcePosition(range.end, sourceDuration, `${label} end`);
  if (range.start >= range.end) throw new RangeError(`${label} must satisfy start < end`);
}

function cloneTags(segment: Pick<TimelineStateSegment, 'tags'>) {
  return segment.tags == null ? undefined : { ...segment.tags };
}

/**
 * Build a compressed edit/display timeline without changing the source ranges.
 * Completed segments are projected in their existing array order; markers are
 * validated but do not occupy display time.
 */
export function buildTimelineProjection(segments: readonly TimelineStateSegment[], sourceDuration: number): TimelineProjection {
  assertSourceDuration(sourceDuration);

  let displayCursor = 0;
  const items: TimelineProjectionItem[] = [];

  segments.forEach((segment, originalIndex) => {
    assertSourcePosition(segment.start, sourceDuration, `Segment ${originalIndex} start`);
    if (segment.end == null) return;

    const source = { start: segment.start, end: segment.end };
    assertSourceRange(source, sourceDuration, `Segment ${originalIndex}`);

    const display = {
      start: displayCursor,
      end: displayCursor + (source.end - source.start),
    };
    if (!Number.isFinite(display.end)) throw new RangeError('Display duration must remain finite');
    displayCursor = display.end;

    const sourceSegment = {
      ...segment,
      end: segment.end,
      ...(segment.tags != null && { tags: cloneTags(segment) }),
    };
    const displaySegment = {
      ...sourceSegment,
      start: display.start,
      end: display.end,
      ...(sourceSegment.tags != null && { tags: cloneTags(sourceSegment) }),
    };

    items.push({ sourceSegment, displaySegment, originalIndex, source, display });
  });

  return { sourceDuration, displayDuration: displayCursor, items };
}

/**
 * Map a source-media time into compressed display time. Source times in deleted
 * gaps return undefined. Ranges use [start, end); sourceDuration is accepted as
 * the terminal point when a projected segment ends there.
 */
export function sourceTimeToDisplayTime(projection: TimelineProjection, sourceTime: number): number | undefined {
  assertSourcePosition(sourceTime, projection.sourceDuration, 'Source time');

  const item = projection.items.find(({ source }) => sourceTime >= source.start && sourceTime < source.end);
  if (item != null) return item.display.start + (sourceTime - item.source.start);

  if (sourceTime === projection.sourceDuration) {
    const terminalItem = projection.items.findLast(({ source }) => source.end === sourceTime);
    return terminalItem?.display.end;
  }

  return undefined;
}

/**
 * Map compressed edit/display time back to source-media time. At a shared
 * display boundary, "next" selects the following segment's source start while
 * "previous" selects the preceding segment's source end. The default is next.
 */
export function displayTimeToSourceTime(
  projection: TimelineProjection,
  displayTime: number,
  bias: TimelineBoundaryBias = 'next',
): number | undefined {
  if (!Number.isFinite(displayTime) || displayTime < 0 || displayTime > projection.displayDuration) {
    throw new RangeError('Display time must be finite and within the display duration');
  }

  const firstItem = projection.items[0];
  const lastItem = projection.items.at(-1);
  if (firstItem == null || lastItem == null) return undefined;

  if (displayTime === 0) return firstItem.source.start;
  if (displayTime === projection.displayDuration) return lastItem.source.end;

  const item = bias === 'next'
    ? projection.items.find(({ display }) => displayTime >= display.start && displayTime < display.end)
    : projection.items.find(({ display }) => displayTime > display.start && displayTime <= display.end);

  if (item == null) return undefined;
  return item.source.start + (displayTime - item.display.start);
}

/**
 * Create the one explicit export list used by either separate or merge export.
 * An empty selection stays empty and never falls back to the whole source.
 */
export function buildExplicitExportSegments(segments: readonly TimelineStateSegment[], sourceDuration: number): SegmentExportSnapshot[] {
  assertSourceDuration(sourceDuration);

  return segments.flatMap((segment, originalIndex) => {
    assertSourcePosition(segment.start, sourceDuration, `Segment ${originalIndex} start`);
    if (segment.end == null) return [];

    const range = { start: segment.start, end: segment.end };
    assertSourceRange(range, sourceDuration, `Segment ${originalIndex}`);
    if (!segment.selected) return [];

    return [{
      segId: segment.segId,
      ...range,
      name: segment.name,
      ...(segment.tags != null && { tags: cloneTags(segment) }),
      originalIndex,
    }];
  });
}

/**
 * Split one completed source segment while preserving its user metadata.
 * The caller owns identity policy through segmentIds. The transient
 * `initial` flag is removed because neither result is the initial whole-file
 * placeholder anymore.
 */
export function splitSourceSegment({
  segment,
  splitTime,
  sourceDuration,
  segmentIds,
}: {
  segment: TimelineStateSegment,
  splitTime: number,
  sourceDuration: number,
  segmentIds: Record<SplitSegmentPart, string>,
}): [TimelineStateSegment, TimelineStateSegment] {
  assertSourceDuration(sourceDuration);
  if (segment.end == null) throw new RangeError('Cannot split a marker without an end time');
  assertSourceRange({ start: segment.start, end: segment.end }, sourceDuration, 'Segment');
  assertSourcePosition(splitTime, sourceDuration, 'Split time');
  if (splitTime <= segment.start || splitTime >= segment.end) {
    throw new RangeError('Split time must be strictly inside the source segment');
  }

  const { before: beforeId, after: afterId } = segmentIds;
  if (beforeId.length === 0 || afterId.length === 0 || beforeId === afterId) {
    throw new RangeError('Split segment IDs must be non-empty and distinct');
  }

  const metadata = {
    ...segment,
  };
  Reflect.deleteProperty(metadata, 'initial');

  return [
    { ...metadata, start: segment.start, end: splitTime, segId: beforeId, ...(segment.tags != null && { tags: cloneTags(segment) }) },
    { ...metadata, start: splitTime, end: segment.end, segId: afterId, ...(segment.tags != null && { tags: cloneTags(segment) }) },
  ];
}

/**
 * Remove timeline segments by stable identity, preserve the active segment when
 * it survives, and move a playhead out of a deleted source gap. Remaining
 * source ranges are never shifted.
 */
export function removeSourceSegments({
  segments,
  removeSegmentIds,
  activeSegmentId,
  sourceTime,
  sourceDuration,
}: {
  segments: readonly TimelineStateSegment[],
  removeSegmentIds: readonly string[],
  activeSegmentId: string | undefined,
  sourceTime: number,
  sourceDuration: number,
}): RemoveSourceSegmentsResult {
  assertSourceDuration(sourceDuration);
  assertSourcePosition(sourceTime, sourceDuration, 'Source time');

  const removeIds = new Set(removeSegmentIds);
  const remainingSegments = segments.filter(({ segId }) => !removeIds.has(segId));
  if (remainingSegments.length === 0) return { segments: [], activeIndex: 0 };

  const survivingActiveIndex = activeSegmentId == null ? -1 : remainingSegments.findIndex(({ segId }) => segId === activeSegmentId);
  const firstRemovedIndex = segments.findIndex(({ segId }) => removeIds.has(segId));
  const activeIndex = survivingActiveIndex >= 0
    ? survivingActiveIndex
    : Math.min(Math.max(firstRemovedIndex, 0), remainingSegments.length - 1);

  const completedSegments = remainingSegments.filter((segment): segment is TimelineStateSegment & { end: number } => segment.end != null);
  const sourceTimeStillVisible = completedSegments.some(({ start, end }) => sourceTime >= start && sourceTime < end);
  if (sourceTimeStillVisible) return { segments: remainingSegments, activeIndex, normalizedSourceTime: sourceTime };

  const orderedSegments = [...completedSegments].sort((a, b) => a.start - b.start);
  const nextSegment = orderedSegments.find(({ start }) => start >= sourceTime);
  const previousSegment = orderedSegments.findLast(({ end }) => end <= sourceTime);
  const normalizedSourceTime = nextSegment?.start ?? previousSegment?.end ?? orderedSegments[0]?.start;

  return { segments: remainingSegments, activeIndex, normalizedSourceTime };
}
