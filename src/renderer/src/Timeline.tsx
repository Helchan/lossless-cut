import type { MutableRefObject, CSSProperties, WheelEventHandler, MouseEventHandler, MouseEvent as ReactMouseEvent, ChangeEventHandler, KeyboardEventHandler, ReactNode } from 'react';
import { memo, useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { useMotionValue, useSpring } from 'motion/react';
import debounce from 'lodash/debounce';
import { useTranslation } from 'react-i18next';
import { FaSearchMinus, FaSearchPlus } from 'react-icons/fa';
import { AiOutlineSplitCells } from 'react-icons/ai';
import { MdRedo, MdUndo } from 'react-icons/md';
import invariant from 'tiny-invariant';

import TimelineSeg from './TimelineSeg';
import BetweenSegments from './BetweenSegments';
import useContextMenu from './hooks/useContextMenu';
import useUserSettings from './hooks/useUserSettings';

import styles from './Timeline.module.css';


import { timelineBackground, darkModeTransition } from './colors';
import type { Frame } from './ffmpeg';
import type { ContextMenuTemplate, FormatTimecode, InverseCutSegment, OverviewWaveform, RenderableWaveform, SegmentToExport, WaveformSlice, StateSegment, Thumbnail } from './types';
import Button from './components/Button';
import type { UseSegments } from './hooks/useSegments';
import { calculateTimelinePercent as calculateTimelinePercent2, calculateTimelinePos } from './util';
import { zoomMax } from './util/constants';


type CalculateTimelinePercent = (time: number) => string | undefined;
interface TimelineSegmentItem {
  sourceSegment: StateSegment,
  displaySegment: StateSegment,
  originalIndex: number,
  sourceStart: number,
  sourceEnd?: number | undefined,
  displayStart: number,
  displayEnd?: number | undefined,
}

// eslint-disable-next-line react/display-name
const Waveform = memo(({ waveform, calculateTimelinePercent, fileDurationNonZero, darkMode }: {
  waveform: RenderableWaveform,
  calculateTimelinePercent: CalculateTimelinePercent,
  fileDurationNonZero: number,
  darkMode: boolean,
}) => {
  const leftPos = 'from' in waveform ? calculateTimelinePercent(waveform.from) : '0%';

  const width = 'to' in waveform ? ((Math.min(waveform.to, fileDurationNonZero) - waveform.from) / fileDurationNonZero) * 100 : 100;

  const style = useMemo<CSSProperties>(() => ({
    pointerEvents: 'none', position: 'absolute', height: '100%', left: leftPos, width: `${width}%`, filter: darkMode ? undefined : 'invert(1)', imageRendering: 'pixelated',
  }), [darkMode, leftPos, width]);

  if (waveform.url == null) {
    return <div style={{ ...style }} className={styles['loading-bg']} />;
  }

  return (
    <img src={waveform.url} draggable={false} style={style} alt="" />
  );
});

// eslint-disable-next-line react/display-name
const Waveforms = memo(({ calculateTimelinePercent, fileDurationNonZero, waveforms, overviewWaveform, zoom, darkMode, height }: {
  calculateTimelinePercent: CalculateTimelinePercent,
  fileDurationNonZero: number,
  waveforms: WaveformSlice[],
  overviewWaveform: OverviewWaveform | undefined,
  zoom: number,
  darkMode: boolean,
  height: number,
}) => (
  <div style={{ height, width: '100%', position: 'relative' }}>
    {zoom === 1 && overviewWaveform != null ? (
      <Waveform waveform={overviewWaveform} calculateTimelinePercent={calculateTimelinePercent} fileDurationNonZero={fileDurationNonZero} darkMode={darkMode} />
    ) : waveforms.map((waveform) => (
      <Waveform key={`${waveform.from}-${waveform.to}`} waveform={waveform} calculateTimelinePercent={calculateTimelinePercent} fileDurationNonZero={fileDurationNonZero} darkMode={darkMode} />
    ))}
  </div>
));

// eslint-disable-next-line react/display-name
const TimelinePlayhead = memo(({ commandedTimePercent }: { commandedTimePercent: string }) => (
  <div className={styles['playhead']} style={{ left: commandedTimePercent }}>
    <div className={styles['playhead-handle']} />
  </div>
));

const timelineHeight = 36;
const seekLaneHeight = 48;
type TimelineExportMode = 'single' | 'merge' | 'separate';

function Timeline({
  fileName,
  fileDurationNonZero,
  playerTime,
  commandedTime,
  relevantTime,
  zoom,
  setZoom,
  neighbouringKeyFrames,
  seekAbs,
  cutSegments,
  setCurrentSegIndex,
  currentSegIndexSafe,
  inverseCutSegments,
  formatTimecode,
  waveforms,
  overviewWaveform,
  shouldShowWaveform,
  shouldShowKeyframes,
  thumbnails,
  zoomWindowStartTime,
  zoomWindowEndTime,
  onZoomWindowStartTimeChange,
  onGenerateOverviewWaveformClick,
  splitCurrentSegment,
  undoCutSegments,
  redoCutSegments,
  canUndoCutSegments,
  canRedoCutSegments,
  onTimelineExport,
  removeSegments,
  selectOnlySegment,
  toggleSegmentSelected,
  selectAllSegments,
  waveformEnabled,
  waveformHeight,
  showThumbnails,
  onWheel,
  commandedTimeRef,
  playing,
  darkMode,
  setHoveringTime,
  renderPrimaryControls,
  footerControls,
} : {
  fileName: string | undefined,
  fileDurationNonZero: number,
  startTimeOffset: number,
  playerTime: number | undefined,
  commandedTime: number,
  relevantTime: number,
  zoom: number,
  setZoom: (fn: (z: number) => number) => void,
  neighbouringKeyFrames: Frame[],
  seekAbs: (a: number) => void,
  cutSegments: StateSegment[],
  setCurrentSegIndex: (a: number) => void,
  currentSegIndexSafe: number,
  inverseCutSegments: InverseCutSegment[],
  formatTimecode: FormatTimecode,
  waveforms: WaveformSlice[],
  overviewWaveform: OverviewWaveform | undefined,
  shouldShowWaveform: boolean,
  shouldShowKeyframes: boolean,
  thumbnails: Thumbnail[],
  zoomWindowStartTime: number,
  zoomWindowEndTime: number | undefined,
  onZoomWindowStartTimeChange: (a: number) => void,
  onGenerateOverviewWaveformClick: () => void,
  splitCurrentSegment: (time?: number) => void,
  undoCutSegments: () => void,
  redoCutSegments: () => void,
  canUndoCutSegments: boolean,
  canRedoCutSegments: boolean,
  onTimelineExport: (mode: TimelineExportMode, segmentsToExport: SegmentToExport[]) => void,
  removeSegments: UseSegments['removeSegments'],
  selectOnlySegment: UseSegments['selectOnlySegment'],
  toggleSegmentSelected: UseSegments['toggleSegmentSelected'],
  selectAllSegments: UseSegments['selectAllSegments'],
  waveformEnabled: boolean,
  waveformHeight: number,
  showThumbnails: boolean,
  playing: boolean,
  isFileOpened: boolean,
  onWheel: WheelEventHandler,
  commandedTimeRef: MutableRefObject<number>,
  darkMode: boolean,
  setHoveringTime: (time: number | undefined) => void,
  renderPrimaryControls?: (controls: { leadingControls: ReactNode, trailingControls: ReactNode }) => ReactNode,
  footerControls?: ReactNode,
}) {
  const { t } = useTranslation();

  const { invertCutSegments } = useUserSettings();

  const timelineScrollerRef = useRef<HTMLDivElement>(null);
  const timelineScrollerSkipEventRef = useRef<boolean>(false);
  const timelineScrollerSkipEventDebounce = useRef<() => void>(undefined);
  const timelineWrapperRef = useRef<HTMLDivElement>(null);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const seekAnimationFrameRef = useRef<number | undefined>(undefined);
  const pendingSeekTimeRef = useRef<number | undefined>(undefined);
  const [draggingSourceTime, setDraggingSourceTime] = useState<number>();

  const isZoomed = zoom > 1;

  const {
    timelineSegments,
    timelineDisplayDuration,
    hasCompactSourceGaps,
    sourceTimeToTimelineTime,
    sourceTimeToVisibleTimelineTime,
    timelineTimeToSourceTime,
  } = useMemo(() => {
    const timeEpsilon = Math.max(fileDurationNonZero / 1_000_000, 0.001);
    let displayCursor = 0;
    const completeItems: TimelineSegmentItem[] = [];

    for (const [originalIndex, segment] of cutSegments.entries()) {
      if (segment.end != null && segment.end > segment.start) {
        const duration = segment.end - segment.start;
        const displayStart = displayCursor;
        const displayEnd = displayStart + duration;
        displayCursor = displayEnd;

        completeItems.push({
          sourceSegment: segment,
          displaySegment: { ...segment, start: displayStart, end: displayEnd },
          originalIndex,
          sourceStart: segment.start,
          sourceEnd: segment.end,
          displayStart,
          displayEnd,
        });
      }
    }

    const displayDuration = displayCursor > 0 ? displayCursor : fileDurationNonZero;

    const mapSourceToVisibleTimeline = (sourceTime: number) => {
      const item = completeItems.find(({ sourceStart, sourceEnd }) => sourceEnd != null && sourceTime >= sourceStart - timeEpsilon && sourceTime <= sourceEnd + timeEpsilon);
      if (item == null || item.sourceEnd == null || item.displayEnd == null) return undefined;
      return Math.min(Math.max(item.displayStart + (sourceTime - item.sourceStart), item.displayStart), item.displayEnd);
    };

    const mapSourceToTimeline = (sourceTime: number) => {
      const visibleTime = mapSourceToVisibleTimeline(sourceTime);
      if (visibleTime != null) return visibleTime;
      if (completeItems.length === 0) return Math.min(Math.max(sourceTime, 0), displayDuration);

      const nextItem = completeItems.find(({ sourceStart }) => sourceStart > sourceTime);
      return nextItem?.displayStart ?? displayDuration;
    };

    const mapTimelineToSource = (timelineTime: number) => {
      const clampedTimelineTime = Math.min(Math.max(timelineTime, 0), displayDuration);
      const item = completeItems.find(({ displayStart, displayEnd }) => displayEnd != null && clampedTimelineTime >= displayStart - timeEpsilon && clampedTimelineTime <= displayEnd + timeEpsilon);
      if (item == null || item.sourceEnd == null || item.displayEnd == null) return clampedTimelineTime;
      return Math.min(Math.max(item.sourceStart + (clampedTimelineTime - item.displayStart), item.sourceStart), item.sourceEnd);
    };

    const compactItemByIndex = new Map(completeItems.map((item) => [item.originalIndex, item]));
    const items = cutSegments.map<TimelineSegmentItem>((segment, originalIndex) => {
      const completeItem = compactItemByIndex.get(originalIndex);
      if (completeItem != null) return completeItem;

      const displayStart = completeItems.length > 0 ? mapSourceToTimeline(segment.start) : segment.start;
      return {
        sourceSegment: segment,
        displaySegment: { ...segment, start: displayStart },
        originalIndex,
        sourceStart: segment.start,
        displayStart,
      };
    });

    let previousSourceEnd = 0;
    const sourceGaps = completeItems.some((item, index) => {
      const hasGapBefore = index === 0 ? Math.abs(item.sourceStart) > timeEpsilon : Math.abs(item.sourceStart - previousSourceEnd) > timeEpsilon;
      previousSourceEnd = item.sourceEnd ?? previousSourceEnd;
      return hasGapBefore;
    });
    const lastSourceEnd = completeItems.at(-1)?.sourceEnd;
    const sourceDoesNotReachEnd = completeItems.length > 0 && (lastSourceEnd == null || Math.abs(lastSourceEnd - fileDurationNonZero) > timeEpsilon);

    return {
      timelineSegments: items,
      timelineDisplayDuration: displayDuration,
      hasCompactSourceGaps: sourceGaps || sourceDoesNotReachEnd,
      sourceTimeToTimelineTime: mapSourceToTimeline,
      sourceTimeToVisibleTimelineTime: mapSourceToVisibleTimeline,
      timelineTimeToSourceTime: mapTimelineToSource,
    };
  }, [cutSegments, fileDurationNonZero]);

  const keyFramesInZoomWindow = useMemo(() => (zoomWindowEndTime == null ? [] : neighbouringKeyFrames.filter((f) => {
    const timelineTime = sourceTimeToVisibleTimelineTime(f.time);
    return timelineTime != null && timelineTime >= zoomWindowStartTime && timelineTime <= zoomWindowEndTime;
  })), [neighbouringKeyFrames, sourceTimeToVisibleTimelineTime, zoomWindowEndTime, zoomWindowStartTime]);

  // Don't show keyframes if too packed together (at current zoom)
  // See https://github.com/mifi/lossless-cut/issues/259
  const areKeyframesTooClose = keyFramesInZoomWindow.length > zoom * 200;

  const calculateTimelinePercent = useCallback((time: number) => calculateTimelinePercent2(time, timelineDisplayDuration), [timelineDisplayDuration]);
  const playheadSourceTime = draggingSourceTime ?? (playing ? playerTime : undefined) ?? commandedTime;
  const playheadTimelineTime = useMemo(() => sourceTimeToTimelineTime(playheadSourceTime), [playheadSourceTime, sourceTimeToTimelineTime]);
  const playheadTimePercent = useMemo(() => calculateTimelinePercent2(playheadTimelineTime, timelineDisplayDuration), [playheadTimelineTime, timelineDisplayDuration]);

  const timeOfInterestPosPixels = useMemo(() => {
    // https://github.com/mifi/lossless-cut/issues/676
    const pos = calculateTimelinePos(sourceTimeToTimelineTime(relevantTime), timelineDisplayDuration);
    // eslint-disable-next-line react-hooks/refs
    if (pos != null && timelineScrollerRef.current) return pos * zoom * timelineScrollerRef.current!.offsetWidth;
    return undefined;
  }, [relevantTime, sourceTimeToTimelineTime, timelineDisplayDuration, zoom]);

  const calcZoomWindowStartTime = useCallback(() => (timelineScrollerRef.current
    ? (timelineScrollerRef.current.scrollLeft / (timelineScrollerRef.current!.offsetWidth * zoom)) * timelineDisplayDuration
    : 0), [timelineDisplayDuration, zoom]);

  // const zoomWindowStartTime = calcZoomWindowStartTime(duration, zoom);

  useEffect(() => {
    timelineScrollerSkipEventDebounce.current = debounce(() => {
      timelineScrollerSkipEventRef.current = false;
    }, 1000);
  }, []);

  function suppressScrollerEvents() {
    timelineScrollerSkipEventRef.current = true;
    timelineScrollerSkipEventDebounce.current?.();
  }

  const scrollLeftMotion = useMotionValue(0);

  const spring = useSpring(scrollLeftMotion, { damping: 100, stiffness: 1000 });

  useEffect(() => {
    spring.on('change', (value) => {
      if (timelineScrollerSkipEventRef.current) return; // Don't animate while zooming
      timelineScrollerRef.current!.scrollLeft = value;
    });
  }, [spring]);

  // Pan timeline when cursor moves out of timeline window
  useEffect(() => {
    if (timeOfInterestPosPixels == null || timelineScrollerSkipEventRef.current) return;

    invariant(timelineScrollerRef.current != null);
    if (timeOfInterestPosPixels > timelineScrollerRef.current.scrollLeft + timelineScrollerRef.current.offsetWidth) {
      const timelineWidth = timelineWrapperRef.current!.offsetWidth;
      const scrollLeft = timeOfInterestPosPixels - (timelineScrollerRef.current.offsetWidth * 0.1);
      scrollLeftMotion.set(Math.min(scrollLeft, timelineWidth - timelineScrollerRef.current.offsetWidth));
    } else if (timeOfInterestPosPixels < timelineScrollerRef.current.scrollLeft) {
      const scrollLeft = timeOfInterestPosPixels - (timelineScrollerRef.current.offsetWidth * 0.9);
      scrollLeftMotion.set(Math.max(scrollLeft, 0));
    }
  }, [timeOfInterestPosPixels, scrollLeftMotion]);

  // Keep cursor in middle while zooming
  useEffect(() => {
    suppressScrollerEvents();

    if (isZoomed) {
      invariant(timelineScrollerRef.current != null);
      const zoomedTargetWidth = timelineScrollerRef.current.offsetWidth * zoom;

      const scrollLeft = Math.max((sourceTimeToTimelineTime(commandedTimeRef.current) / timelineDisplayDuration) * zoomedTargetWidth - timelineScrollerRef.current.offsetWidth / 2, 0);
      scrollLeftMotion.set(scrollLeft);
      timelineScrollerRef.current.scrollLeft = scrollLeft;
    }
  }, [zoom, timelineDisplayDuration, sourceTimeToTimelineTime, commandedTimeRef, scrollLeftMotion, isZoomed]);


  useEffect(() => {
    const cancelWheel = (event: WheelEvent) => event.preventDefault();

    const scroller = timelineScrollerRef.current;
    invariant(scroller != null);
    scroller.addEventListener('wheel', cancelWheel, { passive: false });

    return () => {
      scroller.removeEventListener('wheel', cancelWheel);
    };
  }, []);

  const onTimelineScroll = useCallback(() => {
    onZoomWindowStartTimeChange(calcZoomWindowStartTime());
  }, [calcZoomWindowStartTime, onZoomWindowStartTimeChange]);

  // Keep cursor in middle while scrolling
  /* const onTimelineScroll = useCallback((e) => {
    onZoomWindowStartTimeChange(zoomWindowStartTime);

    if (!zoomed || timelineScrollerSkipEventRef.current) return;

    seekAbs((((e.target.scrollLeft + (timelineScrollerRef.current.offsetWidth * 0.5))
      / (timelineScrollerRef.current.offsetWidth * zoom)) * duration));
  }, [duration, seekAbs, zoomed, zoom, zoomWindowStartTime, onZoomWindowStartTimeChange]); */

  const getMouseTimelinePos = useCallback((e: MouseEvent) => {
    const target = timelineWrapperRef.current;
    invariant(target != null);
    const rect = target.getBoundingClientRect();
    const relX = e.pageX - (rect.left + document.body.scrollLeft);
    return (relX / target.offsetWidth) * timelineDisplayDuration;
  }, [timelineDisplayDuration]);

  const mouseDownRef = useRef<unknown>(undefined);

  useEffect(() => {
    setHoveringTime(undefined);
  }, [relevantTime, setHoveringTime]);

  useEffect(() => () => {
    if (seekAnimationFrameRef.current != null) cancelAnimationFrame(seekAnimationFrameRef.current);
  }, []);

  const flushPendingSeek = useCallback(() => {
    seekAnimationFrameRef.current = undefined;
    const pendingSeekTime = pendingSeekTimeRef.current;
    pendingSeekTimeRef.current = undefined;
    if (pendingSeekTime != null) seekAbs(pendingSeekTime);
  }, [seekAbs]);

  const scheduleSeek = useCallback((sourceTime: number) => {
    pendingSeekTimeRef.current = sourceTime;
    if (seekAnimationFrameRef.current == null) seekAnimationFrameRef.current = requestAnimationFrame(flushPendingSeek);
  }, [flushPendingSeek]);

  const seekFromMouseEvent = useCallback((e: MouseEvent) => {
    const mouseTimelinePos = getMouseTimelinePos(e);
    const sourceTime = timelineTimeToSourceTime(mouseTimelinePos);
    setDraggingSourceTime(sourceTime);
    scheduleSeek(sourceTime);
    setHoveringTime(sourceTime);
  }, [getMouseTimelinePos, scheduleSeek, setHoveringTime, timelineTimeToSourceTime]);

  const focusTimeline = useCallback(() => {
    timelineRootRef.current?.focus({ preventScroll: true });
  }, []);

  const onSeekLaneMouseDown = useCallback<MouseEventHandler<HTMLDivElement>>((e) => {
    if (e.nativeEvent.buttons !== 1) return; // not primary button

    focusTimeline();
    seekFromMouseEvent(e.nativeEvent);
    mouseDownRef.current = e.target;

    function onMouseMove(e2: MouseEvent) {
      if (mouseDownRef.current == null) return;
      seekFromMouseEvent(e2);
    }

    function onMouseUp(e2: MouseEvent) {
      const sourceTime = timelineTimeToSourceTime(getMouseTimelinePos(e2));
      setDraggingSourceTime(undefined);
      pendingSeekTimeRef.current = undefined;
      if (seekAnimationFrameRef.current != null) {
        cancelAnimationFrame(seekAnimationFrameRef.current);
        seekAnimationFrameRef.current = undefined;
      }
      seekAbs(sourceTime);
      setHoveringTime(undefined);
      mouseDownRef.current = undefined;
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
    }

    // https://github.com/mifi/lossless-cut/issues/1432
    // https://stackoverflow.com/questions/11533098/how-to-catch-mouse-up-event-outside-of-element
    // https://stackoverflow.com/questions/6073505/what-is-the-difference-between-screenx-y-clientx-y-and-pagex-y
    window.addEventListener('mouseup', onMouseUp, { once: true });
    window.addEventListener('mousemove', onMouseMove);
  }, [focusTimeline, getMouseTimelinePos, seekAbs, seekFromMouseEvent, setHoveringTime, timelineTimeToSourceTime]);

  const onSeekLaneMouseMove = useCallback<MouseEventHandler<HTMLDivElement>>((e) => {
    if (!mouseDownRef.current) { // no button pressed
      setHoveringTime(timelineTimeToSourceTime(getMouseTimelinePos(e.nativeEvent)));
    }
    e.preventDefault();
  }, [getMouseTimelinePos, setHoveringTime, timelineTimeToSourceTime]);

  const onMouseOut = useCallback(() => setHoveringTime(undefined), [setHoveringTime]);

  const selectedTimelineSegments = useMemo<SegmentToExport[]>(() => cutSegments.flatMap((seg, index) => {
    if (!seg.selected || seg.end == null) return [];
    return [{ start: seg.start, end: seg.end, name: seg.name, tags: seg.tags, originalIndex: index }];
  }), [cutSegments]);
  const selectedTimelineSegmentIds = useMemo(() => cutSegments.flatMap((seg) => (seg.selected ? [seg.segId] : [])), [cutSegments]);

  const timelineContextSegmentsRef = useRef<SegmentToExport[]>(selectedTimelineSegments);
  const timelineContextSegmentIdsRef = useRef<string[]>(selectedTimelineSegmentIds);

  useEffect(() => {
    timelineContextSegmentsRef.current = selectedTimelineSegments;
    timelineContextSegmentIdsRef.current = selectedTimelineSegmentIds;
  }, [selectedTimelineSegmentIds, selectedTimelineSegments]);

  const removeTimelineContextSegments = useCallback(() => {
    const segmentIds = timelineContextSegmentIdsRef.current;
    if (segmentIds.length > 0) removeSegments(segmentIds);
  }, [removeSegments]);

  const contextMenuTemplate = useMemo<ContextMenuTemplate>(() => {
    const deleteMenuItem = { label: t('Delete'), click: removeTimelineContextSegments };

    if (selectedTimelineSegments.length > 1) {
      return [
        { label: t('Export+merge'), click: () => onTimelineExport('merge', timelineContextSegmentsRef.current) },
        { label: t('Separate files'), click: () => onTimelineExport('separate', timelineContextSegmentsRef.current) },
        { type: 'separator' },
        deleteMenuItem,
      ];
    }

    return [
      { label: t('Export'), click: () => onTimelineExport('single', timelineContextSegmentsRef.current) },
      { type: 'separator' },
      deleteMenuItem,
    ];
  }, [onTimelineExport, removeTimelineContextSegments, selectedTimelineSegments.length, t]);

  useContextMenu(timelineScrollerRef, contextMenuTemplate);

  const onGenerateOverviewWaveformClick2 = useCallback<MouseEventHandler<HTMLButtonElement>>((e) => {
    e.preventDefault(); // todo this doesn't work. dunno why
    onGenerateOverviewWaveformClick();
  }, [onGenerateOverviewWaveformClick]);

  const timelineThumbnails = useMemo(() => thumbnails.flatMap((thumbnail) => {
    const displayTime = sourceTimeToVisibleTimelineTime(thumbnail.time);
    if (displayTime == null) return [];
    return [{ ...thumbnail, displayTime }];
  }).sort((a, b) => a.displayTime - b.displayTime), [sourceTimeToVisibleTimelineTime, thumbnails]);

  const hasVisibleWaveform = !hasCompactSourceGaps && waveformEnabled && shouldShowWaveform && (waveforms.length > 0 || overviewWaveform != null);
  const hasMediaTimeline = showThumbnails || hasVisibleWaveform;
  const clipHeaderHeight = hasMediaTimeline ? 24 : 0;
  const thumbnailLaneHeight = showThumbnails ? 60 : 0;
  const waveformLaneHeight = hasVisibleWaveform ? waveformHeight : 0;
  const compositeTimelineHeight = hasMediaTimeline ? Math.max(timelineHeight, clipHeaderHeight + thumbnailLaneHeight + waveformLaneHeight) : timelineHeight;
  const waveformTop = clipHeaderHeight + thumbnailLaneHeight;
  const clipDurationLabel = useMemo(() => formatTimecode({ seconds: timelineDisplayDuration, shorten: true }), [formatTimecode, timelineDisplayDuration]);
  const zoomPower = useMemo(() => Math.round(Math.log2(zoom)), [zoom]);
  const maxZoomPower = useMemo(() => Math.round(Math.log2(zoomMax)), []);

  const timelineTrackStyle = useMemo<CSSProperties>(() => ({
    height: compositeTimelineHeight,
    backgroundColor: hasMediaTimeline ? undefined : timelineBackground,
    transition: darkModeTransition,
  }), [compositeTimelineHeight, hasMediaTimeline]);

  const timelineContentStyle = useMemo<CSSProperties>(() => ({
    width: `${zoom * 100}%`,
  }), [zoom]);

  const cutBoundaryTimes = useMemo(() => {
    const timeEpsilon = Math.max(timelineDisplayDuration / 1_000_000, 0.001);
    const boundaryTimes = timelineSegments.flatMap(({ displaySegment: { start, end } }) => {
      if (end == null || end <= start) return [];
      return [start, end].filter((time) => (
        Number.isFinite(time)
        && time > timeEpsilon
        && time < timelineDisplayDuration - timeEpsilon
      ));
    }).sort((a, b) => a - b);

    return boundaryTimes.filter((time, index) => index === 0 || Math.abs(time - boundaryTimes[index - 1]!) > timeEpsilon);
  }, [timelineDisplayDuration, timelineSegments]);

  const onSegmentMouseDown = useCallback((index: number, e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    focusTimeline();
    const seg = cutSegments[index];
    if (seg == null) return;

    setCurrentSegIndex(index);
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      toggleSegmentSelected(seg);
    } else {
      selectOnlySegment(seg);
    }
  }, [cutSegments, focusTimeline, selectOnlySegment, setCurrentSegIndex, toggleSegmentSelected]);

  const getSegmentExportTarget = useCallback((index: number) => {
    const seg = cutSegments[index];
    if (seg == null || seg.end == null) return [];
    const segmentToExport = [{ start: seg.start, end: seg.end, name: seg.name, tags: seg.tags, originalIndex: index }];
    if (seg.selected && selectedTimelineSegments.length > 0) return selectedTimelineSegments;
    return segmentToExport;
  }, [cutSegments, selectedTimelineSegments]);

  const getSegmentDeleteTarget = useCallback((index: number) => {
    const seg = cutSegments[index];
    if (seg == null) return [];
    if (seg.selected && selectedTimelineSegmentIds.length > 0) return selectedTimelineSegmentIds;
    return [seg.segId];
  }, [cutSegments, selectedTimelineSegmentIds]);

  const onTimelineContextMenuCapture = useCallback(() => {
    timelineContextSegmentsRef.current = selectedTimelineSegments;
    timelineContextSegmentIdsRef.current = selectedTimelineSegmentIds;
  }, [selectedTimelineSegmentIds, selectedTimelineSegments]);

  const onSegmentContextMenuCapture = useCallback((index: number) => {
    const seg = cutSegments[index];
    timelineContextSegmentsRef.current = getSegmentExportTarget(index);
    timelineContextSegmentIdsRef.current = getSegmentDeleteTarget(index);

    if (seg == null) return;
    setCurrentSegIndex(index);
    if (!seg.selected) selectOnlySegment(seg);
  }, [cutSegments, getSegmentDeleteTarget, getSegmentExportTarget, selectOnlySegment, setCurrentSegIndex]);

  const onZoomSliderChange = useCallback<ChangeEventHandler<HTMLInputElement>>((e) => {
    const value = parseInt(e.target.value, 10);
    setZoom(() => 2 ** value);
  }, [setZoom]);

  const onSplitCurrentSegmentPress = useCallback(() => {
    splitCurrentSegment(playheadSourceTime);
  }, [playheadSourceTime, splitCurrentSegment]);

  const onSeekLaneKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>((e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = timelineDisplayDuration / 100;
    const nextTimelineTime = Math.min(Math.max(sourceTimeToTimelineTime(commandedTime) + (e.key === 'ArrowRight' ? step : -step), 0), timelineDisplayDuration);
    seekAbs(timelineTimeToSourceTime(nextTimelineTime));
  }, [commandedTime, seekAbs, sourceTimeToTimelineTime, timelineDisplayDuration, timelineTimeToSourceTime]);

  useEffect(() => {
    const onTimelineKeyDown = (e: KeyboardEvent) => {
      const timelineRoot = timelineRootRef.current;
      if (timelineRoot == null) return;

      const { activeElement } = document;
      if (activeElement == null || !timelineRoot.contains(activeElement)) return;

      const target = e.target as HTMLElement | null;
      if (target != null && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;

      const isPrimaryModifier = e.metaKey || e.ctrlKey;
      const isUndoRedo = isPrimaryModifier && !e.altKey && e.code === 'KeyZ';
      if (isUndoRedo) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redoCutSegments();
        else undoCutSegments();
        return;
      }

      const isSelectAll = isPrimaryModifier && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a';
      if (isSelectAll) {
        e.preventDefault();
        e.stopPropagation();
        selectAllSegments();
        return;
      }

      const isDeleteSelectedSegments = !isPrimaryModifier && !e.altKey && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace');
      if (isDeleteSelectedSegments && selectedTimelineSegmentIds.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        removeSegments(selectedTimelineSegmentIds);
      }
    };

    window.addEventListener('keydown', onTimelineKeyDown);
    return () => window.removeEventListener('keydown', onTimelineKeyDown);
  }, [redoCutSegments, removeSegments, selectAllSegments, selectedTimelineSegmentIds, undoCutSegments]);

  const leadingControls = (
    <div className={styles['timeline-leading-controls']}>
      <div className={styles['history-button-group']}>
        <button type="button" className={`${styles['toolbar-button']} ${styles['history-button']}`} title={t('Undo')} aria-label={t('Undo')} onClick={() => undoCutSegments()} disabled={!canUndoCutSegments}>
          <MdUndo />
        </button>
        <button type="button" className={`${styles['toolbar-button']} ${styles['history-button']}`} title={t('Redo')} aria-label={t('Redo')} onClick={() => redoCutSegments()} disabled={!canRedoCutSegments}>
          <MdRedo />
        </button>
      </div>

      <button type="button" className={styles['toolbar-button']} title={t('Split segment at cursor')} onClick={onSplitCurrentSegmentPress}>
        <AiOutlineSplitCells />
      </button>
    </div>
  );

  const trailingControls = (
    <div className={styles['zoom-control']} title={t('Zoom')}>
      <FaSearchMinus />
      <input type="range" min={0} max={maxZoomPower} step={1} value={zoomPower} onChange={onZoomSliderChange} />
      <FaSearchPlus />
    </div>
  );


  return (
    <div ref={timelineRootRef} className={`no-user-select ${styles['timeline-root']}`} tabIndex={-1}>
      <div className={styles['timeline-toolbar']}>
        {renderPrimaryControls != null ? (
          <div className={styles['timeline-primary-controls']}>
            {renderPrimaryControls({ leadingControls, trailingControls })}
          </div>
        ) : (
          <>
            {leadingControls}
            <div className={styles['toolbar-spacer']} />
            {trailingControls}
          </>
        )}
      </div>

      {(waveformEnabled && !shouldShowWaveform) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: timelineHeight, bottom: timelineHeight, left: 0, right: 0, color: 'var(--gray-11)' }}>
          {t('Zoom in more to view waveform')}
          <Button onClick={onGenerateOverviewWaveformClick2} style={{ marginLeft: '.5em' }}>{t('Load overview')}</Button>
        </div>
      )}

      <div
        className={`hide-scrollbar ${styles['timeline-scroller']}`}
        onWheel={onWheel}
        onScroll={onTimelineScroll}
        ref={timelineScrollerRef}
      >
        <div
          style={timelineContentStyle}
          className={styles['timeline-content']}
          ref={timelineWrapperRef}
          onContextMenuCapture={onTimelineContextMenuCapture}
        >
          <div
            className={styles['seek-lane']}
            style={{ height: seekLaneHeight }}
            role="slider"
            tabIndex={0}
            aria-label={t('Seek')}
            aria-valuemin={0}
            aria-valuemax={timelineDisplayDuration}
            aria-valuenow={playheadTimelineTime}
            onMouseDown={onSeekLaneMouseDown}
            onMouseMove={onSeekLaneMouseMove}
            onMouseOut={onMouseOut}
            onBlur={onMouseOut}
            onKeyDown={onSeekLaneKeyDown}
          />

          <div
            style={timelineTrackStyle}
            className={`${styles['clip-track']} ${hasMediaTimeline ? styles['clip-track-media'] : ''}`}
          >
            {showThumbnails && (
              <div className={styles['thumbnail-strip']} style={{ top: clipHeaderHeight, height: thumbnailLaneHeight }}>
                {timelineThumbnails.map((thumbnail, i) => {
                  const leftPercent = (thumbnail.displayTime / timelineDisplayDuration) * 100;
                  const nextThumbnail = timelineThumbnails[i + 1];
                  const nextThumbTime = nextThumbnail ? nextThumbnail.displayTime : timelineDisplayDuration;
                  const widthPercent = ((nextThumbTime - thumbnail.displayTime) / timelineDisplayDuration) * 100;
                  return (
                    <img key={thumbnail.url} src={thumbnail.url} alt="" className={styles['thumbnail-image']} style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }} />
                  );
                })}
              </div>
            )}

            {hasVisibleWaveform && (
              <div className={styles['waveform-strip']} style={{ top: waveformTop, height: waveformLaneHeight }}>
                <Waveforms
                  calculateTimelinePercent={calculateTimelinePercent}
                  fileDurationNonZero={timelineDisplayDuration}
                  waveforms={waveforms}
                  overviewWaveform={overviewWaveform}
                  zoom={zoom}
                  darkMode={darkMode}
                  height={waveformLaneHeight}
                />
              </div>
            )}

            {!hasCompactSourceGaps && inverseCutSegments.map((seg) => (
              <BetweenSegments
                key={seg.segId}
                start={seg.start}
                end={seg.end}
                fileDurationNonZero={fileDurationNonZero}
                invertCutSegments={invertCutSegments}
              />
            ))}

            {timelineSegments.map(({ sourceSegment, displaySegment, originalIndex }) => {
              const selected = invertCutSegments || sourceSegment.selected;

              return (
                <TimelineSeg
                  key={sourceSegment.segId}
                  seg={displaySegment}
                  segNum={originalIndex}
                  onSegMouseDown={onSegmentMouseDown}
                  onSegContextMenuCapture={onSegmentContextMenuCapture}
                  isActive={originalIndex === currentSegIndexSafe}
                  fileDurationNonZero={timelineDisplayDuration}
                  invertCutSegments={invertCutSegments}
                  formatTimecode={formatTimecode}
                  selected={selected}
                  mediaLaneMode={hasMediaTimeline}
                />
              );
            })}

            {cutBoundaryTimes.map((time) => (
              <div key={`cut-boundary-${time}`} className={styles['cut-boundary']} style={{ left: calculateTimelinePercent(time) }} />
            ))}

            {shouldShowKeyframes && !areKeyframesTooClose && keyFramesInZoomWindow.map((f) => (
              <div key={f.time} style={{ position: 'absolute', top: 0, bottom: 0, left: calculateTimelinePercent(sourceTimeToVisibleTimelineTime(f.time) ?? 0), marginLeft: -1, width: 1, background: 'var(--gray-10)', pointerEvents: 'none', zIndex: 5 }} />
            ))}

            {hasMediaTimeline && (
              <div className={styles['clip-header']}>
                {fileName && <div className={styles['clip-title']}>{fileName}</div>}
                <div className={styles['clip-duration']}>{clipDurationLabel}</div>
              </div>
            )}
          </div>

          {playheadTimePercent !== undefined && (
            <TimelinePlayhead commandedTimePercent={playheadTimePercent} />
          )}
        </div>
      </div>

      {footerControls != null && (
        <div className={styles['timeline-footer-controls']}>
          {footerControls}
        </div>
      )}
    </div>
  );
}

export default memo(Timeline);
