import { computed, onUnmounted, ref, watch, type InjectionKey, type Ref } from "vue";
import { useEditAccess } from "./useEditAccess.ts";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  MIN_PANEL_SPAN,
  PANEL_IDS,
  defaultPanelLayout,
  isPanelHidden,
  sanitizeHiddenPanels,
  type PanelId,
  type PanelLayout,
  type PanelPlacement,
} from "../types.ts";

/**
 * Jaettu ruudukkoelementin viittaus: LayoutEditor tarvitsee ruudukon
 * mittasuhteet muuttaakseen sormen liikkeen pikseleistä ruudukon soluiksi,
 * mutta mittaus tehdään yhdessä paikassa (App.vue) eikä jokaisessa
 * paneelissa erikseen.
 */
export const panelGridKey: InjectionKey<Ref<HTMLElement | null>> = Symbol("panelGridEl");

/**
 * Leveys, jonka alapuolella näyttö pinoutuu yhdeksi sarakkeeksi (ks. App.vuen
 * `@media (max-width: 900px)`) ja pikseli->solu-muunnos ei enää vastaa
 * gridiä. Vakio on tässä eikä App.vuessa, jotta SettingsPanel ja tämä
 * composable käyttävät samaa lukua eivätkä voi ajautua eri arvoihin.
 */
export const NARROW_LAYOUT_BREAKPOINT_PX = 900;

function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${NARROW_LAYOUT_BREAKPOINT_PX}px)`).matches;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sameSize(a: PanelPlacement, b: PanelPlacement): boolean {
  return a.colSpan === b.colSpan && a.rowSpan === b.rowSpan;
}

export function overlaps(a: PanelPlacement, b: PanelPlacement): boolean {
  const aColEnd = a.col + a.colSpan - 1;
  const aRowEnd = a.row + a.rowSpan - 1;
  const bColEnd = b.col + b.colSpan - 1;
  const bRowEnd = b.row + b.rowSpan - 1;
  return a.col <= bColEnd && aColEnd >= b.col && a.row <= bRowEnd && aRowEnd >= b.row;
}

function cloneLayout(layout: PanelLayout): PanelLayout {
  const clone = {} as PanelLayout;
  for (const id of PANEL_IDS) clone[id] = { ...layout[id] };
  return clone;
}

function isValidPlacement(value: unknown): value is PanelPlacement {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!["col", "row"].every((k) => typeof p[k] === "number" && Number.isInteger(p[k] as number) && (p[k] as number) >= 1)) {
    return false;
  }
  if (
    !["colSpan", "rowSpan"].every(
      (k) => typeof p[k] === "number" && Number.isInteger(p[k] as number) && (p[k] as number) >= MIN_PANEL_SPAN,
    )
  ) {
    return false;
  }
  const placement = value as PanelPlacement;
  if (placement.col + placement.colSpan - 1 > GRID_COLUMNS) return false;
  if (placement.row + placement.rowSpan - 1 > GRID_ROWS) return false;
  return true;
}

/**
 * Vanha tai puutteellinen asettelu (esim. skeeman muuttuessa) ei saa pudottaa
 * korttia näytöltä: jokainen paneeli tarkistetaan erikseen, ja vain se yksi
 * paneeli palautetaan oletuspaikkaansa jos sen tieto puuttuu tai on kelvoton
 * — muut paneelit säilyttävät käyttäjän valitseman paikan.
 */
export function mergeWithDefaults(stored: PanelLayout | null): PanelLayout {
  const merged = {} as PanelLayout;
  for (const id of PANEL_IDS) {
    const candidate = stored?.[id];
    merged[id] = isValidPlacement(candidate) ? candidate : { ...defaultPanelLayout[id] };
  }
  return merged;
}

/**
 * Ne NÄKYVÄT paneelit jotka menevät toistensa päälle annetulla asettelulla.
 * Tyhjä lista = ruudukko on kunnossa.
 *
 * Tavallisessa käytössä tämä on aina tyhjä: resolveMove ja resolveResize
 * eivät päästä päällekkäisyyttä syntymään. Yksi tilanne sen silti tuottaa,
 * eikä se ole teoreettinen:
 *
 * Kun ohjelmistoon lisätään uusi paneeli, palvelin täydentää sen käyttäjän
 * vanhaan tallennettuun asetteluun OLETUSPAIKALLEEN ja kytkee sen pois
 * päältä (server/src/core/settings.ts, `adoptNewPanels`) — ruudukko on
 * täynnä, joten vapaata paikkaa ei ole. Oletuspaikka on kuitenkin varattu
 * sellaisessa asettelussa, jonka käyttäjä on itse tehnyt toisenlaiseksi.
 * Sillä hetkellä kun hän kytkee uuden paneelin päälle, kaksi korttia on
 * samoissa ruuduissa.
 *
 * Päällekkäisyyttä ei estetä eikä korjata automaattisesti: kumman pitäisi
 * väistää, on käyttäjän päätös, ja automaattinen siirto kirjoittaisi hänen
 * asetteluaan uusiksi. Sen sijaan tilanne KERROTAAN (ks. SettingsPanel.vue),
 * jottei se jää ihmeteltäväksi ruudulle.
 */
export function overlappingVisiblePanels(
  layout: PanelLayout,
  hiddenPanels: readonly unknown[] | null | undefined,
): PanelId[] {
  const visible = PANEL_IDS.filter((id) => !isPanelHidden(id, hiddenPanels));
  const clashing = new Set<PanelId>();
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i];
      const b = visible[j];
      if (a === undefined || b === undefined) continue;
      if (overlaps(layout[a], layout[b])) {
        clashing.add(a);
        clashing.add(b);
      }
    }
  }
  return PANEL_IDS.filter((id) => clashing.has(id));
}

/** Miksi paneelin siirto hylättiin — käytetään muokkaustilan yläpalkin selitteeseen. */
export type MoveRejectionReason = "size-mismatch" | "occupied";

export interface MoveOutcome {
  layout: PanelLayout;
  /** null = siirto onnistui, tai kohde oli sama kuin paneelin nykyinen paikka. */
  rejected: MoveRejectionReason | null;
}

/**
 * Ne paneelit jotka ovat oikeasti ruudulla. Piilotetun paneelin sijoitus on
 * PARKKIPAIKKA eikä piirtopaikka: sitä ei renderöidä, joten se ei voi peittää
 * mitään eikä se saa varata ruutuja muilta. Ilman tätä eroa paneelin pois
 * kytkeminen ei vapauttaisi yhtään tilaa — käyttäjä piilottaisi sähkökortin
 * eikä silti voisi kasvattaa säätä sen paikalle.
 *
 * Sama raja kuin palvelimen validoinnissa: se hylkää päällekkäisyyden vain
 * näkyvien paneelien kesken (ks. server/src/core/settings.ts).
 */
function visibleIds(hiddenPanels: readonly unknown[] | null | undefined): PanelId[] {
  return PANEL_IDS.filter((id) => !isPanelHidden(id, hiddenPanels));
}

/** Mikä NÄKYVÄ paneeli (jos mikään) omistaa annetun solun. Ruudukon invariantin ansiosta enintään yksi voi omistaa sen. */
function cellOwner(
  layout: PanelLayout,
  excludeId: PanelId,
  col: number,
  row: number,
  hiddenPanels: readonly unknown[] | null | undefined,
): PanelId | null {
  for (const otherId of visibleIds(hiddenPanels)) {
    if (otherId === excludeId) continue;
    const p = layout[otherId];
    if (col >= p.col && col <= p.col + p.colSpan - 1 && row >= p.row && row <= p.row + p.rowSpan - 1) {
      return otherId;
    }
  }
  return null;
}

/**
 * Kollisiosääntö paneelin siirrossa.
 *
 * Oletusasettelu täyttää koko 6x8-ruudukon (kaikkien paneelien alat summautuvat
 * tasan 48 soluun), joten vapaata tilaa ei yleensä ole valmiiksi. Tästä
 * syystä "työnnä tieltä" -tyyppinen algoritmi joutuisi lähes aina siirtämään
 * jonkin paneelin ruudukon ulkopuolelle, mikä rikkoisi ehdottoman vaatimuksen.
 * Sen sijaan sääntö on kaksivaiheinen ja aina turvallinen:
 *
 *   1. Katso mikä paneeli omistaa sen solun joka on pudotushetkellä sormen/
 *      kursorin alla (`pointerCol`/`pointerRow`) — EI raahatun paneelin omaa,
 *      raahauksen alusta lasketusta deltasta johdettua kulmaa. Käyttäjän
 *      tarvitsee siis vain osua kohdepaneelin päälle jostain kohtaa, ei
 *      tarkalleen sen vasempaan yläkulmaan — kosketuksella osuminen on
 *      epätarkkaa, ja täsmäosuma tuntui rikkinäiseltä.
 *      - Jos joku omistaa sen ja on samankokoinen kuin raahattava: paneelit
 *        vaihtavat paikkaa. Kumpikin siirtyy toisen entiselle, jo ennestään
 *        kelvolliselle paikalle, joten swap ei koskaan voi aiheuttaa
 *        päällekkäisyyttä kolmannen paneelin kanssa eikä vaadi erillistä
 *        tarkistusta.
 *      - Jos joku omistaa sen mutta on eri kokoinen: siirto hylätään
 *        syyllä "size-mismatch".
 *   2. Jos kukaan ei omista pudotussolua, kokeillaan siirtoa raahatun
 *      paneelin omalla, deltasta lasketulla kulmalla (`targetCol`/
 *      `targetRow`, typistettynä ruudukon sisään). Jos koko jalanjälki on
 *      vapaa, paneeli siirtyy sinne; muuten siirto hylätään syyllä
 *      "occupied" (esim. iso paneeli, jonka reuna ulottuisi tyhjän solun
 *      ohi toisen paneelin päälle).
 *
 * Paneeli ei voi koskaan kadota eikä joutua ruudukon ulkopuolelle: jokainen
 * hyväksytty siirto joko täyttää tyhjän tilan tai vaihtaa kaksi identtisen
 * kokoista paneelia paikoiltaan toisiin, aiemmin kelvollisiin paikkoihin.
 */
export function resolveMove(
  layout: PanelLayout,
  id: PanelId,
  targetCol: number,
  targetRow: number,
  pointerCol: number,
  pointerRow: number,
  /** Piilotetut paneelit eivät ole ruudulla eivätkä siksi tiellä — ks. visibleIds. */
  hiddenPanels: readonly unknown[] | null | undefined = [],
): MoveOutcome {
  const current = layout[id];

  const ownerId = cellOwner(layout, id, clamp(pointerCol, 1, GRID_COLUMNS), clamp(pointerRow, 1, GRID_ROWS), hiddenPanels);
  if (ownerId !== null) {
    const owner = layout[ownerId];
    if (!sameSize(owner, current)) {
      return { layout, rejected: "size-mismatch" };
    }
    const next = { ...layout } as PanelLayout;
    next[id] = { ...current, col: owner.col, row: owner.row };
    next[ownerId] = { ...owner, col: current.col, row: current.row };
    return { layout: next, rejected: null };
  }

  const col = clamp(targetCol, 1, GRID_COLUMNS - current.colSpan + 1);
  const row = clamp(targetRow, 1, GRID_ROWS - current.rowSpan + 1);
  if (col === current.col && row === current.row) return { layout, rejected: null };

  const candidate: PanelPlacement = { ...current, col, row };
  const blocked = visibleIds(hiddenPanels).some((otherId) => otherId !== id && overlaps(candidate, layout[otherId]));
  if (blocked) return { layout, rejected: "occupied" };
  return { layout: { ...layout, [id]: candidate }, rejected: null };
}

/**
 * Koon muutossääntö: tavoitekoko typistetään ensin ruudukon rajoihin ja
 * MIN_PANEL_SPANiin (kortti leikkaisi otsikkonsa piiloon sitä pienempänä,
 * ks. types.ts), ja jos se silti menisi päällekkäin toisen paneelin kanssa,
 * kutistetaan sitä ulottuvuutta joka on kasvanut eniten suhteessa nykyiseen
 * kokoon — ei koskaan sitä ulottuvuutta joka ei muuttunut tai jota käyttäjä
 * nimenomaan pienensi. Paneelin oma nykyinen koko on taatusti aina vapaa (se
 * oli sen paikka jo ennen koon muutosta) ja vähintään MIN_PANEL_SPAN
 * (kaikki tallennetut asettelut kulkevat mergeWithDefaultsin läpi), joten
 * kutistus pysähtyy viimeistään siihen eikä koskaan mene sen alle silloin
 * kun kumpikin ulottuvuus vain kasvoi. Koon muutos ei siis koskaan voi
 * työntää toista paneelia, ajaa ruudukon ulkopuolelle eikä kutistaa
 * minimin alle.
 */
export function resolveResize(
  layout: PanelLayout,
  id: PanelId,
  targetColSpan: number,
  targetRowSpan: number,
  /** Piilotetut paneelit eivät ole ruudulla eivätkä siksi tiellä — ks. visibleIds. */
  hiddenPanels: readonly unknown[] | null | undefined = [],
): PanelLayout {
  const current = layout[id];
  let colSpan = clamp(targetColSpan, MIN_PANEL_SPAN, GRID_COLUMNS - current.col + 1);
  let rowSpan = clamp(targetRowSpan, MIN_PANEL_SPAN, GRID_ROWS - current.row + 1);

  const others = visibleIds(hiddenPanels)
    .filter((otherId) => otherId !== id)
    .map((otherId) => layout[otherId]);
  const fits = (cs: number, rs: number): boolean =>
    !others.some((other) => overlaps({ ...current, colSpan: cs, rowSpan: rs }, other));

  // Kutista ensisijaisesti se ulottuvuus joka on kasvanut enemmän suhteessa
  // nykyiseen kokoon. Kun molemmat ulottuvuudet ovat palanneet nykyiseen
  // kokoonsa asti, kohde on taatusti vapaa (ks. yllä), joten silmukka
  // päättyy viimeistään siihen eikä voi jäädä ikuisiksi ajaksi kiertämään.
  while (!fits(colSpan, rowSpan) && (colSpan > current.colSpan || rowSpan > current.rowSpan)) {
    const colGrowth = colSpan - current.colSpan;
    const rowGrowth = rowSpan - current.rowSpan;
    if (colGrowth >= rowGrowth && colSpan > current.colSpan) {
      colSpan -= 1;
    } else if (rowSpan > current.rowSpan) {
      rowSpan -= 1;
    } else {
      colSpan -= 1;
    }
  }

  if (colSpan === current.colSpan && rowSpan === current.rowSpan) return layout;
  return { ...layout, [id]: { ...current, colSpan, rowSpan } };
}

/**
 * Ensimmäinen vapaa paikka annetun kokoiselle paneelille, näkyvien paneelien
 * väleistä. Null = ei mahdu mihinkään.
 *
 * Haku käy ruudukon läpi ylhäältä alas ja vasemmalta oikealle, joten tulos on
 * sama joka kerta eikä riipu paneelien järjestyksestä — sattumanvarainen
 * sijoituspaikka olisi juuri se mitä käyttäjä ei voi ennakoida.
 */
export function findFreeSpot(
  layout: PanelLayout,
  hiddenPanels: readonly unknown[] | null | undefined,
  id: PanelId,
  colSpan: number,
  rowSpan: number,
): PanelPlacement | null {
  const others = visibleIds(hiddenPanels)
    .filter((otherId) => otherId !== id)
    .map((otherId) => layout[otherId]);
  for (let row = 1; row <= GRID_ROWS - rowSpan + 1; row++) {
    for (let col = 1; col <= GRID_COLUMNS - colSpan + 1; col++) {
      const candidate: PanelPlacement = { col, row, colSpan, rowSpan };
      if (!others.some((other) => overlaps(candidate, other))) return candidate;
    }
  }
  return null;
}

/** Miksi paneelin käyttöönotto ei onnistunut. null = onnistui. */
export type EnableRejectionReason = "no-room";

export interface EnableOutcome {
  layout: PanelLayout;
  hiddenPanels: PanelId[];
  rejected: EnableRejectionReason | null;
  /** true = paneeli ei mahtunut entiselle paikalleen ja se sijoitettiin muualle. */
  relocated: boolean;
}

/**
 * Paneelin ottaminen takaisin käyttöön.
 *
 * TÄMÄ EI OLE PELKKÄ LISTASTA POISTO, koska piilotetun paneelin sijoitus on
 * parkkipaikka eikä piirtopaikka (ks. visibleIds). Parkkipaikka voi olla
 * toisen paneelin päällä — päivityksen mukana tullut uusi paneeli saa
 * oletuspaikkansa käyttäjän omaan asetteluun, ja jos se asettelu on täynnä,
 * oletuspaikka on väistämättä jonkin päällä. Pelkkä listasta poisto laittaisi
 * silloin kaksi korttia samoihin ruutuihin, ja palvelin torjuisi tallennuksen
 * 400:lla (ks. server/src/core/settings.ts).
 *
 * Kolme tapausta, tässä järjestyksessä:
 *
 *   1. Parkkipaikka on vapaa → paneeli palaa TÄSMÄLLEEN siihen. Tämä on
 *      tavallinen tapaus: käyttäjä kytki kortin pois ja takaisin eikä muuta
 *      ehtinyt liikkua. Juuri tämä tekee kytkimestä peruutettavan.
 *   2. Parkkipaikka on varattu, mutta samankokoinen paikka löytyy muualta →
 *      paneeli sijoitetaan sinne. Siirretään VAIN käyttöön otettavaa
 *      paneelia, ei koskaan naapuria: käyttäjän näkyvä asettelu pysyy
 *      koskemattomana.
 *   3. Mikään ei mahdu → EI OTETA KÄYTTÖÖN. Ei kutisteta ketään
 *      automaattisesti tilan tekemiseksi; kumpi kortti väistää, on käyttäjän
 *      päätös. Kutsuja kertoo syyn (ks. ENABLE_REJECTION_MESSAGES).
 *
 * Koko on aina paneelin oma tallennettu koko. Sitä ei pienennetä
 * mahtumisen vuoksi — se olisi hiljainen muutos käyttäjän asetteluun, ja
 * pienennetty kortti palaisi väärän kokoisena.
 */
export function enablePanel(
  layout: PanelLayout,
  hiddenPanels: readonly unknown[] | null | undefined,
  id: PanelId,
): EnableOutcome {
  const stored = sanitizeHiddenPanels(hiddenPanels);
  const remaining = stored.filter((entry) => entry !== id);
  if (!stored.includes(id)) return { layout, hiddenPanels: stored, rejected: null, relocated: false };

  const parked = layout[id];
  const others = visibleIds(remaining)
    .filter((otherId) => otherId !== id)
    .map((otherId) => layout[otherId]);

  if (!others.some((other) => overlaps(parked, other))) {
    return { layout, hiddenPanels: remaining, rejected: null, relocated: false };
  }

  const spot = findFreeSpot(layout, remaining, id, parked.colSpan, parked.rowSpan);
  if (spot === null) {
    return { layout, hiddenPanels: stored, rejected: "no-room", relocated: false };
  }
  return {
    layout: { ...layout, [id]: spot },
    hiddenPanels: remaining,
    rejected: null,
    relocated: true,
  };
}

/** Suomenkieliset selitteet hylätylle siirrolle — näytetään muokkaustilan yläpalkissa. */
const MOVE_REJECTION_MESSAGES: Record<MoveRejectionReason, string> = {
  "size-mismatch": "Eri kokoiset paneelit eivät vaihda paikkaa — muuta ensin kokoa.",
  occupied: "Kohde on varattu.",
};

const RESIZE_BLOCKED_MESSAGE = "Ei mahdu tähän — toinen paneeli tiellä.";
const ENABLE_NO_ROOM_MESSAGE =
  "Ruudukossa ei ole tilaa. Pienennä tai siirrä jotakin korttia, niin paneeli mahtuu.";
const ENABLE_RELOCATED_MESSAGE = "Entinen paikka oli varattu — paneeli sijoitettiin lähimpään vapaaseen kohtaan.";
const OVERLAP_SAVE_MESSAGE = "Kaksi paneelia on päällekkäin — siirrä toinen ennen tallennusta.";
const MIN_SPAN_MESSAGE = `Pienin koko on ${MIN_PANEL_SPAN}×${MIN_PANEL_SPAN} solua.`;

export function usePanelLayout(
  settingsLayout: Ref<PanelLayout | null>,
  /**
   * Tallennettu `hiddenPanels`. Samassa composablessa asettelun kanssa eikä
   * omassaan, koska ne ovat saman luonnoksen kaksi puolta: "Valmis"
   * tallentaa molemmat yhdellä pyynnöllä ja "Peruuta" hylkää molemmat.
   * Erillisinä käyttäjä voisi perua paneelin siirron mutta ei sen
   * piilotusta, mikä on juuri se puolittainen tila jota muokkaustilassa ei
   * saa olla.
   */
  settingsHidden: Ref<readonly unknown[] | null | undefined>,
  canEdit: Ref<boolean>,
  onSaved?: () => void,
) {
  const editAccess = useEditAccess();
  const editing = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  // Lyhyt, hillitty vihje muokkaustilan yläpalkkiin kun raahaus tai koon
  // muutos hylätään — ei virhe (ei tallennusta epäonnistunut), vaan selitys
  // sille miksi kosketus ei juuri tehnyt mitään.
  const notice = ref<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function setNotice(message: string | null): void {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    notice.value = message;
    if (message !== null) {
      noticeTimer = setTimeout(() => {
        notice.value = null;
        noticeTimer = null;
      }, 4000);
    }
  }

  onUnmounted(() => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
  });

  const baseLayout = computed<PanelLayout>(() => mergeWithDefaults(settingsLayout.value));
  const draft = ref<PanelLayout>(cloneLayout(baseLayout.value));

  const baseHidden = computed<PanelId[]>(() => sanitizeHiddenPanels(settingsHidden.value));
  const hiddenDraft = ref<PanelId[]>([...baseHidden.value]);

  // Palvelimelta tuleva uusi asettelu (esim. toinen selain tallensi) korvaa
  // luonnoksen vain silloin kun ei olla parhaillaan muokkaamassa — muuten
  // kesken oleva raahaus hyppäisi alta pois.
  watch(baseLayout, (next) => {
    if (!editing.value) draft.value = cloneLayout(next);
  });

  watch(baseHidden, (next) => {
    if (!editing.value) hiddenDraft.value = [...next];
  });

  const layout = computed<PanelLayout>(() => (editing.value ? draft.value : baseLayout.value));

  /**
   * Piilotetut paneelit. Muokkaustilassa luonnos, muuten tallennettu tila —
   * täsmälleen sama kuvio kuin `layout`illa yllä ja samasta syystä: kesken
   * oleva muokkaus ei saa hypähtää alta pois kun palvelin vastaa
   * pollaukseen.
   */
  const hiddenPanels = computed<PanelId[]>(() => (editing.value ? hiddenDraft.value : baseHidden.value));

  function startEditing(): void {
    // Kapealla näytöllä paneelit on pinottu (ks. App.vuen mobiilimedia-
    // kysely), joten pikseli->solu-muunnos mittaisi väärää asettelua ja
    // jokainen raahaus hylättäisiin turhaan. Muokkaustilaa ei siis avata
    // ollenkaan silloin — tämä on varmistus SettingsPanelin napin `disabled`-
    // tilan lisäksi, jos joku kutsuisi tätä suoraan.
    if (!canEdit.value || editing.value || isNarrowViewport()) return;
    draft.value = cloneLayout(baseLayout.value);
    hiddenDraft.value = [...baseHidden.value];
    error.value = null;
    setNotice(null);
    editing.value = true;
  }

  /**
   * Palauttaa onnistuiko tallennus. Kutsuja päättää itse mitä sen jälkeen
   * tehdään — persist() ei enää sulje muokkaustilaa, koska epäonnistunut
   * PUT (verkko poikki, palvelin torjui asettelun) ei saa hukata koko
   * raahaustyötä äänettömästi ilman uudelleenyrityksen mahdollisuutta.
   */
  async function persist(next: PanelLayout | null, nextHidden: PanelId[]): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const response = await editAccess.editFetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Osittainen PUT: vain nämä kaksi avainta. Muokkaustila ei tiedä
        // mitään muista asetuksista eikä saa kirjoittaa niiden päälle —
        // asetuspaneeli voi olla auki toisella laitteella samaan aikaan.
        body: JSON.stringify({ panelLayout: next, hiddenPanels: nextHidden }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        // 401 tarkoittaa että tallennettu PIN ei enää kelpaa (editFetch on
        // jo tyhjentänyt sen) — muokkaustilan pitäminen auki johtaisi vain
        // samaan virheeseen uudestaan jokaisella uudella yrityksellä, joten
        // se suljetaan tässä sen sijaan että jäisi roikkumaan rikkinäisenä.
        // Asettelun muokkaus on käytännössä aina näyttölaitteella (kapealla
        // näytöllä nappi on piilotettu), joten tämä on harvinainen — mutta
        // PIN:llä muokkaava, tarpeeksi leveä selain voi silti osua tähän.
        if (response.status === 401) {
          editing.value = false;
          error.value = "PIN ei enää kelpaa — muokkaus suljettu. Ota käyttöön uusi PIN jatkaaksesi.";
          return false;
        }
        throw new Error(body?.error ?? `Asettelun tallennus epäonnistui (HTTP ${response.status})`);
      }
      onSaved?.();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Asettelun tallennus epäonnistui";
      error.value = `${message} Muokkaustila pysyy auki — yritä uudelleen.`;
      return false;
    } finally {
      saving.value = false;
    }
  }

  // editing sulkeutuu vasta onnistuneen tallennuksen jälkeen: muuten ruutu
  // näpsähtäisi hetkeksi vanhaan asetteluun (layout lukee baseLayoutia heti
  // kun editing=false, mutta baseLayout päivittyy vasta kun onSaved() on
  // hakenut dashboardin uudelleen), ja epäonnistunut PUT hukkaisi luonnoksen
  // kokonaan ilman että käyttäjä pääsisi enää yrittämään uudelleen.
  async function finishEditing(): Promise<void> {
    if (!editing.value) return;
    // Palvelin hylkää asettelun jossa kaksi NÄKYVÄÄ paneelia on päällekkäin
    // (ks. server/src/core/settings.ts). Tavallisessa käytössä sitä ei voi
    // syntyä — resolveMove, resolveResize ja enablePanel torjuvat sen
    // kaikki — mutta tallennus ei saa lähteä siitä siltikään: palvelimen
    // 400 kertoisi saman asian huonommin ja vasta verkkokäynnin jälkeen.
    const clashing = overlappingVisiblePanels(draft.value, hiddenDraft.value);
    if (clashing.length > 0) {
      setNotice(OVERLAP_SAVE_MESSAGE);
      return;
    }
    setNotice(null);
    const ok = await persist(draft.value, hiddenDraft.value);
    if (ok) editing.value = false;
  }

  /**
   * Palauttaa sekä paikat/koot ETTÄ näkyvyyden oletuksiin. Näkyvyys on
   * mukana tarkoituksella: tämä on ainoa tie takaisin tunnettuun tilaan, ja
   * juuri se jota tarvitaan silloin kun paneeleja on kytketty pois niin
   * monta ettei näytöllä ole enää mitään.
   */
  async function resetToDefault(): Promise<void> {
    if (!editing.value) return;
    draft.value = cloneLayout(defaultPanelLayout);
    hiddenDraft.value = [];
    setNotice(null);
    const ok = await persist(null, []);
    if (ok) editing.value = false;
  }

  /** Hylkää luonnoksen eikä lähetä mitään palvelimelle — reitti ulos vahingossa avatusta muokkaustilasta. */
  function cancelEditing(): void {
    if (!editing.value) return;
    draft.value = cloneLayout(baseLayout.value);
    hiddenDraft.value = [...baseHidden.value];
    error.value = null;
    setNotice(null);
    editing.value = false;
  }

  function movePanel(id: PanelId, col: number, row: number, pointerCol: number, pointerRow: number): void {
    if (!editing.value) return;
    const outcome = resolveMove(draft.value, id, col, row, pointerCol, pointerRow, hiddenDraft.value);
    draft.value = outcome.layout;
    setNotice(outcome.rejected !== null ? MOVE_REJECTION_MESSAGES[outcome.rejected] : null);
  }

  function resizePanel(id: PanelId, colSpan: number, rowSpan: number): void {
    if (!editing.value) return;
    const before = draft.value[id];
    const next = resolveResize(draft.value, id, colSpan, rowSpan, hiddenDraft.value);
    draft.value = next;

    // Kahva (LayoutEditor) päästää raa'an, typistämättömän pyynnön asti tänne
    // asti juuri jotta alarajaan osuminen voidaan kertoa käyttäjälle — ilman
    // tätä kutistus vain pysähtyisi äänettömästi MIN_PANEL_SPANiin.
    if (colSpan < MIN_PANEL_SPAN || rowSpan < MIN_PANEL_SPAN) {
      setNotice(MIN_SPAN_MESSAGE);
      return;
    }
    const after = next[id];
    const requestedGrowth = colSpan > before.colSpan || rowSpan > before.rowSpan;
    const blocked = requestedGrowth && after.colSpan === before.colSpan && after.rowSpan === before.rowSpan;
    setNotice(blocked ? RESIZE_BLOCKED_MESSAGE : null);
  }

  /**
   * Kytkee paneelin pois näkyvistä. EI KOSKE `draft`iin eli paneelin paikkaan
   * ja kokoon millään tavalla: sijoitus jää muistiin parkkipaikaksi, ja juuri
   * siksi paneeli palaa takaisin entiselle paikalleen jos se on yhä vapaa.
   * Pois kytkeminen VAPAUTTAA ruudut muille (ks. visibleIds), joten
   * naapuria voi heti kasvattaa vapautuneeseen tilaan.
   */
  function hidePanel(id: PanelId): void {
    if (!editing.value || hiddenDraft.value.includes(id)) return;
    setNotice(null);
    hiddenDraft.value = PANEL_IDS.filter((entry) => entry === id || hiddenDraft.value.includes(entry));
  }

  /**
   * Ottaa paneelin takaisin käyttöön. Voi epäonnistua: jos ruudukossa ei ole
   * tilaa, mitään ei tapahdu ja käyttäjälle kerrotaan mitä hänen pitää tehdä
   * (ks. enablePanel — emme kutista naapuria hänen puolestaan).
   */
  function showPanel(id: PanelId): void {
    if (!editing.value || !hiddenDraft.value.includes(id)) return;
    const outcome = enablePanel(draft.value, hiddenDraft.value, id);
    if (outcome.rejected !== null) {
      setNotice(ENABLE_NO_ROOM_MESSAGE);
      return;
    }
    draft.value = outcome.layout;
    hiddenDraft.value = outcome.hiddenPanels;
    setNotice(outcome.relocated ? ENABLE_RELOCATED_MESSAGE : null);
  }

  function togglePanelHidden(id: PanelId): void {
    if (hiddenDraft.value.includes(id)) showPanel(id);
    else hidePanel(id);
  }

  return {
    editing,
    layout,
    hiddenPanels,
    togglePanelHidden,
    hidePanel,
    showPanel,
    saving,
    error,
    notice,
    startEditing,
    finishEditing,
    resetToDefault,
    cancelEditing,
    movePanel,
    resizePanel,
  };
}

export type UsePanelLayout = ReturnType<typeof usePanelLayout>;
