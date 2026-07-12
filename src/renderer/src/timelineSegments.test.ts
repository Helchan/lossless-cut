import { describe, expect, it } from 'vitest';

import type { StateSegment } from './types';
import {
  buildExplicitExportSegments,
  buildTimelineProjection,
  displayTimeToSourceTime,
  removeSourceSegments,
  snapSourceTimeToFramePts,
  sourceTimeToDisplayTime,
  splitSourceSegment,
} from './timelineSegments';


function segment({
  start,
  end,
  segId,
  selected = true,
  name = '',
  tags,
  segColorIndex = 0,
  initial,
}: Pick<StateSegment, 'start' | 'end' | 'segId'> & Partial<Pick<StateSegment, 'selected' | 'name' | 'tags' | 'segColorIndex' | 'initial'>>): StateSegment {
  return { start, end, segId, selected, name, tags, segColorIndex, ...(initial && { initial }) };
}

describe('timeline projection', () => {
  it('keeps source ranges absolute while compressing a deleted middle range', () => {
    const projection = buildTimelineProjection([
      segment({ start: 0, end: 10, segId: 'a' }),
      segment({ start: 20, end: 30, segId: 'c' }),
    ], 30);

    expect(projection.displayDuration).toBe(20);
    expect(projection.items.map(({ source, display }) => ({ source, display }))).toEqual([
      { source: { start: 0, end: 10 }, display: { start: 0, end: 10 } },
      { source: { start: 20, end: 30 }, display: { start: 10, end: 20 } },
    ]);
    expect(sourceTimeToDisplayTime(projection, 25)).toBe(15);
    expect(sourceTimeToDisplayTime(projection, 15)).toBeUndefined();
  });

  it('maps a shared display boundary to next by default and supports previous bias', () => {
    const projection = buildTimelineProjection([
      segment({ start: 0, end: 10, segId: 'a' }),
      segment({ start: 20, end: 30, segId: 'c' }),
    ], 30);

    expect(displayTimeToSourceTime(projection, 10)).toBe(20);
    expect(displayTimeToSourceTime(projection, 10, 'next')).toBe(20);
    expect(displayTimeToSourceTime(projection, 10, 'previous')).toBe(10);
    expect(displayTimeToSourceTime(projection, 20)).toBe(30);
  });
});

describe('explicit export segments', () => {
  it('preserves current timeline array order and original indexes', () => {
    const segments = [
      segment({ start: 20, end: 30, segId: 'c', name: 'third', tags: { order: 'first' } }),
      segment({ start: 0, end: 10, segId: 'a', name: 'first' }),
      segment({ start: 10, end: 20, segId: 'b', selected: false }),
    ];

    expect(buildExplicitExportSegments(segments, 30)).toEqual([
      { segId: 'c', start: 20, end: 30, name: 'third', tags: { order: 'first' }, originalIndex: 0 },
      { segId: 'a', start: 0, end: 10, name: 'first', originalIndex: 1 },
    ]);
  });

  it('returns empty when nothing is explicitly selected', () => {
    expect(buildExplicitExportSegments([
      segment({ start: 0, end: 10, segId: 'a', selected: false }),
      segment({ start: 10, end: 20, segId: 'b', selected: false }),
    ], 20)).toEqual([]);
  });
});

describe('source segment split', () => {
  it('inherits metadata, clones tags, and lets the caller reset IDs', () => {
    const source = segment({
      start: 2,
      end: 8,
      segId: 'original',
      selected: false,
      name: 'scene',
      tags: { camera: 'a' },
      segColorIndex: 7,
      initial: true,
    });

    const [before, after] = splitSourceSegment({
      segment: source,
      splitTime: 5,
      sourceDuration: 10,
      segmentIds: { before: 'before', after: 'after' },
    });

    expect(before).toEqual({
      start: 2,
      end: 5,
      segId: 'before',
      selected: false,
      name: 'scene',
      tags: { camera: 'a' },
      segColorIndex: 7,
    });
    expect(after).toEqual({
      start: 5,
      end: 8,
      segId: 'after',
      selected: false,
      name: 'scene',
      tags: { camera: 'a' },
      segColorIndex: 7,
    });
    expect(before.tags).not.toBe(source.tags);
    expect(after.tags).not.toBe(source.tags);
    expect(after.tags).not.toBe(before.tags);
    expect(source).toHaveProperty('initial', true);
  });
});

describe('source segment removal', () => {
  const segments = [
    segment({ start: 0, end: 10, segId: 'a' }),
    segment({ start: 10, end: 20, segId: 'b' }),
    segment({ start: 20, end: 30, segId: 'c' }),
  ];

  it('keeps absolute source ranges and moves a deleted-gap playhead to the next visible segment', () => {
    expect(removeSourceSegments({
      segments,
      removeSegmentIds: ['b'],
      activeSegmentId: 'b',
      sourceTime: 15,
      sourceDuration: 30,
    })).toMatchObject({
      segments: [
        { segId: 'a', start: 0, end: 10 },
        { segId: 'c', start: 20, end: 30 },
      ],
      activeIndex: 1,
      normalizedSourceTime: 20,
    });
  });

  it('preserves active identity when removing an earlier segment', () => {
    const result = removeSourceSegments({
      segments,
      removeSegmentIds: ['a'],
      activeSegmentId: 'b',
      sourceTime: 12,
      sourceDuration: 30,
    });

    expect(result.activeIndex).toBe(0);
    expect(result.segments[result.activeIndex]?.segId).toBe('b');
    expect(result.normalizedSourceTime).toBe(12);
  });

  it('returns an empty model without reintroducing the whole source', () => {
    expect(removeSourceSegments({
      segments,
      removeSegmentIds: ['a', 'b', 'c'],
      activeSegmentId: 'b',
      sourceTime: 15,
      sourceDuration: 30,
    })).toEqual({ segments: [], activeIndex: 0 });
  });
});

it('snaps cut times to actual frame PTS instead of an average-FPS estimate', () => {
  expect(snapSourceTimeToFramePts(1.06, [1, 1.04, 1.083, 1.125])).toBe(1.04);
  expect(snapSourceTimeToFramePts(1.07, [1, 1.04, 1.083, 1.125])).toBe(1.083);
  expect(snapSourceTimeToFramePts(1.07, [])).toBe(1.07);
});

it('rejects invalid ranges and split boundaries', () => {
  expect(() => buildTimelineProjection([
    segment({ start: 10, end: 10, segId: 'zero' }),
  ], 20)).toThrow(RangeError);
  expect(() => buildExplicitExportSegments([
    segment({ start: 0, end: 21, segId: 'too-long' }),
  ], 20)).toThrow(RangeError);
  expect(() => splitSourceSegment({
    segment: segment({ start: 0, end: 10, segId: 'a' }),
    splitTime: 10,
    sourceDuration: 10,
    segmentIds: { before: 'before', after: 'after' },
  })).toThrow(RangeError);
});
