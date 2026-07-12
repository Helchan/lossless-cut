import { describe, expect, it } from 'vitest';

import {
  buildSegmentExportPlan,
  SegmentExportPlanError,
  type SegmentExportIntent,
  type SegmentExportSnapshot,
} from './segmentExportPlan';


const sourceDuration = 60;

const originalSegments = {
  a: {
    segId: 'a', start: 2, end: 5, name: 'A', tags: { group: 'keep' }, originalIndex: 0,
  },
  b: {
    segId: 'b', start: 10, end: 14, name: 'B', tags: { group: 'delete' }, originalIndex: 1,
  },
  c: {
    segId: 'c', start: 20, end: 25, name: 'C', tags: { group: 'keep' }, originalIndex: 2,
  },
  d: {
    segId: 'd', start: 30, end: 36, name: 'D', tags: { group: 'delete' }, originalIndex: 3,
  },
} satisfies Record<string, SegmentExportSnapshot>;

interface UserScenario {
  name: string;
  intent: SegmentExportIntent;
  segments: SegmentExportSnapshot[];
  expectedIds: string[];
  expectedDuration: number;
}

describe.each<UserScenario>([
  {
    name: 'no deletion, one selected, separate',
    intent: 'separate',
    segments: [originalSegments.b],
    expectedIds: ['b'],
    expectedDuration: 4,
  },
  {
    name: 'no deletion, multiple selected, separate',
    intent: 'separate',
    segments: [originalSegments.a, originalSegments.b, originalSegments.c],
    expectedIds: ['a', 'b', 'c'],
    expectedDuration: 12,
  },
  {
    name: 'no deletion, one selected, merge',
    intent: 'merge',
    segments: [originalSegments.b],
    expectedIds: ['b'],
    expectedDuration: 4,
  },
  {
    name: 'no deletion, multiple selected, merge',
    intent: 'merge',
    segments: [originalSegments.a, originalSegments.b, originalSegments.c],
    expectedIds: ['a', 'b', 'c'],
    expectedDuration: 12,
  },
  {
    name: 'after deletion, one remaining selected, separate',
    intent: 'separate',
    segments: [originalSegments.c],
    expectedIds: ['c'],
    expectedDuration: 5,
  },
  {
    name: 'after deletion, multiple remaining selected, separate',
    intent: 'separate',
    segments: [originalSegments.a, originalSegments.c],
    expectedIds: ['a', 'c'],
    expectedDuration: 8,
  },
  {
    name: 'after deletion, one remaining selected, merge',
    intent: 'merge',
    segments: [originalSegments.c],
    expectedIds: ['c'],
    expectedDuration: 5,
  },
  {
    name: 'after deletion, multiple remaining selected, merge',
    intent: 'merge',
    segments: [originalSegments.a, originalSegments.c],
    expectedIds: ['a', 'c'],
    expectedDuration: 8,
  },
])('$name', ({ intent, segments, expectedIds, expectedDuration }) => {
  it('builds the requested explicit plan', () => {
    const plan = buildSegmentExportPlan({ intent, sourceDuration, segments });

    expect(plan.intent).toBe(intent);
    expect(plan.sourceDuration).toBe(sourceDuration);
    expect(plan.segments.map(({ segId }) => segId)).toEqual(expectedIds);
    expect(plan.segments.map(({ duration }) => duration)).toEqual(
      plan.segments.map(({ start, end }) => end - start),
    );
    expect(plan.expectedDuration).toBe(expectedDuration);

    for (const plannedSegment of plan.segments) {
      const inputSegment = segments.find(({ segId }) => segId === plannedSegment.segId);
      expect(inputSegment).toBeDefined();
      expect(plannedSegment).toMatchObject(inputSegment!);
    }
  });
});

it('rejects an empty explicit selection instead of falling back to the whole source', () => {
  expect(() => buildSegmentExportPlan({ intent: 'separate', sourceDuration, segments: [] }))
    .toThrowError(new SegmentExportPlanError('empty-segments', 'At least one explicitly selected segment is required.'));
});

describe.each([
  { name: 'non-finite source duration', sourceDuration: Number.POSITIVE_INFINITY, segment: originalSegments.a },
  { name: 'negative source duration', sourceDuration: -1, segment: originalSegments.a },
  { name: 'non-finite start', sourceDuration, segment: { ...originalSegments.a, start: Number.NaN } },
  { name: 'non-finite end', sourceDuration, segment: { ...originalSegments.a, end: Number.POSITIVE_INFINITY } },
  { name: 'negative start', sourceDuration, segment: { ...originalSegments.a, start: -0.1 } },
  { name: 'zero duration', sourceDuration, segment: { ...originalSegments.a, end: originalSegments.a.start } },
  { name: 'reversed range', sourceDuration, segment: { ...originalSegments.a, start: 8, end: 7 } },
  { name: 'end after source duration', sourceDuration, segment: { ...originalSegments.a, end: sourceDuration + 0.1 } },
])('invalid range: $name', ({ sourceDuration: invalidSourceDuration, segment }) => {
  it('rejects the plan', () => {
    expect(() => buildSegmentExportPlan({
      intent: 'separate',
      sourceDuration: invalidSourceDuration,
      segments: [segment],
    })).toThrowError(SegmentExportPlanError);
  });
});

it('preserves the visible timeline order without mutating the input array', () => {
  const segments = [originalSegments.d, originalSegments.b, originalSegments.c, originalSegments.a];
  const inputIdsBeforePlanning = segments.map(({ segId }) => segId);

  const plan = buildSegmentExportPlan({ intent: 'merge', sourceDuration, segments });

  expect(plan.segments.map(({ segId }) => segId)).toEqual(inputIdsBeforePlanning);
  expect(segments.map(({ segId }) => segId)).toEqual(inputIdsBeforePlanning);
});

it('preserves input order regardless of source start time', () => {
  const sameStartSegments: SegmentExportSnapshot[] = [
    { segId: 'third', start: 10, end: 13, name: 'third', tags: { order: '1' }, originalIndex: 8 },
    { segId: 'first', start: 1, end: 2, name: 'first', tags: { order: '0' }, originalIndex: 2 },
    { segId: 'second', start: 10, end: 12, name: 'second', tags: { order: '2' }, originalIndex: 4 },
  ];

  const plan = buildSegmentExportPlan({ intent: 'merge', sourceDuration, segments: sameStartSegments });

  expect(plan.segments.map(({ segId }) => segId)).toEqual(['third', 'first', 'second']);
});

it('keeps merge as the intent for a single segment', () => {
  const plan = buildSegmentExportPlan({ intent: 'merge', sourceDuration, segments: [originalSegments.c] });

  expect(plan).toMatchObject({
    intent: 'merge',
    expectedDuration: 5,
    segments: [{ segId: 'c', duration: 5 }],
  });
});
