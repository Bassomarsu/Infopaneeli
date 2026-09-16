import type { InjectionKey, Ref } from 'vue';
import type { PanelId, Settings } from '../types';
export const widgetPanelKey: InjectionKey<Readonly<Ref<PanelId>>> = Symbol('widgetPanel');
export const widgetSettingsKey: InjectionKey<(id: PanelId) => void> = Symbol('widgetSettings');
/**
 * Kunkin dialogin avaimet = täsmälleen ne kentät jotka se NÄYTTÄÄ (ks.
 * SettingsPanel.vuen `inWidget`/`inSettings`). Kumpikin suunta on virhe:
 * näkymätön avain listassa kirjoittaisi vanhentuneen luonnosarvon toisen
 * dialogin päälle, ja listasta puuttuva näkyvä kenttä näyttäisi
 * tallentuvan tallentumatta.
 *
 * `breakfastTime` EI ole lukujärjestyksen avaimissa: aamupala on hälytysten
 * ankkuri ja asetetaan vain yleisistä asetuksista.
 */
export const WIDGET_SETTING_KEYS: Partial<Record<PanelId, readonly (keyof Settings)[]>> = {
  schedule: ['visibleStudents', 'visiblePaikkyChildren', 'scheduleLayout', 'rolloverTime'],
  messages: ['visibleStudents', 'visiblePaikkyChildren', 'hideMessagePreviews'],
  weather: ['weatherPostalCode'], menu: ['menuSchoolIds'], waste: [], news: ['newsCategories'],
};
/**
 * Yleiset asetukset tallentaa myös ne kentät jotka näkyvät sekä täällä että
 * kortin hammasrattaassa — piilotetulla kortilla hammasratasta ei ole, joten
 * ilman näitä esim. aamupala-aika, päivän vaihtumisaika, lapsivalinnat, sään
 * postinumero ja viestien esikatselu olisivat tavoittamattomissa (mitattu:
 * kuusi paneelia piilossa = nolla hammasratasta).
 *
 * EIVÄT kuulu tänne: `newsCategories`, `menuSchoolIds`, `scheduleLayout` ja
 * jätehuollon omat asetukset — ne ovat yhden kortin sisältövalintoja eivätkä
 * näy tässä dialogissa.
 */
export const GENERAL_SETTING_KEYS: readonly (keyof Settings)[] = [
  'hiddenPanels', 'panelLayout', 'gridOverflow', 'hideNextAlarm', 'nightModeStart', 'nightModeEnd',
  'visibleStudents', 'visiblePaikkyChildren', 'rolloverTime', 'breakfastTime', 'weatherPostalCode',
  'hideMessagePreviews',
];
/** A dialog saves only its own fields, so it cannot overwrite another widget. */
export function settingsPatch(settings: Settings, widget?: PanelId): Partial<Settings> {
  return Object.fromEntries((widget ? WIDGET_SETTING_KEYS[widget] ?? [] : GENERAL_SETTING_KEYS)
    .map(key => [key, settings[key]])) as Partial<Settings>;
}
