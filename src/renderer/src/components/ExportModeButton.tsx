import type { CSSProperties } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { withBlur } from '../util';
import useUserSettings from '../hooks/useUserSettings';
import Select from './Select';
import type { SegmentExportIntent } from '../segmentExportPlan';


function ExportModeButton({ style }: { selectedSegments: unknown[], style?: CSSProperties }) {
  const { t } = useTranslation();

  const { effectiveExportMode, setAutoMerge, setAutoDeleteMergedSegments, setSegmentsToChaptersOnly } = useUserSettings();

  function onChange(newMode: SegmentExportIntent) {
    switch (newMode) {
      case 'merge': {
        setAutoMerge(true);
        setAutoDeleteMergedSegments(true);
        setSegmentsToChaptersOnly(false);
        break;
      }
      case 'separate': {
        setAutoMerge(false);
        setAutoDeleteMergedSegments(false);
        setSegmentsToChaptersOnly(false);
        break;
      }
      default:
    }
  }

  const selectedMode: SegmentExportIntent = effectiveExportMode === 'merge' || effectiveExportMode === 'merge+separate' ? 'merge' : 'separate';

  return (
    // eslint-disable-next-line react/jsx-props-no-spreading
    <Select
      style={style}
      value={selectedMode}
      onChange={withBlur((e) => onChange(e.target.value as SegmentExportIntent))}
    >
      <option key="disabled" value="" disabled>{t('Export mode')}</option>

      {(['separate', 'merge'] as const).map((mode) => {
        const titles = {
          merge: t('Export+merge'),
          separate: t('Separate files'),
        };

        const title = titles[mode];

        return (
          <option key={mode} value={mode}>{title}</option>
        );
      })}
    </Select>
  );
}

export default memo(ExportModeButton);
