import type { MutableRefObject, FormEvent } from 'react';
import { useCallback, useRef, useMemo, useState, useEffect } from 'react';
import { useStateWithHistory } from 'react-use/lib/useStateWithHistory';
import i18n from 'i18next';
import pMap from 'p-map';
import invariant from 'tiny-invariant';
import sortBy from 'lodash/sortBy';
import { Trans, useTranslation } from 'react-i18next';
import { FaLink } from 'react-icons/fa';

import TextInput from '../components/TextInput';
import { detectSceneChanges as ffmpegDetectSceneChanges, readFrames, mapTimesToSegments, findKeyframeNearTime } from '../ffmpeg';
import { getFileSize, shuffleArray } from '../util';
import { errorToast } from '../swal';
import { createNumSegments as createNumSegmentsDialog, createFixedByteSixedSegments as createFixedByteSixedSegmentsDialog, createRandomSegments as createRandomSegmentsDialog, labelSegmentDialog, askForAlignSegments, selectSegmentsByLabelDialog, askForSegmentDuration, toastError } from '../dialogs';
import { createSegment, sortSegments, invertSegments, combineOverlappingSegments as combineOverlappingSegments2, combineSelectedSegments as combineSelectedSegments2, isDurationValid, addSegmentColorIndex, filterNonMarkers, makeDurationSegments, isInitialSegment } from '../segments';
import type { FfmpegDialog } from '../ffmpegParameters';
import { parameters as allFfmpegParameters, getHint, getLabel } from '../ffmpegParameters';
import { maxSegmentsAllowed } from '../util/constants';
import type { DefiniteSegmentBase, ParseTimecode, SegmentBase, SegmentToExport, StateSegment, UpdateSegAtIndex } from '../types';
import { segmentTagsSchema } from '../types';
import safeishEval from '../worker/eval';
import type { FFprobeFormat, FFprobeStream } from '../../../common/ffprobe';
import type { HandleError } from '../contexts';
import type { ShowGenericDialog } from '../components/GenericDialog';
import { useGenericDialogContext } from '../components/GenericDialog';
import ExpressionDialog from '../components/ExpressionDialog';
import Button, { DialogButton } from '../components/Button';
import { ButtonRow } from '../components/Dialog';
import * as Dialog from '../components/Dialog';
import { UserFacingError } from '../../errors';
import { editSegmentByExpressionHelpUrl, selectSegmentByExpressionHelpUrl } from '../../../common/constants';
import type { Segment as ScopeSegment } from '../../../common/userTypes';
import type { FfmpegHwAccel } from '../../../common/types';
import mainApi from '../mainApi';
import { removeSourceSegments, snapSourceTimeToFramePts, splitSourceSegment } from '../timelineSegments';

const remote = window.require('@electron/remote');
const { ffmpeg: { blackDetect, silenceDetect } } = remote.require('./index.js');


type ParameterDialogParameters = Record<string, string>;

const offsetSegments = (segments: DefiniteSegmentBase[], offset: number) => segments.map((s) => ({ start: s.start + offset, end: s.end + offset }));

function useSegments({ filePath, workingRef, setWorking, setProgress, videoStream, fileDuration, getRelevantTime, maxLabelLength, checkFileOpened, segmentsToChaptersOnly, timecodePlaceholder, parseTimecode, appendFfmpegCommandLog, fileDurationNonZero, mainFileMeta, seekAbs, activeVideoStreamIndex, activeAudioStreamIndexes, handleError, showGenericDialog, ffmpegHwaccel }: {
  filePath?: string | undefined,
  workingRef: MutableRefObject<boolean>,
  setWorking: (w: { text: string, abortController?: AbortController } | undefined) => void,
  setProgress: (a: number | undefined) => void,
  videoStream: FFprobeStream | undefined,
  fileDuration?: number | undefined,
  getRelevantTime: () => number,
  maxLabelLength: number,
  checkFileOpened: () => boolean,
  segmentsToChaptersOnly: boolean,
  timecodePlaceholder: string,
  parseTimecode: ParseTimecode,
  appendFfmpegCommandLog: (args: string[]) => void,
  fileDurationNonZero: number,
  mainFileMeta: { format: FFprobeFormat, streams: FFprobeStream[] } | undefined,
  seekAbs: (val: number | undefined) => void,
  activeVideoStreamIndex: number | undefined,
  activeAudioStreamIndexes: Set<number>,
  handleError: HandleError,
  showGenericDialog: ShowGenericDialog,
  ffmpegHwaccel: FfmpegHwAccel,
}) {
  const { t } = useTranslation();

  // Segment related state
  const [segColorCounter, setSegColorCounterState] = useState(0);
  const segColorCounterRef = useRef(0);
  const setSegColorCounter = useCallback((v: number) => {
    segColorCounterRef.current = v;
    setSegColorCounterState(v);
  }, []);

  const createIndexedSegment = useCallback(({ segment, incrementCount }: {
    segment?: Parameters<typeof createSegment>[0],
    incrementCount?: boolean,
  } = {}) => {
    if (incrementCount) {
      setSegColorCounter(segColorCounterRef.current + 1);
    }
    return addSegmentColorIndex(createSegment(segment), segColorCounterRef.current);
  }, [setSegColorCounter]);

  const [cutSegments, setCutSegments, cutSegmentsHistory] = useStateWithHistory<StateSegment[], StateSegment[]>(
    [],
    100,
  );
  const cutSegmentsRef = useRef(cutSegments);
  useEffect(() => {
    cutSegmentsRef.current = cutSegments;
  }, [cutSegments]);

  const [currentSegIndex, setCurrentSegIndex] = useState(0);

  const [ffmpegParameters, setFfmpegParameters] = useState(() => Object.fromEntries(Object.entries(allFfmpegParameters).map(([dialogType, parameters]) => ([
    dialogType,
    Object.fromEntries(Object.entries(parameters).map(([k2, v2]) => [k2, v2.value])),
  ] as const))));

  const setFfmpegParametersForDialog = useCallback((dialogType: FfmpegDialog, newParams: Record<string, string>) => setFfmpegParameters((existing) => ({
    ...existing,
    [dialogType]: {
      ...existing[dialogType],
      ...newParams,
    },
  })), []);


  const clearSegColorCounter = useCallback(() => {
    // eslint-disable-next-line no-param-reassign
    setSegColorCounter(0);
  }, [setSegColorCounter]);

  const safeSetCutSegments = useCallback((newSegmentsOrFn: StateSegment[] | ((a: StateSegment[]) => StateSegment[]), clampDuration?: number) => {
    function clampValue(val: number | undefined) {
      if (val == null || Number.isNaN(val)) return undefined;
      const clamped = Math.max(val, 0);
      if (clampDuration == null) return clamped;
      return Math.min(clamped, clampDuration);
    }

    // delete "initial" after modifying segments
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const map = (newSegments: StateSegment[]) => newSegments.flatMap(({ start, end, initial: _ignored, ...rest }) => {
      const startClamped = clampValue(start) ?? 0;
      const endClamped = clampValue(end);

      // convert 0 length segments into a markers
      if (endClamped == null || endClamped <= startClamped) {
        return [{
          ...rest,
          start: startClamped,
        }];
      }

      return [{
        ...rest,
        start: startClamped,
        end: endClamped,
      }];
    });

    if (typeof newSegmentsOrFn === 'function') {
      setCutSegments((existing) => map(newSegmentsOrFn(existing)));
      return;
    }

    setCutSegments(map(newSegmentsOrFn));
  }, [setCutSegments]);

  const clearSegments = useCallback(() => {
    clearSegColorCounter();
    safeSetCutSegments([]);
  }, [clearSegColorCounter, safeSetCutSegments]);

  const shuffleSegments = useCallback(() => safeSetCutSegments((existingSegments) => [
    ...existingSegments.filter((s) => !s.selected),
    ...shuffleArray(existingSegments.filter((s) => s.selected)),
  ]), [safeSetCutSegments]);

  // todo combine with safeSetCutSegments?
  const loadCutSegments = useCallback(({ segments, append, clampDuration, getNextCurrentSegIndex }: {
    segments: SegmentBase[],
    append: boolean,
    clampDuration?: number | undefined,
    getNextCurrentSegIndex?: (newEdl: SegmentBase[]) => number,
  }) => {
    if (segments.length === 0) throw new UserFacingError(i18n.t('No valid segments found'));

    if (segments.length > maxSegmentsAllowed) throw new UserFacingError(i18n.t('Tried to create too many segments (max {{maxSegmentsAllowed}}.)', { maxSegmentsAllowed }));

    if (!append) clearSegColorCounter();

    safeSetCutSegments((existingSegments) => {
      const needToAppend = append && !isInitialSegment(existingSegments);
      let newSegments = segments.map((segment, i) => createIndexedSegment({ segment, incrementCount: needToAppend || i > 0 }));
      if (needToAppend) newSegments = [...existingSegments, ...newSegments];
      if (getNextCurrentSegIndex) setCurrentSegIndex(getNextCurrentSegIndex(newSegments));
      return newSegments;
    }, clampDuration);
  }, [clearSegColorCounter, createIndexedSegment, safeSetCutSegments]);

  const detectSegments = useCallback(async ({ name, workingText, errorText, fn }: {
    name: string,
    workingText: string,
    errorText: string,
    fn: (onSegmentDetected: (seg: SegmentBase) => void) => Promise<{ ffmpegArgs: string[] }>,
  }) => {
    if (!filePath) return;
    if (workingRef.current) return;
    try {
      setWorking({ text: workingText });
      setProgress(0);

      // todo throttle?
      const { ffmpegArgs } = await fn((detectedSegment) => {
        console.log('Detected', name, detectedSegment);
        loadCutSegments({ segments: [detectedSegment], append: true, getNextCurrentSegIndex: (edl) => edl.length - 1, clampDuration: fileDuration });
        seekAbs(detectedSegment.start);
      });
      appendFfmpegCommandLog(ffmpegArgs);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) handleError({ err, title: errorText });
    } finally {
      setWorking(undefined);
      setProgress(undefined);
    }
  }, [filePath, workingRef, setWorking, setProgress, appendFfmpegCommandLog, loadCutSegments, fileDuration, seekAbs, handleError]);

  const getScopeSegment = useCallback((seg: Pick<StateSegment, 'name' | 'start' | 'end' | 'tags'>, index: number): ScopeSegment => {
    const { start, end, name, tags } = seg;
    // must clone tags because scope is mutable (editable by expression)
    return { index, label: name, start, end, duration: end != null ? end - start : 0, tags: { ...tags } };
  }, []);

  const haveInvalidSegs = useMemo(() => cutSegments.some((cutSegment) => cutSegment.end != null && cutSegment.start >= cutSegment.end), [cutSegments]);

  const currentSegIndexSafe = Math.min(currentSegIndex, cutSegments.length - 1);

  const currentCutSeg = useMemo(() => cutSegments[currentSegIndexSafe], [currentSegIndexSafe, cutSegments]);

  const deleteCurrentCutSeg = useCallback(() => {
    if (currentCutSeg == null) return;
    safeSetCutSegments((existing) => existing.filter((s) => s !== currentCutSeg));
  }, [currentCutSeg, safeSetCutSegments]);

  const currentCutSegOrWholeTimeline = useMemo(() => {
    const { start = 0, end = fileDurationNonZero } = currentCutSeg ?? {};
    return { start, end, duration: end - start };
  }, [currentCutSeg, fileDurationNonZero]);

  const selectedSegments = useMemo(() => cutSegments.flatMap((segment, i) => (segment.selected ? [{ ...segment, originalIndex: i }] : [])), [cutSegments]);

  const getFfmpegParameters = useCallback((key: FfmpegDialog) => {
    const parameters = ffmpegParameters[key];
    invariant(parameters);
    return parameters;
  }, [ffmpegParameters]);

  const showParametersDialog = useCallback(async ({ title, description, dialogType, parameters: parametersIn, docUrl }: {
    title?: string,
    description?: string,
    dialogType: FfmpegDialog,
    parameters: ParameterDialogParameters,
    docUrl?: string,
  }) => new Promise<ParameterDialogParameters | undefined>((resolve) => {
    function ParametersDialog() {
      const { onOpenChange } = useGenericDialogContext();

      const firstInputRef = useRef<HTMLInputElement>(null);
      const [parameters, setParameters] = useState(parametersIn);

      const getParameter = (key: string) => parameters[key];

      const handleChange = (key: string, value: string) => setParameters((existing) => ({ ...existing, [key]: value }));

      const handleSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        resolve(parameters);
        onOpenChange(false);
      }, [onOpenChange, parameters]);

      useEffect(() => {
        firstInputRef.current?.focus();
      }, []);

      return (
        <Dialog.Content aria-describedby={undefined} style={{ width: '80vw' }}>
          <Dialog.Title>{title}</Dialog.Title>

          <Dialog.Description>{description}</Dialog.Description>

          {docUrl && <p><Button onClick={() => mainApi.openExternal(docUrl)}><FaLink style={{ fontSize: '.8em' }} /> {t('Read more')}</Button></p>}

          <form onSubmit={handleSubmit}>
            {Object.entries(parametersIn).map(([key, parameter], i) => {
              const id = `parameter-${key}`;
              return (
                <div key={key} style={{ marginBottom: '.5em' }}>
                  <label htmlFor={id} style={{ display: 'block', fontFamily: 'monospace', marginBottom: '.3em' }}>{getLabel(dialogType, parameter) || key}</label>
                  <TextInput
                    id={id}
                    ref={i === 0 ? firstInputRef : undefined}
                    value={getParameter(key)}
                    onChange={(e) => handleChange(key, e.target.value)}
                    style={{ marginBottom: '.2em' }}
                  />
                  {getHint(dialogType, key) && <div style={{ opacity: 0.6, fontSize: '0.8em' }}>{getHint(dialogType, key)}</div>}
                </div>
              );
            })}

            <ButtonRow>
              <Dialog.Close asChild>
                <DialogButton>{t('Cancel')}</DialogButton>
              </Dialog.Close>

              <DialogButton type="submit" primary>{t('Confirm')}</DialogButton>
            </ButtonRow>
          </form>
        </Dialog.Content>
      );
    }

    showGenericDialog({
      render: () => <ParametersDialog />,
      onClose: () => resolve(undefined),
    });
  }), [showGenericDialog, t]);

  const detectBlackScenes = useCallback(async () => {
    const { start, end } = currentCutSegOrWholeTimeline;
    deleteCurrentCutSeg();
    const dialogType = 'blackdetect';
    const parameters = await showParametersDialog({ title: i18n.t('Enter parameters'), dialogType, parameters: getFfmpegParameters(dialogType), docUrl: 'https://ffmpeg.org/ffmpeg-filters.html#blackdetect' });
    if (parameters == null) return;
    const { mode, ...filterOptions } = parameters;
    setFfmpegParametersForDialog(dialogType, parameters);
    invariant(mode === '1' || mode === '2');
    invariant(filePath != null);
    await detectSegments({ name: 'blackScenes', workingText: i18n.t('Detecting black scenes'), errorText: i18n.t('Failed to detect black scenes'), fn: async (onSegmentDetected) => blackDetect({ filePath, streamId: activeVideoStreamIndex, filterOptions, boundingMode: mode === '1', onProgress: setProgress, onSegmentDetected, from: start, to: end, ffmpegHwaccel }) });
  }, [currentCutSegOrWholeTimeline, deleteCurrentCutSeg, showParametersDialog, getFfmpegParameters, setFfmpegParametersForDialog, filePath, detectSegments, activeVideoStreamIndex, setProgress, ffmpegHwaccel]);

  const detectSilentScenes = useCallback(async () => {
    const { start, end } = currentCutSegOrWholeTimeline;
    deleteCurrentCutSeg();
    const dialogType = 'silencedetect';
    const parameters = await showParametersDialog({ title: i18n.t('Enter parameters'), dialogType, parameters: getFfmpegParameters(dialogType), docUrl: 'https://ffmpeg.org/ffmpeg-filters.html#silencedetect' });
    if (parameters == null) return;
    setFfmpegParametersForDialog(dialogType, parameters);
    const { mode, ...filterOptions } = parameters;
    invariant(mode === '1' || mode === '2');
    invariant(filePath != null);
    await detectSegments({ name: 'silentScenes', workingText: i18n.t('Detecting silent scenes'), errorText: i18n.t('Failed to detect silent scenes'), fn: async (onSegmentDetected) => silenceDetect({ filePath, streamId: [...activeAudioStreamIndexes][0], filterOptions, boundingMode: mode === '1', onProgress: setProgress, onSegmentDetected, from: start, to: end, ffmpegHwaccel }) });
  }, [activeAudioStreamIndexes, currentCutSegOrWholeTimeline, deleteCurrentCutSeg, detectSegments, ffmpegHwaccel, filePath, getFfmpegParameters, setFfmpegParametersForDialog, setProgress, showParametersDialog]);

  const detectSceneChanges = useCallback(async () => {
    const { start, end } = currentCutSegOrWholeTimeline;
    deleteCurrentCutSeg();
    const dialogType = 'sceneChange';
    const parameters = await showParametersDialog({ title: i18n.t('Enter parameters'), dialogType, parameters: getFfmpegParameters(dialogType) });
    if (parameters == null) return;
    setFfmpegParametersForDialog(dialogType, parameters);
    invariant(filePath != null);
    // eslint-disable-next-line prefer-destructuring
    const minChange = parameters['minChange'];
    invariant(minChange != null);
    await detectSegments({ name: 'sceneChanges', workingText: i18n.t('Detecting scene changes'), errorText: i18n.t('Failed to detect scene changes'), fn: async (onSegmentDetected) => ffmpegDetectSceneChanges({ filePath, streamId: activeVideoStreamIndex, minChange, onProgress: setProgress, onSegmentDetected, from: start, to: end, ffmpegHwaccel }) });
  }, [activeVideoStreamIndex, currentCutSegOrWholeTimeline, deleteCurrentCutSeg, detectSegments, ffmpegHwaccel, filePath, getFfmpegParameters, setFfmpegParametersForDialog, setProgress, showParametersDialog]);

  const createSegmentsFromKeyframes = useCallback(async () => {
    const { start, end } = currentCutSegOrWholeTimeline;
    deleteCurrentCutSeg();
    if (!videoStream) return;
    invariant(filePath != null);
    const keyframes = (await readFrames({ filePath, from: start, to: end, streamIndex: videoStream.index })).filter((frame) => frame.keyframe);
    const newSegments = mapTimesToSegments(keyframes.map((keyframe) => keyframe.time), true);
    loadCutSegments({ segments: newSegments, append: true, getNextCurrentSegIndex: (edl) => edl.length - 1, clampDuration: fileDuration });
  }, [currentCutSegOrWholeTimeline, deleteCurrentCutSeg, fileDuration, filePath, loadCutSegments, videoStream]);

  const removeSegments = useCallback((removeSegmentIds: string[]) => {
    if (removeSegmentIds.length === 0) return;

    const result = removeSourceSegments({
      segments: cutSegments,
      removeSegmentIds,
      activeSegmentId: currentCutSeg?.segId,
      sourceTime: Math.min(Math.max(getRelevantTime(), 0), fileDurationNonZero),
      sourceDuration: fileDurationNonZero,
    });

    if (result.segments.length === 0) {
      clearSegColorCounter();
      setCurrentSegIndex(0);
      safeSetCutSegments([]);
      return;
    }

    setCurrentSegIndex(result.activeIndex);
    if (result.normalizedSourceTime != null && Math.abs(result.normalizedSourceTime - getRelevantTime()) > 0.000001) seekAbs(result.normalizedSourceTime);
    safeSetCutSegments(result.segments);
  }, [clearSegColorCounter, currentCutSeg?.segId, cutSegments, fileDurationNonZero, getRelevantTime, safeSetCutSegments, seekAbs]);

  const removeSegment = useCallback((index: number, wholeSegment?: true) => {
    const seg = cutSegments[index];
    if (seg == null) return;
    if (wholeSegment || seg.end == null) {
      // remove whole segment
      removeSegments([seg.segId]);
    } else {
      // remove end cut point first
      safeSetCutSegments((existingSegments) => existingSegments.map((existingSegment, i) => (
        i === index ? {
          ...existingSegment,
          end: undefined,
        } : existingSegment)));
    }
  }, [cutSegments, removeSegments, safeSetCutSegments]);

  const invertAllSegments = useCallback(() => {
    // treat markers as 0 length
    const sortedSegments = sortSegments(cutSegments);

    const inverseSegmentsAndMarkers = invertSegments(sortedSegments, true, true, fileDuration);

    if (inverseSegmentsAndMarkers.length === 0) {
      errorToast(i18n.t('Make sure you have no overlapping segments.'));
      return;
    }
    // preserve segColorIndex (which represent colors) when inverting
    const newInverseCutSegments = inverseSegmentsAndMarkers.map((inverseSegment, index) => addSegmentColorIndex(createSegment(inverseSegment), index));
    safeSetCutSegments(newInverseCutSegments, fileDuration);
  }, [cutSegments, fileDuration, safeSetCutSegments]);

  const fillSegmentsGaps = useCallback(() => {
    // treat markers as 0 length
    const sortedSegments = sortSegments(selectedSegments.map(({ end, ...rest }) => ({ ...rest, end: end ?? rest.start })));

    const inverseSegmentsAndMarkers = invertSegments(sortedSegments, true, true, fileDuration);

    if (inverseSegmentsAndMarkers.length === 0) {
      errorToast(i18n.t('Make sure you have no overlapping segments.'));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const newInverseCutSegments = inverseSegmentsAndMarkers.map(({ name: _ignored, ...segment }) => createIndexedSegment({ segment, incrementCount: true }));
    safeSetCutSegments((existing) => ([...existing, ...newInverseCutSegments]));
  }, [createIndexedSegment, fileDuration, selectedSegments, safeSetCutSegments]);

  const combineOverlappingSegments = useCallback(() => {
    safeSetCutSegments((existingSegments) => [
      ...existingSegments.filter((s) => !s.selected),
      ...combineOverlappingSegments2(existingSegments.filter((s) => s.selected)), // only process selected
    ]);
  }, [safeSetCutSegments]);

  const combineSelectedSegments = useCallback(() => {
    safeSetCutSegments((existingSegments) => combineSelectedSegments2(existingSegments));
  }, [safeSetCutSegments]);

  const updateSegAtIndex = useCallback<UpdateSegAtIndex>((index, newProps) => {
    if (index < 0) return;
    const cutSegmentsNew = [...cutSegments];
    const existing = cutSegments[index];
    invariant(existing != null);
    cutSegmentsNew.splice(index, 1, { ...existing, ...newProps });
    safeSetCutSegments(cutSegmentsNew, fileDuration);
  }, [cutSegments, safeSetCutSegments, fileDuration]);

  const setCutTime = useCallback((type: 'start' | 'end' | 'move', time: number | undefined) => {
    if (!isDurationValid(fileDuration) || currentCutSeg == null) return;

    const clampStart = (start: number) => Math.min(Math.max(start, 0), fileDuration);
    const clampEnd = (end?: number | undefined) => (end != null ? Math.min(Math.max(end, 0), fileDuration) : undefined);

    if (type === 'start') {
      invariant(time != null);
      if (currentCutSeg.end != null && time >= currentCutSeg.end) {
        throw new UserFacingError(i18n.t('Segment start time must precede end time'));
      }
      updateSegAtIndex(currentSegIndexSafe, { start: clampStart(time) });
    }
    if (type === 'end') {
      if (time != null && time <= currentCutSeg.start) {
        throw new UserFacingError(i18n.t('Segment start time must precede end time'));
      }
      updateSegAtIndex(currentSegIndexSafe, { end: clampEnd(time) });
    }
    if (type === 'move') {
      invariant(time != null);
      updateSegAtIndex(currentSegIndexSafe, {
        start: clampStart(time),
        ...(currentCutSeg.end != null && { end: clampEnd(time + (currentCutSeg.end - currentCutSeg.start)) }),
      });
    }
  }, [currentSegIndexSafe, currentCutSeg, fileDuration, updateSegAtIndex]);

  const snapCutTimeToSourceFrame = useCallback(async (time: number) => {
    const clampedTime = Math.min(Math.max(time, 0), fileDurationNonZero);
    if (clampedTime === 0 || clampedTime === fileDurationNonZero) return clampedTime;

    if (filePath != null && videoStream != null) {
      const searchWindow = 2;
      const parsedFormatStartTime = Number.parseFloat(mainFileMeta?.format.start_time ?? '');
      const temporalStartTimes = (mainFileMeta?.streams ?? []).flatMap((stream) => {
        if (stream.codec_type !== 'video' && stream.codec_type !== 'audio') return [];
        const parsed = Number.parseFloat(stream.start_time ?? '');
        return Number.isFinite(parsed) ? [parsed] : [];
      });
      let sourceStartTime = 0;
      if (Number.isFinite(parsedFormatStartTime)) sourceStartTime = parsedFormatStartTime;
      else if (temporalStartTimes.length > 0) sourceStartTime = Math.min(...temporalStartTimes);
      const frames = await readFrames({
        filePath,
        from: sourceStartTime + Math.max(clampedTime - searchWindow / 2, 0),
        to: sourceStartTime + Math.min(clampedTime + searchWindow / 2, fileDurationNonZero),
        streamIndex: videoStream.index,
      });
      return Math.min(Math.max(snapSourceTimeToFramePts(clampedTime, frames.map(({ time: frameTime }) => frameTime - sourceStartTime)), 0), fileDurationNonZero);
    }

    const activeAudioStream = mainFileMeta?.streams.find((stream) => stream.codec_type === 'audio' && activeAudioStreamIndexes.has(stream.index));
    const sampleRate = activeAudioStream?.sample_rate == null ? undefined : Number.parseInt(activeAudioStream.sample_rate, 10);
    if (sampleRate != null && Number.isFinite(sampleRate) && sampleRate > 0) return Math.round(clampedTime * sampleRate) / sampleRate;
    return clampedTime;
  }, [activeAudioStreamIndexes, fileDurationNonZero, filePath, mainFileMeta?.format.start_time, mainFileMeta?.streams, videoStream]);

  const modifySelectedSegmentTimes = useCallback(async (transformSegment: <T extends SegmentBase>(s: T) => Promise<T> | T, concurrency = 5) => {
    const newSegments = await pMap(cutSegments, async (segment) => {
      if (!segment.selected) return segment; // pass thru non-selected segments

      return transformSegment(segment);
    }, { concurrency });

    safeSetCutSegments(newSegments, fileDuration);
  }, [cutSegments, fileDuration, safeSetCutSegments]);

  const alignSegmentTimesToKeyframes = useCallback(async () => {
    if (!videoStream || workingRef.current) return;
    try {
      const response = await askForAlignSegments();
      if (response == null) return;
      setWorking({ text: i18n.t('Aligning segments to keyframes') });
      const { mode, startOrEnd } = response;
      await modifySelectedSegmentTimes(async (segment) => {
        const newSegment = { ...segment };

        const align = async (key: 'start' | 'end') => {
          const time = newSegment[key];
          invariant(filePath != null);
          if (time != null) {
            const keyframe = await findKeyframeNearTime({
              filePath,
              streamIndex: videoStream.index,
              time,
              mode: mode === 'opposing' ? (key === 'start' ? 'before' : 'after') : mode,
            });
            if (keyframe == null) throw new UserFacingError(i18n.t('Cannot find any keyframe within 60 seconds of frame {{time}}', { time }));
            newSegment[key] = keyframe;
          }
        };
        if (startOrEnd.includes('start')) await align('start');
        if (startOrEnd.includes('end')) await align('end');
        return newSegment;
      });
    } catch (err) {
      handleError({ err });
    } finally {
      setWorking(undefined);
    }
  }, [videoStream, workingRef, setWorking, modifySelectedSegmentTimes, filePath, handleError]);

  const updateSegOrder = useCallback((index: number, newOrder: number) => {
    if (newOrder > cutSegments.length - 1 || newOrder < 0) return;
    const newSegments = [...cutSegments];
    const removedSeg = newSegments.splice(index, 1)[0];
    invariant(removedSeg != null);
    newSegments.splice(newOrder, 0, removedSeg);
    safeSetCutSegments(newSegments);
    setCurrentSegIndex(newOrder);
  }, [cutSegments, setCurrentSegIndex, safeSetCutSegments]);

  const updateSegOrders = useCallback((newOrders: string[]) => {
    const newSegments = sortBy(cutSegments, (seg) => newOrders.indexOf(seg.segId));
    safeSetCutSegments(newSegments);
    if (currentCutSeg != null) {
      const newCurrentSegIndex = newOrders.indexOf(currentCutSeg.segId);
      if (newCurrentSegIndex !== -1 && newCurrentSegIndex < newSegments.length) setCurrentSegIndex(newCurrentSegIndex);
    }
  }, [cutSegments, safeSetCutSegments, currentCutSeg, setCurrentSegIndex]);

  const reorderSegsByStartTime = useCallback(() => {
    safeSetCutSegments(sortBy(cutSegments, (seg) => seg.start));
  }, [cutSegments, safeSetCutSegments]);

  const addSegment = useCallback(async () => {
    try {
      const suggestedStart = await snapCutTimeToSourceFrame(getRelevantTime());
      /* if (keyframeCut) {
        const keyframeAlignedStart = getSafeCutTime(suggestedStart, true);
        if (keyframeAlignedStart != null) suggestedStart = keyframeAlignedStart;
      } */

      if (fileDuration == null || suggestedStart >= fileDuration) return;

      const liveSegments = cutSegmentsRef.current;
      const initial = isInitialSegment(liveSegments);

      const newSegment = createIndexedSegment({ segment: { start: suggestedStart }, incrementCount: !initial });

      // if initial segment, replace it instead
      const cutSegmentsNew = initial
        ? [newSegment]
        : [...liveSegments, newSegment];

      safeSetCutSegments(cutSegmentsNew, fileDuration);
      setCurrentSegIndex(cutSegmentsNew.length - 1);
    } catch (err) {
      console.error(err);
    }
  }, [getRelevantTime, fileDuration, createIndexedSegment, safeSetCutSegments, snapCutTimeToSourceFrame]);

  const duplicateSegment = useCallback((segment: Pick<StateSegment, 'start' | 'end'> & Partial<Pick<StateSegment, 'name'>>) => {
    try {
      // Cannot duplicate if seg is not finished
      if (segment.start === undefined && segment.end === undefined) return;

      const cutSegmentsNew = [
        ...cutSegments,
        createIndexedSegment({ segment: { start: segment.start, end: segment.end, name: segment.name }, incrementCount: true }),
      ];

      safeSetCutSegments(cutSegmentsNew);
      setCurrentSegIndex(cutSegmentsNew.length - 1);
    } catch (err) {
      console.error(err);
    }
  }, [createIndexedSegment, cutSegments, safeSetCutSegments]);

  const duplicateCurrentSegment = useCallback(() => {
    if (currentCutSeg == null) return;
    duplicateSegment(currentCutSeg);
  }, [currentCutSeg, duplicateSegment]);

  const setCutStart = useCallback(async () => {
    if (!checkFileOpened()) return;

    const relevantTime = getRelevantTime();
    // https://github.com/mifi/lossless-cut/issues/168
    // If current time is after the end of the current segment in the timeline, or there is no segment,
    // conveniently add a new segment that starts at playerTime
    if (currentCutSeg == null || (currentCutSeg.end != null && relevantTime >= currentCutSeg.end)) {
      await addSegment();
    } else {
      try {
        const targetSegmentId = currentCutSeg.segId;
        const startTime = await snapCutTimeToSourceFrame(relevantTime);
        /* if (keyframeCut) {
          const keyframeAlignedCutTo = getSafeCutTime(startTime, true);
          if (keyframeAlignedCutTo != null) startTime = keyframeAlignedCutTo;
        } */
        const liveSegments = cutSegmentsRef.current;
        const targetIndex = liveSegments.findIndex(({ segId }) => segId === targetSegmentId);
        if (targetIndex === -1) return;
        const liveTarget = liveSegments[targetIndex]!;
        if (liveTarget.end != null && startTime >= liveTarget.end) {
          throw new UserFacingError(i18n.t('Segment start time must precede end time'));
        }
        const newSegments = [...liveSegments];
        newSegments[targetIndex] = { ...liveTarget, start: startTime };
        safeSetCutSegments(newSegments, fileDuration);
      } catch (err) {
        toastError(err);
      }
    }
  }, [addSegment, checkFileOpened, currentCutSeg, fileDuration, getRelevantTime, safeSetCutSegments, snapCutTimeToSourceFrame]);

  const setCutEnd = useCallback(async () => {
    if (!checkFileOpened()) return;
    const targetSegmentId = currentCutSeg?.segId;
    if (targetSegmentId == null) return;

    try {
      const endTime = await snapCutTimeToSourceFrame(getRelevantTime());

      /* if (keyframeCut) {
        const keyframeAlignedCutTo = getSafeCutTime(endTime, false);
        if (keyframeAlignedCutTo != null) endTime = keyframeAlignedCutTo;
      } */
      const liveSegments = cutSegmentsRef.current;
      const targetIndex = liveSegments.findIndex(({ segId }) => segId === targetSegmentId);
      if (targetIndex === -1) return;
      const liveTarget = liveSegments[targetIndex]!;
      if (endTime <= liveTarget.start) {
        throw new UserFacingError(i18n.t('Segment start time must precede end time'));
      }
      const newSegments = [...liveSegments];
      newSegments[targetIndex] = { ...liveTarget, end: endTime };
      safeSetCutSegments(newSegments, fileDuration);
    } catch (err) {
      toastError(err);
    }
  }, [checkFileOpened, currentCutSeg?.segId, fileDuration, getRelevantTime, safeSetCutSegments, snapCutTimeToSourceFrame]);

  const labelSegment = useCallback(async (index: number) => {
    const seg = cutSegments[index];
    if (seg == null) return;
    const { name } = seg;
    const value = await labelSegmentDialog({ currentName: name, maxLength: maxLabelLength });
    if (value != null) updateSegAtIndex(index, { name: value });
  }, [cutSegments, updateSegAtIndex, maxLabelLength]);

  const selectSegments = useCallback((segmentsToSelect: { segId: string }[]) => {
    const segIdsToSelect = new Set(segmentsToSelect.map(({ segId }) => segId));
    if (segIdsToSelect.size === 0) return; // no point in selecting none
    setCutSegments((existing) => existing.map(({ selected, ...segment }) => ({
      ...segment,
      selected: selected || segIdsToSelect.has(segment.segId),
    })));
  }, [setCutSegments]);

  const findSegmentsAtCursor = useCallback((currentTime: number) => (
    cutSegments.flatMap((segment, index) => {
      if (
        (segment.start <= currentTime)
        && (segment.end != null && segment.end >= currentTime)
      ) {
        return [index];
      }
      return [];
    }).reverse() // reverse, so that if we are on multiple, we select the last first. That way, auto play selected segments won't go on repeat on the same segment
  ), [cutSegments]);

  const focusSegmentAtCursor = useCallback(() => {
    const relevantTime = getRelevantTime();
    const [firstSegmentAtCursorIndex] = findSegmentsAtCursor(relevantTime);
    if (firstSegmentAtCursorIndex == null) return;
    setCurrentSegIndex(firstSegmentAtCursorIndex);
  }, [findSegmentsAtCursor, getRelevantTime]);

  const selectSegmentsAtCursor = useCallback(() => {
    const relevantTime = getRelevantTime();
    selectSegments(findSegmentsAtCursor(relevantTime).flatMap((index) => (cutSegments[index] ? [cutSegments[index]] : [])));
  }, [cutSegments, findSegmentsAtCursor, getRelevantTime, selectSegments]);

  const splitCurrentSegment = useCallback(async (time?: number) => {
    if (!checkFileOpened()) return;

    const requestedTime = time ?? getRelevantTime();
    const timeEpsilon = 0.000001;
    const requestedTarget = cutSegmentsRef.current.flatMap((segment) => {
      const segmentEnd = segment.end;
      if (segmentEnd == null) return [];
      return segment.start + timeEpsilon < requestedTime && segmentEnd - timeEpsilon > requestedTime ? [segment] : [];
    }).reverse()[0];
    if (requestedTarget == null) {
      errorToast(i18n.t('No segment to split. Please move cursor over the segment you want to split'));
      return;
    }

    let relevantTime: number;
    try {
      relevantTime = await snapCutTimeToSourceFrame(requestedTime);
    } catch (err) {
      handleError({ err, title: i18n.t('Unable to resolve the exact source frame for this cut point') });
      return;
    }
    const liveSegments = cutSegmentsRef.current;
    const targetIndex = liveSegments.findIndex(({ segId }) => segId === requestedTarget.segId);
    const targetSegment = targetIndex === -1 ? undefined : liveSegments[targetIndex];
    const targetEnd = targetSegment?.end;
    const segmentAtCursor = targetSegment != null && targetEnd != null && targetSegment.start + timeEpsilon < relevantTime && targetEnd - timeEpsilon > relevantTime
      ? { segment: targetSegment, index: targetIndex }
      : undefined;

    if (segmentAtCursor != null) {
      const [firstPart, secondPart] = splitSourceSegment({
        segment: segmentAtCursor.segment,
        splitTime: relevantTime,
        sourceDuration: fileDurationNonZero,
        segmentIds: {
          before: createSegment().segId,
          after: createSegment().segId,
        },
      });
      const newSegments = [...liveSegments];
      newSegments.splice(segmentAtCursor.index, 1, firstPart, secondPart);
      safeSetCutSegments(newSegments, fileDuration);
      setCurrentSegIndex(segmentAtCursor.index + 1);
      return;
    }

    errorToast(i18n.t('No segment to split. Please move cursor over the segment you want to split'));
  }, [checkFileOpened, fileDuration, fileDurationNonZero, getRelevantTime, handleError, safeSetCutSegments, setCurrentSegIndex, snapCutTimeToSourceFrame]);

  const createNumSegments = useCallback(async () => {
    if (!checkFileOpened() || currentCutSegOrWholeTimeline.duration <= 0) return;
    const segments = await createNumSegmentsDialog(currentCutSegOrWholeTimeline.duration);
    if (!segments) return;
    deleteCurrentCutSeg();
    loadCutSegments({ segments: offsetSegments(segments, currentCutSegOrWholeTimeline.start), append: true, getNextCurrentSegIndex: (edl) => edl.length - 1, clampDuration: fileDuration });
  }, [checkFileOpened, currentCutSegOrWholeTimeline.duration, currentCutSegOrWholeTimeline.start, deleteCurrentCutSeg, fileDuration, loadCutSegments]);

  const createFixedDurationSegments = useCallback(async () => {
    if (!checkFileOpened() || currentCutSegOrWholeTimeline.duration <= 0) return;
    const segmentDuration = await askForSegmentDuration({ totalDuration: currentCutSegOrWholeTimeline.duration, inputPlaceholder: timecodePlaceholder, parseTimecode });
    if (segmentDuration == null) return;
    deleteCurrentCutSeg();
    const segments = makeDurationSegments(segmentDuration, currentCutSegOrWholeTimeline.duration);
    loadCutSegments({ segments: offsetSegments(segments, currentCutSegOrWholeTimeline.start), append: true, getNextCurrentSegIndex: (edl) => edl.length - 1, clampDuration: fileDuration });
  }, [checkFileOpened, currentCutSegOrWholeTimeline.duration, currentCutSegOrWholeTimeline.start, deleteCurrentCutSeg, fileDuration, loadCutSegments, parseTimecode, timecodePlaceholder]);

  const createFixedByteSizedSegments = useCallback(async () => {
    if (!checkFileOpened() || !isDurationValid(fileDuration)) return;
    invariant(mainFileMeta != null);
    const fileSize = getFileSize(mainFileMeta.format);
    invariant(fileSize != null);
    const segmentDuration = await createFixedByteSixedSegmentsDialog({ fileDuration, fileSize });
    if (segmentDuration == null) return;
    loadCutSegments({ segments: makeDurationSegments(segmentDuration, fileDuration), append: true, clampDuration: fileDuration });
  }, [checkFileOpened, fileDuration, loadCutSegments, mainFileMeta]);

  const getSegEstimatedSize = useCallback((segment: Pick<StateSegment, 'start' | 'end'>) => {
    if (mainFileMeta == null || !isDurationValid(fileDuration) || segment.end == null) return undefined;
    const fileSize = getFileSize(mainFileMeta.format);
    if (fileSize == null) return undefined;
    const segDuration = segment.end - segment.start;
    return Math.round((segDuration / fileDuration) * fileSize);
  }, [fileDuration, mainFileMeta]);

  const createRandomSegments = useCallback(async () => {
    if (!checkFileOpened() || currentCutSegOrWholeTimeline.duration <= 0) return;
    const segments = await createRandomSegmentsDialog(currentCutSegOrWholeTimeline.duration);
    if (!segments) return;
    deleteCurrentCutSeg();
    loadCutSegments({ segments: offsetSegments(segments, currentCutSegOrWholeTimeline.start), append: true, getNextCurrentSegIndex: (edl) => edl.length - 1, clampDuration: fileDuration });
  }, [checkFileOpened, currentCutSegOrWholeTimeline.duration, currentCutSegOrWholeTimeline.start, deleteCurrentCutSeg, fileDuration, loadCutSegments]);

  const selectSegmentsByLabel = useCallback(async () => {
    const value = await selectSegmentsByLabelDialog(currentCutSeg?.name);
    if (value == null) return;
    selectSegments(cutSegments.filter((seg) => seg.name === value));
  }, [currentCutSeg?.name, cutSegments, selectSegments]);

  const selectAllMarkers = useCallback(() => {
    selectSegments(cutSegments.filter((seg) => seg.end == null));
  }, [cutSegments, selectSegments]);

  const selectSegmentsByExpr = useCallback(async () => {
    const matchSegment = async (seg: StateSegment, index: number, expr: string) => (
      (await safeishEval(expr, { segment: getScopeSegment(seg, index) })) === true
    );

    const getSegmentsToSelect = async (expr: string) => (
      await pMap(cutSegments, async (seg, index) => (
        ((await matchSegment(seg, index, expr)) ? [seg] : [])
      ), { concurrency: 5 })).flat();

    const onSubmit = async (value: string) => {
      try {
        if (value.trim().length === 0) return { error: i18n.t('Please enter a JavaScript expression.') };
        const segmentsToSelect = await getSegmentsToSelect(value);
        if (segmentsToSelect.length === 0) return { error: i18n.t('No segments match this expression.') };
        if (segmentsToSelect.length === cutSegments.length) return { error: i18n.t('All segments match this expression.') };
        selectSegments(segmentsToSelect);
        return undefined;
      } catch (err) {
        if (err instanceof Error) {
          return { error: i18n.t('Expression failed: {{errorMessage}}', { errorMessage: err.message }) };
        }
        throw err;
      }
    };

    showGenericDialog({
      isAlert: true,
      render: () => (
        <ExpressionDialog
          onSubmit={onSubmit}
          confirmButtonText={t('Select segments')}
          examples={[
            { name: i18n.t('Segment duration less than 5 seconds'), code: 'segment.duration < 5' },
            { name: i18n.t('Segment starts after 01:00'), code: 'segment.start > 60' },
            { name: i18n.t('Segment label (exact)'), code: "segment.label === 'My label'" },
            { name: i18n.t('Segment label (starts with)'), code: "segment.label.startsWith('My lab')" },
            { name: i18n.t('Segment label (regexp)'), code: '/^My label/.test(segment.label)' },
            { name: i18n.t('Segment tag value'), code: "segment.tags.myTag === 'tag value'" },
            { name: i18n.t('Markers'), code: 'segment.end == null' },
          ]}
          title={i18n.t('Select segments by expression')}
          description={<Trans>Enter a JavaScript expression which will be evaluated for each segment. Segments for which the expression evaluates to &quot;true&quot; will be selected. <button type="button" className="link-button" onClick={() => mainApi.openExternal(selectSegmentByExpressionHelpUrl)}>View available syntax.</button></Trans>}
          variables={['segment.index', 'segment.label', 'segment.start', 'segment.end', 'segment.duration', 'segment.tags.*']}
        />
      ),
    });
  }, [showGenericDialog, t, getScopeSegment, cutSegments, selectSegments]);

  const mutateSegmentsByExpr = useCallback(async () => {
    async function mutateSegment(seg: StateSegment, index: number, expr: string) {
      const response = (await safeishEval(expr, { segment: getScopeSegment(seg, index) }));
      invariant(typeof response === 'object' && response != null, i18n.t('The expression must return an object'));
      const ret: Partial<Pick<StateSegment, 'name' | 'start' | 'end' | 'tags'>> = {};
      if ('label' in response) {
        if (typeof response.label !== 'string') throw new UserFacingError(i18n.t('"{{property}}" must be a string', { property: 'label' }));
        ret.name = response.label;
      }
      if ('start' in response) {
        if (typeof response.start !== 'number') throw new UserFacingError(i18n.t('"{{property}}" must be a number', { property: 'start' }));
        ret.start = response.start;
      }
      if ('end' in response) {
        if (!(typeof response.end === 'number' || response.end === undefined)) throw new UserFacingError(i18n.t('"{{property}}" must be a number', { property: 'end' }));
        ret.end = response.end;
      }
      if ('tags' in response) {
        const tags = segmentTagsSchema.safeParse(response.tags);
        if (!tags.success) throw new UserFacingError(i18n.t('"{{property}}" must be an object of strings', { property: 'tags' }));
        ret.tags = tags.data;
      }
      return ret;
    }

    const mutateSegments = async (expr: string) => (await pMap(cutSegments, async (seg, index) => ({
      ...seg,
      ...(seg.selected && await mutateSegment(seg, index, expr)),
    }), { concurrency: 5 })).flat();

    const onSubmit = async (value: string) => {
      try {
        if (value.trim().length === 0) return { error: i18n.t('Please enter a JavaScript expression.') };
        const mutated = await mutateSegments(value);

        safeSetCutSegments(mutated, fileDuration);

        return undefined;
      } catch (err) {
        if (err instanceof Error) {
          return { error: i18n.t('Expression failed: {{errorMessage}}', { errorMessage: err.message }) };
        }
        throw err;
      }
    };

    showGenericDialog({
      isAlert: true,
      render: () => (
        <ExpressionDialog
          onSubmit={onSubmit}
          confirmButtonText={t('Apply change')}
          examples={[
            { name: i18n.t('Expand segments +5 sec'), code: '{ start: segment.start - 5, end: segment.end + 5 }' },
            { name: i18n.t('Shrink segments -5 sec'), code: '{ start: segment.start + 5, end: segment.end - 5 }' },
            { name: i18n.t('Center segments around start time'), code: '{ start: segment.start - 5, end: segment.start + 5 }' },
            // eslint-disable-next-line no-template-curly-in-string
            { name: i18n.t('Add number suffix to label'), code: '{ label: `${segment.label} ${segment.index + 1}` }' },
            { name: i18n.t('Add a tag to every even segment'), code: '{ tags: (segment.index + 1) % 2 === 0 ? { ...segment.tags, even: \'true\' } : segment.tags }' },
            { name: i18n.t('Convert segments to markers'), code: '{ end: undefined }' },
            { name: i18n.t('Convert markers to segments'), code: '{ ...(segment.end == null && { end: segment.start + 5 }) }' },
          ]}
          title={i18n.t('Edit segments by expression')}
          description={<Trans>Enter a JavaScript expression which will be evaluated for each selected segment. Returned properties will be edited. <button type="button" className="link-button" onClick={() => mainApi.openExternal(editSegmentByExpressionHelpUrl)}>View available syntax.</button></Trans>}
          variables={['segment.index', 'segment.label', 'segment.start', 'segment.end', 'segment.tags.*']}
        />
      ),
    });
  }, [cutSegments, fileDuration, getScopeSegment, safeSetCutSegments, showGenericDialog, t]);

  const labelSelectedSegments = useCallback(async () => {
    const firstSelectedSegment = selectedSegments[0];
    if (firstSelectedSegment == null) return;
    const { name } = firstSelectedSegment;
    const value = await labelSegmentDialog({ currentName: name, maxLength: maxLabelLength });
    if (value == null) return;
    safeSetCutSegments((existingSegments) => existingSegments.map((existingSegment) => {
      if (!existingSegment.selected) return existingSegment;
      return { ...existingSegment, name: value };
    }));
  }, [maxLabelLength, selectedSegments, safeSetCutSegments]);

  const maybeCreateFullLengthSegment = useCallback((newFileDuration: number) => {
    // don't use safeSetCutSegments because we want to set initial: true
    setCutSegments((existing) => {
      if (existing.length > 0 || newFileDuration <= 0) return existing;
      const segment = { start: 0, end: newFileDuration, initial: true } as const;
      console.log('Creating initial segment', segment);
      return [createIndexedSegment({ segment })];
    });
  }, [createIndexedSegment, setCutSegments]);

  const selectedSegmentsToExport = useMemo<SegmentToExport[]>(() => {
    const nonMarkers = filterNonMarkers(selectedSegments);
    // Exclude the initial segment to prevent cutting when not really needed
    // (for example if duration changes after the placeholder was created).
    return nonMarkers.filter((seg) => !seg.initial);
  }, [selectedSegments]);

  const segmentsToExport = useMemo<SegmentToExport[]>(() => {
    // 'segmentsToChaptersOnly' is a special mode where all segments will be simply written out as chapters to one file: https://github.com/mifi/lossless-cut/issues/993#issuecomment-1037927595
    // Chapters export mode: Emulate no cuts (full timeline)
    if (segmentsToChaptersOnly) return [];
    // in other modes, return all selected segments
    return selectedSegmentsToExport;
  }, [selectedSegmentsToExport, segmentsToChaptersOnly]);

  const removeSelectedSegments = useCallback(() => removeSegments(selectedSegments.map((seg) => seg.segId)), [removeSegments, selectedSegments]);

  const selectOnlySegment = useCallback((seg: Pick<StateSegment, 'segId'>) => setCutSegments((existing) => existing.map((segment) => ({
    ...segment, selected: segment.segId === seg.segId,
  }))), [setCutSegments]);

  const toggleSegmentSelected = useCallback((seg: Pick<StateSegment, 'segId'>) => setCutSegments((existing) => existing.map((segment) => {
    if (segment.segId !== seg.segId) return segment;
    return { ...segment, selected: !segment.selected };
  })), [setCutSegments]);

  const deselectAllSegments = useCallback(() => setCutSegments((existing) => existing.map((segment) => ({ ...segment, selected: false }))), [setCutSegments]);
  const selectAllSegments = useCallback(() => setCutSegments((existing) => existing.map((segment) => ({ ...segment, selected: true }))), [setCutSegments]);
  const invertSelectedSegments = useCallback(() => setCutSegments((existing) => existing.map((segment) => ({ ...segment, selected: !segment.selected }))), [setCutSegments]);

  const selectOnlyCurrentSegment = useCallback(() => {
    if (currentCutSeg == null) return;
    selectOnlySegment(currentCutSeg);
  }, [currentCutSeg, selectOnlySegment]);

  const toggleCurrentSegmentSelected = useCallback(() => {
    if (currentCutSeg == null) return;
    toggleSegmentSelected(currentCutSeg);
  }, [currentCutSeg, toggleSegmentSelected]);

  return {
    cutSegments,
    cutSegmentsHistory,
    createSegmentsFromKeyframes,
    shuffleSegments,
    detectBlackScenes,
    detectSilentScenes,
    detectSceneChanges,
    removeSegments,
    removeSegment,
    invertAllSegments,
    fillSegmentsGaps,
    combineOverlappingSegments,
    combineSelectedSegments,
    modifySelectedSegmentTimes,
    alignSegmentTimesToKeyframes,
    updateSegOrder,
    updateSegOrders,
    reorderSegsByStartTime,
    addSegment,
    duplicateCurrentSegment,
    duplicateSegment,
    setCutStart,
    setCutEnd,
    labelSegment,
    splitCurrentSegment,
    focusSegmentAtCursor,
    selectSegmentsAtCursor,
    createNumSegments,
    createFixedDurationSegments,
    createFixedByteSizedSegments,
    createRandomSegments,
    getSegEstimatedSize,
    haveInvalidSegs,
    currentSegIndexSafe,
    currentCutSeg,
    clearSegments,
    clearSegColorCounter,
    loadCutSegments,
    selectedSegments,
    selectedSegmentsToExport,
    segmentsToExport,
    maybeCreateFullLengthSegment,

    setCurrentSegIndex,

    labelSelectedSegments,
    deselectAllSegments,
    selectAllSegments,
    selectOnlyCurrentSegment,
    toggleCurrentSegmentSelected,
    invertSelectedSegments,
    removeSelectedSegments,
    selectSegmentsByLabel,
    selectSegmentsByExpr,
    selectAllMarkers,
    mutateSegmentsByExpr,
    toggleSegmentSelected,
    selectOnlySegment,
    setCutTime,
    updateSegAtIndex,
    findSegmentsAtCursor,
    currentCutSegOrWholeTimeline,
    segColorCounter,
  };
}

export type UseSegments = ReturnType<typeof useSegments>;

export default useSegments;
