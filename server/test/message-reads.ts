/**
 * Neither source tells us reliably whether a message was read — Wilma not at
 * all (see providers/wilma.ts), Päikky only with a claim that can be "not
 * known" (see providers/paikky.ts:parseUnread) — so read state is tracked
 * locally in the `message_reads` table instead. This covers the store
 * functions that back that: marking a message read must be idempotent, and
 * unrelated ids must stay unread.
 *
 * Se kattaa myös taulun migraation yhden lähteen muodosta lähdekohtaiseen.
 * Migraatio on tässä muutoksessa se kohta jossa voi oikeasti hävitä jotain:
 * perheen luettu-tila on tuotannossa oikeassa tietokannassa, eikä sitä saa
 * menettää. Migraatiotestit ajetaan omaa muistinvaraista tietokantaansa
 * vasten (`:memory:`), koska store.ts on jo ehtinyt migroida testikannan
 * moduulia ladatessa — vanhan muotoista taulua ei siis enää ole olemassa
 * mistä testata.
 *
 * Run with:  npm run test:message-reads --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/core/config.ts";
import {
  isMessageRead,
  listReadMessageIds,
  markMessageRead,
  markMessagesRead,
  migrateMessageReads,
} from "../src/core/store.ts";

// The test database file persists between runs, so start from a clean table
// rather than dodging leftovers with time-derived ids. Fixed ids keep the test
// deterministic, and clearing up front means a failed run cannot poison the
// next one — the same reason the suite writes to its own database at all.
// Toinen yhteys samaan testikantaan: sillä siivotaan alkutila ja luetaan
// rivit raakana ohi store.ts:n omien funktioiden — juuri se on tapa nähdä
// MITEN arvo on tallennettu, ei vain että se löytyy.
const inspector = new DatabaseSync(config.dbPath);
inspector.exec("DELETE FROM message_reads");

const [readId, untouchedId] = ["86921", "86922"];

/** Päikyn tunniste on merkkijono, ei numero — juuri siksi taulu yleistettiin. */
const paikkyId = "c-8f2a-4d11";

function columnsOf(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA table_info(message_reads)").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * `all()` palauttaa prototyypittömiä olioita, joita assert.deepEqual (strict)
 * ei pidä tavallisten olioiden vertaisina — rivit kopioidaan siksi tavallisiksi
 * olioiksi, jotta vertailu kertoo sisällöstä eikä prototyypistä.
 */
function allRows(db: DatabaseSync): Array<{ source: string; message_id: string; read_at: string }> {
  const rows = db
    .prepare("SELECT source, message_id, read_at FROM message_reads ORDER BY source, message_id")
    .all() as Array<{ source: string; message_id: string; read_at: string }>;
  return rows.map((row) => ({ source: row.source, message_id: row.message_id, read_at: row.read_at }));
}

/** Taulu täsmälleen siinä muodossa jossa se on tuotannossa ennen tätä muutosta. */
const LEGACY_SCHEMA = `
  CREATE TABLE message_reads (
    message_id INTEGER PRIMARY KEY,
    read_at    TEXT NOT NULL
  );
  INSERT INTO message_reads (message_id, read_at) VALUES (86921, '2026-08-01T06:00:00.000Z');
  INSERT INTO message_reads (message_id, read_at) VALUES (86922, '2026-08-02T07:30:00.000Z');
`;

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_SCHEMA);
  return db;
}

/**
 * Ajaa annetun testin omassa väliaikaiskansiossaan levyllä. Varmuuskopiota ei
 * voi testata muistinvaraisella kannalla, koska kopio on tiedosto-operaatio.
 */
function withTempDatabaseDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infonaytto-migraatio-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testMigrationMovesLegacyRowsToWilma(): void {
  const db = legacyDatabase();
  migrateMessageReads(db);

  assert.deepEqual(columnsOf(db), ["source", "message_id", "read_at"], "taulun pitää olla uudessa muodossa");
  assert.deepEqual(
    allRows(db),
    [
      { source: "wilma", message_id: "86921", read_at: "2026-08-01T06:00:00.000Z" },
      { source: "wilma", message_id: "86922", read_at: "2026-08-02T07:30:00.000Z" },
    ],
    "vanhat rivit siirtyvät Wilman lähteelle, tunniste merkkijonoksi ja read_at koskemattomana",
  );
  console.log("ok  vanhan muodon rivit säilyvät ja siirtyvät source='wilma' -riveiksi");
}

function testMigrationIsIdempotent(): void {
  const db = legacyDatabase();
  migrateMessageReads(db);
  const afterFirst = allRows(db);

  // Migraatio ajetaan joka käynnistyksessä, joten toinen ajo on normaali
  // tilanne eikä poikkeus: sen pitää olla täysin vaikutukseton.
  migrateMessageReads(db);
  migrateMessageReads(db);

  assert.deepEqual(allRows(db), afterFirst, "uudelleenajo ei saa muuttaa yhtään riviä");
  assert.deepEqual(columnsOf(db), ["source", "message_id", "read_at"]);

  // Väliaikaistaulun pitää olla siivottu — jäänyt kopio olisi hiljainen
  // toinen totuus luettu-tilasta.
  const leftovers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'message_reads%'")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    leftovers.map((row) => row.name),
    ["message_reads"],
    "migraation väliaikaistaulua ei saa jäädä jäljelle",
  );
  console.log("ok  migraatio on idempotentti eikä jätä väliaikaistaulua");
}

function testMigrationDoesNotTouchAlreadyMigratedRows(): void {
  const db = new DatabaseSync(":memory:");
  migrateMessageReads(db); // uusi asennus: taulua ei ole vielä lainkaan
  assert.deepEqual(columnsOf(db), ["source", "message_id", "read_at"], "tyhjään kantaan luodaan uusi muoto suoraan");
  assert.deepEqual(allRows(db), [], "uusi asennus alkaa tyhjästä");

  db.prepare("INSERT INTO message_reads (source, message_id, read_at) VALUES (?, ?, ?)").run(
    "paikky",
    paikkyId,
    "2026-08-31T05:00:00.000Z",
  );
  migrateMessageReads(db);

  assert.deepEqual(
    allRows(db),
    [{ source: "paikky", message_id: paikkyId, read_at: "2026-08-31T05:00:00.000Z" }],
    "jo migroidun taulun rivejä ei saa leimata uudelleen Wilman riveiksi",
  );
  console.log("ok  uusi asennus saa uuden muodon suoraan, eikä muun lähteen rivejä kirjoiteta Wilmaksi");
}

/**
 * Paluu vanhaan julkaisuun on se tilanne jossa kopiota tarvitaan: vanha
 * store.ts kaatuu uutta taulua vasten heti moduulia ladattaessa
 * (`ON CONFLICT(message_id)` ei täsmää uuteen avaimeen), eikä
 * `CREATE TABLE IF NOT EXISTS` korjaa sitä. `data/` säilyy päivityksessä,
 * joten ilman kopiota rollback tarkoittaisi palvelinta joka ei käynnisty.
 */
function testMigrationCopiesDatabaseBeforeChangingIt(): void {
  withTempDatabaseDir((dir) => {
    const dbPath = path.join(dir, "infonaytto.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec(LEGACY_SCHEMA);
    seed.close();

    const db = new DatabaseSync(dbPath);
    migrateMessageReads(db, dbPath);

    const backupPath = path.join(dir, "infonaytto-ennen-viestilahteita.db");
    assert.ok(fs.existsSync(backupPath), "kopio pitää syntyä samaan kansioon");

    // Kopion pitää olla nimenomaan migraatiota EDELTÄVÄ tila, ei kopio uudesta.
    const backup = new DatabaseSync(backupPath);
    assert.deepEqual(columnsOf(backup), ["message_id", "read_at"], "kopiossa on vanha muoto");
    const rows = backup.prepare("SELECT message_id FROM message_reads ORDER BY message_id").all() as Array<{
      message_id: number;
    }>;
    assert.deepEqual(rows.map((row) => row.message_id), [86921, 86922], "kopiossa on kaikki vanhat rivit");
    backup.close();
    db.close();
  });
  console.log("ok  migraatio kopioi kannan ennen muutosta, jotta paluu vanhaan julkaisuun on mahdollinen");
}

function testMigrationDoesNotCopyWhenNothingToMigrate(): void {
  withTempDatabaseDir((dir) => {
    const dbPath = path.join(dir, "infonaytto.db");
    const db = new DatabaseSync(dbPath);

    migrateMessageReads(db, dbPath); // uusi asennus: ei mitään migroitavaa
    migrateMessageReads(db, dbPath); // jo migroitu: ei mitään tehtävää
    db.close();

    assert.equal(
      fs.existsSync(path.join(dir, "infonaytto-ennen-viestilahteita.db")),
      false,
      "kopiota ei saa ottaa joka käynnistyksellä, vain kun migraatio oikeasti tehdään",
    );
  });
  console.log("ok  kopio otetaan vain kun migraatio oikeasti tehdään");
}

/**
 * Jäännöstaulu keskeytyneestä yrityksestä kaataisi ALTERin, ja koska migraatio
 * ajetaan joka käynnistyksessä, palvelin ei käynnistyisi enää koskaan.
 */
function testMigrationSurvivesLeftoverTable(): void {
  const db = legacyDatabase();
  db.exec("CREATE TABLE message_reads_pre_source (message_id INTEGER PRIMARY KEY, read_at TEXT NOT NULL)");

  migrateMessageReads(db);

  assert.deepEqual(allRows(db), [
    { source: "wilma", message_id: "86921", read_at: "2026-08-01T06:00:00.000Z" },
    { source: "wilma", message_id: "86922", read_at: "2026-08-02T07:30:00.000Z" },
  ]);
  console.log("ok  edellisen yrityksen jäännöstaulu ei estä migraatiota");
}

/**
 * Kaatunut migraatio ei saa jättää transaktiota auki: `exec` ei peruuta sitä
 * itse, joten jokainen seuraava BEGIN kaatuisi ja yhdestä viasta tulisi
 * pysyvä. Vika laukaistaan NULL-arvoisella `read_at`illa, jota uusi taulu ei
 * hyväksy.
 */
function testFailedMigrationLeavesNoOpenTransaction(): void {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE message_reads (message_id INTEGER PRIMARY KEY, read_at TEXT);
    INSERT INTO message_reads (message_id, read_at) VALUES (86921, NULL);
  `);

  assert.throws(() => migrateMessageReads(db), /NOT NULL/i, "kelvoton rivi kaataa migraation");

  // Peruttu transaktio = taulu on yhä ennallaan eikä puoliksi migroitu.
  assert.deepEqual(columnsOf(db), ["message_id", "read_at"], "epäonnistunut migraatio ei saa jättää puolikasta");

  // Ja tämä on se varsinainen väite: uusi transaktio onnistuu.
  db.exec("BEGIN; INSERT INTO message_reads (message_id, read_at) VALUES (99, 'x'); COMMIT;");
  console.log("ok  kaatunut migraatio peruuttaa transaktionsa eikä jumita seuraavia");
}

function testUnknownMessageIsNotRead(): void {
  assert.equal(isMessageRead("wilma", untouchedId), false, "a message never opened must not read as read");
  console.log("ok  an id that was never marked read stays unread");
}

function testMarkingReadPersists(): void {
  assert.equal(isMessageRead("wilma", readId), false, "must start unread");
  const readAt = markMessageRead("wilma", readId);
  assert.ok(readAt, "markMessageRead must return the timestamp it stored");
  assert.equal(isMessageRead("wilma", readId), true, "must read as read once marked");
  assert.equal(isMessageRead("wilma", untouchedId), false, "marking one message must not affect another");
  console.log("ok  marking a message read persists and is scoped to that id");
}

function testMarkingReadTwiceStaysConsistent(): void {
  const first = markMessageRead("wilma", readId);
  const second = markMessageRead("wilma", readId);
  assert.equal(isMessageRead("wilma", readId), true, "must still read as read");
  assert.ok(second >= first, "the second read_at must not move backwards");
  console.log("ok  opening an already-read message again does not error or unread it");
}

function testListReadMessageIdsIncludesMarkedOnes(): void {
  const ids = listReadMessageIds("wilma");
  assert.ok(ids.has(readId), "the bulk listing must include a message marked read above");
  assert.ok(!ids.has(untouchedId), "the bulk listing must not include an id that was never marked");
  console.log("ok  listReadMessageIds reflects what markMessageRead recorded");
}

/**
 * Sama tunniste voi tarkoittaa eri viestiä eri lähteessä — Wilman tunnisteet
 * ovat numeroita ja Päikyn merkkijonoja, mutta mikään ei estä niitä
 * näyttämästä samalta. Yhteinen joukko merkitsisi väärän viestin luetuksi.
 */
function testReadStateIsScopedToSource(): void {
  markMessageRead("paikky", readId);
  assert.equal(isMessageRead("paikky", readId), true, "Päikyn oma rivi pitää löytyä");
  assert.equal(isMessageRead("paikky", untouchedId), false, "toista Päikyn tunnistetta ei ole merkitty");
  assert.ok(!listReadMessageIds("paikky").has(untouchedId), "lähdekohtainen listaus ei saa vuotaa yli");

  markMessageRead("paikky", paikkyId);
  assert.equal(isMessageRead("wilma", paikkyId), false, "Päikyn tunniste ei saa näkyä Wilman luettuna");
  assert.ok(listReadMessageIds("paikky").has(paikkyId), "merkkijonotunniste kelpaa sellaisenaan");
  console.log("ok  luettu-tila on lähdekohtainen eikä vuoda lähteestä toiseen");
}

function testMarkMessagesReadMarksEachDistinctId(): void {
  const ids = ["1001", "1002", "1002", "1003"];
  const marked = markMessagesRead("paikky", ids);
  assert.equal(marked, 3, "sama tunniste kahdesti on yksi viesti");

  const read = listReadMessageIds("paikky");
  for (const id of ["1001", "1002", "1003"]) {
    assert.ok(read.has(id), `joukkomerkinnän pitää kattaa ${id}`);
  }
  assert.equal(isMessageRead("wilma", "1001"), false, "joukkomerkintä ei saa vuotaa toiseen lähteeseen");

  // Toistokin on turvallinen: näyttö voi lähettää saman listan uudestaan.
  assert.equal(markMessagesRead("paikky", ids), 3, "uudelleenajo ei kaadu eikä muuta tulosta");
  assert.equal(markMessagesRead("paikky", []), 0, "tyhjä lista ei merkitse mitään");
  console.log("ok  markMessagesRead merkitsee jokaisen eri tunnisteen kerran ja on toistettavissa");
}

/**
 * `node:sqlite` sitoo JS-numeron liukulukuna, joten TEXT-sarakkeeseen
 * tallentuisi "86930.0". Sitä riviä ei löytäisi enää kumpikaan haku — ei
 * numerolla eikä merkkijonolla — jolloin viesti näyttäisi ikuisesti
 * lukemattomalta ja taulu täyttyisi roskariveistä ilman mitään virhettä.
 * Tyyppi `string` ei estä tätä: numero voi tulla JSON-rungosta.
 */
function testNumericIdIsStoredAsPlainText(): void {
  const numeric = 86930 as unknown as string;
  markMessageRead("wilma", numeric);

  const stored = inspector
    .prepare("SELECT message_id, typeof(message_id) AS kind FROM message_reads WHERE source = 'wilma' AND message_id = ?")
    .get("86930") as { message_id: string; kind: string } | undefined;
  assert.ok(stored, 'numeroargumentin pitää tallentua tekstinä "86930", ei "86930.0"');
  assert.equal(stored.kind, "text", "sarakkeeseen ei saa päätyä liukulukua");
  assert.equal(stored.message_id, "86930");
  assert.equal(isMessageRead("wilma", numeric), true, "numerona haettuna sama rivi löytyy");
  assert.equal(isMessageRead("wilma", "86930"), true, "ja merkkijonona sama rivi");

  // Joukkomerkintä samoin: numero ja merkkijono ovat SAMA viesti, eivät kaksi,
  // joten palautettu lukumäärä ei saa laskea niitä erikseen.
  const marked = markMessagesRead("paikky", [86931 as unknown as string, "86931", 86932 as unknown as string]);
  assert.equal(marked, 2, "86931 numerona ja merkkijonona on yksi viesti");

  const ids = listReadMessageIds("paikky");
  assert.ok(ids.has("86931") && ids.has("86932"), "joukkomerkinnän numerot tallentuvat tekstitunnisteina");
  assert.ok(![...ids].some((id) => id.includes(".")), 'yhdessäkään tunnisteessa ei saa olla ".0"-häntää');
  console.log("ok  numeroargumentti tallentuu tekstitunnisteena eikä liukulukuna");
}

testMigrationMovesLegacyRowsToWilma();
testMigrationIsIdempotent();
testMigrationDoesNotTouchAlreadyMigratedRows();
testMigrationCopiesDatabaseBeforeChangingIt();
testMigrationDoesNotCopyWhenNothingToMigrate();
testMigrationSurvivesLeftoverTable();
testFailedMigrationLeavesNoOpenTransaction();
testUnknownMessageIsNotRead();
testMarkingReadPersists();
testMarkingReadTwiceStaysConsistent();
testListReadMessageIdsIncludesMarkedOnes();
testReadStateIsScopedToSource();
testMarkMessagesReadMarksEachDistinctId();
testNumericIdIsStoredAsPlainText();

console.log("\nall message-read tests passed");
process.exit(0);
