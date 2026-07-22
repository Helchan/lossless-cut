export interface SourcePreservingSpan {
  start: number,
  end: number,
}

export interface SourcePreservingFadeDurations {
  fadeInDuration?: number | undefined,
  fadeOutDuration?: number | undefined,
}

export type SourcePreservingPart =
  | (SourcePreservingSpan & { mode: 'copy' })
  | (SourcePreservingSpan & {
    mode: 'encode',
    fadeInDuration?: number | undefined,
    fadeOutDuration?: number | undefined,
  });

export interface SourcePreservingSegmentPlan {
  span: SourcePreservingSpan,
  parts: SourcePreservingPart[],
  copiedDuration: number,
  reencodedDuration: number,
}

export interface BuildSourcePreservingSegmentPlanOptions extends SourcePreservingFadeDurations {
  span: SourcePreservingSpan,
  nextSafeIdrAtOrAfterCopyStart?: number | undefined,
  previousSafeIdrAtOrBeforeCopyEnd?: number | undefined,
  sourceDuration?: number | undefined,
}

const boundaryTolerance = 0.000001;
const effectDurationTolerance = 0.000000001;
const minimumFilterDuration = 0.000001;

/**
 * Returns true only when an Annex-B H.264 access unit contains an IDR slice.
 * ffprobe's packet K flag also covers recovery-point/open-GOP I pictures,
 * which are not safe standalone splice boundaries.
 */
export function containsH264IdrAccessUnit(data: Uint8Array) {
  for (let index = 0; index + 3 < data.length;) {
    let nalStart: number | undefined;
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
      nalStart = index + 3;
    } else if (index + 4 < data.length && data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 0 && data[index + 3] === 1) {
      nalStart = index + 4;
    }

    if (nalStart == null) {
      index += 1;
    } else {
      if (data[nalStart]! % 32 === 5) return true;
      index = nalStart + 1;
    }
  }
  return false;
}

function isSameTime(a: number, b: number) {
  return Math.abs(a - b) <= boundaryTolerance;
}

function durationOf({ start, end }: SourcePreservingSpan) {
  return end - start;
}

function validateSourcePreservingSpan({ start, end }: SourcePreservingSpan) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Source-preserving export requires a finite half-open interval with 0 <= start < end');
  }
}

function validateFadeDuration(name: string, duration: number) {
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
}

export function getSourcePreservingCopyTargets({
  span,
  fadeInDuration = 0,
  fadeOutDuration = 0,
}: {
  span: SourcePreservingSpan,
} & SourcePreservingFadeDurations) {
  validateSourcePreservingSpan(span);
  validateFadeDuration('Fade-in duration', fadeInDuration);
  validateFadeDuration('Fade-out duration', fadeOutDuration);

  if (fadeInDuration + fadeOutDuration > durationOf(span) + effectDurationTolerance) {
    throw new Error('Fade durations must not exceed the source-preserving segment duration');
  }

  return {
    copyStart: span.start + fadeInDuration,
    copyEnd: span.end - fadeOutDuration,
  };
}

/**
 * Keeps the boundary encoder's decode reordering compatible with copied GOPs.
 * A zero-B-frame prefix followed by source B-frames forces the concat muxer to
 * rewrite DTS values even though the presentation timestamps are continuous.
 */
export function getSourcePreservingBoundaryBFrames(hasBFrames: number | undefined) {
  if (hasBFrames == null || !Number.isFinite(hasBFrames)) return 0;
  return Math.max(0, Math.min(Math.trunc(hasBFrames), 16));
}

/**
 * Returns the end of the selected video presentation on the exported timeline.
 * The container or an audio track may legitimately outlive the source video.
 */
export function getSourcePreservingVideoPresentationDuration({
  spans,
  sourceVideoEnd,
}: {
  spans: readonly SourcePreservingSpan[],
  sourceVideoEnd: number,
}) {
  if (!Number.isFinite(sourceVideoEnd) || sourceVideoEnd < 0) throw new Error('Source video end must be finite and non-negative');

  let elapsed = 0;
  let presentationEnd = 0;
  spans.forEach((span) => {
    const spanDuration = durationOf(span);
    if (!Number.isFinite(spanDuration) || span.start < 0 || spanDuration <= 0) {
      throw new Error('Source-preserving video spans must satisfy 0 <= start < end');
    }
    const availableDuration = Math.max(Math.min(span.end, sourceVideoEnd) - span.start, 0);
    if (availableDuration > 0) presentationEnd = elapsed + availableDuration;
    elapsed += spanDuration;
  });
  return presentationEnd;
}

export function getSourcePreservingPacketPresentationDuration({
  packets,
  fallbackFrameDuration,
}: {
  packets: readonly { time: number, duration?: number | undefined }[],
  fallbackFrameDuration: number,
}) {
  if (!Number.isFinite(fallbackFrameDuration) || fallbackFrameDuration <= 0) {
    throw new Error('Fallback frame duration must be positive and finite');
  }
  if (packets.length === 0) return undefined;

  return packets.reduce((latestEnd, packet) => {
    const duration = packet.duration != null && Number.isFinite(packet.duration) && packet.duration > 0
      ? packet.duration
      : fallbackFrameDuration;
    return Math.max(latestEnd, packet.time + duration);
  }, Number.NEGATIVE_INFINITY);
}

/**
 * Builds a half-open [start, end) export plan. Complete GOPs stay byte-for-byte
 * copied. Only the leading/trailing dependency regions are encoded. If both
 * dependency regions overlap, the selected short segment is encoded once.
 */
export function buildSourcePreservingSegmentPlan({
  span,
  fadeInDuration = 0,
  fadeOutDuration = 0,
  nextSafeIdrAtOrAfterCopyStart,
  previousSafeIdrAtOrBeforeCopyEnd,
  sourceDuration,
}: BuildSourcePreservingSegmentPlanOptions): SourcePreservingSegmentPlan {
  const { start, end } = span;
  const { copyStart: copyStartTarget, copyEnd: copyEndTarget } = getSourcePreservingCopyTargets({
    span,
    fadeInDuration,
    fadeOutDuration,
  });
  if (nextSafeIdrAtOrAfterCopyStart != null && !Number.isFinite(nextSafeIdrAtOrAfterCopyStart)) {
    throw new Error('The safe IDR at or after the copy start must be finite');
  }
  if (previousSafeIdrAtOrBeforeCopyEnd != null && !Number.isFinite(previousSafeIdrAtOrBeforeCopyEnd)) {
    throw new Error('The safe IDR at or before the copy end must be finite');
  }
  if (fadeInDuration > 0
    && nextSafeIdrAtOrAfterCopyStart != null
    && nextSafeIdrAtOrAfterCopyStart < copyStartTarget - effectDurationTolerance) {
    throw new Error('The safe IDR copy start intrudes into the fade-in window');
  }
  if (fadeOutDuration > 0
    && previousSafeIdrAtOrBeforeCopyEnd != null
    && previousSafeIdrAtOrBeforeCopyEnd > copyEndTarget + effectDurationTolerance) {
    throw new Error('The safe IDR copy end intrudes into the fade-out window');
  }

  const startsAtSafePoint = fadeInDuration === 0 && (start === 0
    || (nextSafeIdrAtOrAfterCopyStart != null && isSameTime(nextSafeIdrAtOrAfterCopyStart, start)));
  const endsAtSafePoint = fadeOutDuration === 0 && ((sourceDuration != null && isSameTime(end, sourceDuration))
    || (previousSafeIdrAtOrBeforeCopyEnd != null && isSameTime(previousSafeIdrAtOrBeforeCopyEnd, end)));

  const copyStart = startsAtSafePoint ? start : nextSafeIdrAtOrAfterCopyStart;
  const copyEnd = endsAtSafePoint ? end : previousSafeIdrAtOrBeforeCopyEnd;
  const fadeProperties = {
    ...(fadeInDuration > 0 ? { fadeInDuration } : {}),
    ...(fadeOutDuration > 0 ? { fadeOutDuration } : {}),
  };

  const parts: SourcePreservingPart[] = copyStartTarget >= copyEndTarget - effectDurationTolerance
    || copyStart == null
    || copyEnd == null
    || copyEnd <= copyStart + boundaryTolerance
    ? [{ mode: 'encode', start, end, ...fadeProperties }]
    : [
      ...(!isSameTime(start, copyStart) ? [{
        mode: 'encode' as const,
        start,
        end: copyStart,
        ...(fadeInDuration > 0 ? { fadeInDuration } : {}),
      }] : []),
      { mode: 'copy' as const, start: copyStart, end: copyEnd },
      ...(!isSameTime(copyEnd, end) ? [{
        mode: 'encode' as const,
        start: copyEnd,
        end,
        ...(fadeOutDuration > 0 ? { fadeOutDuration } : {}),
      }] : []),
    ];

  const firstPart = parts[0];
  const lastPart = parts.at(-1);
  if (firstPart == null || lastPart == null || !isSameTime(firstPart.start, start) || !isSameTime(lastPart.end, end)) {
    throw new Error('Source-preserving export plan does not cover the requested span');
  }
  parts.slice(1).forEach((part, index) => {
    if (!isSameTime(parts[index]!.end, part.start)) throw new Error('Source-preserving export plan contains a gap or overlap');
  });

  const copiedDuration = parts.filter(({ mode }) => mode === 'copy').reduce((total, part) => total + durationOf(part), 0);
  const reencodedDuration = parts.filter(({ mode }) => mode === 'encode').reduce((total, part) => total + durationOf(part), 0);

  return { span, parts, copiedDuration, reencodedDuration };
}

function formatFilterNumber(value: number) {
  if (!Number.isFinite(value)) throw new Error('Video filter values must be finite');
  return value.toFixed(6);
}

export function buildSourcePreservingVideoFilter({
  duration,
  lastFrameOffset,
  fadeInDuration = 0,
  fadeOutDuration = 0,
}: {
  duration: number,
  lastFrameOffset?: number | undefined,
} & SourcePreservingFadeDurations) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video filter duration must be positive and finite');
  validateFadeDuration('Fade-in duration', fadeInDuration);
  validateFadeDuration('Fade-out duration', fadeOutDuration);
  if (fadeInDuration > duration + effectDurationTolerance || fadeOutDuration > duration + effectDurationTolerance) {
    throw new Error('Fade duration must not exceed the encoded part duration');
  }
  if ((fadeInDuration > 0 && fadeInDuration < minimumFilterDuration)
    || (fadeOutDuration > 0 && fadeOutDuration < minimumFilterDuration)) {
    throw new Error('Positive fade duration must be at least one microsecond');
  }

  const filters = [
    `setpts=PTS-STARTPTS,trim=duration=${formatFilterNumber(duration)},setpts=PTS-STARTPTS`,
  ];
  if (fadeInDuration > 0) {
    filters.push(`fade=t=in:st=0:d=${formatFilterNumber(fadeInDuration)}:c=black`);
  }
  if (fadeOutDuration > 0) {
    if (lastFrameOffset == null
      || !Number.isFinite(lastFrameOffset)
      || lastFrameOffset <= 0
      || lastFrameOffset > duration) {
      throw new Error('Fade-out requires a positive finite last frame offset within the encoded part');
    }

    const lastFrameTime = duration - lastFrameOffset;
    if (lastFrameTime <= boundaryTolerance) {
      filters.push(`fade=t=in:st=${formatFilterNumber(duration)}:d=${formatFilterNumber(fadeOutDuration)}:c=black`);
    } else {
      const idealFadeOutStart = duration - fadeOutDuration - lastFrameOffset;
      const fadeOutStart = Math.max(idealFadeOutStart, 0);
      const effectiveFadeOutDuration = idealFadeOutStart >= 0 ? fadeOutDuration : lastFrameTime;
      filters.push(`fade=t=out:st=${formatFilterNumber(fadeOutStart)}:d=${formatFilterNumber(effectiveFadeOutDuration)}:c=black`);
    }
  }
  return filters.join(',');
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Concat duration must be a positive finite number');
  return value.toFixed(9).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
}

function escapeConcatPath(path: string) {
  return path.replaceAll('\'', String.raw`'\''`);
}

/**
 * Explicit duration directives are essential: AAC packet overhang in a
 * temporary MP4 must not move the next video's first frame.
 */
export function buildSourcePreservingConcatManifest({ paths, durations }: {
  paths: string[],
  durations: number[],
}) {
  if (paths.length === 0 || paths.length !== durations.length) {
    throw new Error('Concat paths and planned durations must have the same non-zero length');
  }

  return paths.map((path, index) => [
    `file 'file:${escapeConcatPath(path)}'`,
    `duration ${formatDuration(durations[index]!)}`,
  ].join('\n')).join('\n');
}

interface ProbeStream {
  index?: number | undefined,
  codec_type?: string | undefined,
  codec_name?: string | undefined,
  start_time?: string | number | undefined,
  duration?: string | number | undefined,
  time_base?: string | undefined,
  avg_frame_rate?: string | undefined,
  r_frame_rate?: string | undefined,
  sample_rate?: string | number | undefined,
  tags?: Record<string, string | undefined> | undefined,
}

export interface SourcePreservingProbeMeta {
  format?: {
    format_name?: string | undefined,
    start_time?: string | number | undefined,
    duration?: string | number | undefined,
  } | undefined,
  streams?: ProbeStream[] | undefined,
}

export interface ExpectedTemporalCodec {
  codecType: 'video' | 'audio',
  codecName: string,
}

export type SourcePreservingVerificationIssueCode =
  | 'FORMAT_MISMATCH'
  | 'STREAM_LAYOUT_MISMATCH'
  | 'CODEC_MISMATCH'
  | 'START_TIME_MISMATCH'
  | 'DURATION_MISMATCH';

export interface SourcePreservingVerificationIssue {
  code: SourcePreservingVerificationIssueCode,
  message: string,
}

function parseFinite(value: string | number | undefined) {
  if (value == null) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseClockDuration(value: string | undefined) {
  if (value == null) return undefined;
  const match = value.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (match == null) return undefined;
  return Number.parseInt(match[1]!, 10) * 3600 + Number.parseInt(match[2]!, 10) * 60 + Number.parseFloat(match[3]!);
}

function getStreamDuration(stream: ProbeStream) {
  return parseFinite(stream.duration) ?? parseClockDuration(stream.tags?.['DURATION']) ?? parseClockDuration(stream.tags?.['duration']);
}

function formatMatches(actual: string | undefined, expected: string) {
  if (actual == null) return false;
  const names = new Set(actual.toLowerCase().split(',').map((name) => name.trim()));
  const normalized = expected.toLowerCase().replace(/^\./, '');
  if (normalized === 'mkv') return names.has('matroska');
  if (normalized === 'm4a' || normalized === 'ipod') return names.has('mp4') || names.has('mov');
  return names.has(normalized);
}

function getAudioPacketTolerance(stream: ProbeStream) {
  const sampleRate = parseFinite(stream.sample_rate);
  if (sampleRate == null || sampleRate <= 0) return 0.05;
  const samplesPerPacket = stream.codec_name === 'aac' ? 1024 : (stream.codec_name === 'mp3' ? 1152 : 2048);
  return Math.max(samplesPerPacket / sampleRate, 0.001);
}

export function verifySourcePreservingExportMeta({
  meta,
  expectedDuration,
  expectedFormat,
  expectedTemporalCodecs,
  expectedFrameDuration,
  actualVideoPresentationDuration,
  expectedVideoPresentationDuration,
  expectedContainerDuration = expectedDuration,
}: {
  meta: SourcePreservingProbeMeta,
  expectedDuration: number,
  expectedFormat: string,
  expectedTemporalCodecs: ExpectedTemporalCodec[],
  expectedFrameDuration?: number | undefined,
  actualVideoPresentationDuration?: number | undefined,
  expectedVideoPresentationDuration?: number | undefined,
  expectedContainerDuration?: number | undefined,
}) {
  const issues: SourcePreservingVerificationIssue[] = [];
  if (!formatMatches(meta.format?.format_name, expectedFormat)) {
    issues.push({ code: 'FORMAT_MISMATCH', message: `Expected ${expectedFormat}, received ${meta.format?.format_name ?? '(unknown format)'}` });
  }

  const streams = (meta.streams ?? []).filter((stream) => stream.codec_type === 'video' || stream.codec_type === 'audio');
  const expectedTypeCounts = new Map<'video' | 'audio', number>();
  const actualTypeCounts = new Map<string, number>();
  expectedTemporalCodecs.forEach(({ codecType }) => expectedTypeCounts.set(codecType, (expectedTypeCounts.get(codecType) ?? 0) + 1));
  streams.forEach(({ codec_type: codecType }) => actualTypeCounts.set(codecType ?? '', (actualTypeCounts.get(codecType ?? '') ?? 0) + 1));
  if (streams.length !== expectedTemporalCodecs.length
    || [...expectedTypeCounts].some(([codecType, count]) => actualTypeCounts.get(codecType) !== count)) {
    issues.push({ code: 'STREAM_LAYOUT_MISMATCH', message: 'Output temporal stream layout differs from the source selection' });
  }

  const actualByType = {
    video: streams.filter(({ codec_type: codecType }) => codecType === 'video'),
    audio: streams.filter(({ codec_type: codecType }) => codecType === 'audio'),
  };
  const expectedTypeIndexes = { video: 0, audio: 0 };
  expectedTemporalCodecs.forEach((expected) => {
    const actual = actualByType[expected.codecType][expectedTypeIndexes[expected.codecType]];
    expectedTypeIndexes[expected.codecType] += 1;
    if (actual != null && actual.codec_name !== expected.codecName) {
      issues.push({ code: 'CODEC_MISMATCH', message: `Expected ${expected.codecName} ${expected.codecType}, received ${actual.codec_name ?? '(unknown codec)'}` });
    }
  });

  streams.forEach((stream) => {
    const isVideo = stream.codec_type === 'video';
    const tolerance = isVideo
      ? Math.max(
        actualVideoPresentationDuration != null && expectedVideoPresentationDuration != null
          ? (expectedFrameDuration ?? 0.04) / 2
          : (expectedFrameDuration ?? 0.04),
        0.001,
      )
      : getAudioPacketTolerance(stream);
    const start = parseFinite(stream.start_time) ?? 0;
    if (Math.abs(start) > tolerance) {
      issues.push({ code: 'START_TIME_MISMATCH', message: `Output ${stream.codec_type ?? 'stream'} starts at ${start}, expected zero` });
    }
    const duration = isVideo && actualVideoPresentationDuration != null
      ? actualVideoPresentationDuration
      : getStreamDuration(stream);
    const streamExpectedDuration = isVideo && expectedVideoPresentationDuration != null
      ? expectedVideoPresentationDuration
      : expectedDuration;
    if (duration == null || Math.abs(duration - streamExpectedDuration) > tolerance) {
      issues.push({ code: 'DURATION_MISMATCH', message: `Output ${stream.codec_type ?? 'stream'} duration ${duration ?? '(unknown)'} differs from ${streamExpectedDuration}` });
    }
  });

  const formatStart = parseFinite(meta.format?.start_time) ?? 0;
  const containerDuration = parseFinite(meta.format?.duration);
  const formatTolerance = Math.max(expectedFrameDuration ?? 0.04, ...streams.map((stream) => getAudioPacketTolerance(stream)));
  if (Math.abs(formatStart) > formatTolerance) {
    issues.push({ code: 'START_TIME_MISMATCH', message: `Output container starts at ${formatStart}, expected zero` });
  }
  if (containerDuration == null || Math.abs(containerDuration - expectedContainerDuration) > formatTolerance) {
    issues.push({ code: 'DURATION_MISMATCH', message: `Output container duration ${containerDuration ?? '(unknown)'} differs from ${expectedContainerDuration}` });
  }

  return { ok: issues.length === 0, issues };
}

export class SourcePreservingVerificationError extends Error {
  issues: SourcePreservingVerificationIssue[];

  constructor(issues: SourcePreservingVerificationIssue[]) {
    super(issues.map(({ message }) => message).join('; '));
    this.name = 'SourcePreservingVerificationError';
    this.issues = issues;
  }
}

export function assertSourcePreservingExportMeta(options: Parameters<typeof verifySourcePreservingExportMeta>[0]) {
  const result = verifySourcePreservingExportMeta(options);
  if (!result.ok) throw new SourcePreservingVerificationError(result.issues);
  return result;
}
