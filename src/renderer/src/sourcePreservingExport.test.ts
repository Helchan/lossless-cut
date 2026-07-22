import { describe, expect, test } from 'vitest';

import {
  buildSourcePreservingConcatManifest,
  buildSourcePreservingSegmentPlan,
  buildSourcePreservingVideoFilter,
  containsH264IdrAccessUnit,
  getSourcePreservingBoundaryBFrames,
  getSourcePreservingCopyTargets,
  getSourcePreservingPacketPresentationDuration,
  getSourcePreservingVideoPresentationDuration,
  verifySourcePreservingExportMeta,
} from './sourcePreservingExport';

describe('containsH264IdrAccessUnit', () => {
  test('accepts a four-byte start-code IDR access unit', () => {
    expect(containsH264IdrAccessUnit(Uint8Array.from([
      0, 0, 0, 1, 0x06, 0x01,
      0, 0, 0, 1, 0x65, 0x88,
    ]))).toBe(true);
  });

  test('rejects an open-GOP recovery I picture without an IDR slice', () => {
    expect(containsH264IdrAccessUnit(Uint8Array.from([
      0, 0, 1, 0x06, 0x01,
      0, 0, 1, 0x41, 0x88,
    ]))).toBe(false);
  });
});

describe('buildSourcePreservingSegmentPlan', () => {
  test('copies complete GOPs and encodes only both dependency edges', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 3.1, end: 18.4 },
      nextSafeIdrAtOrAfterCopyStart: 4,
      previousSafeIdrAtOrBeforeCopyEnd: 18,
      sourceDuration: 60,
    });

    expect(plan.parts).toEqual([
      { mode: 'encode', start: 3.1, end: 4 },
      { mode: 'copy', start: 4, end: 18 },
      { mode: 'encode', start: 18, end: 18.4 },
    ]);
    expect(plan.copiedDuration + plan.reencodedDuration).toBeCloseTo(15.3, 9);
    expect(plan.copiedDuration).toBe(14);
  });

  test('copies a segment whose boundaries are safe random-access points', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 4, end: 18 },
      nextSafeIdrAtOrAfterCopyStart: 4,
      previousSafeIdrAtOrBeforeCopyEnd: 18,
      sourceDuration: 60,
    });
    expect(plan.parts).toEqual([{ mode: 'copy', start: 4, end: 18 }]);
    expect(plan.reencodedDuration).toBe(0);
  });

  test('encodes only the selected short segment when boundary GOPs overlap', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 3.1, end: 3.7 },
      nextSafeIdrAtOrAfterCopyStart: 4,
      previousSafeIdrAtOrBeforeCopyEnd: 2,
      sourceDuration: 60,
    });
    expect(plan.parts).toEqual([{ mode: 'encode', start: 3.1, end: 3.7 }]);
    expect(plan.copiedDuration).toBe(0);
  });

  test('treats source beginning and end as safe boundaries', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 0, end: 60 },
      sourceDuration: 60,
    });
    expect(plan.parts).toEqual([{ mode: 'copy', start: 0, end: 60 }]);
  });

  test('encodes source edges that contain fade effects instead of treating them as copy-safe', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 0, end: 10 },
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
      nextSafeIdrAtOrAfterCopyStart: 2,
      previousSafeIdrAtOrBeforeCopyEnd: 8,
      sourceDuration: 10,
    });

    expect(plan.parts).toEqual([
      { mode: 'encode', start: 0, end: 2, fadeInDuration: 0.23 },
      { mode: 'copy', start: 2, end: 8 },
      { mode: 'encode', start: 8, end: 10, fadeOutDuration: 0.23 },
    ]);
  });

  test('encodes one continuous part when the fade copy targets touch', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 4, end: 4.46 },
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
      sourceDuration: 60,
    });

    expect(plan.parts).toEqual([{
      mode: 'encode',
      start: 4,
      end: 4.46,
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
    }]);
  });

  test('rejects safe boundaries that intrude into a fade effect window', () => {
    expect(() => buildSourcePreservingSegmentPlan({
      span: { start: 4, end: 18 },
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
      nextSafeIdrAtOrAfterCopyStart: 4.2,
      previousSafeIdrAtOrBeforeCopyEnd: 16,
    })).toThrow(/copy start/i);

    expect(() => buildSourcePreservingSegmentPlan({
      span: { start: 4, end: 18 },
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
      nextSafeIdrAtOrAfterCopyStart: 6,
      previousSafeIdrAtOrBeforeCopyEnd: 17.8,
    })).toThrow(/copy end/i);
  });

  test('rejects invalid fade durations', () => {
    expect(() => getSourcePreservingCopyTargets({ span: { start: 1, end: 2 }, fadeInDuration: -0.1 })).toThrow();
    expect(() => getSourcePreservingCopyTargets({ span: { start: 1, end: 2 }, fadeOutDuration: Number.NaN })).toThrow();
    expect(() => getSourcePreservingCopyTargets({
      span: { start: 1, end: 2 },
      fadeInDuration: 0.6,
      fadeOutDuration: 0.5,
    })).toThrow();
  });
});

describe('buildSourcePreservingVideoFilter', () => {
  const base = 'setpts=PTS-STARTPTS,trim=duration=2.000000,setpts=PTS-STARTPTS';

  test('keeps the legacy filter byte-for-byte when no fade is requested', () => {
    expect(buildSourcePreservingVideoFilter({ duration: 2 })).toBe(base);
  });

  test('uses the real last-frame offset so a 60 fps final frame reaches black', () => {
    expect(buildSourcePreservingVideoFilter({
      duration: 2,
      lastFrameOffset: 1 / 60,
      fadeInDuration: 0.23,
      fadeOutDuration: 0.23,
    })).toBe([
      base,
      'fade=t=in:st=0:d=0.230000:c=black',
      'fade=t=out:st=1.753333:d=0.230000:c=black',
    ].join(','));
  });

  test('uses an irregular VFR last-frame offset instead of average FPS', () => {
    expect(buildSourcePreservingVideoFilter({
      duration: 2,
      lastFrameOffset: 0.04,
      fadeOutDuration: 0.23,
    })).toContain('fade=t=out:st=1.730000:d=0.230000:c=black');
  });

  test.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY, 3])('rejects invalid fade-out last-frame offset %s', (lastFrameOffset) => {
    expect(() => buildSourcePreservingVideoFilter({
      duration: 2,
      ...(lastFrameOffset != null ? { lastFrameOffset } : {}),
      fadeOutDuration: 0.23,
    })).toThrow(/last frame offset/i);
  });

  test('uses an explicit black sampling filter for a fade-out-only single frame', () => {
    expect(buildSourcePreservingVideoFilter({
      duration: 1 / 60,
      lastFrameOffset: 1 / 60,
      fadeOutDuration: 0.01,
    })).toBe([
      'setpts=PTS-STARTPTS,trim=duration=0.016667,setpts=PTS-STARTPTS',
      'fade=t=in:st=0.016667:d=0.010000:c=black',
    ].join(','));
  });

  test('starts a fade-in-only single frame at black', () => {
    expect(buildSourcePreservingVideoFilter({
      duration: 1 / 60,
      fadeInDuration: 0.01,
    })).toBe([
      'setpts=PTS-STARTPTS,trim=duration=0.016667,setpts=PTS-STARTPTS',
      'fade=t=in:st=0:d=0.010000:c=black',
    ].join(','));
  });

  test('keeps a single frame black when both effects are present', () => {
    expect(buildSourcePreservingVideoFilter({
      duration: 1 / 60,
      lastFrameOffset: 1 / 60,
      fadeInDuration: 0.005,
      fadeOutDuration: 0.005,
    })).toBe([
      'setpts=PTS-STARTPTS,trim=duration=0.016667,setpts=PTS-STARTPTS',
      'fade=t=in:st=0:d=0.005000:c=black',
      'fade=t=in:st=0.016667:d=0.005000:c=black',
    ].join(','));
  });
});

describe('source-preserving video timing', () => {
  test('keeps boundary B-frame reordering aligned with the copied source', () => {
    expect(getSourcePreservingBoundaryBFrames(3)).toBe(3);
    expect(getSourcePreservingBoundaryBFrames(undefined)).toBe(0);
    expect(getSourcePreservingBoundaryBFrames(Number.NaN)).toBe(0);
  });

  test('uses source video coverage when audio and the container end later', () => {
    expect(getSourcePreservingVideoPresentationDuration({
      spans: [{ start: 58.233, end: 117.469751 }],
      sourceVideoEnd: 117.433312,
    })).toBeCloseTo(59.200312, 9);
  });

  test('maps the final selected video packet onto a merged timeline', () => {
    expect(getSourcePreservingVideoPresentationDuration({
      spans: [{ start: 3, end: 8 }, { start: 10, end: 15 }],
      sourceVideoEnd: 14.9,
    })).toBeCloseTo(9.9, 9);
  });

  test('derives presentation duration from packet PTS rather than decode duration metadata', () => {
    expect(getSourcePreservingPacketPresentationDuration({
      packets: [
        { time: 59.1, duration: 0.033 },
        { time: 59.167, duration: 0.033313 },
        { time: 59.134, duration: 0.033 },
      ],
      fallbackFrameDuration: 1 / 30,
    })).toBeCloseTo(59.200313, 9);
  });
});

test('concat manifest pins every transition to its planned video duration', () => {
  expect(buildSourcePreservingConcatManifest({
    paths: ['/tmp/prefix.mp4', "/tmp/tail's.mp4"],
    durations: [2.7, 17.266666667],
  })).toBe([
    "file 'file:/tmp/prefix.mp4'",
    'duration 2.7',
    String.raw`file 'file:/tmp/tail'\''s.mp4'`,
    'duration 17.266666667',
  ].join('\n'));
});

describe('verifySourcePreservingExportMeta', () => {
  const expected = {
    expectedDuration: 19.966667,
    expectedFormat: 'mp4',
    expectedTemporalCodecs: [
      { codecType: 'video' as const, codecName: 'h264' },
      { codecType: 'audio' as const, codecName: 'aac' },
    ],
    expectedFrameDuration: 1 / 30,
  };

  test('accepts original MP4 codecs with frame-exact video and AAC packet tolerance', () => {
    const result = verifySourcePreservingExportMeta({
      ...expected,
      meta: {
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '0', duration: '19.970997' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', start_time: '0', duration: '19.966667', time_base: '1/90000' },
          { codec_type: 'audio', codec_name: 'aac', start_time: '0.001995', duration: '19.969002', sample_rate: '44100' },
        ],
      },
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  test('accepts B-frame decode-duration metadata only when presentation coverage is exact', () => {
    const result = verifySourcePreservingExportMeta({
      expectedDuration: 59.236751,
      expectedFormat: 'mp4',
      expectedTemporalCodecs: [
        { codecType: 'video', codecName: 'h264' },
        { codecType: 'audio', codecName: 'aac' },
      ],
      expectedFrameDuration: 1 / 30,
      expectedVideoPresentationDuration: 59.200312,
      actualVideoPresentationDuration: 59.200313,
      meta: {
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '0', duration: '59.236751' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', start_time: '0', duration: '59.100313', time_base: '1/16000' },
          { codec_type: 'audio', codec_name: 'aac', start_time: '0', duration: '59.236735', sample_rate: '44100' },
        ],
      },
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  test('rejects a missing final presentation frame even when decode-duration metadata looks similar', () => {
    const result = verifySourcePreservingExportMeta({
      expectedDuration: 59.236751,
      expectedFormat: 'mp4',
      expectedTemporalCodecs: [
        { codecType: 'video', codecName: 'h264' },
        { codecType: 'audio', codecName: 'aac' },
      ],
      expectedFrameDuration: 1 / 30,
      expectedVideoPresentationDuration: 59.200312,
      actualVideoPresentationDuration: 59.16698,
      meta: {
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '0', duration: '59.236751' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', start_time: '0', duration: '59.100313', time_base: '1/16000' },
          { codec_type: 'audio', codec_name: 'aac', start_time: '0', duration: '59.236735', sample_rate: '44100' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'DURATION_MISMATCH' }));
  });

  test('rejects the old forced MKV/WavPack result', () => {
    const result = verifySourcePreservingExportMeta({
      ...expected,
      meta: {
        format: { format_name: 'matroska,webm', start_time: '0', duration: '19.966667' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', start_time: '0', duration: '19.966667' },
          { codec_type: 'audio', codec_name: 'wavpack', start_time: '0', duration: '19.966667', sample_rate: '44100' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['FORMAT_MISMATCH', 'CODEC_MISMATCH']));
  });
});
