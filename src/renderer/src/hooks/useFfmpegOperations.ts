import { useCallback } from 'react';
import sum from 'lodash/sum';
import pMap from 'p-map';
import invariant from 'tiny-invariant';
import i18n from 'i18next';

import { getSuffixedOutPath, transferTimestamps, getOutFileExtension, getOutDir, getHtml5ifiedPath, unlinkWithRetry, getFrameDuration, isMac, html5ifiedPrefix, html5dummySuffix, assertFileExists } from '../util';
import { isCuttingStart, isCuttingEnd, runFfmpegWithProgress, getFfCommandLine, getDuration, createChaptersFromSegments, readFileFfprobeMeta, readFrames, getExperimentalArgs, getVideoTimescaleArgs, logStdoutStderr, runFfmpegConcat, RefuseOverwriteError, runFfmpeg } from '../ffmpeg';
import { getActiveDisposition, getMapStreamsArgs, getStreamIdsToCopy } from '../util/streams';
import { needsSmartCut, getCodecParams } from '../smartcut';
import { getGuaranteedSegments, isDurationValid } from '../segments';
import type { FFprobeStream } from '../../../common/ffprobe';
import type { AvoidNegativeTs, FfmpegHwAccel, Html5ifyMode, PreserveMetadata } from '../../../common/types';
import { deleteDispositionValue, type AllFilesMeta, type Chapter, type CopyfileStreams, type LiteFFprobeStream, type ParamsByFile, type SegmentToExport } from '../types';
import type { LossyMode } from '../../../main';
import { UserFacingError } from '../../errors';
import mainApi from '../mainApi';
import { formatFfmpegNumber, getHwaccelArgs } from '../../../common/util';
import type { SegmentExportIntent } from '../segmentExportPlan';
import { snapSourceTimeToFramePts } from '../timelineSegments';
import { assertSourcePreservingExportMeta, buildSourcePreservingConcatManifest, buildSourcePreservingSegmentPlan, buildSourcePreservingVideoFilter, containsH264IdrAccessUnit, getSourcePreservingBoundaryBFrames, getSourcePreservingPacketPresentationDuration, getSourcePreservingVideoPresentationDuration, SourcePreservingVerificationError } from '../sourcePreservingExport';
import { createMonotonicProgressReporter, mapProgressRange, sourcePreservingProgressPhases } from '../sourcePreservingProgress';
import { MergeTransitionPlanError } from '../mergeTransition';
import { buildLastFrameReadWindow, buildSnappedMergeTransitionPreflight, buildTransitionIdrSearchPlan, getLastFrameOffset, normalizeFramePts, type MergeTransitionSnapshot } from '../mergeTransitionExport';
import { minimumMergeTransitionDuration } from '../../../common/mergeTransition';

const { join, resolve, dirname } = window.require('node:path');
const { writeFile, mkdir, mkdtemp, rm, rename, access, link, copyFile, constants: { W_OK } } = window.require('node:fs/promises');


export class OutputNotWritableError extends Error {
  constructor() {
    super();
    this.name = 'OutputNotWritableError';
  }
}

function formatTransitionSeconds(value: number) {
  return value.toFixed(6).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
}

async function writeChaptersFfmetadata(outDir: string, chapters: Chapter[] | undefined) {
  if (!chapters || chapters.length === 0) return undefined;

  const path = join(outDir, `ffmetadata-${Date.now()}.txt`);

  const ffmetadata = chapters.map(({ start, end, name }) => (
    `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.floor(start * 1000)}\nEND=${Math.floor(end * 1000)}\ntitle=${name || ''}`
  )).join('\n\n');
  console.log('Writing chapters', ffmetadata);
  await writeFile(path, ffmetadata);
  return path;
}

function getMovFlags({ preserveMovData, movFastStart }: { preserveMovData: boolean, movFastStart: boolean }) {
  const flags: string[] = [];

  // https://video.stackexchange.com/a/26084/29486
  // https://github.com/mifi/lossless-cut/issues/331#issuecomment-623401794
  if (preserveMovData) flags.push('use_metadata_tags');

  // https://github.com/mifi/lossless-cut/issues/347
  if (movFastStart) flags.push('+faststart');

  if (flags.length === 0) return [];
  return flags.flatMap((flag) => ['-movflags', flag]);
}

function getMatroskaFlags() {
  return [
    '-default_mode', 'infer_no_subs',
    // because it makes sense to not force subtitles disposition to "default" if they were not default in the input file
    // after some testing, it seems that default is actually "infer", contrary to what is documented (ffmpeg doc says "passthrough" is default)
    // https://ffmpeg.org/ffmpeg-formats.html#Options-8
    // https://github.com/mifi/lossless-cut/issues/972#issuecomment-1015176316
  ];
}

const getChaptersInputArgs = (ffmetadataPath: string | undefined) => (ffmetadataPath ? ['-f', 'ffmetadata', '-i', ffmetadataPath] : []);

async function tryDeleteFiles(paths: string[]) {
  return pMap(paths, (path) => unlinkWithRetry(path).catch((err) => console.error('Failed to delete', path, err)), { concurrency: 5 });
}

export async function maybeMkDeepOutDir({ outputDir, fileOutPath }: { outputDir: string, fileOutPath: string }) {
  // cutFileNames might contain slashes and therefore might have a subdir(tree) that we need to mkdir
  // https://github.com/mifi/lossless-cut/issues/1532
  const actualOutputDir = dirname(fileOutPath);
  if (actualOutputDir !== outputDir) await mkdir(actualOutputDir, { recursive: true });
}


function useFfmpegOperations({ filePath, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, isEncoding, lossyMode, enableOverwriteOutput, outputPlaybackRate, cutFromAdjustmentFrames, cutToAdjustmentFrames, appendLastCommandsLog, encCustomBitrate, appendFfmpegCommandLog, ffmpegHwaccel }: {
  filePath: string | undefined,
  treatInputFileModifiedTimeAsStart: boolean,
  treatOutputFileModifiedTimeAsStart: boolean | null | undefined,
  enableOverwriteOutput: boolean,
  isEncoding: boolean,
  lossyMode: LossyMode | undefined,
  outputPlaybackRate: number,
  cutFromAdjustmentFrames: number,
  cutToAdjustmentFrames: number,
  appendLastCommandsLog: (a: string) => void,
  encCustomBitrate: number | undefined,
  appendFfmpegCommandLog: (args: string[]) => void,
  ffmpegHwaccel: FfmpegHwAccel,
}) {
  const shouldSkipExistingFile = useCallback(async (path: string) => {
    const fileExists = await mainApi.pathExists(path);

    // If output file exists, check that it is writable, so we can inform user if it's not (or else ffmpeg will fail with "Permission denied")
    // this seems to sometimes happen on Windows, not sure why.
    if (fileExists) {
      try {
        await access(path, W_OK);
      } catch {
        throw new OutputNotWritableError();
      }
    }
    const shouldSkip = !enableOverwriteOutput && fileExists;
    if (shouldSkip) console.log('Not overwriting existing file', path);
    return shouldSkip;
  }, [enableOverwriteOutput]);

  const getOutputPlaybackRateArgs = useCallback(() => (outputPlaybackRate !== 1 ? ['-itsscale', String(1 / outputPlaybackRate)] : []), [outputPlaybackRate]);

  const concatFiles = useCallback(async ({ paths, plannedDurations, outDir, outPath, metadataFromPath, includeAllStreams, streams, outFormat, ffmpegExperimental, onProgress = () => undefined, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase }: {
    paths: string[],
    plannedDurations?: number[] | undefined,
    outDir: string | undefined,
    outPath: string,
    metadataFromPath: string,
    includeAllStreams: boolean,
    streams: FFprobeStream[],
    outFormat?: string | undefined,
    ffmpegExperimental: boolean,
    onProgress?: (a: number) => void,
    preserveMovData: boolean,
    movFastStart: boolean,
    chapters: Chapter[] | undefined,
    preserveMetadataOnMerge: boolean,
    videoTimebase?: number | undefined,
  }) => {
    if (await shouldSkipExistingFile(outPath)) return { haveExcludedStreams: false };

    console.log('Merging files', { paths }, 'to', outPath);

    if (plannedDurations != null && (plannedDurations.length !== paths.length || plannedDurations.some((duration) => !Number.isFinite(duration) || duration <= 0))) {
      throw new Error('Planned concat durations must match every input file');
    }
    const durations = plannedDurations ?? await pMap(paths, async (path) => (await getDuration(path)) ?? 0, { concurrency: 1 });
    const totalDuration = sum(durations);

    let chaptersPath: string | undefined;
    if (chapters) {
      const chaptersWithNames = chapters.map((chapter, i) => ({ ...chapter, name: chapter.name || `Chapter ${i + 1}` }));
      invariant(outDir != null);
      chaptersPath = await writeChaptersFfmetadata(outDir, chaptersWithNames);
    }

    try {
      let inputArgs: string[] = [];
      let inputIndex = 0;

      // Keep track of input index to be used later
      // eslint-disable-next-line no-inner-declarations
      function addInput(args: string[]) {
        inputArgs = [...inputArgs, ...args];
        const retIndex = inputIndex;
        inputIndex += 1;
        return retIndex;
      }

      // concat list - always first
      addInput([
        // https://blog.yo1.dog/fix-for-ffmpeg-protocol-not-on-whitelist-error-for-urls/
        '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd',
        '-i', '-',
      ]);

      let metadataSourceIndex: number | undefined;
      if (preserveMetadataOnMerge) {
        // If preserve metadata, add the first file (we will get metadata from this input)
        metadataSourceIndex = addInput(['-i', metadataFromPath]);
      }

      let chaptersInputIndex: number | undefined;
      if (chaptersPath) {
        // if chapters, add chapters source file
        chaptersInputIndex = addInput(getChaptersInputArgs(chaptersPath));
      }

      const { streamIdsToCopy, excludedStreamIds } = getStreamIdsToCopy({ streams, includeAllStreams });
      const mapStreamsArgs = getMapStreamsArgs({
        allFilesMeta: { [metadataFromPath]: { streams } },
        copyFileStreams: [{ path: metadataFromPath, streamIds: streamIdsToCopy }],
        outFormat,
        manuallyCopyDisposition: true,
        needFlac: true, // https://github.com/mifi/lossless-cut/issues/2636
      });

      // Keep this similar to losslessCutSingle()
      const ffmpegArgs = [
        '-hide_banner',
        // No progress if we set loglevel warning :(
        // '-loglevel', 'warning',

        ...inputArgs,

        ...mapStreamsArgs,

        // -map_metadata 0 with concat demuxer doesn't transfer metadata from the concat'ed file input (index 0) when merging.
        // So we use the first file file (index 1) for metadata
        // Can only do this if allStreams (-map 0) is set
        ...(metadataSourceIndex != null ? ['-map_metadata', String(metadataSourceIndex)] : []),

        ...(chaptersInputIndex != null ? ['-map_chapters', String(chaptersInputIndex)] : []),

        ...getMovFlags({ preserveMovData, movFastStart }),
        ...getMatroskaFlags(),

        // See https://github.com/mifi/lossless-cut/issues/170
        '-ignore_unknown',

        ...getExperimentalArgs(ffmpegExperimental),

        ...getVideoTimescaleArgs(videoTimebase),

        ...(outFormat ? ['-f', outFormat] : []),
        '-y', outPath,
      ];

      // https://superuser.com/questions/787064/filename-quoting-in-ffmpeg-concat
      // Must add "file:" or we get "Impossible to open 'pipe:xyz.mp4'" on newer ffmpeg versions
      // https://superuser.com/questions/718027/ffmpeg-concat-doesnt-work-with-absolute-path
      const concatTxt = plannedDurations == null
        ? paths.map((file) => `file 'file:${resolve(file).replaceAll('\'', String.raw`'\''`)}'`).join('\n')
        : buildSourcePreservingConcatManifest({ paths: paths.map((file) => resolve(file)), durations });

      const ffmpegCommandLine = getFfCommandLine('ffmpeg', ffmpegArgs);

      const fullCommandLine = `echo -e "${concatTxt.replaceAll('\n', String.raw`\n`)}" | ${ffmpegCommandLine}`;
      console.log(fullCommandLine);
      appendLastCommandsLog(fullCommandLine);

      const result = await runFfmpegConcat({ ffmpegArgs, concatTxt, totalDuration, onProgress });
      logStdoutStderr(result);

      await transferTimestamps({ inPath: metadataFromPath, outPath, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, duration: totalDuration });

      return { haveExcludedStreams: excludedStreamIds.length > 0 };
    } finally {
      if (chaptersPath) await tryDeleteFiles([chaptersPath]);
    }
  }, [appendLastCommandsLog, shouldSkipExistingFile, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  const losslessCutSingle = useCallback(async ({
    keyframeCut: ssBeforeInput, avoidNegativeTs, copyFileStreams, cutFrom, cutTo, chaptersPath, onProgress, outPath,
    fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, videoTimebase, detectedFps,
  }: {
    keyframeCut: boolean,
    avoidNegativeTs: AvoidNegativeTs | undefined,
    copyFileStreams: CopyfileStreams,
    cutFrom: number,
    cutTo: number,
    chaptersPath: string | undefined,
    onProgress: (p: number) => void,
    outPath: string,
    fileDuration: number | undefined,
    rotation: number | undefined,
    allFilesMeta: AllFilesMeta,
    outFormat: string,
    shortestFlag: boolean,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    preserveChapters: boolean,
    movFastStart: boolean,
    paramsByFile: ParamsByFile,
    videoTimebase?: number | undefined,
    detectedFps?: number,
  }) => {
    const frameDuration = getFrameDuration(detectedFps);

    const cuttingStart = isCuttingStart(cutFrom);
    const cutFromWithAdjustment = cutFrom + cutFromAdjustmentFrames * frameDuration;
    const cutToWithAdjustment = cutTo + cutToAdjustmentFrames * frameDuration;
    const cuttingEnd = isCuttingEnd(cutTo, fileDuration);
    const areWeCutting = cuttingStart || cuttingEnd;
    if (areWeCutting) console.log('Cutting from', cuttingStart ? `${cutFrom} (${cutFromWithAdjustment} adjusted ${cutFromAdjustmentFrames} frames)` : 'start', 'to', cuttingEnd ? `${cutTo} (adjusted ${cutToAdjustmentFrames} frames)` : 'end');

    let cutDuration = cutToWithAdjustment - cutFromWithAdjustment;
    if (detectedFps != null) cutDuration = Math.max(cutDuration, frameDuration); // ensure at least one frame duration

    // Don't cut if not needed: https://github.com/mifi/lossless-cut/issues/50
    const cutFromArgs = cuttingStart ? ['-ss', formatFfmpegNumber(cutFromWithAdjustment)] : [];
    const cutToArgs = areWeCutting && Number.isFinite(cutDuration) && cutDuration > 0 ? ['-t', formatFfmpegNumber(cutDuration)] : [];

    const copyFileStreamsFiltered = copyFileStreams.filter(({ streamIds }) => streamIds.length > 0);

    // remove -avoid_negative_ts make_zero when not cutting start (no -ss), or else some videos get blank first frame in QuickLook
    const avoidNegativeTsArgs = cuttingStart && avoidNegativeTs && ssBeforeInput ? ['-avoid_negative_ts', String(avoidNegativeTs)] : [];

    // Keep output seek/duration after every input; before another `-i`, ffmpeg treats them as input options.
    const inputFilesArgs = copyFileStreamsFiltered.length > 1
      ? copyFileStreamsFiltered.flatMap(({ streamIds, path }) => {
        const fileParams = paramsByFile.get(path);
        // Don't cut/seek cover art or images attached by users - it will break them, see https://github.com/mifi/lossless-cut/issues/2884
        const streamParams = streamIds.map((streamId) => fileParams?.paramsByStream.get(streamId));
        if (streamIds.length === 1 && streamParams[0]?.disposition === 'attached_pic') {
          return ['-i', path];
        }

        const itsOffsetArgs = fileParams?.offset ? ['-itsoffset', formatFfmpegNumber(fileParams.offset)] : [];

        return [
          ...(ssBeforeInput ? cutFromArgs : []),
          ...itsOffsetArgs,
          '-i', path,
        ];
      })
      : [
        ...(ssBeforeInput ? cutFromArgs : []),
        '-i', copyFileStreamsFiltered[0]!.path,
      ];

    const chaptersInputIndex = copyFileStreamsFiltered.length;

    const rotationArgs = rotation !== undefined ? ['-display_rotation:v:0', String(360 - rotation)] : [];

    // This function tries to calculate the output stream index needed for -metadata:s:x and -disposition:x arguments
    // It is based on the assumption that copyFileStreamsFiltered contains the order of the input files (and their respective streams orders) sent to ffmpeg, to hopefully calculate the same output stream index values that ffmpeg does internally.
    // It also takes into account previously added files that have been removed and disabled streams.
    function mapInputStreamIndexToOutputIndex(inputFilePath: string, inputFileStreamIndex: number) {
      let streamCount = 0;
      // Count copied streams of all files until this input file
      const foundFile = copyFileStreamsFiltered.find(({ path: path2, streamIds }) => {
        if (path2 === inputFilePath) return true;
        streamCount += streamIds.length;
        return false;
      });
      if (!foundFile) return undefined; // Could happen if a tag has been edited on an external file, then the file was removed

      // Then add the index of the current stream index to the count
      const copiedStreamIndex = foundFile.streamIds.indexOf(inputFileStreamIndex);
      if (copiedStreamIndex === -1) return undefined; // Could happen if a tag has been edited on a stream, but the stream is disabled
      return streamCount + copiedStreamIndex;
    }

    invariant(filePath != null);

    const customFileMetadataArgs = Object.entries(paramsByFile.get(filePath)?.metadata ?? {}).flatMap(([key, value]) => [
      '-metadata', `${key}=${value}`,
    ]);

    const mapStreamsArgs = getMapStreamsArgs({ copyFileStreams: copyFileStreamsFiltered, allFilesMeta, outFormat, needFlac: areWeCutting });

    const customParamsArgs = (() => {
      const ret: string[] = [];
      for (const [fileId, { paramsByStream }] of paramsByFile.entries()) {
        for (const [streamId, streamParams] of paramsByStream.entries()) {
          const outputIndex = mapInputStreamIndexToOutputIndex(fileId, streamId);
          if (outputIndex != null) {
            const { disposition } = streamParams;
            if (disposition != null) {
              // "0" means delete the disposition for this stream
              const dispositionArg = disposition === deleteDispositionValue ? '0' : disposition;
              ret.push(`-disposition:${outputIndex}`, String(dispositionArg));
            }

            const bitstreamFilters: string[] = [];
            if (streamParams.bsfH264Mp4toannexb) bitstreamFilters.push('h264_mp4toannexb');
            if (streamParams.bsfHevcMp4toannexb) bitstreamFilters.push('hevc_mp4toannexb');
            if (streamParams.bsfHevcAudInsert) bitstreamFilters.push('hevc_metadata=aud=insert');

            const getFileStreams = () => allFilesMeta[fileId]?.streams;
            const getStream = () => getFileStreams()?.find((s) => s.index === streamId);

            // Lossless crop via codec bitstream metadata (#643)
            if (streamParams.crop) {
              const { left, right, top, bottom } = streamParams.crop;
              if (left > 0 || right > 0 || top > 0 || bottom > 0) {
                // Look up codec_name from allFilesMeta to determine the correct bitstream filter
                const streamInfo = getStream();
                const codecName = streamInfo?.codec_name;

                const cropParams = `crop_left=${left}:crop_right=${right}:crop_top=${top}:crop_bottom=${bottom}`;
                if (codecName === 'h264') {
                  bitstreamFilters.push(`h264_metadata=${cropParams}`);
                } else if (codecName === 'hevc') {
                  bitstreamFilters.push(`hevc_metadata=${cropParams}`);
                }
              }
            }

            // Lossless aspect ratio (SAR) via codec bitstream metadata (#643)
            if (streamParams.aspectRatio) {
              const { num, den } = streamParams.aspectRatio;
              if (num > 0 && den > 0) {
                const streamInfo = getStream();
                const codecName = streamInfo?.codec_name;

                if (codecName === 'h264') {
                  bitstreamFilters.push(`h264_metadata=sample_aspect_ratio=${num}/${den}`);
                } else if (codecName === 'hevc') {
                  bitstreamFilters.push(`hevc_metadata=sample_aspect_ratio=${num}/${den}`);
                } else {
                  // For non-H264/HEVC codecs, use container-level -aspect flag
                  ret.push('-aspect', `${num}:${den}`);
                }
              }
            }

            if (bitstreamFilters.length > 0) {
              ret.push(`-bsf:${outputIndex}`, bitstreamFilters.join(','));
            }

            if (streamParams.tag != null) {
              ret.push(`-tag:${outputIndex}`, streamParams.tag);
            }

            // custom stream metadata
            if (streamParams.metadata != null) {
              for (const [tag, value] of Object.entries(streamParams.metadata)) {
                ret.push(`-metadata:s:${outputIndex}`, `${tag}=${value}`);
              }
            }
          }
        }
      }
      return ret;
    })();

    function getPreserveMetadata() {
      if (preserveMetadata === 'default') return ['-map_metadata', '0']; // todo isn't this ffmpeg default and can be omitted? https://stackoverflow.com/a/67508734/6519037
      if (preserveMetadata === 'none') return ['-map_metadata', '-1'];
      if (preserveMetadata === 'nonglobal') return ['-map_metadata:g', '-1']; // https://superuser.com/a/1546267/658247
      return [];
    }

    function getPreserveChapters() {
      if (chaptersPath) return ['-map_chapters', String(chaptersInputIndex)];
      // todo should preserve chapters be hardcoded (and disabled in UI) when segmentsToChaptersOnly mode is enabled?
      if (!preserveChapters) return ['-map_chapters', '-1']; // https://github.com/mifi/lossless-cut/issues/2176
      return []; // default: includes chapters from input
    }

    const ffmpegArgs = [
      '-hide_banner',
      // No progress if we set loglevel warning :(
      // '-loglevel', 'warning',

      ...getOutputPlaybackRateArgs(),

      ...rotationArgs,

      ...inputFilesArgs,
      ...getChaptersInputArgs(chaptersPath),

      ...(!ssBeforeInput ? cutFromArgs : []),
      ...cutToArgs,

      ...avoidNegativeTsArgs,

      ...mapStreamsArgs,

      ...getPreserveMetadata(),

      ...getPreserveChapters(),

      ...(shortestFlag ? ['-shortest'] : []),

      ...getMovFlags({ preserveMovData, movFastStart }),
      ...getMatroskaFlags(),

      ...customFileMetadataArgs,

      ...customParamsArgs,

      // See https://github.com/mifi/lossless-cut/issues/170
      '-ignore_unknown',

      ...getExperimentalArgs(ffmpegExperimental),

      ...getVideoTimescaleArgs(videoTimebase),

      '-f', outFormat, '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration: cutDuration, onProgress });
    logStdoutStderr(result);

    await transferTimestamps({ inPath: filePath, outPath, cutFrom, cutTo, treatInputFileModifiedTimeAsStart, duration: isDurationValid(fileDuration) ? fileDuration : undefined, treatOutputFileModifiedTimeAsStart });
  }, [appendFfmpegCommandLog, cutFromAdjustmentFrames, cutToAdjustmentFrames, filePath, getOutputPlaybackRateArgs, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  // inspired by https://gist.github.com/fernandoherreradelasheras/5eca67f4200f1a7cc8281747da08496e
  const cutEncodeSmartPart = useCallback(async ({ cutFrom, cutTo, outPath, outFormat, videoCodec, videoBitrate, videoTimebase, allFilesMeta, copyFileStreams, videoStreamIndex, sourceVideoStream, ffmpegExperimental, hasBFrames, forceClosedGop = false, fadeInDuration, fadeOutDuration, lastFrameOffset }: {
    cutFrom: number,
    cutTo: number,
    outPath: string,
    outFormat: string,
    videoCodec: string,
    videoBitrate: number,
    videoTimebase: number,
    allFilesMeta: AllFilesMeta,
    copyFileStreams: CopyfileStreams,
    videoStreamIndex: number,
    sourceVideoStream?: LiteFFprobeStream | undefined,
    ffmpegExperimental: boolean,
    hasBFrames: number | undefined,
    forceClosedGop?: boolean | undefined,
    fadeInDuration?: number | undefined,
    fadeOutDuration?: number | undefined,
    lastFrameOffset?: number | undefined,
  }) => {
    invariant(filePath != null);
    if (((fadeInDuration ?? 0) > 0 || (fadeOutDuration ?? 0) > 0) && !forceClosedGop) {
      throw new Error('Source-preserving fade effects require a closed GOP boundary encode');
    }

    function getVideoArgs({ streamIndex, outputIndex }: { streamIndex: number, outputIndex: number }) {
      if (streamIndex !== videoStreamIndex) return undefined;

      const args = [
        `-c:${outputIndex}`, videoCodec,
        `-b:${outputIndex}`, String(videoBitrate),
      ];

      if (forceClosedGop) {
        args.push(`-filter:${outputIndex}`, buildSourcePreservingVideoFilter({
          duration: cutTo - cutFrom,
          ...(fadeInDuration != null ? { fadeInDuration } : {}),
          ...(fadeOutDuration != null ? { fadeOutDuration } : {}),
          ...(lastFrameOffset != null ? { lastFrameOffset } : {}),
        }));

        if (sourceVideoStream?.pix_fmt != null) args.push(`-pix_fmt:${outputIndex}`, sourceVideoStream.pix_fmt);
        const x264Profile = ({
          'Constrained Baseline': 'baseline',
          Baseline: 'baseline',
          Main: 'main',
          High: 'high',
          'High 10': 'high10',
          'High 4:2:2': 'high422',
          'High 4:4:4 Predictive': 'high444',
        } as Record<string, string>)[sourceVideoStream?.profile ?? ''];
        if (videoCodec === 'libx264' && x264Profile != null) args.push(`-profile:${outputIndex}`, x264Profile);

        const colorArgs = [
          ['color_range', sourceVideoStream?.color_range],
          ['colorspace', sourceVideoStream?.color_space],
          ['color_trc', sourceVideoStream?.color_transfer],
          ['color_primaries', sourceVideoStream?.color_primaries],
          ['chroma_sample_location', sourceVideoStream?.chroma_location],
        ] as const;
        colorArgs.forEach(([option, value]) => {
          if (value != null && value !== 'unknown') args.push(`-${option}:${outputIndex}`, value);
        });
      }

      // seems like ffmpeg handles this itself well when encoding same source file
      // if (videoLevel != null) args.push(`-level:${outputIndex}`, videoLevel);
      // if (videoProfile != null) args.push(`-profile:${outputIndex}`, videoProfile);

      return args;
    }

    const mapStreamsArgs = getMapStreamsArgs({
      allFilesMeta,
      copyFileStreams,
      outFormat,
      getVideoArgs,
    });

    const seekPreroll = 10;
    const fastSeekFrom = Math.max(0, cutFrom - seekPreroll);
    const preciseSeekFrom = cutFrom - fastSeekFrom;

    const ffmpegArgs = [
      '-hide_banner',
      // No progress if we set loglevel warning :(
      // '-loglevel', 'warning',

      ...(forceClosedGop ? ['-noautorotate'] : []),
      ...(forceClosedGop
        ? (cutFrom > 0 ? ['-ss', formatFfmpegNumber(cutFrom)] : [])
        : (fastSeekFrom > 0 ? ['-ss', formatFfmpegNumber(fastSeekFrom)] : [])),
      '-i', filePath,
      ...(!forceClosedGop && preciseSeekFrom > 0 ? ['-ss', formatFfmpegNumber(preciseSeekFrom)] : []),
      '-t', formatFfmpegNumber(cutTo - cutFrom),

      ...mapStreamsArgs,

      // See https://github.com/mifi/lossless-cut/issues/170
      '-ignore_unknown',

      ...getVideoTimescaleArgs(videoTimebase),

      ...(forceClosedGop && ['libx264', 'libx265', 'h264_videotoolbox', 'hevc_videotoolbox'].includes(videoCodec)
        ? ['-bf', String(getSourcePreservingBoundaryBFrames(hasBFrames))]
        : (!forceClosedGop && hasBFrames ? ['-bf', String(hasBFrames)] : [])),

      ...getExperimentalArgs(ffmpegExperimental),

      '-f', outFormat, '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    await runFfmpeg(ffmpegArgs);
  }, [appendFfmpegCommandLog, filePath]);

  const cutCopySourceVideoPart = useCallback(async ({
    cutFrom,
    cutTo,
    outPath,
    outFormat,
    videoStreamIndex,
    videoTimebase,
    ffmpegExperimental,
    onProgress,
  }: {
    cutFrom: number,
    cutTo: number,
    outPath: string,
    outFormat: string,
    videoStreamIndex: number,
    videoTimebase: number | undefined,
    ffmpegExperimental: boolean,
    onProgress: (progress: number) => void,
  }) => {
    invariant(filePath != null);
    const duration = cutTo - cutFrom;
    const formattedDuration = formatFfmpegNumber(duration);
    const ffmpegArgs = [
      '-hide_banner',
      ...(cutFrom > 0 ? ['-ss', formatFfmpegNumber(cutFrom)] : []),
      '-i', filePath,
      '-t', formattedDuration,
      '-map', `0:${videoStreamIndex}`,
      '-c:v', 'copy',
      // Input seeking may retain B-frame packets whose PTS belongs after the
      // half-open end. Drop only those packets; every retained payload stays
      // byte-for-byte original.
      '-bsf:v:0', `noise=drop='lt(pts*tb,0)+gte(pts*tb,${formattedDuration})'`,
      '-an', '-sn', '-dn',
      '-ignore_unknown',
      ...getVideoTimescaleArgs(videoTimebase),
      ...getExperimentalArgs(ffmpegExperimental),
      '-f', outFormat, '-y', outPath,
    ];
    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });
    logStdoutStderr(result);
  }, [appendFfmpegCommandLog, filePath]);

  const isSafeH264Idr = useCallback(async ({
    keyframeTime,
    sourceStartTime,
    videoStreamIndex,
  }: {
    keyframeTime: number,
    sourceStartTime: number,
    videoStreamIndex: number,
  }) => {
    invariant(filePath != null);
    const ffmpegArgs = [
      '-v', 'error',
      ...(keyframeTime > sourceStartTime ? ['-ss', formatFfmpegNumber(keyframeTime - sourceStartTime)] : []),
      '-i', filePath,
      '-map', `0:${videoStreamIndex}`,
      '-frames:v', '1',
      '-c:v', 'copy',
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'h264', 'pipe:1',
    ];
    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpeg(ffmpegArgs);
    return containsH264IdrAccessUnit(stdout);
  }, [appendFfmpegCommandLog, filePath]);

  const encodeSourceAudioSpans = useCallback(async ({
    spans,
    audioStreams,
    outPath,
    outFormat,
    ffmpegExperimental,
    onProgress,
  }: {
    spans: { start: number, end: number }[],
    audioStreams: LiteFFprobeStream[],
    outPath: string,
    outFormat: string,
    ffmpegExperimental: boolean,
    onProgress: (progress: number) => void,
  }) => {
    invariant(filePath != null);
    if (spans.length === 0 || audioStreams.length === 0) throw new Error('Audio export requires spans and source audio streams');

    const getEncoder = (codecName: string) => ({
      aac: 'aac',
      mp3: 'libmp3lame',
      opus: 'libopus',
      vorbis: 'libvorbis',
      flac: 'flac',
      alac: 'alac',
      ac3: 'ac3',
      eac3: 'eac3',
    })[codecName] ?? (codecName.startsWith('pcm_') ? codecName : undefined);
    const encoders = audioStreams.map(({ codec_name: codecName }) => getEncoder(codecName));
    if (encoders.some((encoder) => encoder == null)) {
      throw new UserFacingError(i18n.t('The source audio codec cannot be preserved during precise export.'));
    }

    const inputArgs = spans.flatMap(({ start, end }) => [
      ...(start > 0 ? ['-ss', formatFfmpegNumber(start)] : []),
      '-t', formatFfmpegNumber(end - start),
      '-i', filePath,
    ]);
    const filterChains: string[] = [];
    const outputLabels: string[] = [];
    audioStreams.forEach((stream, audioIndex) => {
      const partLabels = spans.map(({ start, end }, spanIndex) => {
        const label = `a${audioIndex}_${spanIndex}`;
        const duration = formatFfmpegNumber(end - start);
        // Accurate input seeking keeps a positive first PTS when this track
        // starts later than the selected video timeline. first_pts=0 fills
        // that leading gap with silence; apad does the same for a short/ended
        // track. Only then is the planned span normalized for concat.
        filterChains.push(`[${spanIndex}:${stream.index}]atrim=duration=${duration},aresample=async=0:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration},asetpts=PTS-STARTPTS[${label}]`);
        return `[${label}]`;
      });
      const outputLabel = `aout${audioIndex}`;
      filterChains.push(`${partLabels.join('')}concat=n=${spans.length}:v=0:a=1[${outputLabel}]`);
      outputLabels.push(`[${outputLabel}]`);
    });

    const codecArgs = audioStreams.flatMap((stream, audioIndex) => {
      const args = [`-c:a:${audioIndex}`, encoders[audioIndex]!];
      const bitrate = Number.parseInt(stream.bit_rate ?? '', 10);
      if (Number.isFinite(bitrate) && !stream.codec_name.startsWith('pcm_') && !['flac', 'alac'].includes(stream.codec_name)) {
        args.push(`-b:a:${audioIndex}`, String(bitrate));
      }
      const sampleRate = Number.parseInt(stream.sample_rate ?? '', 10);
      if (Number.isFinite(sampleRate)) args.push(`-ar:a:${audioIndex}`, String(sampleRate));
      if (stream.channels != null) args.push(`-ac:a:${audioIndex}`, String(stream.channels));
      return args;
    });
    const duration = sum(spans.map(({ start, end }) => end - start));
    const streamMetadataArgs = audioStreams.flatMap((stream, audioIndex) => {
      const disposition = getActiveDisposition(stream.disposition);
      return [
        `-map_metadata:s:a:${audioIndex}`, `0:s:${stream.index}`,
        ...(disposition != null ? [`-disposition:a:${audioIndex}`, disposition] : []),
      ];
    });
    const ffmpegArgs = [
      '-hide_banner',
      ...inputArgs,
      '-filter_complex', filterChains.join(';'),
      ...outputLabels.flatMap((label) => ['-map', label]),
      ...codecArgs,
      '-map_metadata', '0',
      ...streamMetadataArgs,
      '-map_chapters', '-1',
      '-t', formatFfmpegNumber(duration),
      '-vn', '-sn', '-dn',
      ...getExperimentalArgs(ffmpegExperimental),
      '-f', outFormat, '-y', outPath,
    ];
    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });
    logStdoutStderr(result);
  }, [appendFfmpegCommandLog, filePath]);

  const muxSourcePreservingStreams = useCallback(async ({
    videoPath,
    audioPath,
    outPath,
    outFormat,
    duration,
    videoTimebase,
    ffmpegExperimental,
    preserveMetadata,
    preserveMovData,
    movFastStart,
    onProgress,
  }: {
    videoPath: string,
    audioPath?: string | undefined,
    outPath: string,
    outFormat: string,
    duration: number,
    videoTimebase: number | undefined,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    movFastStart: boolean,
    onProgress: (progress: number) => void,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',
      '-i', videoPath,
      ...(audioPath != null ? ['-i', audioPath] : []),
      '-map', '0:v:0', '-c:v', 'copy',
      ...(audioPath != null ? ['-map', '1:a', '-c:a', 'copy'] : []),
      ...(preserveMetadata === 'none' ? ['-map_metadata', '-1'] : ['-map_metadata', '0']),
      '-map_chapters', '-1',
      '-t', formatFfmpegNumber(duration),
      ...getMovFlags({ preserveMovData, movFastStart }),
      ...getMatroskaFlags(),
      ...getVideoTimescaleArgs(videoTimebase),
      ...getExperimentalArgs(ffmpegExperimental),
      '-f', outFormat, '-y', outPath,
    ];
    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });
    logStdoutStderr(result);
  }, [appendFfmpegCommandLog]);

  const cutMultiple = useCallback(async ({
    outputDir, customOutDir, segments: segmentsIn, cutFileNames, fileDuration, rotation, detectedFps, onProgress: onTotalProgress, keyframeCut, copyFileStreams, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMetadataOnMerge, preserveMovData, preserveChapters, movFastStart, avoidNegativeTs, paramsByFile, chapters,
  }: {
    outputDir: string,
    customOutDir: string | undefined,
    segments: SegmentToExport[],
    cutFileNames: string[],
    fileDuration: number | undefined,
    rotation: number | undefined,
    detectedFps: number | undefined,
    onProgress: (p: number) => void,
    keyframeCut: boolean,
    copyFileStreams: CopyfileStreams,
    allFilesMeta: AllFilesMeta,
    outFormat: string | undefined,
    shortestFlag: boolean,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    preserveMetadataOnMerge: boolean,
    preserveChapters: boolean,
    movFastStart: boolean,
    avoidNegativeTs: AvoidNegativeTs | undefined,
    paramsByFile: ParamsByFile,
    chapters: Chapter[] | undefined,
  }) => {
    console.log('paramsByFile', paramsByFile);

    const segments = getGuaranteedSegments(segmentsIn, fileDuration);

    const singleProgresses: Record<number, number> = {};
    function onSingleProgress(id: number, singleProgress: number) {
      singleProgresses[id] = singleProgress;
      return onTotalProgress((sum(Object.values(singleProgresses)) / segments.length));
    }

    invariant(filePath != null);
    await assertFileExists(filePath);

    const chaptersPath = await writeChaptersFfmetadata(outputDir, chapters);

    // This function will either call losslessCutSingle (if no smart cut enabled)
    // or if enabled, will first cut&encode the part before the next keyframe, trying to match the input file's codec params
    // then it will cut the part *from* the keyframe to "end", and concat them together and return the concated file
    // so that for the calling code it looks as if it's just a normal segment
    const cutSegment = async ({ start: desiredCutFrom, end: cutTo }: { start: number, end: number }, i: number) => {
      const onProgress = (progress: number) => onSingleProgress(i, progress / 2);
      const onConcatProgress = (progress: number) => onSingleProgress(i, (1 + progress) / 2);

      const finalOutPath = join(outputDir, cutFileNames[i]!);

      if (await shouldSkipExistingFile(finalOutPath)) return { path: finalOutPath, created: false };

      await maybeMkDeepOutDir({ outputDir, fileOutPath: finalOutPath });

      const shouldEncodeSegment = isEncoding;

      const cutLosslessPart = async () => {
        invariant(outFormat != null);
        await losslessCutSingle({
          cutFrom: desiredCutFrom, cutTo, chaptersPath, outPath: finalOutPath, copyFileStreams, keyframeCut, avoidNegativeTs, fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, onProgress: (progress) => onSingleProgress(i, progress),
        });
        return { path: finalOutPath, created: true };
      };

      if (!shouldEncodeSegment) {
        // simple lossless cut
        return cutLosslessPart();
      }

      // smart cut only supports cutting main file (no externally added files)
      const { streams } = allFilesMeta[filePath]!;
      const streamsToCopyFromMainFile = copyFileStreams.find(({ path }) => path === filePath)!.streamIds
        .flatMap((streamId) => {
          const match = streams.find((stream) => stream.index === streamId);
          return match ? [match] : [];
        });

      const sourceCodecParams = await getCodecParams({ path: filePath, fileDuration, streams: streamsToCopyFromMainFile });
      const { videoStream, videoTimebase } = sourceCodecParams;

      const videoCodec = lossyMode ? lossyMode.videoEncoder : sourceCodecParams.videoCodec;

      const copyFileStreamsFiltered = [{
        path: filePath,
        // with smart cut, we only copy/cut *one* video stream, and *all* other non-video streams (main file only)
        streamIds: streamsToCopyFromMainFile.filter((stream) => stream.index === videoStream.index || stream.codec_type !== 'video').map((stream) => stream.index),
      }];

      const cutEncodeSmartPartWrapper = async ({ cutFrom: encodeCutFrom, cutTo: encodeCutTo, outPath }: { cutFrom: number, cutTo: number, outPath: string }) => {
        if (await shouldSkipExistingFile(outPath)) return;
        invariant(videoCodec != null);
        invariant(sourceCodecParams.videoBitrate != null);
        invariant(sourceCodecParams.videoTimebase != null);
        invariant(filePath != null);
        invariant(outFormat != null);
        await cutEncodeSmartPart({ cutFrom: encodeCutFrom, cutTo: encodeCutTo, outPath, outFormat, videoCodec, videoBitrate: encCustomBitrate != null ? encCustomBitrate * 1000 : sourceCodecParams.videoBitrate, videoStreamIndex: videoStream.index, videoTimebase: sourceCodecParams.videoTimebase, allFilesMeta, copyFileStreams: copyFileStreamsFiltered, ffmpegExperimental, hasBFrames: sourceCodecParams.videoStream.has_b_frames });
      };

      const cutEncodeWholePart = async () => {
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo, outPath: finalOutPath });
        return { path: finalOutPath, created: true };
      };
      if (lossyMode) {
        console.log('Lossy mode: cutting/encoding the whole segment', { desiredCutFrom, cutTo });
        return cutEncodeWholePart();
      }

      const { losslessCutFrom, segmentNeedsSmartCut } = await needsSmartCut({ path: filePath, desiredCutFrom, videoStream });
      if (segmentNeedsSmartCut && !detectedFps) throw new UserFacingError(i18n.t('Smart cut is not possible when FPS is unknown'));
      console.log('Smart cut on video stream', videoStream.index);

      // If we are cutting within two keyframes, just encode the whole part and return that
      // See https://github.com/mifi/lossless-cut/pull/1267#issuecomment-1236381740
      if (segmentNeedsSmartCut && losslessCutFrom > cutTo) {
        console.log('Segment is between two keyframes, cutting/encoding the whole segment', { desiredCutFrom, losslessCutFrom, cutTo });
        return cutEncodeWholePart();
      }

      invariant(outFormat != null);

      const ext = getOutFileExtension({ isCustomFormatSelected: true, outFormat, filePath });

      if (segmentNeedsSmartCut) {
        console.log('Cutting/encoding lossless part', { from: losslessCutFrom, to: cutTo });
      }

      const losslessPartOutPath = segmentNeedsSmartCut
        ? getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `smartcut-segment-copy-${i}${ext}` })
        : finalOutPath;

      // Keep smart-cut temp files structurally simple. Chapters/faststart/metadata
      // are applied to the final segment after concat; adding them to only one
      // temp file can make concat see mismatched streams and force slow fallback.
      await losslessCutSingle({
        cutFrom: losslessCutFrom,
        cutTo,
        chaptersPath: segmentNeedsSmartCut ? undefined : chaptersPath,
        outPath: losslessPartOutPath,
        copyFileStreams: copyFileStreamsFiltered,
        keyframeCut: true,
        avoidNegativeTs: undefined,
        fileDuration,
        rotation,
        allFilesMeta,
        outFormat,
        shortestFlag,
        ffmpegExperimental,
        preserveMetadata: segmentNeedsSmartCut ? 'none' : preserveMetadata,
        preserveMovData: segmentNeedsSmartCut ? false : preserveMovData,
        preserveChapters: segmentNeedsSmartCut ? false : preserveChapters,
        movFastStart: segmentNeedsSmartCut ? false : movFastStart,
        paramsByFile,
        videoTimebase,
        onProgress,
      });

      // We don't need to concat, just return the single cut file (we may need smart cut in other segments though)
      if (!segmentNeedsSmartCut) return { path: finalOutPath, created: true };

      // We need to concat

      const smartCutEncodedPartOutPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `smartcut-segment-encode-${i}${ext}` });
      const smartCutSegmentsToConcat = [smartCutEncodedPartOutPath, losslessPartOutPath];

      try {
        // Both parts are half-open. The encoded prefix ends exactly where the
        // copied keyframe tail begins; subtracting one frame loses content.
        console.log('Cutting/encoding smart part', { from: desiredCutFrom, to: losslessCutFrom });
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo: losslessCutFrom, outPath: smartCutEncodedPartOutPath });

        // The concat demuxer's stream layout follows the first file in the list.
        // Use the encoded prefix for mapping, otherwise metadata/chapters in the
        // copied tail can make us map streams that do not exist in concat input 0.
        const { streams: streamsAfterCut } = await readFileFfprobeMeta(smartCutEncodedPartOutPath);

        await concatFiles({ paths: smartCutSegmentsToConcat, plannedDurations: [losslessCutFrom - desiredCutFrom, cutTo - losslessCutFrom], outDir: outputDir, outPath: finalOutPath, metadataFromPath: smartCutEncodedPartOutPath, outFormat, includeAllStreams: true, streams: streamsAfterCut, ffmpegExperimental, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase, onProgress: onConcatProgress });
        return { path: finalOutPath, created: true };
      } finally {
        await tryDeleteFiles(smartCutSegmentsToConcat);
      }
    };

    try {
      return await pMap(segments, cutSegment, { concurrency: 1 });
    } finally {
      if (chaptersPath) await tryDeleteFiles([chaptersPath]);
    }
  }, [shouldSkipExistingFile, isEncoding, filePath, lossyMode, losslessCutSingle, cutEncodeSmartPart, encCustomBitrate, concatFiles]);

  const concatCutSegments = useCallback(async ({ customOutDir, outFormat, segmentPaths, plannedDurations, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapterNames, preserveMetadataOnMerge, mergedOutFilePath }: {
    customOutDir: string | undefined,
    outFormat: string | undefined,
    segmentPaths: string[],
    plannedDurations?: number[] | undefined,
    ffmpegExperimental: boolean,
    onProgress: (p: number) => void,
    preserveMovData: boolean,
    movFastStart: boolean,
    chapterNames: (string | undefined)[] | undefined,
    preserveMetadataOnMerge: boolean,
    mergedOutFilePath: string,
  }) => {
    const outDir = getOutDir(customOutDir, filePath);

    if (await shouldSkipExistingFile(mergedOutFilePath)) return { created: false };

    const chapters = await createChaptersFromSegments({ paths: segmentPaths, defaultChapterNames: chapterNames });

    const metadataFromPath = segmentPaths[0];
    invariant(metadataFromPath != null);
    // need to re-read streams because may have changed
    const { streams } = await readFileFfprobeMeta(metadataFromPath);
    await concatFiles({ paths: segmentPaths, plannedDurations, outDir, outPath: mergedOutFilePath, metadataFromPath, outFormat, includeAllStreams: true, streams, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge });
    return { created: true };
  }, [concatFiles, filePath, shouldSkipExistingFile]);

  const exportSourcePreservingSegments = useCallback(async ({
    intent,
    outputDir,
    segments,
    separateOutPaths,
    mergedOutPath,
    copyFileStreams,
    allFilesMeta,
    outFormat,
    fileDuration,
    detectedFps,
    ffmpegExperimental,
    preserveMetadata,
    preserveMovData,
    movFastStart,
    mergeTransition,
    onProgress,
  }: {
    intent: SegmentExportIntent,
    outputDir: string,
    segments: SegmentToExport[],
    separateOutPaths?: string[] | undefined,
    mergedOutPath?: string | undefined,
    copyFileStreams: CopyfileStreams,
    allFilesMeta: AllFilesMeta,
    outFormat: string,
    fileDuration: number | undefined,
    detectedFps: number | undefined,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    movFastStart: boolean,
    mergeTransition: MergeTransitionSnapshot,
    onProgress: (progress: number) => void,
  }) => {
    invariant(filePath != null);
    const progressReporter = createMonotonicProgressReporter(onProgress);
    const reportProgressRange = (value: number, start: number, end: number) => progressReporter.report(mapProgressRange(value, start, end));
    progressReporter.report(0);
    if (segments.length === 0) throw new UserFacingError(i18n.t('No segments to export.'));

    const externalInputs = copyFileStreams.filter(({ path, streamIds }) => path !== filePath && streamIds.length > 0);
    if (externalInputs.length > 0) throw new UserFacingError(i18n.t('Precise source-preserving export does not support external tracks.'));

    const sourceMeta = allFilesMeta[filePath];
    invariant(sourceMeta != null);
    const mainInput = copyFileStreams.find(({ path }) => path === filePath);
    invariant(mainInput != null);
    const selectedStreams = mainInput.streamIds.flatMap((streamId) => {
      const stream = sourceMeta.streams.find(({ index }) => index === streamId);
      return stream == null ? [] : [stream];
    });
    const realVideoStreams = selectedStreams.filter((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    if (realVideoStreams.length !== 1) {
      throw new UserFacingError(i18n.t('Precise source-preserving export requires exactly one video track.'));
    }
    const [primaryVideoStream] = realVideoStreams;
    invariant(primaryVideoStream != null);

    const sourcePreservingFormats = ['mp4', 'mov', 'ipod', 'm4v', '3gp', '3g2'];
    if (primaryVideoStream.codec_name !== 'h264' || !sourcePreservingFormats.includes(outFormat)) {
      throw new UserFacingError(i18n.t('Precise source-preserving export currently supports H.264 in MP4 or MOV-family containers.'));
    }

    const temporalStreams = selectedStreams.filter((stream) => stream.index === primaryVideoStream.index || stream.codec_type === 'audio');
    const ignoredStreamCount = selectedStreams.length - temporalStreams.length;
    const expectedTemporalCodecs = temporalStreams.map((stream) => ({
      codecType: stream.codec_type as 'video' | 'audio',
      codecName: stream.codec_name,
    }));

    const parsedSourceDuration = Number.parseFloat(sourceMeta.format.duration);
    const effectiveFileDuration = Number.isFinite(parsedSourceDuration) ? parsedSourceDuration : fileDuration;
    const parsedFormatStartTime = Number.parseFloat(sourceMeta.format.start_time);
    const parsedTemporalStartTimes = temporalStreams.flatMap((stream) => {
      const parsed = Number.parseFloat(stream.start_time ?? '');
      return Number.isFinite(parsed) ? [parsed] : [];
    });
    const sourceStartTime = Number.isFinite(parsedFormatStartTime)
      ? parsedFormatStartTime
      : (parsedTemporalStartTimes.length > 0 ? Math.min(...parsedTemporalStartTimes) : 0);
    const parsedVideoStartTime = Number.parseFloat(primaryVideoStream.start_time ?? '');
    const videoStartTolerance = detectedFps != null ? getFrameDuration(detectedFps) : 0.05;
    if (Number.isFinite(parsedVideoStartTime) && Math.abs(parsedVideoStartTime - sourceStartTime) > videoStartTolerance) {
      throw new UserFacingError(i18n.t('Precise export cannot preserve a source whose video track is delayed relative to the container timeline.'));
    }
    const parsedVideoDuration = Number.parseFloat(primaryVideoStream.duration ?? '');
    const sourceVideoEnd = Number.isFinite(parsedVideoDuration)
      ? (Number.isFinite(parsedVideoStartTime) ? parsedVideoStartTime : sourceStartTime) + parsedVideoDuration - sourceStartTime
      : effectiveFileDuration;
    if (sourceVideoEnd == null) throw new UserFacingError(i18n.t('Unable to determine the source video duration for precise export.'));
    let snappedCutPointCount = 0;

    const snapBoundary = async (time: number) => {
      if (time === 0 || (effectiveFileDuration != null && Math.abs(time - effectiveFileDuration) <= 0.000001)) return time;
      const frames = await readFrames({
        filePath,
        from: sourceStartTime + Math.max(time - 1, 0),
        to: sourceStartTime + (effectiveFileDuration != null ? Math.min(time + 1, effectiveFileDuration) : time + 1),
        streamIndex: primaryVideoStream.index,
      });
      const snapped = snapSourceTimeToFramePts(time, frames.map(({ time: frameTime }) => frameTime - sourceStartTime));
      if (Math.abs(snapped - time) > 0.000001) snappedCutPointCount += 1;
      return snapped;
    };

    const exactSegments = await pMap(segments, async (segment) => {
      const [start, end] = await Promise.all([snapBoundary(segment.start), snapBoundary(segment.end)]);
      if (end <= start) throw new UserFacingError(i18n.t('A selected segment is shorter than one source frame.'));
      return { ...segment, start, end };
    }, { concurrency: 1 });

    let mergeTransitionPlan;
    try {
      mergeTransitionPlan = buildSnappedMergeTransitionPreflight({
        intent,
        snapshot: mergeTransition,
        spans: exactSegments,
      });
    } catch (err) {
      if (!(err instanceof MergeTransitionPlanError)) throw err;
      if (err.code === 'invalid-duration') {
        throw new UserFacingError(i18n.t(
          'Fade-through-black transition duration must be a finite number of at least {{minimumDuration}}s.',
          { minimumDuration: formatTransitionSeconds(minimumMergeTransitionDuration) },
        ));
      }
      if (err.code === 'segment-too-short') {
        invariant(err.segmentIndex != null && err.actualDuration != null && err.requiredDuration != null);
        throw new UserFacingError(i18n.t(
          'Segment {{segmentNumber}} is {{actualDuration}}s, but the fade-through-black transition requires at least {{requiredDuration}}s.',
          {
            segmentNumber: err.segmentIndex + 1,
            actualDuration: formatTransitionSeconds(err.actualDuration),
            requiredDuration: formatTransitionSeconds(err.requiredDuration),
          },
        ));
      }
      throw err;
    }

    const finalPaths = intent === 'merge' ? [mergedOutPath] : separateOutPaths;
    if (finalPaths == null || finalPaths.some((path) => path == null) || (intent === 'separate' && finalPaths.length !== exactSegments.length)) {
      throw new Error('Source-preserving export output plan is incomplete');
    }
    const definiteFinalPaths = finalPaths as string[];
    if (new Set(definiteFinalPaths).size !== definiteFinalPaths.length) {
      throw new UserFacingError(i18n.t('Multiple selected segments resolve to the same output path.'));
    }
    for (const finalPath of definiteFinalPaths) {
      if (await shouldSkipExistingFile(finalPath)) throw new RefuseOverwriteError();
    }

    const segmentLastFrameOffsets = await pMap(mergeTransitionPlan.segments, async (segment) => {
      if (segment.fadeOutDuration === 0) return undefined;

      let windowDuration = 2;
      let reachedSegmentStart = false;
      while (!reachedSegmentStart) {
        const { from, to } = buildLastFrameReadWindow({ segment, sourceStartTime, windowDuration });
        const frames = await readFrames({ filePath, from, to, streamIndex: primaryVideoStream.index });
        let normalizedFramePts: number[];
        try {
          normalizedFramePts = normalizeFramePts({
            absoluteFramePts: frames.map(({ time }) => time),
            sourceStartTime,
          }).filter((pts) => pts >= segment.start && pts < segment.end - 0.000000001);
          if (normalizedFramePts.length > 0) return getLastFrameOffset({ segment, framePts: normalizedFramePts });
        } catch (err) {
          console.error('Unable to resolve fade-through-black last-frame timing', err);
          throw new UserFacingError(i18n.t('Fade-through-black transition requires reliable source frame timing.'));
        }

        reachedSegmentStart = from <= sourceStartTime + segment.start + 0.000000001;
        if (reachedSegmentStart) {
          throw new UserFacingError(i18n.t('Fade-through-black transition requires reliable source frame timing.'));
        }
        windowDuration *= 4;
      }
      throw new UserFacingError(i18n.t('Fade-through-black transition requires reliable source frame timing.'));
    }, { concurrency: 1 });

    const stagingDir = await mkdtemp(join(outputDir, '.losslesscut-export-'));
    let preserveStagingForRecovery = false;
    let completedResult: {
      paths: string[],
      ignoredStreamCount: number,
      snappedCutPointCount: number,
      copiedDuration: number,
      reencodedDuration: number,
      fullyEncodedSegmentCount: number,
    } | undefined;
    try {
      const ext = getOutFileExtension({ isCustomFormatSelected: true, outFormat, filePath });
      const sourceCodecParams = await getCodecParams({ path: filePath, fileDuration: effectiveFileDuration, streams: selectedStreams });
      const { videoCodec, videoBitrate, videoTimebase } = sourceCodecParams;
      if (videoTimebase == null) throw new UserFacingError(i18n.t('Unable to determine the source video time base for precise export.'));
      const videoOnlyStreams: CopyfileStreams = [{ path: filePath, streamIds: [primaryVideoStream.index] }];
      const audioStreams = temporalStreams.filter((stream) => stream.codec_type === 'audio');
      const idrSafetyCache = new Map<string, Promise<boolean>>();
      const maxIdrCandidateChecks = 64;
      let idrCandidateCheckCount = 0;
      const isSafeIdrCached = (keyframeTime: number) => {
        const cacheKey = keyframeTime.toFixed(9);
        const existing = idrSafetyCache.get(cacheKey);
        if (existing != null) return existing;
        if (idrCandidateCheckCount >= maxIdrCandidateChecks) {
          throw new UserFacingError(i18n.t('Precise export stopped because no safe H.264 IDR boundary was found within the search limit.'));
        }
        idrCandidateCheckCount += 1;
        const pending = isSafeH264Idr({ keyframeTime, sourceStartTime, videoStreamIndex: primaryVideoStream.index });
        idrSafetyCache.set(cacheKey, pending);
        return pending;
      };
      const findSafeRandomAccessPoint = async ({ time, mode, searchStart, searchEnd }: {
        time: number,
        mode: 'before' | 'after',
        searchStart: number,
        searchEnd: number,
      }) => {
        let window = 10;
        const maxSearchWindow = 600;
        let reachedSearchBoundary = false;
        while (!reachedSearchBoundary) {
          const from = mode === 'after' ? time : Math.max(searchStart, time - window);
          const to = mode === 'after' ? Math.min(searchEnd, time + window) : time;
          const frames = await readFrames({
            filePath,
            from: Math.max(searchStart, from - 0.000001),
            to: Math.min(searchEnd, to + 0.000001),
            streamIndex: primaryVideoStream.index,
          });
          const candidates = frames
            .filter(({ keyframe, time: candidateTime }) => keyframe
              && candidateTime >= searchStart - 0.000001
              && candidateTime <= searchEnd + 0.000001
              && candidateTime >= from - 0.000001
              && candidateTime <= to + 0.000001
              && (mode === 'after' ? candidateTime >= time - 0.000001 : candidateTime <= time + 0.000001))
            .sort((a, b) => (mode === 'after' ? a.time - b.time : b.time - a.time));
          for (const candidate of candidates) {
            if (await isSafeIdrCached(candidate.time)) return candidate.time;
          }

          reachedSearchBoundary = mode === 'after'
            ? to >= searchEnd - 0.000001
            : from <= searchStart + 0.000001;
          if (reachedSearchBoundary) return undefined;
          if (window >= maxSearchWindow) {
            throw new UserFacingError(i18n.t('Precise export stopped because no safe H.264 IDR boundary was found within the search limit.'));
          }
          window = Math.min(window * 4, maxSearchWindow);
        }
        return undefined;
      };
      const segmentPlans = await pMap(mergeTransitionPlan.segments, async (transitionSegment) => {
        const { start, end, fadeInDuration, fadeOutDuration } = transitionSegment;
        const sourceTime = (time: number) => sourceStartTime + time;
        const relativeTime = (time: number | undefined) => (time == null ? undefined : time - sourceStartTime);
        const searchPlan = buildTransitionIdrSearchPlan({ segment: transitionSegment, sourceStartTime });
        if (searchPlan.fullyEncode) {
          return buildSourcePreservingSegmentPlan({
            span: { start, end },
            fadeInDuration,
            fadeOutDuration,
            sourceDuration: effectiveFileDuration,
          });
        }

        const atSourceStart = fadeInDuration === 0 && Math.abs(start) <= 0.000001;
        const atSourceEnd = fadeOutDuration === 0
          && effectiveFileDuration != null
          && Math.abs(end - effectiveFileDuration) <= 0.000001;
        const [nextKeyframeAbsolute, previousKeyframeAbsolute] = await Promise.all([
          atSourceStart ? Promise.resolve(sourceTime(start)) : findSafeRandomAccessPoint({ ...searchPlan.after, mode: 'after' }),
          atSourceEnd ? Promise.resolve(sourceTime(end)) : findSafeRandomAccessPoint({ ...searchPlan.before, mode: 'before' }),
        ]);
        return buildSourcePreservingSegmentPlan({
          span: { start, end },
          fadeInDuration,
          fadeOutDuration,
          nextSafeIdrAtOrAfterCopyStart: relativeTime(nextKeyframeAbsolute),
          previousSafeIdrAtOrBeforeCopyEnd: relativeTime(previousKeyframeAbsolute),
          sourceDuration: effectiveFileDuration,
        });
      }, { concurrency: 1 });
      const fullyEncodedDuration = sum(segmentPlans
        .filter(({ copiedDuration }) => copiedDuration === 0)
        .map(({ reencodedDuration }) => reencodedDuration));
      if (fullyEncodedDuration > 30) {
        throw new UserFacingError(i18n.t('Precise export would require more than 30 seconds of full video re-encoding because no safe reusable GOP was found.'));
      }
      progressReporter.report(sourcePreservingProgressPhases.preflightEnd);

      const stagedSegmentVideoPaths: string[] = [];
      for (const [segmentIndex, plan] of segmentPlans.entries()) {
        console.log('Source-preserving segment plan', plan);
        const partPaths = plan.parts.map((_, partIndex) => join(stagingDir, `segment-${segmentIndex}-part-${partIndex}${ext}`));
        try {
          for (const [partIndex, part] of plan.parts.entries()) {
            const partPath = partPaths[partIndex]!;
            const partProgress = (value: number) => reportProgressRange(
              (segmentIndex + (partIndex + value) / (plan.parts.length + 1)) / segmentPlans.length,
              sourcePreservingProgressPhases.preflightEnd,
              sourcePreservingProgressPhases.segmentVideoEnd,
            );
            if (part.mode === 'copy') {
              await cutCopySourceVideoPart({
                cutFrom: part.start,
                cutTo: part.end,
                outPath: partPath,
                outFormat,
                videoStreamIndex: primaryVideoStream.index,
                videoTimebase,
                ffmpegExperimental,
                onProgress: partProgress,
              });
            } else {
              const lastFrameOffset = segmentLastFrameOffsets[segmentIndex];
              if (part.fadeOutDuration != null) invariant(lastFrameOffset != null);
              await cutEncodeSmartPart({
                cutFrom: part.start,
                cutTo: part.end,
                outPath: partPath,
                outFormat,
                videoCodec,
                videoBitrate,
                videoTimebase,
                allFilesMeta,
                copyFileStreams: videoOnlyStreams,
                videoStreamIndex: primaryVideoStream.index,
                sourceVideoStream: primaryVideoStream,
                ffmpegExperimental,
                hasBFrames: sourceCodecParams.videoStream.has_b_frames,
                forceClosedGop: true,
                ...(part.fadeInDuration != null ? { fadeInDuration: part.fadeInDuration } : {}),
                ...(part.fadeOutDuration != null ? {
                  fadeOutDuration: part.fadeOutDuration,
                  lastFrameOffset,
                } : {}),
              });
              partProgress(1);
            }

            const { streams: createdPartStreams } = await readFileFfprobeMeta(partPath);
            const createdPartVideo = createdPartStreams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
            const incompatibleBoundaryParameters = createdPartVideo == null
              || createdPartVideo.width !== primaryVideoStream.width
              || createdPartVideo.height !== primaryVideoStream.height
              || (primaryVideoStream.pix_fmt != null && createdPartVideo.pix_fmt !== primaryVideoStream.pix_fmt)
              || (primaryVideoStream.sample_aspect_ratio != null
                && primaryVideoStream.sample_aspect_ratio !== 'N/A'
                && createdPartVideo.sample_aspect_ratio !== primaryVideoStream.sample_aspect_ratio);
            if (incompatibleBoundaryParameters) {
              throw new UserFacingError(i18n.t('Precise export produced incompatible video parameters at a splice boundary.'));
            }
          }

          const segmentVideoPath = join(stagingDir, `segment-${segmentIndex}-video${ext}`);
          const { streams: partStreams } = await readFileFfprobeMeta(partPaths[0]!);
          await concatFiles({
            paths: partPaths,
            plannedDurations: plan.parts.map(({ start, end }) => end - start),
            outDir: stagingDir,
            outPath: segmentVideoPath,
            metadataFromPath: partPaths[0]!,
            includeAllStreams: true,
            streams: partStreams,
            outFormat,
            ffmpegExperimental,
            onProgress: (value) => reportProgressRange(
              (segmentIndex + (plan.parts.length + value) / (plan.parts.length + 1)) / segmentPlans.length,
              sourcePreservingProgressPhases.preflightEnd,
              sourcePreservingProgressPhases.segmentVideoEnd,
            ),
            preserveMovData: false,
            movFastStart: false,
            chapters: undefined,
            preserveMetadataOnMerge: false,
            videoTimebase,
          });
          stagedSegmentVideoPaths.push(segmentVideoPath);
        } finally {
          await tryDeleteFiles(partPaths);
        }
      }
      progressReporter.report(sourcePreservingProgressPhases.segmentVideoEnd);

      const segmentDurations = exactSegments.map(({ start, end }) => end - start);
      let stagedPaths: string[];
      let expectedDurations: number[];
      let expectedVideoDurations: number[];
      let verificationTimesByArtifact: number[][];
      if (intent === 'merge') {
        const mergedVideoPath = stagedSegmentVideoPaths.length === 1
          ? stagedSegmentVideoPaths[0]!
          : join(stagingDir, `merged-video${ext}`);
        if (stagedSegmentVideoPaths.length > 1) {
          const { streams: segmentVideoStreams } = await readFileFfprobeMeta(stagedSegmentVideoPaths[0]!);
          await concatFiles({
            paths: stagedSegmentVideoPaths,
            plannedDurations: segmentDurations,
            outDir: stagingDir,
            outPath: mergedVideoPath,
            metadataFromPath: stagedSegmentVideoPaths[0]!,
            includeAllStreams: true,
            streams: segmentVideoStreams,
            outFormat,
            ffmpegExperimental,
            onProgress: (value) => reportProgressRange(
              value,
              sourcePreservingProgressPhases.segmentVideoEnd,
              sourcePreservingProgressPhases.mergedVideoEnd,
            ),
            preserveMovData: false,
            movFastStart: false,
            chapters: undefined,
            preserveMetadataOnMerge: false,
            videoTimebase,
          });
        }
        progressReporter.report(sourcePreservingProgressPhases.mergedVideoEnd);

        const expectedDuration = sum(segmentDurations);
        const audioPath = audioStreams.length > 0 ? join(stagingDir, `merged-audio${ext}`) : undefined;
        const audioProgressEnd = audioPath != null
          ? sourcePreservingProgressPhases.mergedVideoEnd
            + (sourcePreservingProgressPhases.finalMediaEnd - sourcePreservingProgressPhases.mergedVideoEnd) * 0.55
          : sourcePreservingProgressPhases.mergedVideoEnd;
        if (audioPath != null) {
          await encodeSourceAudioSpans({
            spans: exactSegments,
            audioStreams,
            outPath: audioPath,
            outFormat,
            ffmpegExperimental,
            onProgress: (value) => reportProgressRange(
              value,
              sourcePreservingProgressPhases.mergedVideoEnd,
              audioProgressEnd,
            ),
          });
        }
        const stagedMergedPath = join(stagingDir, `merged${ext}`);
        await muxSourcePreservingStreams({
          videoPath: mergedVideoPath,
          audioPath,
          outPath: stagedMergedPath,
          outFormat,
          duration: expectedDuration,
          videoTimebase,
          ffmpegExperimental,
          preserveMetadata,
          preserveMovData,
          movFastStart,
          onProgress: (value) => reportProgressRange(value, audioProgressEnd, sourcePreservingProgressPhases.finalMediaEnd),
        });
        stagedPaths = [stagedMergedPath];
        expectedDurations = [expectedDuration];
        expectedVideoDurations = [getSourcePreservingVideoPresentationDuration({ spans: exactSegments, sourceVideoEnd })];
        let elapsed = 0;
        const mergedVerificationTimes = [...mergeTransitionPlan.joinOutputTimes];
        segmentPlans.forEach((plan, index) => {
          mergedVerificationTimes.push(...plan.parts.slice(0, -1).map(({ end }) => elapsed + end - plan.span.start));
          elapsed += segmentDurations[index]!;
          if (index < segmentPlans.length - 1) mergedVerificationTimes.push(elapsed);
        });
        verificationTimesByArtifact = [mergedVerificationTimes];
      } else {
        stagedPaths = [];
        for (const [index, segment] of exactSegments.entries()) {
          const duration = segmentDurations[index]!;
          const slotStart = mapProgressRange(
            index / exactSegments.length,
            sourcePreservingProgressPhases.mergedVideoEnd,
            sourcePreservingProgressPhases.finalMediaEnd,
          );
          const slotEnd = mapProgressRange(
            (index + 1) / exactSegments.length,
            sourcePreservingProgressPhases.mergedVideoEnd,
            sourcePreservingProgressPhases.finalMediaEnd,
          );
          const audioPath = audioStreams.length > 0 ? join(stagingDir, `segment-${index}-audio${ext}`) : undefined;
          const audioProgressEnd = audioPath != null ? slotStart + (slotEnd - slotStart) * 0.55 : slotStart;
          if (audioPath != null) {
            await encodeSourceAudioSpans({
              spans: [segment],
              audioStreams,
              outPath: audioPath,
              outFormat,
              ffmpegExperimental,
              onProgress: (value) => reportProgressRange(value, slotStart, audioProgressEnd),
            });
          }
          const stagedPath = join(stagingDir, `segment-${index}${ext}`);
          await muxSourcePreservingStreams({
            videoPath: stagedSegmentVideoPaths[index]!,
            audioPath,
            outPath: stagedPath,
            outFormat,
            duration,
            videoTimebase,
            ffmpegExperimental,
            preserveMetadata,
            preserveMovData,
            movFastStart,
            onProgress: (value) => reportProgressRange(value, audioProgressEnd, slotEnd),
          });
          stagedPaths.push(stagedPath);
        }
        expectedDurations = segmentDurations;
        expectedVideoDurations = exactSegments.map((segment) => getSourcePreservingVideoPresentationDuration({ spans: [segment], sourceVideoEnd }));
        verificationTimesByArtifact = segmentPlans.map((plan) => plan.parts.slice(0, -1).map(({ end }) => end - plan.span.start));
      }
      progressReporter.report(sourcePreservingProgressPhases.finalMediaEnd);

      const expectedFrameDuration = detectedFps != null ? getFrameDuration(detectedFps) : undefined;
      const verificationJobs = stagedPaths.map((stagedPath, index) => {
        const expectedDuration = expectedDurations[index]!;
        const expectedVideoDuration = expectedVideoDurations[index]!;
        const decodeWindowStarts = [...new Set([
          0,
          Math.max(expectedDuration - 2, 0),
          ...verificationTimesByArtifact[index]!.map((time) => Math.max(time - 1, 0)),
        ])];
        return { stagedPath, expectedDuration, expectedVideoDuration, decodeWindowStarts };
      });
      const totalVerificationUnits = sum(verificationJobs.map(({ decodeWindowStarts }) => 1 + decodeWindowStarts.length));
      let completedVerificationUnits = 0;
      const advanceVerificationProgress = () => {
        completedVerificationUnits += 1;
        reportProgressRange(
          completedVerificationUnits / totalVerificationUnits,
          sourcePreservingProgressPhases.finalMediaEnd,
          sourcePreservingProgressPhases.verificationEnd,
        );
      };
      for (const { stagedPath, expectedDuration, expectedVideoDuration, decodeWindowStarts } of verificationJobs) {
        try {
          const meta = await readFileFfprobeMeta(stagedPath);
          const outputVideoStream = meta.streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
          if (outputVideoStream == null) throw new UserFacingError(i18n.t('Precise export produced no video track.'));
          const presentationPackets = await readFrames({
            filePath: stagedPath,
            from: Math.max(expectedVideoDuration - 2, 0),
            to: expectedDuration + 1,
            streamIndex: outputVideoStream.index,
          });
          const actualVideoPresentationDuration = getSourcePreservingPacketPresentationDuration({
            packets: presentationPackets,
            fallbackFrameDuration: expectedFrameDuration ?? 0.04,
          });
          assertSourcePreservingExportMeta({
            meta,
            expectedDuration,
            expectedFormat: outFormat,
            expectedTemporalCodecs,
            expectedFrameDuration,
            actualVideoPresentationDuration,
            expectedVideoPresentationDuration: expectedVideoDuration,
            expectedContainerDuration: audioStreams.length > 0 ? expectedDuration : expectedVideoDuration,
          });
          advanceVerificationProgress();

          for (const start of decodeWindowStarts) {
            const duration = Math.min(2, expectedDuration - start);
            if (duration > 0) {
              const decodeResult = await runFfmpeg([
                '-v', 'error', '-xerror',
                ...(start > 0 ? ['-ss', formatFfmpegNumber(start)] : []),
                '-i', stagedPath,
                '-t', formatFfmpegNumber(duration),
                '-map', '0:v:0', '-map', '0:a?',
                '-f', 'null', '-',
              ]);
              logStdoutStderr(decodeResult);
            }
            advanceVerificationProgress();
          }
        } catch (err) {
          if (err instanceof SourcePreservingVerificationError) throw new UserFacingError(err.message);
          throw err;
        }
      }
      progressReporter.report(sourcePreservingProgressPhases.verificationEnd);

      const totalPublishUnits = definiteFinalPaths.length + stagedPaths.length;
      let completedPublishUnits = 0;
      const advancePublishProgress = () => {
        completedPublishUnits += 1;
        reportProgressRange(
          completedPublishUnits / totalPublishUnits,
          sourcePreservingProgressPhases.verificationEnd,
          sourcePreservingProgressPhases.publishEnd,
        );
      };
      const backups = new Map<number, string>();
      for (const [index, finalPath] of definiteFinalPaths.entries()) {
        await maybeMkDeepOutDir({ outputDir, fileOutPath: finalPath });
        if (await mainApi.pathExists(finalPath)) {
          const backupPath = join(stagingDir, `existing-${index}`);
          try {
            await link(finalPath, backupPath);
          } catch {
            await copyFile(finalPath, backupPath);
          }
          backups.set(index, backupPath);
        }
        advancePublishProgress();
      }

      const changedTargets = new Set<number>();
      try {
        for (const [index, stagedPath] of stagedPaths.entries()) {
          const finalPath = definiteFinalPaths[index]!;
          if (!enableOverwriteOutput && await mainApi.pathExists(finalPath)) throw new RefuseOverwriteError();
          try {
            await rename(stagedPath, finalPath);
            changedTargets.add(index);
          } catch (err) {
            const canRetryAfterUnlink = enableOverwriteOutput && err instanceof Error && 'code' in err && ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String(err.code));
            if (!canRetryAfterUnlink) throw err;
            await unlinkWithRetry(finalPath);
            changedTargets.add(index);
            await rename(stagedPath, finalPath);
          }
          advancePublishProgress();
        }
      } catch (publishError) {
        const rollbackErrors: unknown[] = [];
        for (const index of [...changedTargets].reverse()) {
          const finalPath = definiteFinalPaths[index]!;
          const backupPath = backups.get(index);
          try {
            await unlinkWithRetry(finalPath).catch((err: unknown) => {
              if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
            });
            if (backupPath != null) await rename(backupPath, finalPath);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          preserveStagingForRecovery = true;
          console.error(new AggregateError([publishError, ...rollbackErrors], 'Source-preserving export publish failed and rollback was incomplete'));
          throw new UserFacingError(i18n.t('Publishing failed and rollback was incomplete. Recovery files remain in {{path}}', { path: stagingDir }));
        }
        throw publishError;
      }

      completedResult = {
        paths: definiteFinalPaths,
        ignoredStreamCount,
        snappedCutPointCount,
        copiedDuration: sum(segmentPlans.map(({ copiedDuration }) => copiedDuration)),
        reencodedDuration: sum(segmentPlans.map(({ reencodedDuration }) => reencodedDuration)),
        fullyEncodedSegmentCount: segmentPlans.filter(({ copiedDuration }) => copiedDuration === 0).length,
      };
    } finally {
      if (!preserveStagingForRecovery) {
        if (completedResult != null) progressReporter.report(sourcePreservingProgressPhases.publishEnd);
        await rm(stagingDir, { recursive: true, force: true }).catch((err: unknown) => console.error('Failed to clean source-preserving export staging directory', stagingDir, err));
        if (completedResult != null) progressReporter.report(sourcePreservingProgressPhases.cleanupEnd);
      }
    }
    invariant(completedResult != null);
    progressReporter.complete();
    return completedResult;
  }, [concatFiles, cutCopySourceVideoPart, cutEncodeSmartPart, enableOverwriteOutput, encodeSourceAudioSpans, filePath, isSafeH264Idr, muxSourcePreservingStreams, shouldSkipExistingFile]);

  // This is just used to load something into the player with correct duration,
  // so that the user can seek and then we render frames using ffmpeg & MediaSource
  const html5ifyDummy = useCallback(async ({ filePath: filePathArg, outPath, onProgress }: {
    filePath: string,
    outPath: string,
    onProgress: (p: number) => void,
  }) => {
    console.log('Making ffmpeg-assisted dummy file', { filePathArg, outPath });

    const duration = await getDuration(filePathArg);

    const ffmpegArgs = [
      '-hide_banner',

      // This is just a fast way of generating an empty dummy file
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(duration),
      '-acodec', 'flac',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });
    logStdoutStderr(result);

    await transferTimestamps({ inPath: filePathArg, outPath, duration, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });
  }, [appendFfmpegCommandLog, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  const html5ify = useCallback(async ({ customOutDir, filePath: filePathArg, speed, hasAudio, hasVideo, onProgress }: {
    customOutDir: string | undefined,
    filePath: string,
    speed: Html5ifyMode,
    hasAudio: boolean,
    hasVideo: boolean,
    onProgress: (p: number) => void,
  }) => {
    console.log('html5ifyAndLoad', { speed, hasVideo, hasAudio });

    if (speed === 'fastest') {
      const path = getSuffixedOutPath({ customOutDir, filePath: filePathArg, nameSuffix: `${html5ifiedPrefix}${html5dummySuffix}.mkv` });
      await html5ifyDummy({ filePath: filePathArg, outPath: path, onProgress });
      return path;
    }

    const outPath = getHtml5ifiedPath(customOutDir, filePathArg, speed);
    invariant(outPath != null);

    let audio: 'hq' | 'lq' | 'copy' | undefined;
    if (hasAudio) {
      if (speed === 'slowest') audio = 'hq';
      else if (['slow-audio', 'fast-audio'].includes(speed)) audio = 'lq';
      else if (['fast-audio-remux'].includes(speed)) audio = 'copy';
    }

    let video: 'hq' | 'lq' | 'copy' | undefined;
    if (hasVideo) {
      if (speed === 'slowest') video = 'hq';
      else if (['slow-audio', 'slow'].includes(speed)) video = 'lq';
      else video = 'copy';
    }

    console.log('Making HTML5 friendly version', { filePathArg, outPath, speed, video, audio });

    let videoArgs: string[];
    let audioArgs: string[];

    // h264/aac_at: No licensing when using HW encoder (Video/Audio Toolbox on Mac)
    // https://github.com/mifi/lossless-cut/issues/372#issuecomment-810766512

    switch (video) {
      case 'hq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          videoArgs = ['-vf', 'format=yuv420p', '-allow_sw', '1', '-vcodec', 'h264', '-b:v', '15M'];
        } else {
          // AV1 is very slow
          // videoArgs = ['-vf', 'format=yuv420p', '-sws_flags', 'neighbor', '-vcodec', 'libaom-av1', '-crf', '30', '-cpu-used', '8'];
          // Theora is a bit faster but not that much
          // videoArgs = ['-vf', '-c:v', 'libtheora', '-qscale:v', '1'];
          // videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1'];
          // x264 can only be used in GPL projects
          videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-preset:v', 'slow', '-crf', '17'];
        }
        break;
      }
      case 'lq': {
        const targetHeight = 400;

        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-allow_sw', '1', '-sws_flags', 'lanczos', '-vcodec', 'h264', '-b:v', '1500k'];
        } else {
          // videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-sws_flags', 'neighbor', '-c:v', 'libtheora', '-qscale:v', '1'];
          // x264 can only be used in GPL projects
          videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-sws_flags', 'neighbor', '-c:v', 'libx264', '-profile:v', 'baseline', '-x264opts', 'level=3.0', '-preset:v', 'ultrafast', '-crf', '28'];
        }
        break;
      }
      case 'copy': {
        videoArgs = ['-vcodec', 'copy'];
        break;
      }
      default: {
        videoArgs = ['-vn'];
      }
    }

    switch (audio) {
      case 'hq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          audioArgs = ['-acodec', 'aac_at', '-b:a', '192k'];
        } else {
          audioArgs = ['-acodec', 'flac'];
        }
        break;
      }
      case 'lq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          audioArgs = ['-acodec', 'aac_at', '-ar', '44100', '-ac', '2', '-b:a', '96k'];
        } else {
          audioArgs = ['-acodec', 'flac', '-ar', '11025', '-ac', '2'];
        }
        break;
      }
      case 'copy': {
        audioArgs = ['-acodec', 'copy'];
        break;
      }
      default: {
        audioArgs = ['-an'];
      }
    }

    const ffmpegArgs = [
      '-hide_banner',
      ...((video === 'lq' || video === 'hq') ? getHwaccelArgs(ffmpegHwaccel) : []),

      '-i', filePathArg,
      ...videoArgs,
      ...audioArgs,
      '-sn',
      '-y', outPath,
    ];

    const duration = await getDuration(filePathArg);
    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });

    console.log(new TextDecoder().decode(stdout));

    invariant(outPath != null);
    await transferTimestamps({ inPath: filePathArg, outPath, duration, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });
    return outPath;
  }, [appendFfmpegCommandLog, ffmpegHwaccel, html5ifyDummy, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  // https://stackoverflow.com/questions/34118013/how-to-determine-webm-duration-using-ffprobe
  const fixInvalidDuration = useCallback(async ({ filePath: filePathArg, outPath, onProgress }: {
    filePath: string,
    outPath: string,
    onProgress: (a: number) => void,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',

      '-i', filePathArg,

      // https://github.com/mifi/lossless-cut/issues/1415
      '-map_metadata', '0',
      '-map', '0',
      '-ignore_unknown',

      '-c', 'copy',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, onProgress });
    logStdoutStderr(result);

    return outPath;
  }, [appendFfmpegCommandLog]);

  // https://github.com/mifi/lossless-cut/issues/2111
  const decimate = useCallback(async ({ filePath: filePathArg, outPath, n, fps }: {
    n: number,
    fps: number,
    filePath: string,
    outPath: string,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',

      // https://stackoverflow.com/questions/73710657/remove-all-non-keyframes-from-h-264-avc-video-without-re-encoding
      // https://stackoverflow.com/questions/67088473/remove-all-non-key-frames-from-video-without-re-encoding
      // '-discard', 'nokey', // doesn't seem to work with hevc, so use noise=drop=not(key) instead
      // https://chatgpt.com/share/6a1c3be1-1064-83ec-b5c1-fa91ddf3cde8
      '-i', filePathArg,
      '-map', 'v:0',
      '-c', 'copy',
      '-bsf:v', `noise=drop=not(key),noise=drop='mod(n\\,${formatFfmpegNumber(n)})',setts=ts='N/${formatFfmpegNumber(fps)}/TB_OUT'`,
      '-an',
      '-ignore_unknown',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpeg(ffmpegArgs);
    logStdoutStderr(result);

    return outPath;
  }, [appendFfmpegCommandLog]);

  function getPreferredCodecFormat(stream: LiteFFprobeStream) {
    const map = {
      mp3: { format: 'mp3', ext: 'mp3' },
      opus: { format: 'opus', ext: 'opus' },
      vorbis: { format: 'ogg', ext: 'ogg' },
      h264: { format: 'mp4', ext: 'mp4' },
      hevc: { format: 'mp4', ext: 'mp4' },
      eac3: { format: 'eac3', ext: 'eac3' },

      subrip: { format: 'srt', ext: 'srt' },
      mov_text: { format: 'mp4', ext: 'mp4' },

      m4a: { format: 'ipod', ext: 'm4a' },
      aac: { format: 'adts', ext: 'aac' },
      jpeg: { format: 'image2', ext: 'jpeg' },
      png: { format: 'image2', ext: 'png' },

      // TODO add more
      // TODO allow user to change?
    } as const;

    const match = map[stream.codec_name as keyof typeof map];
    if (match) return match;

    // default fallbacks:
    if (stream.codec_type === 'video') return { ext: 'mkv', format: 'matroska' } as const;
    if (stream.codec_type === 'audio') return { ext: 'mka', format: 'matroska' } as const;
    if (stream.codec_type === 'subtitle') return { ext: 'mks', format: 'matroska' } as const;
    if (stream.codec_type === 'data') return { ext: 'bin', format: 'data' } as const; // https://superuser.com/questions/1243257/save-data-stream

    return undefined;
  }

  const extractNonAttachmentStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir?: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    if (streams.length === 0) return [];

    const outStreams = streams.flatMap((s) => {
      const format = getPreferredCodecFormat(s);
      const { index } = s;

      if (format == null || index == null) return [];

      return [{
        index,
        codec: s.codec_name || s.codec_tag_string || s.codec_type,
        type: s.codec_type,
        format,
      }];
    });

    // console.log(outStreams);


    let streamArgs: string[] = [];
    const outPaths = await pMap(outStreams, async ({ index, codec, type, format: { format, ext } }) => {
      const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `stream-${index}-${type}-${codec}.${ext}` });
      if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) throw new RefuseOverwriteError();

      streamArgs = [
        ...streamArgs,
        '-map', `0:${index}`, '-c', 'copy', '-f', format, '-y', outPath,
      ];
      return outPath;
    }, { concurrency: 1 });

    const ffmpegArgs = [
      '-hide_banner',

      '-i', filePath,
      ...streamArgs,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpeg(ffmpegArgs);
    console.log(new TextDecoder().decode(stdout));

    return outPaths;
  }, [appendFfmpegCommandLog, enableOverwriteOutput, filePath]);

  const extractAttachmentStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir?: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    if (streams.length === 0) return [];

    console.log('Extracting', streams.length, 'attachment streams');

    let streamArgs: string[] = [];
    const outPaths = await pMap(streams, async ({ index, codec_name: codec, codec_type: type }) => {
      const ext = codec || 'bin';
      const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `stream-${index}-${type}-${codec}.${ext}` });
      invariant(outPath != null);
      if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) throw new RefuseOverwriteError();

      streamArgs = [
        ...streamArgs,
        `-dump_attachment:${index}`, outPath,
      ];
      return outPath;
    }, { concurrency: 1 });

    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      ...streamArgs,
      '-i', filePath,
    ];

    try {
      appendFfmpegCommandLog(ffmpegArgs);
      const { stdout } = await runFfmpeg(ffmpegArgs);
      console.log(new TextDecoder().decode(stdout));
    } catch (err) {
      // Unfortunately ffmpeg will exit with code 1 even though it's a success
      // Note: This is kind of hacky:
      if (err instanceof Error && 'exitCode' in err && 'stderr' in err && err.exitCode === 1 && typeof err.stderr === 'string' && err.stderr.includes('At least one output file must be specified')) return outPaths;
      throw err;
    }
    return outPaths;
  }, [appendFfmpegCommandLog, enableOverwriteOutput, filePath]);

  // https://stackoverflow.com/questions/32922226/extract-every-audio-and-subtitles-from-a-video-with-ffmpeg
  const extractStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);

    const attachmentStreams = streams.filter((s) => s.codec_type === 'attachment');
    const nonAttachmentStreams = streams.filter((s) => s.codec_type !== 'attachment');

    // TODO progress

    // Attachment streams are handled differently from normal streams
    return [
      ...(await extractNonAttachmentStreams({ customOutDir, streams: nonAttachmentStreams })),
      ...(await extractAttachmentStreams({ customOutDir, streams: attachmentStreams })),
    ];
  }, [extractAttachmentStreams, extractNonAttachmentStreams, filePath]);

  return {
    cutMultiple, exportSourcePreservingSegments, concatFiles, html5ify, html5ifyDummy, fixInvalidDuration, decimate, concatCutSegments, extractStreams, tryDeleteFiles,
  };
}

export default useFfmpegOperations;

export type FfmpegOperations = ReturnType<typeof useFfmpegOperations>;
