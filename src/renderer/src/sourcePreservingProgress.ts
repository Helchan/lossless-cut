export const sourcePreservingProgressPhases = {
  preflightEnd: 0.05,
  segmentVideoEnd: 0.58,
  mergedVideoEnd: 0.65,
  finalMediaEnd: 0.88,
  verificationEnd: 0.96,
  publishEnd: 0.99,
  cleanupEnd: 0.999,
} as const;

function clampUnitProgress(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

export function mapProgressRange(value: number, start: number, end: number) {
  return start + clampUnitProgress(value) * (end - start);
}

export function createMonotonicProgressReporter(onProgress: (progress: number) => void) {
  let lastProgress = 0;
  let completed = false;

  return {
    report(candidate: number) {
      if (completed) return;

      const normalizedCandidate = Number.isNaN(candidate) ? 0 : Math.max(candidate, 0);
      const cappedCandidate = Math.min(normalizedCandidate, sourcePreservingProgressPhases.cleanupEnd);
      lastProgress = Math.max(lastProgress, cappedCandidate);
      onProgress(lastProgress);
    },
    complete() {
      if (completed) return;

      completed = true;
      lastProgress = 1;
      onProgress(lastProgress);
    },
  };
}
