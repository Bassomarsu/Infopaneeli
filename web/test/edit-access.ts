/**
 * useEditAccess.ts on se yksi paikka joka liittää x-edit-pin-otsikon
 * JOKAISEEN pyyntöön (myös /api/dashboardin lukuun, ei vain kirjoituksiin —
 * ks. useDashboard.ts) ja päättää milloin tallennettu koodi on vanhentunut.
 * Kaksi tasoa (edit/full) kulkevat saman otsikon kautta; palvelin kertoo
 * kummasta on kyse. Tämä testaa sen logiikan ilman selainta: väärennetty
 * localStorage (ks. useAlarms.ts:n vastaava StorageLike-kikka) ja
 * väärennetty fetch.
 *
 * Aja:  npm run test:edit-access --workspace=web
 */
import assert from "node:assert/strict";
import { createEditAccessStore, type StorageLike } from "../src/composables/useEditAccess.ts";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Väärennetty fetch joka palauttaa jonotetut vastaukset järjestyksessä ja tallentaa mitä sille lähetettiin. */
interface RecordedCall {
  input: string;
  method: string;
  headers: Headers;
}

function fakeFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch: ei enää jonotettuja vastauksia");
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function testEditFetchAddsHeaderWhenPinStored(): Promise<void> {
  const storage = memoryStorage();
  storage.setItem("infonaytto.editPin", "1234");
  const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { ok: true })]);
  const store = createEditAccessStore(storage, fetchImpl);

  await store.editFetch("/api/notes", { method: "POST" });
  assert.equal(calls[0]?.headers.get("x-edit-pin"), "1234", "tallennettu koodi pitää liittää otsikkoon");
  console.log("ok  editFetch liittää x-edit-pin-otsikon kun koodi on tallessa");
}

/**
 * Regressiotesti tiimin nimenomaisesti varoittamalle sudenkuopalle:
 * /api/dashboard on LUKUREITTI, ja jos editFetchiä ei käytettäisi siihen,
 * FULL_PIN ei koskaan avaisi Wilma-näkyvyyttä vaikka kaikki muu toimisi.
 * editFetch ei saa erotella metodin perusteella liittääkö otsikon.
 */
async function testEditFetchAddsHeaderOnReadsToo(): Promise<void> {
  const storage = memoryStorage();
  storage.setItem("infonaytto.editPin", "424242");
  const { fetchImpl, calls } = fakeFetch([jsonResponse(200, { localClient: true })]);
  const store = createEditAccessStore(storage, fetchImpl);

  await store.editFetch("/api/dashboard", { cache: "no-store" });
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers.get("x-edit-pin"), "424242", "myös lukupyyntö (esim. /api/dashboard) pitää saada otsikko");
  console.log("ok  editFetch liittää otsikon myös GET-lukupyyntöihin, ei vain kirjoituksiin");
}

async function testEditFetchOmitsHeaderWhenNoPinStored(): Promise<void> {
  const storage = memoryStorage();
  const { fetchImpl, calls } = fakeFetch([jsonResponse(403, { error: "ei koodia" })]);
  const store = createEditAccessStore(storage, fetchImpl);

  await store.editFetch("/api/notes", { method: "POST" });
  assert.equal(calls[0]?.headers.get("x-edit-pin"), null, "otsikkoa ei pidä liittää kun koodia ei ole tallessa");
  console.log("ok  editFetch ei liitä otsikkoa kun koodia ei ole tallennettu");
}

async function testEditFetchClearsPinAndFlagsExpiredOn401(): Promise<void> {
  const storage = memoryStorage();
  storage.setItem("infonaytto.editPin", "1234");
  const { fetchImpl } = fakeFetch([jsonResponse(401, { error: "Väärä tai puuttuva PIN" })]);
  const store = createEditAccessStore(storage, fetchImpl);

  assert.equal(store.hasStoredPin.value, true);
  await store.editFetch("/api/notes", { method: "POST" });
  assert.equal(store.hasStoredPin.value, false, "401 pitää tyhjentää tallennettu koodi");
  assert.equal(store.expired.value, true, "401 pitää nostaa expired-lipun");
  assert.equal(storage.getItem("infonaytto.editPin"), null, "koodi pitää poistua myös storagesta");
  console.log("ok  401 tyhjentää tallennetun koodin ja nostaa expired-lipun");
}

async function testEditFetchKeepsPinOn429(): Promise<void> {
  const storage = memoryStorage();
  storage.setItem("infonaytto.editPin", "1234");
  const { fetchImpl } = fakeFetch([jsonResponse(429, { error: "Liian monta väärää PIN-yritystä.", retryAfterSeconds: 300 })]);
  const store = createEditAccessStore(storage, fetchImpl);

  await store.editFetch("/api/notes", { method: "POST" });
  assert.equal(store.hasStoredPin.value, true, "429 ei tarkoita että koodi olisi väärä — sitä ei saa unohtaa");
  assert.equal(store.expired.value, false, "429 ei ole sama asia kuin vanhentunut koodi");
  console.log("ok  429 (rajoitin lauennut) ei tyhjennä tallennettua koodia eikä nosta expired-lippua");
}

async function testVerifyAndStoreSavesEditLevelOnSuccess(): Promise<void> {
  const storage = memoryStorage();
  const { fetchImpl } = fakeFetch([jsonResponse(200, { ok: true, level: "edit" })]);
  const store = createEditAccessStore(storage, fetchImpl);

  const result = await store.verifyAndStore("4242");
  assert.deepEqual(result, { ok: true, error: null, level: "edit" });
  assert.equal(store.hasStoredPin.value, true);
  assert.equal(storage.getItem("infonaytto.editPin"), "4242");
  assert.equal(store.editPinConfigured.value, true, "onnistunut edit-todennus todistaa että EDIT_PIN on käytössä palvelimella");
  console.log("ok  verifyAndStore tallentaa koodin ja edit-tason kun palvelin hyväksyy sen sellaisena");
}

/** Tärkein yksittäinen väite koko laajennukselle asiakaspuolella: full-taso tallentuu ja merkitään omaksi tasokseen, ei sekoitu edit-tasoon. */
async function testVerifyAndStoreSavesFullLevelOnSuccess(): Promise<void> {
  const storage = memoryStorage();
  const { fetchImpl } = fakeFetch([jsonResponse(200, { ok: true, level: "full" })]);
  const store = createEditAccessStore(storage, fetchImpl);

  const result = await store.verifyAndStore("424242");
  assert.equal(result.ok, true);
  assert.equal(result.level, "full", "palvelimen ilmoittama taso pitää välittyä käyttöliittymälle asti");
  assert.equal(store.hasStoredPin.value, true);
  assert.equal(store.fullPinConfigured.value, true, "onnistunut full-todennus todistaa että FULL_PIN on käytössä palvelimella");
  console.log("ok  verifyAndStore tallentaa koodin ja full-tason erillään edit-tasosta");
}

async function testVerifyAndStoreDoesNotSaveOnFailure(): Promise<void> {
  const storage = memoryStorage();
  const { fetchImpl } = fakeFetch([jsonResponse(401, { error: "Väärä tai puuttuva PIN" })]);
  const store = createEditAccessStore(storage, fetchImpl);

  const result = await store.verifyAndStore("0000");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Väärä tai puuttuva PIN");
  assert.equal(store.hasStoredPin.value, false, "väärä koodi ei saa jäädä muistiin");
  console.log("ok  verifyAndStore ei tallenna koodia jonka palvelin hylkää");
}

async function testVerifyAndStorePassesThroughRetryAfter(): Promise<void> {
  const storage = memoryStorage();
  const { fetchImpl } = fakeFetch([jsonResponse(429, { error: "Liian monta väärää PIN-yritystä.", retryAfterSeconds: 42 })]);
  const store = createEditAccessStore(storage, fetchImpl);

  const result = await store.verifyAndStore("0000");
  assert.equal(result.ok, false);
  assert.equal(result.retryAfterSeconds, 42, "429-vastauksen retryAfterSeconds pitää välittyä käyttöliittymälle asti");
  console.log("ok  verifyAndStore välittää retryAfterSecondsin 429-vastauksesta");
}

async function testRefreshPinConfiguredReadsBothTiersIndependently(): Promise<void> {
  const storage = memoryStorage();
  const { fetchImpl } = fakeFetch([jsonResponse(200, { editPinConfigured: true, fullPinConfigured: false })]);
  const store = createEditAccessStore(storage, fetchImpl);

  await store.refreshPinConfigured();
  assert.equal(store.editPinConfigured.value, true);
  assert.equal(store.fullPinConfigured.value, false, "täyden tason puuttuminen ei saa vaikuttaa edit-tason lippuun");
  console.log("ok  refreshPinConfigured lukee molemmat tasot toisistaan riippumatta");
}

function testForgetClearsStoredPinAndExpiredFlag(): void {
  const storage = memoryStorage();
  storage.setItem("infonaytto.editPin", "1234");
  const store = createEditAccessStore(storage, (async () => jsonResponse(200, {})) as typeof fetch);

  store.forget();
  assert.equal(store.hasStoredPin.value, false);
  assert.equal(storage.getItem("infonaytto.editPin"), null);
  console.log("ok  forget() poistaa tallennetun koodin storagesta ja tilasta");
}

function testStoredPinSurvivesStoreRecreationFromSameStorage(): void {
  const storage = memoryStorage();
  const first = createEditAccessStore(storage, (async () => jsonResponse(200, {})) as typeof fetch);
  void first; // vain alustusta varten, ei käytetä suoraan
  storage.setItem("infonaytto.editPin", "5678");

  // Simuloi sivun uudelleenlatausta: uusi store luetaan samasta storagesta.
  const reloaded = createEditAccessStore(storage, (async () => jsonResponse(200, {})) as typeof fetch);
  assert.equal(reloaded.hasStoredPin.value, true, "koodi pitää löytyä storagesta uuden latauksen jälkeen");
  console.log("ok  tallennettu koodi säilyy storagen kautta uudelleenlatauksen yli");
}

await testEditFetchAddsHeaderWhenPinStored();
await testEditFetchAddsHeaderOnReadsToo();
await testEditFetchOmitsHeaderWhenNoPinStored();
await testEditFetchClearsPinAndFlagsExpiredOn401();
await testEditFetchKeepsPinOn429();
await testVerifyAndStoreSavesEditLevelOnSuccess();
await testVerifyAndStoreSavesFullLevelOnSuccess();
await testVerifyAndStoreDoesNotSaveOnFailure();
await testVerifyAndStorePassesThroughRetryAfter();
await testRefreshPinConfiguredReadsBothTiersIndependently();
testForgetClearsStoredPinAndExpiredFlag();
testStoredPinSurvivesStoreRecreationFromSameStorage();

console.log("\nall edit-access tests passed");
process.exit(0);
