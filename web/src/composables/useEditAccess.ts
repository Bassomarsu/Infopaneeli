import { computed, ref } from "vue";

const STORAGE_KEY = "infonaytto.editPin";

/**
 * Pienin mahdollinen `localStorage`-yhteensopiva rajapinta — sama kikka
 * kuin useAlarms.ts:n StorageLike: Node ei tarjoa globaalia localStoragea,
 * ja testit antavat muistinvaraisen toteutuksen sen sijaan.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function defaultStorage(): StorageLike {
  return typeof localStorage !== "undefined" ? localStorage : memoryStorage();
}

/**
 * "edit" = muistilista, asetukset, hälytykset. "full" = sama kuin
 * TRUSTED_HOSTS-laite, myös lasten Wilma-tiedot. Sama otsikko (yksi
 * tallennettu koodi) kantaa kummankin — palvelin päättää tason jokaisella
 * pyynnöllä (ks. server/src/routes/access.ts), selain ei koskaan itse
 * päättele sitä koodin muodosta.
 */
export type PinLevel = "edit" | "full";

export interface VerifyResult {
  ok: boolean;
  error: string | null;
  /** Vain onnistuessa — mikä taso koodilla saavutettiin. */
  level?: PinLevel;
  /** Vain kun palvelin lukitsi lähteen (HTTP 429) — ks. server/src/routes/access.ts. */
  retryAfterSeconds?: number;
}

/**
 * Rakentaa yhden muokkausoikeus-tilan: tallennetun koodin, sen liittämisen
 * jokaiseen pyyntöön (myös /api/dashboardin lukuun — FULL_PIN pitää saada
 * palvelimelle joka pollauksella jotta Wilma-näkyvyys toteutuu, ks.
 * useDashboard.ts) ja vanhentumisen käsittelyn. App.vue, NotesCard,
 * SettingsPanel, AlarmsPanel, usePanelLayout, useDashboard ja
 * EditAccessDialog käyttävät kaikki SAMAA oliota (ks. `useEditAccess`
 * alla) — muuten esim. NotesCard ja SettingsPanel voisivat päätyä eri
 * käsitykseen siitä onko koodi tallessa.
 *
 * Tehdas on silti oma funktionsa eikä suoraan moduulitason muuttujia, jotta
 * testit voivat rakentaa eristetyn instanssin muistinvaraisella storagella
 * ja väärennetyllä fetchillä — jaettu singleton-tila ei saa vuotaa testien
 * välillä.
 */
export function createEditAccessStore(storage: StorageLike = defaultStorage(), fetchImpl: typeof fetch = fetch) {
  function readStoredPin(): string | null {
    try {
      return storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  const storedPin = ref<string | null>(readStoredPin());
  /**
   * Viimeisin tallennettu koodi hylättiin palvelimella (esim. EDIT_PIN tai
   * FULL_PIN vaihtui .env:ssä) — käyttöliittymän pitää pyytää uusi eikä
   * jäädä näyttämään muokkausnäkymää joka epäonnistuu joka kerta selittämättä.
   */
  const expired = ref(false);
  /** Onko palvelimella ylipäätään kyseinen taso asetettu. Null = ei vielä kysytty. */
  const editPinConfigured = ref<boolean | null>(null);
  const fullPinConfigured = ref<boolean | null>(null);

  function persist(pin: string | null): void {
    storedPin.value = pin;
    try {
      if (pin === null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, pin);
    } catch {
      // Esim. yksityinen selaus estää tallennuksen — muokkaus toimii silti
      // tämän istunnon ajan, koodi vain ei säily seuraavaan kertaan.
    }
  }

  const hasStoredPin = computed(() => storedPin.value !== null);

  async function refreshPinConfigured(): Promise<void> {
    try {
      const response = await fetchImpl("/api/edit-access", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { editPinConfigured: boolean; fullPinConfigured: boolean };
      editPinConfigured.value = body.editPinConfigured;
      fullPinConfigured.value = body.fullPinConfigured;
    } catch {
      // Verkko poikki — jätetään edellinen tunnettu tila voimaan.
    }
  }

  /**
   * Yksi paikka joka liittää x-edit-pin-otsikon jokaiseen pyyntöön —
   * kirjoituksiin JA /api/dashboardin lukuun (ks. yllä). Jokainen komponentti
   * kutsuu tätä suoraan fetchin sijaan — aiemmin jokainen teki oman fetch-
   * kutsunsa omine otsikkoineen, mikä on juuri se rakenne jossa yksi reitti
   * unohtaa koodin.
   *
   * 401 tulkitaan aina "tallennettu koodi ei enää kelpaa" ja nollaa sen
   * välittömästi (/api/dashboard ei koskaan palauta 401:tä, joten tämä ei
   * koske sitä — se vain saa otsikon mukaansa). 429 (rajoitin lauennut) EI
   * tee tätä: se ei tarkoita että koodi olisi väärä, vain että samasta
   * lähteestä on juuri yritetty liikaa.
   */
  async function editFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (storedPin.value !== null) headers.set("x-edit-pin", storedPin.value);
    const response = await fetchImpl(input, { ...init, headers });
    if (response.status === 401 && storedPin.value !== null) {
      persist(null);
      expired.value = true;
    }
    return response;
  }

  /** Kokeilee annettua koodia palvelimelta ja tallentaa sen, sekä minkä tason se avasi, vain jos se kelpasi. */
  async function verifyAndStore(pin: string): Promise<VerifyResult> {
    try {
      const response = await fetchImpl("/api/edit-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = (await response.json().catch(() => null)) as
        | { level?: PinLevel; error?: string; retryAfterSeconds?: number }
        | null;
      if (response.ok && body?.level) {
        persist(pin);
        expired.value = false;
        // Koodi täsmäsi juuri tähän tasoon, joten se on todistetusti käytössä
        // — ei tarvitse odottaa seuraavaa refreshPinConfigured-kutsua.
        if (body.level === "full") fullPinConfigured.value = true;
        else editPinConfigured.value = true;
        return { ok: true, error: null, level: body.level };
      }
      return {
        ok: false,
        error: body?.error ?? `Todennus epäonnistui (HTTP ${response.status})`,
        retryAfterSeconds: body?.retryAfterSeconds,
      };
    } catch {
      return { ok: false, error: "Verkkovirhe — yritä uudelleen" };
    }
  }

  /** Selkeä keino unohtaa tallennettu koodi (kumpi taso tahansa) — esim. asetuspaneelista tai PIN-dialogista. */
  function forget(): void {
    persist(null);
    expired.value = false;
  }

  function dismissExpired(): void {
    expired.value = false;
  }

  return {
    hasStoredPin,
    expired,
    editPinConfigured,
    fullPinConfigured,
    refreshPinConfigured,
    editFetch,
    verifyAndStore,
    forget,
    dismissExpired,
  };
}

export type EditAccessStore = ReturnType<typeof createEditAccessStore>;

/** Koko sovelluksen jakama tila — ks. createEditAccessStore-kommentti. */
const editAccessStore = createEditAccessStore();

export function useEditAccess(): EditAccessStore {
  return editAccessStore;
}
