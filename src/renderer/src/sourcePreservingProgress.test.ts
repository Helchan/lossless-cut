import { describe, expect, test, vi } from 'vitest';

import {
  createMonotonicProgressReporter,
  mapProgressRange,
  sourcePreservingProgressPhases,
} from './sourcePreservingProgress';

describe('mapProgressRange', () => {
  test('maps normalized progress into a phase range', () => {
    expect(mapProgressRange(0, 0.2, 0.6)).toBeCloseTo(0.2, 12);
    expect(mapProgressRange(0.5, 0.2, 0.6)).toBeCloseTo(0.4, 12);
    expect(mapProgressRange(1, 0.2, 0.6)).toBeCloseTo(0.6, 12);
  });

  test('clamps NaN, negative, and greater-than-one input', () => {
    expect(mapProgressRange(Number.NaN, 0.2, 0.6)).toBeCloseTo(0.2, 12);
    expect(mapProgressRange(-0.5, 0.2, 0.6)).toBeCloseTo(0.2, 12);
    expect(mapProgressRange(1.5, 0.2, 0.6)).toBeCloseTo(0.6, 12);
    expect(mapProgressRange(Number.NEGATIVE_INFINITY, 0.2, 0.6)).toBeCloseTo(0.2, 12);
    expect(mapProgressRange(Number.POSITIVE_INFINITY, 0.2, 0.6)).toBeCloseTo(0.6, 12);
  });
});

describe('createMonotonicProgressReporter', () => {
  test('never moves reported progress backwards', () => {
    const values: number[] = [];
    const reporter = createMonotonicProgressReporter((value) => values.push(value));

    reporter.report(0.4);
    reporter.report(0.2);
    reporter.report(Number.NaN);
    reporter.report(0.7);

    expect(values).toEqual([0.4, 0.4, 0.4, 0.7]);
  });

  test('caps report at cleanupEnd instead of reporting completion', () => {
    const onProgress = vi.fn();
    const reporter = createMonotonicProgressReporter(onProgress);

    reporter.report(1);
    reporter.report(100);

    expect(onProgress).toHaveBeenNthCalledWith(1, sourcePreservingProgressPhases.cleanupEnd);
    expect(onProgress).toHaveBeenNthCalledWith(2, sourcePreservingProgressPhases.cleanupEnd);
    expect(onProgress).not.toHaveBeenCalledWith(1);
  });

  test('only complete reports exactly one and is terminal', () => {
    const values: number[] = [];
    const reporter = createMonotonicProgressReporter((value) => values.push(value));

    reporter.report(sourcePreservingProgressPhases.publishEnd);
    reporter.complete();
    reporter.report(0.5);
    reporter.complete();

    expect(values).toEqual([sourcePreservingProgressPhases.publishEnd, 1]);
  });
});
