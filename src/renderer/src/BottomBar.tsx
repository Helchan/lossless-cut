import type { CSSProperties, ClipboardEvent, Dispatch, FormEvent, ReactNode, SetStateAction } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { MdRotate90DegreesCcw } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { IoMdKey, IoMdSpeedometer } from 'react-icons/io';
import { FaYinYang, FaTrashAlt, FaStepBackward, FaStepForward, FaCaretLeft, FaCaretRight, FaPause, FaPlay, FaImages, FaKey, FaExclamationTriangle } from 'react-icons/fa';
import { GiSoundWaves } from 'react-icons/gi';
// import useTraceUpdate from 'use-trace-update';
import invariant from 'tiny-invariant';

import { primaryTextColor, primaryColor, darkModeTransition, dangerColor } from './colors';
import SegmentCutpointButton from './components/SegmentCutpointButton';
import ToggleExportConfirm from './components/ToggleExportConfirm';

import SimpleModeButton from './components/SimpleModeButton';
import { mirrorTransform } from './util';
import getSwal from './swal';
import { useSegColors } from './contexts';
import { isExactDurationMatch } from './util/duration';
import useUserSettings from './hooks/useUserSettings';
import useActionTitle from './hooks/useActionTitle';
import { askForPlaybackRate, checkAppPath } from './dialogs';
import type { FormatTimecode, GetFrameCount, ParseTimecode, StateSegment } from './types';
import type { WaveformMode } from '../../common/types';
import type { Frame } from './ffmpeg';
import mainApi from './mainApi';


// eslint-disable-next-line react/display-name
const InvertCutModeButton = memo(({ invertCutSegments, setInvertCutSegments }: { invertCutSegments: boolean, setInvertCutSegments: Dispatch<SetStateAction<boolean>> }) => {
  const { t } = useTranslation();

  const onYinYangClick = useCallback(() => {
    setInvertCutSegments((v) => {
      const newVal = !v;
      getSwal().toast.fire({
        title: newVal
          ? t('When you export, selected segments on the timeline will be REMOVED - the surrounding areas will be KEPT')
          : t('When you export, selected segments on the timeline will be KEPT - the surrounding areas will be REMOVED.'),
      });
      return newVal;
    });
  }, [setInvertCutSegments, t]);

  return (
    <div>
      <motion.div
        animate={{ rotateX: invertCutSegments ? 0 : 180 }}
        transition={{ duration: 0.3 }}
      >
        <FaYinYang
          role="button"
          title={invertCutSegments ? t('Discard selected segments') : t('Keep selected segments')}
          style={{ display: 'block', fontSize: '1.5em', color: invertCutSegments ? dangerColor : undefined }}
          onClick={onYinYangClick}
        />
      </motion.div>
    </div>
  );
});


// eslint-disable-next-line react/display-name
const CutTimeInput = memo(({ disabled, darkMode, cutTime, setCutTime, startTimeOffset, seekAbs, currentCutSeg, isStart, formatTimecode, parseTimecode }: {
  disabled: boolean,
  darkMode: boolean,
  cutTime: number | undefined,
  setCutTime: (type: 'start' | 'end', v: number | undefined) => void,
  startTimeOffset: number,
  seekAbs: (a: number) => void,
  currentCutSeg: StateSegment | undefined,
  isStart?: boolean,
  formatTimecode: FormatTimecode,
  parseTimecode: ParseTimecode,
}) => {
  const { t } = useTranslation();
  const { getSegColor } = useSegColors();

  const [cutTimeManual, setCutTimeManual] = useState<string>();
  const [error, setError] = useState<boolean>(false);

  // Clear manual overrides if upstream cut time has changed
  useEffect(() => {
    // todo
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCutTimeManual(undefined);
    setError(false);
  }, [setCutTimeManual, currentCutSeg?.start, currentCutSeg?.end]);

  const isCutTimeManualSet = useCallback(() => cutTimeManual !== undefined, [cutTimeManual]);

  const border = useMemo(() => {
    const segColor = getSegColor(currentCutSeg);
    return `.1em solid ${darkMode ? segColor.desaturate(0.4).lightness(50).string() : segColor.desaturate(0.2).lightness(60).string()}`;
  }, [currentCutSeg, darkMode, getSegColor]);

  const setTime = useCallback((timeWithOffset: number | undefined) => {
    // Note: If we get an error from setCutTime, remain in the editing state (cutTimeManual)
    // https://github.com/mifi/lossless-cut/issues/988

    if (timeWithOffset == null) { // clear time
      invariant(!isStart);
      setCutTime('end', undefined);
      setCutTimeManual(undefined);
      setError(false);
      return;
    }

    const timeWithoutOffset = Math.max(timeWithOffset - startTimeOffset, 0);
    setCutTime(isStart ? 'start' : 'end', timeWithoutOffset);
    seekAbs(timeWithoutOffset);
    setCutTimeManual(undefined);
    setError(false);
  }, [isStart, seekAbs, setCutTime, startTimeOffset]);

  const isEmptyEndTime = useCallback((v: string | undefined) => !isStart && v?.trim() === '', [isStart]);

  const handleSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    try {
      if (isEmptyEndTime(cutTimeManual)) {
        setTime(undefined); // clear time
        return;
      }

      // Don't proceed if not a valid time value
      const timeWithOffset = cutTimeManual != null ? parseTimecode(cutTimeManual) : undefined;
      if (timeWithOffset === undefined) return;

      setTime(timeWithOffset);
    } catch (err) {
      console.warn('Cannot submit cut time', err);
    }
  }, [cutTimeManual, isEmptyEndTime, parseTimecode, setTime]);

  const parseAndSetCutTime = useCallback((text: string) => {
    if (isEmptyEndTime(text)) {
      setTime(undefined); // clear time
      return;
    }

    // Don't proceed if not a valid time value
    const timeWithOffset = parseTimecode(text);
    if (timeWithOffset === undefined) return;

    setTime(timeWithOffset);
  }, [isEmptyEndTime, parseTimecode, setTime]);

  const handleCutTimeInput = useCallback((text: string) => {
    try {
      if (isExactDurationMatch(text) || isEmptyEndTime(text)) {
        parseAndSetCutTime(text);
        return;
      }
    } catch (err) {
      console.warn(err);
      setError(true);
    }

    // else or if error, just set manual value, to make sure it doesn't jump to end https://github.com/mifi/lossless-cut/issues/988#issuecomment-3475870072
    setCutTimeManual(text);
  }, [isEmptyEndTime, parseAndSetCutTime]);

  const handleInputBlur = useCallback(() => {
    setCutTimeManual(undefined);
    setError(false);
  }, []);

  const handleCutTimePaste = useCallback((e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();

    try {
      const clipboardData = e.clipboardData.getData('Text');
      setCutTimeManual(clipboardData);
      parseAndSetCutTime(clipboardData);
      setError(false);
    } catch (err) {
      console.warn(err);
      setError(true);
    }
  }, [parseAndSetCutTime]);

  const handleContextMenu = useCallback(async () => {
    const text = await mainApi.readClipboardText();
    if (text) {
      try {
        setCutTimeManual(text);
        parseAndSetCutTime(text);
        setError(false);
      } catch (err) {
        console.warn(err);
        setError(true);
      }
    }
  }, [parseAndSetCutTime]);

  const style = useMemo<CSSProperties>(() => ({
    border,
    borderRadius: 5,
    backgroundColor: 'var(--gray-5)',
    transition: darkModeTransition,
    fontSize: 13,
    textAlign: 'center',
    padding: '1px 3px',
    marginTop: 0,
    marginBottom: 0,
    marginLeft: isStart ? 0 : 5,
    marginRight: isStart ? 5 : 0,
    boxSizing: 'border-box',
    fontFamily: 'monospace',
    letterSpacing: '-.05em',
    width: 94,
    outline: 'none',
    color: error ? dangerColor : (isCutTimeManualSet() ? 'var(--gray-12)' : 'var(--gray-11)'),
  }), [border, error, isCutTimeManualSet, isStart]);

  function renderValue() {
    if (isCutTimeManualSet()) return cutTimeManual;
    if (cutTime == null) return formatTimecode({ seconds: 0 }); // marker, see https://github.com/mifi/lossless-cut/issues/2590
    return formatTimecode({ seconds: cutTime + startTimeOffset });
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        disabled={disabled}
        style={style}
        type="text"
        title={isStart ? t('Manually input current segment\'s start time') : t('Manually input current segment\'s end time')}
        onChange={(e) => handleCutTimeInput(e.target.value)}
        onPaste={handleCutTimePaste}
        onBlur={handleInputBlur}
        onContextMenu={handleContextMenu}
        value={renderValue()}
      />
    </form>
  );
});

export interface BottomBarProps {
  zoom: number,
  isRotationSet: boolean,
  rotation: number,
  increaseRotation: () => void,
  cleanupFilesDialog: () => void,
  hasVideo: boolean,
  seekAbs: (a: number) => void,
  currentCutSeg: StateSegment | undefined,
  jumpTimelineStart: () => void,
  jumpTimelineEnd: () => void,
  jumpCutEnd: () => void,
  jumpCutStart: () => void,
  startTimeOffset: number,
  setCutTime: (type: 'start' | 'end', v: number | undefined) => void,
  playing: boolean,
  shortStep: (a: number) => void,
  togglePlay: () => void,
  hasAudio: boolean,
  keyframesEnabled: boolean,
  toggleShowKeyframes: () => void,
  seekClosestKeyframe: (a: number) => void,
  detectedFps: number | undefined,
  isFileOpened: boolean,
  darkMode: boolean,
  toggleShowThumbnails: () => void,
  toggleWaveformMode: () => void,
  waveformMode: WaveformMode | undefined,
  showThumbnails: boolean,
  outputPlaybackRate: number,
  setOutputPlaybackRate: (v: number) => void,
  formatTimecode: FormatTimecode,
  parseTimecode: ParseTimecode,
  playbackRate: number,
  currentFrame: Frame | undefined,
  displayTime: number,
  fileDurationNonZero: number,
  getFrameCount: GetFrameCount,
  selectedSegments: StateSegment[],
}

export function BottomBarFirstRow({ controls, leadingControls, trailingControls }: { controls: BottomBarProps, leadingControls?: ReactNode, trailingControls?: ReactNode }) {
  const {
    isFileOpened,
    isRotationSet,
    rotation,
    increaseRotation,
    cleanupFilesDialog,
    hasAudio,
    hasVideo,
    toggleWaveformMode,
    waveformMode,
    showThumbnails,
    toggleShowThumbnails,
    keyframesEnabled,
    toggleShowKeyframes,
    currentFrame,
    currentCutSeg,
    jumpTimelineStart,
    jumpTimelineEnd,
    jumpCutEnd,
    jumpCutStart,
    startTimeOffset,
    seekAbs,
    setCutTime,
    formatTimecode,
    parseTimecode,
    playing,
    shortStep,
    seekClosestKeyframe,
    togglePlay,
    darkMode,
    detectedFps,
    outputPlaybackRate,
    setOutputPlaybackRate,
    playbackRate,
  } = controls;

  const { t } = useTranslation();
  const { invertCutSegments, setInvertCutSegments, simpleMode, toggleSimpleMode, exportConfirmEnabled } = useUserSettings();
  const actionTitle = useActionTitle();

  const rotationStr = `${rotation}°`;

  const playStyle = useMemo<CSSProperties>(() => ({
    paddingLeft: playing ? 0 : '.1em',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2.3em',
    height: '2.3em',
    borderRadius: '50%',
    boxSizing: 'border-box',
  }), [playing]);

  const keyframeStyle = useMemo(() => ({
    color: currentFrame != null && currentFrame.keyframe ? primaryTextColor : undefined,
  }), [currentFrame]);

  const PlayPause = playing ? FaPause : FaPlay;

  useEffect(() => {
    checkAppPath();
  }, []);

  const handleChangePlaybackRateClick = useCallback(async () => {
    const newRate = await askForPlaybackRate({ detectedFps, outputPlaybackRate });
    if (newRate != null) setOutputPlaybackRate(newRate);
  }, [detectedFps, outputPlaybackRate, setOutputPlaybackRate]);

  const playbackRateRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    playbackRateRef.current?.animate([{ transform: 'scale(2)', color: 'var(--gray-12)', backgroundColor: playbackRate === 1 ? 'var(--cyan-10)' : (playbackRate < 1 ? 'var(--yellow-8)' : 'var(--orange-10)') }, {}], { duration: 200 });
  }, [playbackRate]);

  const fpsControl = isFileOpened && !simpleMode ? (
    <div style={{ whiteSpace: 'nowrap' }}>
      <IoMdSpeedometer title={t('Change FPS')} style={{ fontSize: '1.3em', verticalAlign: 'middle' }} role="button" onClick={handleChangePlaybackRateClick} />

      {detectedFps != null && (
        <span title={t('Video FPS')} role="button" onClick={handleChangePlaybackRateClick} style={{ color: 'var(--gray-11)', fontSize: '.7em', marginLeft: '.3em' }}>{(detectedFps * outputPlaybackRate).toFixed(3)}</span>
      )}
    </div>
  ) : undefined;

  const rotationControl = isFileOpened && !simpleMode && hasVideo ? (
    <div onClick={increaseRotation} role="button" style={{ whiteSpace: 'nowrap' }}>
      <MdRotate90DegreesCcw
        style={{ fontSize: '1.3em', verticalAlign: 'middle', color: isRotationSet ? primaryTextColor : undefined }}
        title={actionTitle(`${t('Set output rotation. Current: ')} ${isRotationSet ? rotationStr : t('Don\'t modify')}`, 'increaseRotation')}
      />
      <span style={{ textAlign: 'right', display: 'inline-block', fontSize: '.8em', marginLeft: '.1em' }}>{isRotationSet && rotationStr}</span>
    </div>
  ) : undefined;

  return (
    <div
      className="no-user-select"
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: '.5em', opacity: isFileOpened ? 1 : 0.5, width: '100%' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {leadingControls}

        {!simpleMode && (
          <>
            {hasAudio && (
              <GiSoundWaves
                style={{ fontSize: '1.6em', padding: '0 .1em', color: waveformMode != null ? primaryTextColor : undefined }}
                role="button"
                title={actionTitle(t('Show waveform'), 'toggleWaveformMode')}
                onClick={() => toggleWaveformMode()}
              />
            )}
            {hasVideo && (
              <>
                <FaImages
                  style={{ fontSize: '1.1em', padding: '0 .2em', color: showThumbnails ? primaryTextColor : undefined }}
                  role="button"
                  title={actionTitle(t('Show thumbnails'), 'toggleShowThumbnails')}
                  onClick={toggleShowThumbnails}
                />

                <FaKey
                  style={{ fontSize: '1em', padding: '0 .2em', color: keyframesEnabled ? primaryTextColor : undefined }}
                  role="button"
                  title={actionTitle(t('Show keyframes'), 'toggleShowKeyframes')}
                  onClick={toggleShowKeyframes}
                />
              </>
            )}
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '.45em', marginLeft: '.8em', minWidth: 0 }}>
          <InvertCutModeButton invertCutSegments={invertCutSegments} setInvertCutSegments={setInvertCutSegments} />

          <div style={{ display: 'flex', alignItems: 'center' }}>
            <SimpleModeButton />

            {simpleMode && (
              <div role="button" onClick={toggleSimpleMode} style={{ fontSize: '.8em', marginLeft: '.2em', whiteSpace: 'nowrap' }}>{t('Toggle advanced view')}</div>
            )}
          </div>

          {isFileOpened && !simpleMode && (
            <div ref={playbackRateRef} title={t('Playback rate')} style={{ color: 'var(--gray-11)', fontSize: '.7em', borderRadius: '.5em' }}>{playbackRate.toFixed(1)}</div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!simpleMode && (
          <>
            <FaStepBackward
              size={16}
              style={{ flexShrink: 0 }}
              title={actionTitle(t('Jump to start of video'), 'jumpTimelineStart')}
              role="button"
              onClick={jumpTimelineStart}
            />

            <SegmentCutpointButton currentCutSeg={currentCutSeg} side="start" Icon={FaStepBackward} onClick={jumpCutStart} title={actionTitle(t('Jump to current segment\'s start time'), 'jumpCutStart')} style={{ marginRight: 5 }} />
          </>
        )}

        {!simpleMode && <CutTimeInput disabled={!isFileOpened} darkMode={darkMode} currentCutSeg={currentCutSeg} startTimeOffset={startTimeOffset} seekAbs={seekAbs} cutTime={currentCutSeg?.start} setCutTime={setCutTime} isStart formatTimecode={formatTimecode} parseTimecode={parseTimecode} />}

        {keyframesEnabled && (
          <IoMdKey
            size={25}
            role="button"
            title={actionTitle(t('Seek previous keyframe'), 'seekBackwardsKeyframe')}
            style={{ flexShrink: 0, marginRight: 2, transform: mirrorTransform, ...keyframeStyle }}
            onClick={() => seekClosestKeyframe(-1)}
          />
        )}

        {!simpleMode && (
          <FaCaretLeft
            style={{ flexShrink: 0, marginLeft: -6, marginRight: -4 }}
            size={28}
            role="button"
            title={actionTitle(t('One frame back'), 'seekPreviousFrame')}
            onClick={() => shortStep(-1)}
          />
        )}

        <div title={actionTitle(t('Play/pause'), 'togglePlayResetSpeed')} role="button" onClick={() => togglePlay()} style={{ ...playStyle, margin: '.1em .1em 0 .2em', background: primaryColor }}>
          <PlayPause style={{ fontSize: '.9em' }} />
        </div>

        {!simpleMode && (
          <FaCaretRight
            style={{ flexShrink: 0, marginRight: -6, marginLeft: -4 }}
            size={28}
            role="button"
            title={actionTitle(t('One frame forward'), 'seekNextFrame')}
            onClick={() => shortStep(1)}
          />
        )}

        {keyframesEnabled && (
          <IoMdKey
            style={{ flexShrink: 0, marginLeft: 2, ...keyframeStyle }}
            size={25}
            role="button"
            title={actionTitle(t('Seek next keyframe'), 'seekForwardsKeyframe')}
            onClick={() => seekClosestKeyframe(1)}
          />
        )}

        {!simpleMode && <CutTimeInput disabled={!isFileOpened} darkMode={darkMode} currentCutSeg={currentCutSeg} startTimeOffset={startTimeOffset} seekAbs={seekAbs} cutTime={currentCutSeg?.end} setCutTime={setCutTime} formatTimecode={formatTimecode} parseTimecode={parseTimecode} />}

        {!simpleMode && (
          <>
            <SegmentCutpointButton currentCutSeg={currentCutSeg} side="end" Icon={FaStepForward} onClick={jumpCutEnd} title={actionTitle(t('Jump to current segment\'s end time'), 'jumpCutEnd')} style={{ marginLeft: 5 }} />

            <FaStepForward
              size={16}
              style={{ flexShrink: 0 }}
              title={actionTitle(t('Jump to end of video'), 'jumpTimelineEnd')}
              role="button"
              onClick={jumpTimelineEnd}
            />
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '.55em', minWidth: 0 }}>
        {!simpleMode && isFileOpened && (
          <FaTrashAlt
            title={actionTitle(t('Close file and clean up'), 'cleanupFilesDialog')}
            style={{ fontSize: '1em', color: dangerColor }}
            onClick={cleanupFilesDialog}
            role="button"
          />
        )}

        {!exportConfirmEnabled && (<FaExclamationTriangle style={{ color: dangerColor }} title={t('Export options screen is disabled, and you will not see any important notices or warnings.')} />)}
        {(!simpleMode || !exportConfirmEnabled) && <ToggleExportConfirm />}

        {fpsControl}
        {rotationControl}

        {trailingControls}
      </div>
    </div>
  );
}

export function BottomBarTimeRow({ controls }: { controls: BottomBarProps }) {
  const {
    zoom,
    formatTimecode,
    displayTime,
    fileDurationNonZero,
    getFrameCount,
    selectedSegments,
  } = controls;

  const { t } = useTranslation();

  const isZoomed = zoom > 1;

  const displayTimeFrameCount = useMemo(() => getFrameCount(displayTime), [displayTime, getFrameCount]);
  const selectedSegmentsDuration = useMemo(() => selectedSegments.reduce((acc, seg) => acc + (seg.end == null ? 0 : seg.end - seg.start), 0), [selectedSegments]);
  const selectedSegmentsFrameCount = useMemo(() => getFrameCount(selectedSegmentsDuration), [getFrameCount, selectedSegmentsDuration]);

  const renderTime = useCallback(({ seconds, frameCount, title }: { seconds: number, frameCount: number | undefined, title: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }} title={title}>
      {formatTimecode({ seconds })}
      <span style={{ display: 'inline-block', minWidth: '3.2em', marginLeft: '.45em' }}>
        {frameCount ?? 0}<span style={{ opacity: 0.5, userSelect: 'none' }}>f</span>
      </span>
    </div>
  ), [formatTimecode]);

  return (
    <div className="no-user-select" style={{ color: 'var(--gray-10)', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', width: '100%', height: '100%', padding: '0 12px', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 13, lineHeight: '16px', letterSpacing: 0, whiteSpace: 'nowrap' }}>
      <div style={{ gridColumn: 1, justifySelf: 'start' }}>
        {renderTime({ seconds: displayTime, frameCount: displayTimeFrameCount, title: t('Current time') })}
      </div>

      {isZoomed && (
        <div style={{ gridColumn: 2, justifySelf: 'center', opacity: 0.8 }} title={t('Zoom')}>
          {Math.round((displayTime / fileDurationNonZero) * 100)}<span style={{ opacity: 0.5, userSelect: 'none' }}>%</span>
        </div>
      )}

      <div style={{ gridColumn: 3, justifySelf: 'end' }}>
        {renderTime({ seconds: selectedSegmentsDuration, frameCount: selectedSegmentsFrameCount, title: t('Selected segments total duration') })}
      </div>
    </div>
  );
}
