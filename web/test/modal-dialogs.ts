/**
 * Modaalien kehys ja yöhimmennys.
 *
 * Kaksi asiaa jotka ovat menneet rikki ja jotka mikään muu ei huomaa:
 *
 * 1. OMA `position: fixed` -OVERLAY. `.app.night { filter: ... }` tekee
 *    `.app`ista sijoitussäiliön myös `fixed`ille, joten oma overlay asemoituu
 *    dokumenttiin eikä näkymään ja liukuu vieritetyllä sivulla ruudun
 *    ulkopuolelle (mitattu −511…−2237 px). Sama vika korjattiin ensin
 *    kahdesta dialogista ja jäi neljään muuhun. Tämä testi ei anna sen palata
 *    yhteenkään.
 *
 * 2. HIMMENNYKSEN LUKU KAHDESSA PAIKASSA. Top layer ei peri `.app.night`in
 *    suodatinta, joten ModalDialog toistaa sen omalle kehykselleen. Jos luvut
 *    erkaantuvat, himmennetty dialogi on eri kirkkaudella kuin ruutu sen
 *    takana — eli juuri se laikku jonka yötilan on määrä poistaa.
 *
 * Aja:  npm run test:modal-dialogs --workspace=web
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path: string): string => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

// ── 1. Himmennyksen luku on sama molemmissa tiedostoissa ─────────────────────

const styleCss = read('../src/style.css');
const modalDialog = read('../src/components/ModalDialog.vue');

const appNight = /\.app\.night\s*\{[^}]*?filter:\s*([^;}]+)[;}]/.exec(styleCss)?.[1]?.trim();
assert.ok(appNight, 'style.css: .app.night-säännöstä ei löytynyt filter-arvoa');

const modalDim = /\.app\.night\s+\.modal--dim\s*\{[^}]*?filter:\s*([^;}]+)[;}]/.exec(modalDialog)?.[1]?.trim();
assert.ok(modalDim, 'ModalDialog.vue: .app.night .modal--dim -säännöstä ei löytynyt filter-arvoa');

assert.equal(
  modalDim,
  appNight,
  'yöhimmennys eroaa: style.css sanoo "' + appNight + '", ModalDialog.vue "' + modalDim + '"',
);

// ── 2. Yksikään dialogi ei rakenna omaa fixed-overlaytä ──────────────────────

/**
 * Jokainen modaali ja se, HIMMENEEKÖ se yötilan mukana. Valinta on
 * sisältökohtainen eikä yhtenäistettävä (ks. ModalDialog.vuen `dim`):
 * passiivinen tieto himmenee, toimintakehotteet ja säätönäkymät eivät.
 */
const MODALS: Array<{ file: string; dim: boolean; why: string }> = [
  { file: 'CalendarMonthDialog.vue', dim: true, why: 'käyttäjän avaama tietonäkymä, samaa pintaa kuin kortit sen takana' },
  { file: 'WeatherHourlyDialog.vue', dim: true, why: 'passiivista tietoa, sama pinta kuin sääkortti' },
  { file: 'MessageDialog.vue', dim: true, why: 'viesti luetaan, sitä ei täytetä' },
  { file: 'AlarmsPanel.vue', dim: false, why: 'lomake jossa syötetään kellonaikoja; himmennys veisi kenttien rajat' },
  { file: 'SettingsPanel.vue', dim: false, why: 'sama lomakepinta kuin hälytysten hallinta' },
  { file: 'KioskExitDialog.vue', dim: false, why: 'toimintakehote, ei passiivista tietoa' },
  { file: 'EditAccessDialog.vue', dim: false, why: 'PIN-syöttö, ei passiivista tietoa' },
];

for (const modal of MODALS) {
  const source = read('../src/components/' + modal.file);

  assert.match(source, /<ModalDialog\b/, modal.file + ': kehyksen on oltava ModalDialog, ei omaa overlaytä');
  assert.ok(
    !/\.overlay\s*\{/.test(source),
    modal.file + ': oma .overlay-sääntö on palannut — yötilan filter vie sen pois näkymästä',
  );
  assert.ok(
    !/class="overlay"/.test(source),
    modal.file + ': oma .overlay-elementti on palannut — yötilan filter vie sen pois näkymästä',
  );

  // `dim` on booleaninen attribuutti: läsnä = tosi, poissa = epätosi.
  const opensDimmed = /<ModalDialog[^>]*\sdim(\s|>|\/)/.test(source);
  assert.equal(
    opensDimmed,
    modal.dim,
    modal.file + (modal.dim ? ': dim on poistettu' : ': dim on lisätty') + ' — ' + modal.why,
  );
}

// ── 3. Escape tulee dialogilta, ei omalta kuuntelijalta ──────────────────────
//
// `<dialog showModal>` lähettää `cancel`-tapahtuman. Oma window-kuuntelija sen
// rinnalla sulkisi saman dialogin kahdesti.
for (const modal of MODALS) {
  const source = read('../src/components/' + modal.file);
  assert.ok(
    !/addEventListener\(\s*["']keydown["']/.test(source),
    modal.file + ': oma keydown-kuuntelija Escapelle — ModalDialogin cancel hoitaa sen',
  );
}

console.log(
  'PASS: kaikki ' + MODALS.length + ' modaalia käyttävät ModalDialogia, yöhimmennys on yksi luku, ja dim-valinta on kirjattu kullekin',
);
