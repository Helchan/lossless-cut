import { describe, expect, test } from 'vitest';

import {
  buildSourcePreservingConcatManifest,
  buildSourcePreservingSegmentPlan,
  containsH264IdrAccessUnit,
  getSourcePreservingBoundaryBFrames,
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
      nextKeyframeAtOrAfterStart: 4,
      previousKeyframeAtOrBeforeEnd: 18,
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
      nextKeyframeAtOrAfterStart: 4,
      previousKeyframeAtOrBeforeEnd: 18,
      sourceDuration: 60,
    });
    expect(plan.parts).toEqual([{ mode: 'copy', start: 4, end: 18 }]);
    expect(plan.reencodedDuration).toBe(0);
  });

  test('encodes only the selected short segment when boundary GOPs overlap', () => {
    const plan = buildSourcePreservingSegmentPlan({
      span: { start: 3.1, end: 3.7 },
      nextKeyframeAtOrAfterStart: 4,
      previousKeyframeAtOrBeforeEnd: 2,
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
