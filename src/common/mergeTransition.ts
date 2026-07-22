export const defaultMergeTransitionEnabled = true;
export const defaultMergeTransitionDuration = 0.46;
export const minimumMergeTransitionDuration = 0.000002;

export function parseMergeTransitionDuration(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimumMergeTransitionDuration ? parsed : undefined;
}
