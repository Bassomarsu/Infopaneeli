import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { logger } from "./logging.ts";

fs.mkdirSync(config.dataDir, { recursive: true });

/**
 * `node:sqlite` ships with Node 24, so there is no native module to compile on
 * Windows. That was the deciding factor over better-sqlite3.
 */
const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_cache (
    id          TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

/**
 * Kumpikaan lähde ei kerro luotettavasti onko viesti luettu: Wilma ei kerro
 * lainkaan (ks. providers/wilma.ts:isUnread) ja Päikyn oma `unread` voi olla
 * "ei tiedossa" (ks. providers/paikky.ts:parseUnread). Tämä taulu on siis
 * infonäytön oma kirjanpito siitä mitkä viestit on avattu TÄLLÄ näytöllä, ei
 * lähteen oma tila.
 *
 * `message_id` on TEKSTIÄ eikä kokonaisluku, koska Päikyn tunniste
 * (`uniqueId`) on merkkijono. Wilman numeerinen tunniste mahtuu tekstiin,
 * muttei toisin päin. Avain on (source, message_id): sama numero voi tarkoittaa
 * eri viestiä eri lähteessä, joten pelkkä tunniste ei riitä avaimeksi.
 */
const CREATE_MESSAGE_READS = `
  CREATE TABLE message_reads (
    source     TEXT NOT NULL,
    message_id TEXT NOT NULL,
    read_at    TEXT NOT NULL,
    PRIMARY KEY (source, message_id)
  )
`;

/**
 * Yleistää vanhan yhden lähteen taulun (`message_id INTEGER PRIMARY KEY`)
 * lähdekohtaiseksi. Perheen luettu-tila on tuotannossa oikeassa
 * tietokannassa, joten vanhat rivit SIIRRETÄÄN eikä pudoteta: ne ovat
 * määritelmän mukaan Wilman, koska muuta lähdettä ei tähän tauluun ole
 * koskaan kirjoitettu.
 *
 * Idempotentti, koska tämä ajetaan joka käynnistyksessä: kohde tunnistetaan
 * taulun sarakkeista eikä erillisestä versionumerosta, joten jo migroitua
 * taulua ei kosketa. Siirto on yhdessä transaktiossa — puolittain migroitu
 * taulu tarkoittaisi juuri sitä kadonnutta luettu-tilaa jota tämä välttää.
 *
 * Ottaa tietokannan parametrina eikä käytä moduulin omaa `db`:tä, jotta
 * migraation voi testata oikealla vanhan muotoisella taululla ilman että
 * testi koskee näytön tietokantaan (ks. test/message-reads.ts). `dbPath` on
 * sama tiedosto auki `target`issa — vain varmuuskopiota varten, ks. alla.
 */
export function migrateMessageReads(target: DatabaseSync, dbPath?: string): void {
  const columns = (target.prepare("PRAGMA table_info(message_reads)").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );

  // Tyhjä sarakejoukko = taulua ei ole vielä lainkaan, eli uusi asennus.
  if (columns.length === 0) {
    target.exec(CREATE_MESSAGE_READS);
    return;
  }
  if (columns.includes("source")) return;

  // Vain kun migraatio oikeasti tehdään, ei joka käynnistyksellä.
  if (dbPath !== undefined) backupBeforeMigration(dbPath);

  try {
    target.exec(`
      BEGIN;
      -- Jäännöstaulu edellisestä keskeytyneestä yrityksestä kaataisi ALTERin,
      -- ja koska tämä ajetaan joka käynnistyksessä, palvelin ei käynnistyisi
      -- enää koskaan. Alkuperäiset rivit ovat tässä tilanteessa yhä
      -- message_readsissa (nimeäminen ei ehtinyt onnistua), ja edellisen rivin
      -- varmuuskopio on olemassa, joten pudotus ei ole se mikä hävittää tietoa.
      DROP TABLE IF EXISTS message_reads_pre_source;
      ALTER TABLE message_reads RENAME TO message_reads_pre_source;
      ${CREATE_MESSAGE_READS};
      INSERT INTO message_reads (source, message_id, read_at)
        SELECT 'wilma', CAST(message_id AS TEXT), read_at FROM message_reads_pre_source;
      DROP TABLE message_reads_pre_source;
      COMMIT;
    `);
  } catch (err) {
    // `exec` ei peruuta transaktiota itse, joten ilman tätä transaktio jäisi
    // auki ja JOKAINEN seuraava BEGIN kaatuisi — yksi vika muuttuisi
    // pysyväksi. ROLLBACK saa itsekin kaatua (jos BEGIN ei ehtinyt onnistua,
    // transaktiota ei ole peruutettavaksi); alkuperäinen virhe on se joka
    // kertoo mitä tapahtui, joten se ei saa jäädä sen alle.
    try {
      target.exec("ROLLBACK");
    } catch {
      // tarkoituksella tyhjä, ks. yllä
    }
    throw err;
  }
}

/**
 * Kopio kannasta ENNEN skeemamuutosta, samaan kansioon.
 *
 * Syy ei ole migraation epäonnistuminen (se on transaktiossa) vaan PALUU
 * VANHAAN JULKAISUUN: vanha `store.ts` ajaa moduulitasolla
 * `ON CONFLICT(message_id)`, joka uutta taulua vasten kaatuu virheeseen
 * "does not match any PRIMARY KEY or UNIQUE constraint", eikä
 * `CREATE TABLE IF NOT EXISTS` korjaa sitä. `data/` säilyy julkaisupaketin
 * päivityksessä, joten rollback tarkoittaisi palvelinta joka ei käynnisty
 * lainkaan — virheilmoituksena SQLite-lause jota kukaan ei osaa yhdistää
 * tähän. Tämä kopio on se tiedosto jonka päälle rollback voi palata.
 *
 * Tavallinen tiedostokopio riittää: tämä ajetaan käynnistyksessä ennen kuin
 * yksikään kirjoitus on käynnissä, eikä kanta ole WAL-tilassa.
 */
function backupBeforeMigration(dbPath: string): void {
  const backupPath = path.join(path.dirname(dbPath), "infonaytto-ennen-viestilahteita.db");
  fs.copyFileSync(dbPath, backupPath);
  // warn eikä debug: oletusloki on `warn`, ja juuri tämän rivin pitää olla
  // löydettävissä siinä tilanteessa jossa kopiota tarvitaan.
  logger.warn(
    { event: "message_reads_migration_backup", backupPath },
    "viestien luettu-tila migroidaan lähdekohtaiseksi — kannasta otettiin kopio ennen muutosta",
  );
}

migrateMessageReads(db, config.dbPath);

const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const selectCache = db.prepare("SELECT payload, fetched_at FROM provider_cache WHERE id = ?");
const upsertCache = db.prepare(
  `INSERT INTO provider_cache (id, payload, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
);

export function getSetting<T>(key: string): T | null {
  const row = selectSetting.get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  upsertSetting.run(key, JSON.stringify(value));
}

export interface CachedPayload<T> {
  data: T;
  fetchedAt: string;
}

/**
 * Last-good data survives a restart on purpose: a schedule fetched yesterday
 * evening is still worth showing at breakfast if Wilma is down this morning.
 */
export function readCache<T>(id: string): CachedPayload<T> | null {
  const row = selectCache.get(id) as { payload: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    return { data: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

export function writeCache(id: string, data: unknown, fetchedAt: string): void {
  upsertCache.run(id, JSON.stringify(data), fetchedAt);
}

export interface Note {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

export function listNotes(): Note[] {
  const rows = db.prepare("SELECT id, text, done, created_at FROM notes ORDER BY done, id").all() as Array<{
    id: number;
    text: string;
    done: number;
    created_at: string;
  }>;
  return rows.map((r) => ({ id: r.id, text: r.text, done: r.done === 1, createdAt: r.created_at }));
}

export function addNote(text: string): Note {
  const createdAt = new Date().toISOString();
  const result = db.prepare("INSERT INTO notes (text, done, created_at) VALUES (?, 0, ?)").run(text, createdAt);
  return { id: Number(result.lastInsertRowid), text, done: false, createdAt };
}

export function setNoteDone(id: number, done: boolean): void {
  db.prepare("UPDATE notes SET done = ? WHERE id = ?").run(done ? 1 : 0, id);
}

export function deleteNote(id: number): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

const selectMessageRead = db.prepare("SELECT 1 FROM message_reads WHERE source = ? AND message_id = ?");
const selectMessageReadsBySource = db.prepare("SELECT message_id FROM message_reads WHERE source = ?");
const upsertMessageRead = db.prepare(
  `INSERT INTO message_reads (source, message_id, read_at) VALUES (?, ?, ?)
   ON CONFLICT(source, message_id) DO UPDATE SET read_at = excluded.read_at`,
);

/**
 * Tunniste tekstiksi ennen sidontaa. **Tämä ei ole turha vaikka tyyppi on jo
 * `string` — älä poista sitä siistimisenä.**
 *
 * `node:sqlite` sitoo JS-numeron liukulukuna, ja TEXT-sarake tallentaa sen
 * silloin muodossa `"86922.0"`. Sellaista riviä ei löydä kumpikaan haku: ei
 * numerolla 86922 eikä merkkijonolla "86922". Yksi ajonaikana läpi päässyt
 * numero (esim. JSON-runko `{"ids":[86921]}`, jonka `string[]`-tyyppi ei estä
 * mitenkään) kirjoittaisi siis rivin jota `listReadMessageIds` ei näe koskaan:
 * viesti näyttäisi ikuisesti lukemattomalta, taulu täyttyisi roskariveistä,
 * eikä mikään kertoisi syytä. Reitti torjuu ei-merkkijonot jo omalta osaltaan
 * (ks. routes/api.ts:n isValidMessageId) — tämä on toinen kerros, koska
 * hiljainen tietokantavika on kalliimpi kuin yksi String()-kutsu.
 */
function asTextId(messageId: string): string {
  return String(messageId);
}

/**
 * Whether a message has been opened on this display. This is entirely local
 * bookkeeping — see the comment on `message_reads` above for why neither
 * source's own read state can be used.
 */
export function isMessageRead(source: string, messageId: string): boolean {
  return selectMessageRead.get(source, asTextId(messageId)) !== undefined;
}

/**
 * Yhden lähteen kaikki täällä avatut viestit, koko postilaatikon
 * kertatarkistusta varten. Lähdekohtainen: Wilman ja Päikyn tunnisteet ovat eri
 * avaruudesta, joten yhteinen joukko antaisi vääriä osumia numeroilla jotka
 * sattuvat esiintymään molemmissa.
 */
export function listReadMessageIds(source: string): Set<string> {
  const rows = selectMessageReadsBySource.all(source) as Array<{ message_id: string }>;
  return new Set(rows.map((r) => r.message_id));
}

/** Idempotent: opening an already-read message just refreshes read_at. */
export function markMessageRead(source: string, messageId: string): string {
  const readAt = new Date().toISOString();
  upsertMessageRead.run(source, asTextId(messageId), readAt);
  return readAt;
}

/**
 * "Merkitse kaikki luetuiksi": yksi teko, joten yksi aikaleima ja yksi
 * transaktio — puolittain kirjoittunut erä jättäisi listan näyttämään osan
 * viesteistä yhä lukemattomina ilman että mikään kertoo miksi. Palauttaa
 * montako ERI viestiä merkittiin; sama tunniste kahdesti on yksi viesti.
 */
export function markMessagesRead(source: string, messageIds: string[]): number {
  // Tekstiksi ENNEN kaksoiskappaleiden poistoa (ks. asTextId): muuten 86921 ja
  // "86921" olisivat joukossa kaksi eri alkiota mutta tauluun sama rivi, ja
  // palautettu lukumäärä valehtelisi.
  const unique = [...new Set(messageIds.map(asTextId))];
  if (unique.length === 0) return 0;

  const readAt = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const messageId of unique) upsertMessageRead.run(source, messageId, readAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return unique.length;
}

export { db };
