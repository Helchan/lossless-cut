import type { MouseEventHandler, MouseEvent as ReactMouseEvent } from 'react';
import { memo, useCallback, useMemo } from 'react';
import type { MotionStyle } from 'motion/react';
import { motion, AnimatePresence } from 'motion/react';
import { FaSave } from 'react-icons/fa';
import type { ColorInstance } from 'color';

import useUserSettings from './hooks/useUserSettings';
import { useSegColors } from './contexts';
import type { FormatTimecode, StateSegment } from './types';


const markerButtonStyle: React.CSSProperties = { fontSize: 10, minWidth: 0, letterSpacing: '-.1em', color: 'white' };

function Marker({
  seg, segNum, color, isActive, selected, onMouseDown, onContextMenuCapture, getTimePercent, formatTimecode,
}: {
  seg: StateSegment,
  segNum: number,
  color: ColorInstance,
  isActive: boolean,
  selected: boolean,
  onMouseDown: MouseEventHandler<HTMLDivElement>,
  onContextMenuCapture: MouseEventHandler<HTMLDivElement>,
  getTimePercent: (a: number) => string,
  formatTimecode: FormatTimecode,
}) {
  const { darkMode, prefersReducedMotion, springAnimation } = useUserSettings();

  const pinColor = darkMode ? color.saturate(0.2).lightness(40).string() : color.desaturate(0.2).lightness(50).string();

  const title = useMemo(() => {
    const parts = [formatTimecode({ seconds: seg.start, shorten: true })];
    if (seg.name) parts.push(seg.name);
    return parts.join(' ');
  }, [formatTimecode, seg.start, seg.name]);

  const style = useMemo<MotionStyle>(() => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: getTimePercent(seg.start),
    width: 2,
    marginLeft: -1,
    overflow: 'visible',
    backgroundColor: 'var(--gray-12)',
    zIndex: 7,
  }), [getTimePercent, seg.start]);

  const borderColor = useMemo(() => {
    if (isActive) {
      if (darkMode) return 'rgba(255,255,255,0.5)';
      return 'rgba(0,0,0,0.5)';
    }
    return 'rgba(0,0,0,0)';
  }, [darkMode, isActive]);

  const segNumStyle = useMemo<React.CSSProperties>(() => ({
    borderRadius: '50%', backgroundColor: pinColor, width: 14, height: 14, marginLeft: -7, flexShrink: 0, textAlign: 'center', border: `1px solid ${borderColor}`,
  }), [pinColor, borderColor]);

  return (
    <motion.div
      style={style}
      layout={!prefersReducedMotion}
      transition={springAnimation}
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: selected ? 1 : 0.5, scale: 1 }}
      exit={{ opacity: 0, scale: 0 }}
      title={title}
      onContextMenuCapture={onContextMenuCapture}
    >
      <div style={segNumStyle}>
        <div
          style={markerButtonStyle}
          role="button"
          onMouseDown={onMouseDown}
        >
          {segNum + 1}
        </div>
      </div>
    </motion.div>
  );
}

function Segment({
  seg, segNum, color, isActive, selected, onMouseDown, onContextMenuCapture, getTimePercent, formatTimecode, mediaLaneMode,
}: {
  seg: Omit<StateSegment, 'end'> & { end: number },
  segNum: number,
  color: ColorInstance,
  isActive: boolean,
  selected: boolean,
  onMouseDown: MouseEventHandler<HTMLDivElement>,
  onContextMenuCapture: MouseEventHandler<HTMLDivElement>,
  getTimePercent: (a: number) => string,
  formatTimecode: FormatTimecode,
  mediaLaneMode: boolean,
}) {
  const { darkMode, prefersReducedMotion, springAnimation } = useUserSettings();
  const { name } = seg;

  const border = useMemo(() => {
    const horizontalBorderWidth = mediaLaneMode ? '2px' : '1px';
    const verticalBorderWidth = mediaLaneMode ? '2px' : '1.5px';
    const isSelected = selected;

    if (mediaLaneMode && isSelected) {
      const selectedColor = 'rgba(255,255,255,0.96)';
      return {
        horizontal: `${horizontalBorderWidth} solid ${selectedColor}`,
        vertical: `${verticalBorderWidth} solid ${selectedColor}`,
      };
    }

    if (mediaLaneMode) {
      const outlineColor = darkMode ? 'rgba(9, 108, 116, 0.95)' : 'rgba(8, 98, 106, 0.72)';
      return {
        horizontal: `1px solid ${outlineColor}`,
        vertical: `1px solid ${outlineColor}`,
      };
    }

    if (isActive) {
      const horizontalColor = darkMode ? color.desaturate(0.1).lightness(60) : color.desaturate(0.2).lightness(40);
      const verticalColor = darkMode ? color.desaturate(0.1).lightness(90) : color.desaturate(0.2).lightness(10);
      return {
        horizontal: `${horizontalBorderWidth} solid ${horizontalColor.string()}`,
        vertical: `${verticalBorderWidth} solid ${verticalColor.string()}`,
      };
    }

    if (isSelected) {
      const selectedColor = darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.95)';
      return {
        horizontal: `${horizontalBorderWidth} solid ${selectedColor}`,
        vertical: `${verticalBorderWidth} solid ${selectedColor}`,
      };
    }

    return {
      horizontal: `${horizontalBorderWidth} solid transparent`,
      vertical: `${verticalBorderWidth} solid transparent`,
    };
  }, [darkMode, isActive, color, mediaLaneMode, selected]);

  const backgroundColor = useMemo(() => {
    // we use both transparency and lightness, so that segments can be visible when overlapping
    if (mediaLaneMode) {
      return 'transparent';
    }

    if (!selected) return darkMode ? color.desaturate(0.3).lightness(30).alpha(0.5).string() : color.desaturate(0.3).lightness(70).alpha(0.5).string();
    if (isActive) return darkMode ? color.saturate(0.2).lightness(60).alpha(0.7).string() : color.saturate(0.2).lightness(40).alpha(0.8).string();
    return darkMode ? color.desaturate(0.2).lightness(50).alpha(0.7).string() : color.lightness(35).alpha(0.6).string();
  }, [darkMode, isActive, color, selected, mediaLaneMode]);

  const vertBorderRadius = mediaLaneMode ? 4 : 5;

  const title = useMemo(() => {
    const parts = [
      formatTimecode({ seconds: seg.start, shorten: true }),
      `- ${formatTimecode({ seconds: seg.end, shorten: true })}`,
    ];
    if (name) parts.push(name);
    return parts.join(' ');
  }, [formatTimecode, name, seg.end, seg.start]);

  const wrapperStyle = useMemo<MotionStyle>(() => {
    const cutSectionWidth = getTimePercent(seg.end - seg.start);
    return {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: getTimePercent(seg.start),
      width: cutSectionWidth,
      display: 'flex',
      alignItems: mediaLaneMode ? 'flex-start' : 'center',
      justifyContent: mediaLaneMode ? 'flex-start' : 'space-between',
      originX: 0,
      boxSizing: 'border-box',
      color: 'white',
      overflow: 'hidden',
      zIndex: mediaLaneMode ? 7 : undefined,

      borderLeft: border.vertical,
      borderTopLeftRadius: vertBorderRadius,
      borderBottomLeftRadius: vertBorderRadius,

      borderRight: border.vertical,
      borderTopRightRadius: vertBorderRadius,
      borderBottomRightRadius: vertBorderRadius,

      borderTop: border.horizontal,
      borderBottom: border.horizontal,
    };
  }, [getTimePercent, seg.end, seg.start, border, mediaLaneMode, vertBorderRadius]);

  return (
    <motion.div
      style={wrapperStyle}
      layout={!prefersReducedMotion}
      transition={springAnimation}
      initial={{ opacity: 0, scaleX: 0 }}
      animate={{ opacity: 1, scaleX: 1, backgroundColor }}
      exit={{ opacity: 0, scaleX: 0 }}
      role="button"
      onMouseDown={onMouseDown}
      onContextMenuCapture={onContextMenuCapture}
      title={title}
      aria-label={title}
    >
      {!mediaLaneMode && (
        <>
          <div style={{ alignSelf: 'flex-start', flexShrink: 0, fontSize: 10, minWidth: 0, letterSpacing: '-.1em' }}>{segNum + 1}</div>

          <AnimatePresence>
            {!seg.name && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                style={{ flexShrink: 1 }}
              >
                <FaSave style={{ display: 'block', width: '100%', minWidth: '.4em', color: 'white', marginRight: '.1em' }} />
              </motion.div>
            )}
          </AnimatePresence>

          {name && <div style={{ flexBasis: 4, flexShrink: 1 }} />}

          {name && <div style={{ flexShrink: 1, fontSize: 11, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>{name}</div>}

          <div style={{ flexGrow: 1 }} />
        </>
      )}
    </motion.div>
  );
}

function SegmentOrMarker({
  seg, fileDurationNonZero, isActive, segNum, onSegMouseDown, onSegContextMenuCapture, formatTimecode, selected, mediaLaneMode = false,
} : {
  seg: StateSegment,
  fileDurationNonZero: number,
  isActive: boolean,
  segNum: number,
  onSegMouseDown: (index: number, e: ReactMouseEvent) => void,
  onSegContextMenuCapture: (index: number, e: ReactMouseEvent) => void,
  formatTimecode: FormatTimecode,
  selected: boolean,
  mediaLaneMode?: boolean,
}) {
  const { getSegColor } = useSegColors();

  const segColor = useMemo(() => getSegColor(seg), [getSegColor, seg]);

  const getTimePercent = (t: number) => `${(t / fileDurationNonZero) * 100}%`;

  const onThisSegMouseDown = useCallback<MouseEventHandler<HTMLDivElement>>((e) => onSegMouseDown(segNum, e), [onSegMouseDown, segNum]);
  const onThisSegContextMenuCapture = useCallback<MouseEventHandler<HTMLDivElement>>((e) => onSegContextMenuCapture(segNum, e), [onSegContextMenuCapture, segNum]);

  if (seg.end != null) {
    return <Segment seg={seg as Omit<StateSegment, 'end'> & { end: number }} segNum={segNum} color={segColor} selected={selected} isActive={isActive} onMouseDown={onThisSegMouseDown} onContextMenuCapture={onThisSegContextMenuCapture} getTimePercent={getTimePercent} formatTimecode={formatTimecode} mediaLaneMode={mediaLaneMode} />;
  }

  return (
    <Marker seg={seg} segNum={segNum} color={segColor} selected={selected} isActive={isActive} onMouseDown={onThisSegMouseDown} onContextMenuCapture={onThisSegContextMenuCapture} getTimePercent={getTimePercent} formatTimecode={formatTimecode} />
  );
}

export default memo(SegmentOrMarker);
