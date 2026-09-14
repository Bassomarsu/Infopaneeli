import type { InjectionKey, Ref } from 'vue';
import type { PanelId, Settings } from '../types';
export const widgetPanelKey: InjectionKey<Readonly<Ref<PanelId>>> = Symbol('widgetPanel');
export const widgetSettingsKey: InjectionKey<(id: PanelId) => void> = Symbol('widgetSettings');
export const WIDGET_SETTING_KEYS: Partial<Record<PanelId, readonly (keyof Settings)[]>> = {
  schedule: ['visibleStudents', 'visiblePaikkyChildren', 'scheduleLayout', 'rolloverTime', 'breakfastTime'],
  messages: ['visibleStudents', 'visiblePaikkyChildren', 'hideMessagePreviews'],
  weather: ['weatherPostalCode'], menu: ['menuSchoolIds'], waste: [], news: ['newsCategories'],
};
export const GENERAL_SETTING_KEYS: readonly (keyof Settings)[] = [
  'hiddenPanels', 'panelLayout', 'gridOverflow', 'hideNextAlarm', 'nightModeStart', 'nightModeEnd',
];
/** A dialog saves only its own fields, so it cannot overwrite another widget. */
export function settingsPatch(settings: Settings, widget?: PanelId): Partial<Settings> {
  return Object.fromEntries((widget ? WIDGET_SETTING_KEYS[widget] ?? [] : GENERAL_SETTING_KEYS)
    .map(key => [key, settings[key]])) as Partial<Settings>;
}
