import type { KeyboardEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { defaultMergeTransitionDuration, parseMergeTransitionDuration } from '../../../common/mergeTransition';
import useUserSettings from '../hooks/useUserSettings';
import Checkbox from './Checkbox';
import styles from './MergeTransitionControl.module.css';


export interface MergeTransitionControlViewProps {
  enabled: boolean,
  duration: number,
  onEnabledChange: (enabled: boolean) => void,
  onDurationChange: (duration: number) => void,
}

export function MergeTransitionControlView({
  enabled,
  duration,
  onEnabledChange,
  onDurationChange,
}: MergeTransitionControlViewProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => String(duration));

  useEffect(() => {
    const parsedDuration = parseMergeTransitionDuration(duration);
    if (parsedDuration == null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external settings changes must replace a stale editing draft
    setDraft(String(parsedDuration));
  }, [duration]);

  const commitDraft = useCallback(() => {
    const currentDuration = parseMergeTransitionDuration(duration) ?? defaultMergeTransitionDuration;
    const parsedDraft = parseMergeTransitionDuration(draft);
    if (parsedDraft == null) {
      setDraft(String(currentDuration));
      return;
    }
    onDurationChange(parsedDraft);
    setDraft(String(parsedDraft));
  }, [draft, duration, onDurationChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitDraft();
  }, [commitDraft]);

  return (
    <div className={styles['root']}>
      <div className={styles['checkbox']}>
        <Checkbox
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked === true)}
          label={t('Fade through black at cut points')}
        />
      </div>

      {enabled && (
        <div className={styles['durationGroup']}>
          <input
            aria-label={t('Transition duration')}
            className={styles['durationInput']}
            type="number"
            inputMode="decimal"
            step="0.01"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={handleKeyDown}
          />
          <span className={styles['unit']}>s</span>
        </div>
      )}
    </div>
  );
}

export default function MergeTransitionControl(): ReactElement {
  const {
    mergeTransitionEnabled,
    mergeTransitionDuration,
    setMergeTransitionEnabled,
    setMergeTransitionDuration,
  } = useUserSettings();

  return (
    <MergeTransitionControlView
      enabled={mergeTransitionEnabled}
      duration={mergeTransitionDuration}
      onEnabledChange={setMergeTransitionEnabled}
      onDurationChange={setMergeTransitionDuration}
    />
  );
}
