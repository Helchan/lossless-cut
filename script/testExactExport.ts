/* eslint-disable camelcase -- ffprobe JSON field names are an external wire format */
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  assertSourcePreservingExportMeta,
  buildSourcePreservingConcatManifest,
  buildSourcePreservingSegmentPlan,
  buildSourcePreservingVideoFilter,
  containsH264IdrAccessUnit,
  getSourcePreservingBoundaryBFrames,
  getSourcePreservingCopyTargets,
  getSourcePreservingPacketPresentationDuration,
  getSourcePreservingVideoPresentationDuration,
  type SourcePreservingPart,
  type SourcePreservingSpan,
} from '../src/renderer/src/sourcePreservingExport.ts';
import { buildMergeTransitionPlan } from '../src/renderer/src/mergeTransition.ts';
import { getLastFrameOffset } from '../src/renderer/src/mergeTransitionExport.ts';


const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const platformDir = process.platform === 'darwin' ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : `${process.platform}-${process.arch}`;
const ffmpegPath = join(repoDir, 'ffmpeg', platformDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobePath = join(repoDir, 'ffmpeg', platformDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

async function runCapture(command: string, args: string[], input?: string | undefined) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
    if (input != null) child.stdin!.end(input);
  });
}

async function run(command: string, args: string[], input?: string | undefined) {
  await runCapture(command, args, input);
}

interface ProbeStream {
  index: number,
  codec_type: 'video' | 'audio' | string,
  codec_name: string,
  profile?: string | undefined,
  pix_fmt?: string | undefined,
  sample_rate?: string | undefined,
  channel_layout?: string | undefined,
  time_base?: string | undefined,
  start_time?: string | undefined,
  duration?: string | undefined,
  bit_rate?: string | undefined,
  nb_read_packets?: string | undefined,
  avg_frame_rate?: string | undefined,
  has_b_frames?: number | undefined,
}

interface ProbeMeta {
  format: {
    format_name?: string | undefined,
    start_time?: string | undefined,
    duration: string,
    size?: string | undefined,
    bit_rate?: string | undefined,
  },
  streams: ProbeStream[],
}

interface PacketInfo {
  stream_index: number,
  pts_time?: string | undefined,
  duration_time?: string | undefined,
  size?: string | undefined,
  flags?: string | undefined,
  data_hash?: string | undefined,
}

function formatNumber(value: number) {
  return value.toFixed(9).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
}

function parseNumber(value: string | undefined) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function probe(path: string, countPackets = false) {
  const stdout = await runCapture(ffprobePath, [
    '-v', 'error',
    ...(countPackets ? ['-count_packets'] : []),
    '-show_streams', '-show_format', '-of', 'json', path,
  ]);
  return JSON.parse(stdout.toString('utf8')) as ProbeMeta;
}

async function readPackets(path: string, streamIndex?: number | undefined, hash = false) {
  const stdout = await runCapture(ffprobePath, [
    '-v', 'error',
    ...(streamIndex == null ? [] : ['-select_streams', String(streamIndex)]),
    '-show_packets',
    ...(hash ? ['-show_data_hash', 'sha256'] : []),
    '-show_entries', 'packet=stream_index,pts_time,duration_time,size,flags,data_hash',
    '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout.toString('utf8')) as { packets?: PacketInfo[] | undefined };
  return parsed.packets ?? [];
}

function packetsInSpans(packets: PacketInfo[], spans: readonly SourcePreservingSpan[]) {
  return packets.filter(({ pts_time }) => {
    const pts = parseNumber(pts_time);
    return pts != null && spans.some(({ start, end }) => pts >= start - 0.000001 && pts < end - 0.000001);
  });
}

function packetKey(packet: PacketInfo) {
  return `${packet.stream_index}:${packet.size ?? ''}:${packet.data_hash ?? ''}`;
}

function packetMultiset(packets: PacketInfo[]) {
  const counts = new Map<string, number>();
  packets.forEach((packet) => counts.set(packetKey(packet), (counts.get(packetKey(packet)) ?? 0) + 1));
  return counts;
}

function consumePacket(multiset: Map<string, number>, packet: PacketInfo) {
  const key = packetKey(packet);
  const count = multiset.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) multiset.delete(key);
  else multiset.set(key, count - 1);
  return true;
}

async function concatMp4(paths: string[], durations: number[], outputPath: string, timescale: number) {
  const manifest = buildSourcePreservingConcatManifest({ paths, durations });
  await run(ffmpegPath, [
    '-v', 'error', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd', '-i', '-',
    '-map', '0', '-c', 'copy', '-video_track_timescale', String(timescale), '-y', outputPath,
  ], manifest);
}

async function exportPart({ sourcePath, part, outputPath, videoBitrate, videoProfile, pixelFormat, timescale, sourceBFrames, lastFrameOffset }: {
  sourcePath: string,
  part: SourcePreservingPart,
  outputPath: string,
  videoBitrate: number,
  videoProfile?: string | undefined,
  pixelFormat?: string | undefined,
  timescale: number,
  sourceBFrames: number | undefined,
  lastFrameOffset?: number | undefined,
}) {
  const duration = part.end - part.start;
  if (part.mode === 'copy') {
    await run(ffmpegPath, [
      '-v', 'error',
      ...(part.start > 0 ? ['-ss', formatNumber(part.start)] : []),
      '-i', sourcePath,
      '-t', formatNumber(duration),
      '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', `noise=drop='lt(pts*tb,0)+gte(pts*tb,${formatNumber(duration)})'`,
      '-an',
      '-video_track_timescale', String(timescale), '-y', outputPath,
    ]);
    return;
  }

  const x264Profile = ({
    'Constrained Baseline': 'baseline',
    Baseline: 'baseline',
    Main: 'main',
    High: 'high',
    'High 10': 'high10',
    'High 4:2:2': 'high422',
    'High 4:4:4 Predictive': 'high444',
  } as Record<string, string>)[videoProfile ?? ''];
  const videoFilter = buildSourcePreservingVideoFilter({
    duration,
    ...(part.fadeInDuration != null ? { fadeInDuration: part.fadeInDuration } : {}),
    ...(part.fadeOutDuration != null ? {
      fadeOutDuration: part.fadeOutDuration,
      ...(lastFrameOffset != null ? { lastFrameOffset } : {}),
    } : {}),
  });
  await run(ffmpegPath, [
    '-v', 'error',
    '-noautorotate',
    ...(part.start > 0 ? ['-ss', formatNumber(part.start)] : []),
    '-i', sourcePath,
    '-t', formatNumber(duration),
    '-map', '0:v:0', '-vf', videoFilter, '-c:v', 'libx264', '-b:v', String(videoBitrate),
    ...(x264Profile != null ? ['-profile:v', x264Profile] : []),
    ...(pixelFormat != null ? ['-pix_fmt', pixelFormat] : []),
    '-bf', String(getSourcePreservingBoundaryBFrames(sourceBFrames)),
    '-an',
    '-video_track_timescale', String(timescale), '-y', outputPath,
  ]);
}

async function encodeAudioSpans({ sourcePath, spans, outputPath, bitrate, sampleRate }: {
  sourcePath: string,
  spans: readonly SourcePreservingSpan[],
  outputPath: string,
  bitrate: number,
  sampleRate: number,
}) {
  const inputArgs = spans.flatMap(({ start, end }) => ['-ss', formatNumber(start), '-t', formatNumber(end - start), '-i', sourcePath]);
  const labels = spans.map((_, index) => `[a${index}]`);
  const filter = [
    ...spans.map(({ start, end }, index) => {
      const duration = formatNumber(end - start);
      return `[${index}:a:0]atrim=duration=${duration},aresample=async=0:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
    }),
    `${labels.join('')}concat=n=${spans.length}:v=0:a=1[aout]`,
  ].join(';');
  const duration = spans.reduce((total, { start, end }) => total + end - start, 0);
  await run(ffmpegPath, [
    '-v', 'error', ...inputArgs,
    '-filter_complex', filter, '-map', '[aout]',
    '-c:a', 'aac', '-b:a', String(bitrate), '-ar', String(sampleRate),
    '-t', formatNumber(duration), '-vn', '-y', outputPath,
  ]);
}

async function muxVideoAudio({ videoPath, audioPath, outputPath, duration, timescale }: {
  videoPath: string,
  audioPath: string,
  outputPath: string,
  duration: number,
  timescale: number,
}) {
  await run(ffmpegPath, [
    '-v', 'error', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-c:v', 'copy', '-map', '1:a:0', '-c:a', 'copy',
    '-t', formatNumber(duration), '-video_track_timescale', String(timescale), '-y', outputPath,
  ]);
}

async function decodedFrameTimes(path: string) {
  const stdout = await runCapture(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout.toString('utf8')) as { frames?: { best_effort_timestamp_time?: string }[] | undefined };
  return (parsed.frames ?? []).flatMap(({ best_effort_timestamp_time }) => {
    const value = parseNumber(best_effort_timestamp_time);
    return value == null ? [] : [value];
  });
}

async function decodedLuma(path: string) {
  return runCapture(ffmpegPath, [
    '-v', 'error', '-i', path,
    '-map', '0:v:0', '-vf', 'scale=1:1:flags=area,format=gray',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ]);
}

function packetPresentationCoverage(packets: PacketInfo[], fallbackFrameDuration: number) {
  const coverage = getSourcePreservingPacketPresentationDuration({
    packets: packets.flatMap(({ pts_time, duration_time }) => {
      const time = parseNumber(pts_time);
      if (time == null) return [];
      const duration = parseNumber(duration_time);
      return [{ time, ...(duration != null ? { duration } : {}) }];
    }),
    fallbackFrameDuration,
  });
  assert(coverage != null);
  return coverage;
}

async function runMergeTransitionRegression(workDir: string) {
  const transitionSourcePath = join(workDir, 'transition-source.mp4');
  await run(ffmpegPath, [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=60:d=8',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', '1M', '-minrate', '1M', '-maxrate', '1M', '-bufsize', '2M', '-x264-params', 'nal-hrd=cbr',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '2',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-video_track_timescale', '60000', '-y', transitionSourcePath,
  ]);

  const transitionSourceMeta = await probe(transitionSourcePath, true);
  const transitionSourceVideo = transitionSourceMeta.streams.find(({ codec_type }) => codec_type === 'video');
  const transitionSourceAudio = transitionSourceMeta.streams.find(({ codec_type }) => codec_type === 'audio');
  assert(transitionSourceVideo != null && transitionSourceAudio != null);
  const transitionTimescaleParts = transitionSourceVideo.time_base?.split('/').map(Number);
  const transitionTimescale = transitionTimescaleParts?.[0] === 1 && Number.isFinite(transitionTimescaleParts[1])
    ? transitionTimescaleParts[1]!
    : 60000;
  const transitionVideoBitrate = Math.floor(Number.parseInt(transitionSourceVideo.bit_rate ?? '1000000', 10) * 1.2);
  const transitionAudioBitrate = Number.parseInt(transitionSourceAudio.bit_rate ?? '128000', 10);
  const transitionAudioSampleRate = Number.parseInt(transitionSourceAudio.sample_rate ?? '48000', 10);
  const transitionSpans: SourcePreservingSpan[] = [{ start: 0.1, end: 3.1 }, { start: 4.9, end: 7.6 }];
  const transitionExpectedDuration = 5.7;
  const transitionJoinFrame = 180;
  const transitionSourcePackets = await readPackets(transitionSourcePath, transitionSourceVideo.index);
  const transitionKeyframeTimes = transitionSourcePackets.flatMap(({ flags, pts_time }) => {
    const pts = parseNumber(pts_time);
    return flags?.startsWith('K') && pts != null ? [pts] : [];
  });
  const transitionIdrCache = new Map<number, Promise<boolean>>();
  const isTransitionSafeIdr = (time: number) => {
    const existing = transitionIdrCache.get(time);
    if (existing != null) return existing;
    const pending = runCapture(ffmpegPath, [
      '-v', 'error', ...(time > 0 ? ['-ss', formatNumber(time)] : []), '-i', transitionSourcePath,
      '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1',
    ]).then((data) => containsH264IdrAccessUnit(data));
    transitionIdrCache.set(time, pending);
    return pending;
  };
  const findTransitionSafeIdr = async (candidates: number[]) => {
    for (const candidate of candidates) {
      if (await isTransitionSafeIdr(candidate)) return candidate;
    }
    return undefined;
  };

  const exportTransitionVideo = async ({ name, fadeEnabled }: { name: string, fadeEnabled: boolean }) => {
    const transitionPlan = buildMergeTransitionPlan({
      intent: 'merge',
      enabled: fadeEnabled,
      totalDuration: 0.46,
      spans: transitionSpans,
    });
    const sourceDuration = Number.parseFloat(transitionSourceMeta.format.duration);
    const plans = await Promise.all(transitionPlan.segments.map(async (segment) => {
      const { copyStart, copyEnd } = getSourcePreservingCopyTargets({
        span: segment,
        fadeInDuration: segment.fadeInDuration,
        fadeOutDuration: segment.fadeOutDuration,
      });
      assert(Math.abs(copyStart - segment.copyStartAtOrAfter) <= 1e-9);
      assert(Math.abs(copyEnd - segment.copyEndAtOrBefore) <= 1e-9);
      const fullyEncode = copyStart >= copyEnd - 1e-9;
      const nextSafeIdrAtOrAfterCopyStart = fullyEncode
        ? undefined
        : await findTransitionSafeIdr(transitionKeyframeTimes
          .filter((time) => time >= copyStart - 0.000001 && time <= segment.end + 0.000001));
      const previousSafeIdrAtOrBeforeCopyEnd = fullyEncode
        ? undefined
        : await findTransitionSafeIdr(transitionKeyframeTimes
          .filter((time) => time >= segment.start - 0.000001 && time <= copyEnd + 0.000001)
          .toReversed());
      return buildSourcePreservingSegmentPlan({
        span: segment,
        fadeInDuration: segment.fadeInDuration,
        fadeOutDuration: segment.fadeOutDuration,
        nextSafeIdrAtOrAfterCopyStart,
        previousSafeIdrAtOrBeforeCopyEnd,
        sourceDuration,
      });
    }));

    const segmentPaths: string[] = [];
    for (const [segmentIndex, plan] of plans.entries()) {
      const transitionSegment = transitionPlan.segments[segmentIndex]!;
      const lastFrameOffset = transitionSegment.fadeOutDuration > 0
        ? getLastFrameOffset({
          segment: transitionSegment,
          framePts: transitionSourcePackets.flatMap(({ pts_time }) => {
            const pts = parseNumber(pts_time);
            return pts != null && pts >= transitionSegment.start && pts < transitionSegment.end - 1e-9 ? [pts] : [];
          }),
        })
        : undefined;
      const partPaths: string[] = [];
      for (const [partIndex, part] of plan.parts.entries()) {
        const partPath = join(workDir, `${name}-segment-${segmentIndex}-part-${partIndex}.mp4`);
        await exportPart({
          sourcePath: transitionSourcePath,
          part,
          outputPath: partPath,
          videoBitrate: transitionVideoBitrate,
          videoProfile: transitionSourceVideo.profile,
          pixelFormat: transitionSourceVideo.pix_fmt,
          timescale: transitionTimescale,
          sourceBFrames: transitionSourceVideo.has_b_frames,
          ...(lastFrameOffset != null ? { lastFrameOffset } : {}),
        });
        partPaths.push(partPath);
      }
      const segmentPath = join(workDir, `${name}-segment-${segmentIndex}.mp4`);
      await concatMp4(partPaths, plan.parts.map(({ start, end }) => end - start), segmentPath, transitionTimescale);
      segmentPaths.push(segmentPath);
    }
    const videoPath = join(workDir, `${name}-video.mp4`);
    await concatMp4(segmentPaths, transitionSpans.map(({ start, end }) => end - start), videoPath, transitionTimescale);
    return { videoPath, plans };
  };

  const fadedVideo = await exportTransitionVideo({ name: 'transition-faded', fadeEnabled: true });
  const controlVideo = await exportTransitionVideo({ name: 'transition-control', fadeEnabled: false });
  const transitionAudioPath = join(workDir, 'transition-audio.mp4');
  await encodeAudioSpans({
    sourcePath: transitionSourcePath,
    spans: transitionSpans,
    outputPath: transitionAudioPath,
    bitrate: transitionAudioBitrate,
    sampleRate: transitionAudioSampleRate,
  });
  const fadedPath = join(workDir, 'transition-faded.mp4');
  const controlPath = join(workDir, 'transition-control.mp4');
  await muxVideoAudio({
    videoPath: fadedVideo.videoPath,
    audioPath: transitionAudioPath,
    outputPath: fadedPath,
    duration: transitionExpectedDuration,
    timescale: transitionTimescale,
  });
  await muxVideoAudio({
    videoPath: controlVideo.videoPath,
    audioPath: transitionAudioPath,
    outputPath: controlPath,
    duration: transitionExpectedDuration,
    timescale: transitionTimescale,
  });

  const [fadedMeta, controlMeta, fadedLuma, controlLuma] = await Promise.all([
    probe(fadedPath, true),
    probe(controlPath, true),
    decodedLuma(fadedPath),
    decodedLuma(controlPath),
  ]);
  assert.equal(fadedLuma.length, 342);
  assert.equal(controlLuma.length, 342);
  assert(Math.abs(Number.parseFloat(fadedMeta.format.duration) - transitionExpectedDuration) <= 1 / 60);
  assert(Math.abs(Number.parseFloat(controlMeta.format.duration) - transitionExpectedDuration) <= 1 / 60);

  const blackThreshold = 20;
  assert(fadedLuma[transitionJoinFrame - 1]! <= blackThreshold, 'Fade-out did not make the previous segment final frame black');
  assert(fadedLuma[transitionJoinFrame]! <= blackThreshold, 'Fade-in did not make the next segment first frame black');
  const fadeOutChangedIndices = Array.from({ length: transitionJoinFrame }, (_, index) => index)
    .filter((index) => Math.abs(fadedLuma[index]! - controlLuma[index]!) > 3);
  const fadeInChangedIndices = Array.from({ length: fadedLuma.length - transitionJoinFrame }, (_, index) => index + transitionJoinFrame)
    .filter((index) => Math.abs(fadedLuma[index]! - controlLuma[index]!) > 3);
  assert(fadeOutChangedIndices.length >= 13 && fadeOutChangedIndices.length <= 15);
  assert(fadeInChangedIndices.length >= 13 && fadeInChangedIndices.length <= 15);
  for (let index = 1; index < fadeOutChangedIndices.length; index += 1) {
    assert(fadedLuma[fadeOutChangedIndices[index]!]! <= fadedLuma[fadeOutChangedIndices[index - 1]!]! + 3);
  }
  for (let index = 1; index < fadeInChangedIndices.length; index += 1) {
    assert(fadedLuma[fadeInChangedIndices[index]!]! + 3 >= fadedLuma[fadeInChangedIndices[index - 1]!]!);
  }

  for (let index = 0; index < transitionJoinFrame - 15; index += 1) {
    assert(Math.abs(fadedLuma[index]! - controlLuma[index]!) <= 3);
  }
  for (let index = transitionJoinFrame + 15; index < fadedLuma.length; index += 1) {
    assert(Math.abs(fadedLuma[index]! - controlLuma[index]!) <= 3);
  }

  const fadedVideoStream = fadedMeta.streams.find(({ codec_type }) => codec_type === 'video');
  const fadedAudioStream = fadedMeta.streams.find(({ codec_type }) => codec_type === 'audio');
  const controlVideoStream = controlMeta.streams.find(({ codec_type }) => codec_type === 'video');
  const controlAudioStream = controlMeta.streams.find(({ codec_type }) => codec_type === 'audio');
  assert(fadedVideoStream != null && fadedAudioStream != null && controlVideoStream != null && controlAudioStream != null);
  assert.equal(fadedVideoStream.has_b_frames, 2);
  assert.equal(fadedVideoStream.profile, transitionSourceVideo.profile);
  assert.equal(fadedVideoStream.pix_fmt, transitionSourceVideo.pix_fmt);
  assert.equal(fadedVideoStream.time_base, transitionSourceVideo.time_base);

  const [fadedVideoPackets, controlVideoPackets] = await Promise.all([
    readPackets(fadedPath, fadedVideoStream.index),
    readPackets(controlPath, controlVideoStream.index),
  ]);
  const fadedCoverage = packetPresentationCoverage(fadedVideoPackets, 1 / 60);
  const controlCoverage = packetPresentationCoverage(controlVideoPackets, 1 / 60);
  assert(Math.abs(fadedCoverage - transitionExpectedDuration) <= 1 / 60);
  assert(Math.abs(controlCoverage - transitionExpectedDuration) <= 1 / 60);
  assert(Math.abs(fadedCoverage - controlCoverage) <= 1 / transitionTimescale);

  const sourceHashedVideoPackets = await readPackets(transitionSourcePath, transitionSourceVideo.index, true);
  const fadedHashedVideoPackets = await readPackets(fadedPath, fadedVideoStream.index, true);
  const fadedPacketCounts = packetMultiset(fadedHashedVideoPackets);
  const copySpans: SourcePreservingSpan[] = [{ start: 1, end: 2 }, { start: 6, end: 7 }];
  const plannedCopySpans = fadedVideo.plans.flatMap(({ parts }) => parts.filter(({ mode }) => mode === 'copy'));
  copySpans.forEach((expectedSpan) => {
    assert(plannedCopySpans.some(({ start, end }) => Math.abs(start - expectedSpan.start) <= 1e-9 && Math.abs(end - expectedSpan.end) <= 1e-9));
  });
  const copyPacketPreservationRatios = copySpans.map((copySpan) => {
    const sourcePackets = packetsInSpans(sourceHashedVideoPackets, [copySpan]);
    const unmatched = sourcePackets.filter((packet) => !consumePacket(fadedPacketCounts, packet));
    const ratio = sourcePackets.length === 0 ? 1 : 1 - unmatched.length / sourcePackets.length;
    assert(ratio >= 0.98, `Only ${(ratio * 100).toFixed(2)}% of ${copySpan.start}-${copySpan.end}s packets were preserved`);
    return ratio;
  });

  const [fadedAudioPackets, controlAudioPackets] = await Promise.all([
    readPackets(fadedPath, fadedAudioStream.index, true),
    readPackets(controlPath, controlAudioStream.index, true),
  ]);
  const audioSignature = (packet: PacketInfo) => ({
    pts_time: packet.pts_time,
    duration_time: packet.duration_time,
    size: packet.size,
    data_hash: packet.data_hash,
  });
  assert.deepEqual(
    fadedAudioPackets.map((packet) => audioSignature(packet)),
    controlAudioPackets.map((packet) => audioSignature(packet)),
  );

  await Promise.all([fadedPath, controlPath].map((path) => run(ffmpegPath, [
    '-v', 'error', '-xerror', '-ss', '2', '-i', path, '-t', '2', '-map', '0:v:0', '-f', 'null', '-',
  ])));

  const whiteFramePath = join(workDir, 'transition-white-frame.mp4');
  await run(ffmpegPath, [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=16x16:r=60',
    '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', whiteFramePath,
  ]);
  const singleFrameDuration = 1 / 60;
  const singleFrameFilters = [
    buildSourcePreservingVideoFilter({ duration: singleFrameDuration, lastFrameOffset: singleFrameDuration, fadeOutDuration: 0.01 }),
    buildSourcePreservingVideoFilter({ duration: singleFrameDuration, fadeInDuration: 0.01 }),
    buildSourcePreservingVideoFilter({
      duration: singleFrameDuration,
      lastFrameOffset: singleFrameDuration,
      fadeInDuration: 0.005,
      fadeOutDuration: 0.005,
    }),
  ];
  for (const [index, filter] of singleFrameFilters.entries()) {
    const filteredPath = join(workDir, `transition-white-frame-${index}.mp4`);
    await run(ffmpegPath, [
      '-v', 'error', '-i', whiteFramePath, '-vf', filter,
      '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', filteredPath,
    ]);
    const luma = await decodedLuma(filteredPath);
    assert.equal(luma.length, 1);
    assert(luma[0]! <= blackThreshold, `Single-frame transition branch ${index} did not render black`);
  }

  return {
    transitionDuration: transitionExpectedDuration,
    transitionJoinFrame,
    fadeOutChangedFrames: fadeOutChangedIndices.length,
    fadeInChangedFrames: fadeInChangedIndices.length,
    copyPacketPreservationRatios,
    audioPacketsIdentical: true,
  };
}

await access(ffmpegPath);
await access(ffprobePath);

const workDir = await mkdtemp(join(tmpdir(), 'losslesscut-source-preserving-export-'));
try {
  const realSourcePath = process.env['LOSSLESSCUT_REAL_SOURCE'];
  const sourcePath = realSourcePath ?? join(workDir, 'source.mp4');
  if (realSourcePath == null) {
    await run(ffmpegPath, [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30:duration=60',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '2',
      '-c:a', 'aac', '-b:a', '192k', '-video_track_timescale', '15360', '-y', sourcePath,
    ]);
  }

  const sourceMeta = await probe(sourcePath);
  const sourceVideo = sourceMeta.streams.find(({ codec_type }) => codec_type === 'video');
  const sourceAudio = sourceMeta.streams.find(({ codec_type }) => codec_type === 'audio');
  assert(sourceVideo != null && sourceAudio != null);
  const timeBaseParts = sourceVideo.time_base?.split('/').map(Number);
  const timescale = timeBaseParts?.[0] === 1 && Number.isFinite(timeBaseParts[1]) ? timeBaseParts[1]! : 15360;
  const sourceBitrate = Number.parseInt(sourceVideo.bit_rate ?? '4000000', 10);
  const boundaryBitrate = Math.floor(sourceBitrate * 1.2);
  const sourceAudioBitrate = Number.parseInt(sourceAudio.bit_rate ?? '192000', 10);
  const sourceAudioSampleRate = Number.parseInt(sourceAudio.sample_rate ?? '48000', 10);
  const [fpsNumerator, fpsDenominator] = (sourceVideo.avg_frame_rate ?? '30/1').split('/').map(Number);
  const fps = fpsNumerator! / fpsDenominator!;
  assert(Number.isFinite(fps) && fps > 0);
  const sourceDuration = Number.parseFloat(sourceMeta.format.duration);
  const sourceTimelineStart = parseNumber(sourceMeta.format.start_time) ?? 0;
  const sourceVideoStart = parseNumber(sourceVideo.start_time) ?? 0;
  const sourceVideoEnd = sourceVideoStart + (parseNumber(sourceVideo.duration) ?? sourceDuration) - sourceTimelineStart;

  const spans: SourcePreservingSpan[] = realSourcePath == null
    ? [{ start: 3.1, end: 18.4 }, { start: 23.3, end: 39.1 }, { start: 43.7, end: 57.4 }]
    : (JSON.parse(process.env['LOSSLESSCUT_REAL_SPANS'] ?? '[]') as [number, number][]).map(([start, end]) => ({ start, end }));
  assert(spans.length > 0);
  const exportStarted = performance.now();
  const sourceVideoPackets = await readPackets(sourcePath, sourceVideo.index);
  const keyframeTimes = sourceVideoPackets.flatMap(({ flags, pts_time }) => {
    const pts = parseNumber(pts_time);
    return flags?.startsWith('K') && pts != null ? [pts] : [];
  });
  const idrCache = new Map<number, Promise<boolean>>();
  const isSafeIdr = (time: number) => {
    const existing = idrCache.get(time);
    if (existing != null) return existing;
    const pending = runCapture(ffmpegPath, [
      '-v', 'error', ...(time > 0 ? ['-ss', formatNumber(time)] : []), '-i', sourcePath,
      '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1',
    ]).then((data) => containsH264IdrAccessUnit(data));
    idrCache.set(time, pending);
    return pending;
  };
  const findSafeIdr = async (candidates: number[]) => {
    for (const candidate of candidates) {
      if (await isSafeIdr(candidate)) return candidate;
    }
    return undefined;
  };
  const plans = await Promise.all(spans.map(async (span) => buildSourcePreservingSegmentPlan({
    span,
    nextSafeIdrAtOrAfterCopyStart: span.start === 0
      ? 0
      : await findSafeIdr(keyframeTimes.filter((time) => time >= span.start - 0.000001)),
    previousSafeIdrAtOrBeforeCopyEnd: Math.abs(span.end - sourceDuration) <= 0.000001
      ? sourceDuration
      : await findSafeIdr(keyframeTimes.filter((time) => time <= span.end + 0.000001).toReversed()),
    sourceDuration,
  })));
  if (realSourcePath == null) assert.equal(plans.reduce((total, { copiedDuration }) => total + copiedDuration, 0), 40);

  const segmentPaths: string[] = [];
  for (const [segmentIndex, plan] of plans.entries()) {
    const partPaths: string[] = [];
    for (const [partIndex, part] of plan.parts.entries()) {
      const partPath = join(workDir, `segment-${segmentIndex}-part-${partIndex}.mp4`);
      await exportPart({ sourcePath, part, outputPath: partPath, videoBitrate: boundaryBitrate, videoProfile: sourceVideo.profile, pixelFormat: sourceVideo.pix_fmt, timescale, sourceBFrames: sourceVideo.has_b_frames });
      partPaths.push(partPath);
    }
    const segmentPath = join(workDir, `segment-${segmentIndex}.mp4`);
    await concatMp4(partPaths, plan.parts.map(({ start, end }) => end - start), segmentPath, timescale);
    segmentPaths.push(segmentPath);
  }
  const mergedVideoPath = join(workDir, 'merged-video.mp4');
  const segmentDurations = spans.map(({ start, end }) => end - start);
  await concatMp4(segmentPaths, segmentDurations, mergedVideoPath, timescale);
  const expectedDuration = segmentDurations.reduce((total, duration) => total + duration, 0);
  const mergedAudioPath = join(workDir, 'merged-audio.mp4');
  await encodeAudioSpans({ sourcePath, spans, outputPath: mergedAudioPath, bitrate: sourceAudioBitrate, sampleRate: sourceAudioSampleRate });
  const mergedPath = join(workDir, 'merged.mp4');
  await muxVideoAudio({ videoPath: mergedVideoPath, audioPath: mergedAudioPath, outputPath: mergedPath, duration: expectedDuration, timescale });
  const exportElapsedSeconds = (performance.now() - exportStarted) / 1000;

  // Independent export uses the same video plan, but creates one exact audio
  // track and final container per selected segment.
  const independentAudioPath = join(workDir, 'independent-audio.mp4');
  await encodeAudioSpans({ sourcePath, spans: [spans[0]!], outputPath: independentAudioPath, bitrate: sourceAudioBitrate, sampleRate: sourceAudioSampleRate });
  const independentPath = join(workDir, 'independent.mp4');
  const independentDuration = spans[0]!.end - spans[0]!.start;
  await muxVideoAudio({ videoPath: segmentPaths[0]!, audioPath: independentAudioPath, outputPath: independentPath, duration: independentDuration, timescale });
  const independentMeta = await probe(independentPath, true);
  const independentVideoPresentationDuration = getSourcePreservingPacketPresentationDuration({
    packets: (await readPackets(independentPath, 0)).flatMap(({ pts_time, duration_time }) => {
      const time = parseNumber(pts_time);
      if (time == null) return [];
      const duration = parseNumber(duration_time);
      return [{ time, ...(duration != null ? { duration } : {}) }];
    }),
    fallbackFrameDuration: 1 / fps,
  });
  const expectedIndependentVideoDuration = getSourcePreservingVideoPresentationDuration({ spans: [spans[0]!], sourceVideoEnd });
  assertSourcePreservingExportMeta({
    meta: independentMeta,
    expectedDuration: independentDuration,
    expectedFormat: 'mp4',
    expectedTemporalCodecs: [
      { codecType: 'video', codecName: sourceVideo.codec_name },
      { codecType: 'audio', codecName: sourceAudio.codec_name },
    ],
    expectedFrameDuration: 1 / fps,
    actualVideoPresentationDuration: independentVideoPresentationDuration,
    expectedVideoPresentationDuration: expectedIndependentVideoDuration,
  });
  assert.equal(
    Number.parseInt(independentMeta.streams.find(({ codec_type }) => codec_type === 'video')?.nb_read_packets ?? '', 10),
    packetsInSpans(sourceVideoPackets, [spans[0]!]).length,
  );
  await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', independentPath, '-f', 'null', '-']);

  const mergedMeta = await probe(mergedPath, true);
  const mergedVideoPresentationDuration = getSourcePreservingPacketPresentationDuration({
    packets: (await readPackets(mergedPath, 0)).flatMap(({ pts_time, duration_time }) => {
      const time = parseNumber(pts_time);
      if (time == null) return [];
      const duration = parseNumber(duration_time);
      return [{ time, ...(duration != null ? { duration } : {}) }];
    }),
    fallbackFrameDuration: 1 / fps,
  });
  const expectedMergedVideoDuration = getSourcePreservingVideoPresentationDuration({ spans, sourceVideoEnd });
  assertSourcePreservingExportMeta({
    meta: mergedMeta,
    expectedDuration,
    expectedFormat: 'mp4',
    expectedTemporalCodecs: [
      { codecType: 'video', codecName: sourceVideo.codec_name },
      { codecType: 'audio', codecName: sourceAudio.codec_name },
    ],
    expectedFrameDuration: 1 / fps,
    actualVideoPresentationDuration: mergedVideoPresentationDuration,
    expectedVideoPresentationDuration: expectedMergedVideoDuration,
  });
  const outputVideo = mergedMeta.streams.find(({ codec_type }) => codec_type === 'video');
  const outputAudio = mergedMeta.streams.find(({ codec_type }) => codec_type === 'audio');
  assert(outputVideo != null && outputAudio != null);
  assert.equal(outputVideo.profile, sourceVideo.profile);
  assert.equal(outputVideo.pix_fmt, sourceVideo.pix_fmt);
  assert.equal(outputAudio.sample_rate, sourceAudio.sample_rate);
  assert.equal(outputAudio.channel_layout, sourceAudio.channel_layout);

  const expectedVideoPackets = packetsInSpans(sourceVideoPackets, spans);
  const segmentPacketCounts = await Promise.all(segmentPaths.map(async (segmentPath) => {
    const segmentMeta = await probe(segmentPath, true);
    return Number.parseInt(segmentMeta.streams.find(({ codec_type }) => codec_type === 'video')?.nb_read_packets ?? '', 10);
  }));
  assert.equal(Number.parseInt(outputVideo.nb_read_packets ?? '', 10), expectedVideoPackets.length);
  if (realSourcePath == null) assert.equal(expectedVideoPackets.length, 1344);
  await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', mergedPath, '-f', 'null', '-']);

  const frameTimes = await decodedFrameTimes(mergedPath);
  assert.equal(frameTimes.length, expectedVideoPackets.length);
  const sourceFrameGaps = spans.flatMap((span) => {
    const times = packetsInSpans(sourceVideoPackets, [span])
      .flatMap(({ pts_time }) => {
        const time = parseNumber(pts_time);
        return time == null ? [] : [time];
      })
      .toSorted((a, b) => a - b);
    return times.slice(1).map((time, index) => time - times[index]!);
  });
  const sourceTimebaseTick = 1 / timescale;
  const maxExpectedFrameGap = Math.max(1 / fps, ...sourceFrameGaps) + sourceTimebaseTick * 2;
  for (let index = 1; index < frameTimes.length; index += 1) {
    const delta = frameTimes[index]! - frameTimes[index - 1]!;
    assert(delta > 0 && delta <= maxExpectedFrameGap, `Unexpected frame timestamp gap ${delta} at ${index}`);
  }

  const sourceHashedPackets = await readPackets(sourcePath, undefined, true);
  const outputHashedPackets = await readPackets(mergedPath, undefined, true);
  const outputPacketCounts = packetMultiset(outputHashedPackets);
  const copiedVideoSpans = plans.flatMap(({ parts }) => parts.filter(({ mode }) => mode === 'copy'));
  const copiedSourcePackets = packetsInSpans(sourceHashedPackets.filter(({ stream_index }) => stream_index === sourceVideo.index), copiedVideoSpans);
  const unmatchedCopiedPackets = copiedSourcePackets.filter((packet) => !consumePacket(outputPacketCounts, packet));
  // MP4 concat may inject codec headers into the first keyframe of each copied
  // region and normalize nearby parameter-set packets. At least 98% of packets
  // in planned copy regions must remain byte-for-byte identical.
  const copiedPacketPreservationRatio = copiedSourcePackets.length === 0
    ? 1
    : 1 - unmatchedCopiedPackets.length / copiedSourcePackets.length;
  assert(copiedPacketPreservationRatio >= 0.98, `${unmatchedCopiedPackets.length} planned copy packets were changed`);

  const sourceSelectedCounts = packetMultiset(packetsInSpans(sourceHashedPackets, spans));
  let matchedPayloadBytes = 0;
  let outputPayloadBytes = 0;
  outputHashedPackets.forEach((packet) => {
    const size = Number.parseInt(packet.size ?? '0', 10);
    outputPayloadBytes += size;
    if (consumePacket(sourceSelectedCounts, packet)) matchedPayloadBytes += size;
  });
  const sourcePayloadRatio = matchedPayloadBytes / outputPayloadBytes;
  if (plans.some(({ copiedDuration }) => copiedDuration > 0)) {
    assert(sourcePayloadRatio >= 0.8, `Only ${(sourcePayloadRatio * 100).toFixed(2)}% of output payload was preserved from source packets`);
  }

  const sourceSelectedPayloadBytes = packetsInSpans(sourceHashedPackets, spans)
    .reduce((total, packet) => total + Number.parseInt(packet.size ?? '0', 10), 0);
  const outputFileBytes = (await stat(mergedPath)).size;
  const sizeRatio = outputFileBytes / sourceSelectedPayloadBytes;
  assert(sizeRatio >= 0.85 && sizeRatio <= 1.3, `Output size ratio ${sizeRatio.toFixed(3)} is outside the source-preserving range`);

  const realtimeFactor = expectedDuration / exportElapsedSeconds;
  assert(realtimeFactor >= 4, `Source-preserving export ran at only ${realtimeFactor.toFixed(2)}x realtime`);

  if (realSourcePath == null) {
    const delayedSourcePath = join(workDir, 'delayed-audio-source.mp4');
    await run(ffmpegPath, [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5',
      '-itsoffset', '0.478', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=4.522',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-y', delayedSourcePath,
    ]);
    const delayedSourceMeta = await probe(delayedSourcePath);
    const delayedSourceAudio = delayedSourceMeta.streams.find(({ codec_type }) => codec_type === 'audio');
    assert((parseNumber(delayedSourceAudio?.start_time) ?? 0) > 0.4);

    for (const [name, audioSpans] of [
      ['separate', [{ start: 0, end: 2 }]],
      ['merge', [{ start: 0, end: 1 }, { start: 2, end: 3 }]],
    ] as const) {
      const delayedOutPath = join(workDir, `delayed-audio-${name}.mp4`);
      await encodeAudioSpans({ sourcePath: delayedSourcePath, spans: audioSpans, outputPath: delayedOutPath, bitrate: 128000, sampleRate: 48000 });
      const delayedOutMeta = await probe(delayedOutPath);
      const delayedOutAudio = delayedOutMeta.streams.find(({ codec_type }) => codec_type === 'audio');
      const delayedExpectedDuration = audioSpans.reduce((total, { start, end }) => total + end - start, 0);
      assert(Math.abs((parseNumber(delayedOutAudio?.start_time) ?? Number.NaN)) <= 0.001);
      assert(Math.abs((parseNumber(delayedOutAudio?.duration) ?? Number.NaN) - delayedExpectedDuration) <= 0.03);
      await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', delayedOutPath, '-f', 'null', '-']);
    }
  }

  const transitionRegression = realSourcePath == null ? await runMergeTransitionRegression(workDir) : undefined;

  console.log(JSON.stringify({
    expectedDuration,
    sourcePath,
    frameCount: frameTimes.length,
    segmentPacketCounts,
    outputFormat: mergedMeta.format.format_name,
    codecs: [outputVideo.codec_name, outputAudio.codec_name],
    copiedDuration: plans.reduce((total, { copiedDuration }) => total + copiedDuration, 0),
    reencodedBoundaryDuration: plans.reduce((total, { reencodedDuration }) => total + reencodedDuration, 0),
    copiedPacketPreservationRatio,
    sourcePayloadRatio,
    outputFileBytes,
    sizeRatio,
    exportElapsedSeconds,
    realtimeFactor,
    transitionRegression,
  }, undefined, 2));
} finally {
  if (process.env['KEEP_EXACT_EXPORT_TEST_FILES'] === '1') console.log('Kept test files in', workDir);
  else await rm(workDir, { recursive: true, force: true });
}
