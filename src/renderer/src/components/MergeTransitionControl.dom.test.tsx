// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MergeTransitionControlView } from './MergeTransitionControl';


const controlCss = readFileSync('src/renderer/src/components/MergeTransitionControl.module.css', 'utf8');


vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function Harness() {
  const [enabled, setEnabled] = useState(true);
  const [duration, setDuration] = useState(0.46);
  return (
    <MergeTransitionControlView
      enabled={enabled}
      duration={duration}
      onEnabledChange={setEnabled}
      onDurationChange={setDuration}
    />
  );
}

describe('MergeTransitionControlView', () => {
  it('is enabled with the measured default and hides only the duration when unchecked', () => {
    render(<Harness />);

    const checkbox = screen.getByRole('checkbox', { name: 'Fade through black at cut points' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('spinbutton', { name: 'Transition duration' }) as HTMLInputElement).value).toBe('0.46');
    expect(screen.getByText('s')).not.toBeNull();

    fireEvent.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByText('s')).toBeNull();

    fireEvent.click(checkbox);
    expect((screen.getByRole('spinbutton', { name: 'Transition duration' }) as HTMLInputElement).value).toBe('0.46');
  });

  it('allows an editing draft and commits valid values on blur or Enter', () => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: 'Transition duration' });

    fireEvent.change(input, { target: { value: '' } });
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('0.46');

    fireEvent.change(input, { target: { value: '0.72' } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('0.72');

    fireEvent.change(input, { target: { value: '0.84' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLInputElement).value).toBe('0.84');
  });

  it.each([
    { value: '', event: 'blur' as const },
    { value: '0.000001', event: 'enter' as const },
    { value: '-1', event: 'blur' as const },
    { value: 'Infinity', event: 'enter' as const },
    { value: '0.72x', event: 'blur' as const },
  ])('restores the latest valid value for invalid draft "$value"', ({ value, event }) => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: 'Transition duration' });
    fireEvent.change(input, { target: { value: '0.72' } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('0.72');

    fireEvent.change(input, { target: { value } });
    if (event === 'enter') fireEvent.keyDown(input, { key: 'Enter' });
    else fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('0.72');
  });

  it('uses the editable hundredth-second step without an HTML minimum base', () => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: 'Transition duration' });

    expect(input.getAttribute('step')).toBe('0.01');
    expect(input.hasAttribute('min')).toBe(false);
    expect((input as HTMLInputElement).validity.stepMismatch).toBe(false);
  });

  it('keeps the compact duration text clear of Chromium native spinner space', () => {
    const spinnerRule = controlCss.match(/::-webkit-inner-spin-button[^}]*\{([^}]*)\}/s)?.[1];

    expect(spinnerRule).toMatch(/(?:-webkit-)?appearance:\s*none/);
  });

  it('reserves enough input width for the complete default duration', () => {
    const inputRule = controlCss.match(/\.durationInput\s*\{([^}]*)\}/s)?.[1];
    const widthEm = Number(inputRule?.match(/\bwidth:\s*([\d.]+)em/)?.[1]);

    expect(widthEm).toBeGreaterThanOrEqual(4.5);
  });
});
