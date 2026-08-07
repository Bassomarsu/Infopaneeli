/**
 * Savutesti oikeaa Wilmaa vasten. Aja aina kun @wilm-ai/wilma-client -kirjaston
 * versiota nostetaan tai kun näyttö väittää Wilman olevan rikki.
 *
 * Testi kutsuu jokaista metodia, jota infonäyttö oikeasti käyttää, ja kertoo
 * saatiinko odotetut kentät. Se vastaa myös kahteen asiaan, joita Wilma ei
 * dokumentoi: palauttaako /schedule?date= viikon vai yhden päivän, ja mitä
 * Message.status tarkoittaa.
 *
 * Tulostus on tarkoituksella *rakenne, ei sisältö*: lasten nimet maskataan,
 * viestien otsikoita ja runkoja ei tulosteta lainkaan. Testin tuloksen voi siis
 * liittää vikailmoitukseen paljastamatta lasten tietoja.
 *
 * Kirjautumisvirheestä lopetetaan heti — uudelleenyritys väärällä salasanalla on
 * nopein tapa lukita koko perheen Wilma-tili.
 *
 * Aja:  npm run test:smoke --workspace=server
 */
import {
  AuthenticationError,
  MfaRequiredError,
  WilmaClient,
  type Message,
} from "@wilm-ai/wilma-client";
import { config, isWilmaConfigured } from "../src/core/config.ts";
import { localDateKey, shiftDateKey, toFinnishDate } from "../src/core/time.ts";

/** Nimet eivät kuulu testitulosteeseen, mutta pituus kertoo että parsinta onnistui. */
function mask(name: string | null | undefined): string {
  if (!name) return "(puuttuu)";
  return `${name.slice(0, 1)}*** (${name.length} merkkiä)`;
}

function ok(label: string, detail: string): void {
  console.log(`  ok    ${label.padEnd(28)} ${detail}`);
}

function warn(label: string, detail: string): void {
  console.log(`  HUOM  ${label.padEnd(28)} ${detail}`);
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

if (!isWilmaConfigured()) {
  console.error("Wilma-tunnuksia ei ole asetettu. Täytä WILMA_* arvot .env-tiedostoon.");
  process.exit(2);
}

const profile = {
  baseUrl: config.wilma.baseUrl,
  username: config.wilma.username,
  password: config.wilma.password,
  studentNumber: null,
  debug: config.debugMode,
};

const problems: string[] = [];

console.log(`Wilma-savutesti  ${config.wilma.baseUrl}`);
console.log(`kirjasto @wilm-ai/wilma-client, käyttäjä ${mask(config.wilma.username)}\n`);

// --- 1. Oppilaat ---------------------------------------------------------
console.log("1. listStudents()");
let students;
try {
  students = await WilmaClient.listStudents(profile);
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error("\nKIRJAUTUMINEN EPÄONNISTUI. Testi lopetetaan heti, ei uudelleenyritystä.");
    console.error("Tarkista WILMA_USERNAME ja WILMA_PASSWORD .env-tiedostosta.");
    process.exit(1);
  }
  if (err instanceof MfaRequiredError) {
    console.error("\nWilma vaatii kaksivaiheisen tunnistautumisen, jota infonäyttö ei tue.");
    process.exit(1);
  }
  throw err;
}

if (students.length === 0) {
  problems.push("listStudents palautti tyhjän listan");
  warn("oppilaita", "0 — kotisivun /!numero/-linkkien parsinta on todennäköisesti rikki");
} else {
  ok("oppilaita", String(students.length));
  for (const s of students) {
    ok(`  ${s.studentNumber}`, `${mask(s.name)} href=${s.href}`);
    if (!s.studentNumber) problems.push("oppilaalta puuttuu studentNumber");
  }
}

const first = students[0];
if (!first) process.exit(problems.length > 0 ? 1 : 0);

// --- 2. Kirjautuminen yhdelle lapselle -----------------------------------
console.log(`\n2. login() oppilaalle ${first.studentNumber}`);
const client = await WilmaClient.login({ ...profile, studentNumber: first.studentNumber });
ok("istunto", "luotu");

// --- 3. Yleisnäkymä = kuluva viikko --------------------------------------
console.log("\n3. overview.get()");
const overview = await client.overview.get();
const overviewDates = distinct(overview.schedule.map((l) => l.date)).sort();

if (overview.schedule.length === 0) {
  problems.push("overview.get palautti 0 tuntia — juuri se allekirjoitus, jonka Wilman päivitys jättää");
  warn("tunteja", "0 — lukujärjestyksen JSON-lohkon parsinta on todennäköisesti rikki");
} else {
  ok("tunteja", String(overview.schedule.length));
  ok("eri päiviä", `${overviewDates.length} kpl: ${overviewDates.join(", ")}`);

  const lesson = overview.schedule[0];
  if (lesson) {
    const missing = (["date", "start", "end", "subject", "teacher"] as const).filter(
      (key) => !lesson[key],
    );
    if (missing.length > 0) {
      problems.push(`tunnista puuttuu kenttiä: ${missing.join(", ")}`);
      warn("tunnin kentät", `puuttuu: ${missing.join(", ")}`);
    } else {
      ok("tunnin kentät", `date=${lesson.date} ${lesson.start}-${lesson.end} aine ja opettaja saatu`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lesson.date)) {
      problems.push(`date ei ole YYYY-MM-DD-muodossa: ${lesson.date}`);
      warn("date-muoto", `${lesson.date} — infonäyttö olettaa YYYY-MM-DD`);
    }
  }
}

ok("läksyjä", String(overview.homework.length));
ok("kokeita", String(overview.upcomingExams.length));

// --- 4. Viikko vai päivä? ------------------------------------------------
// Tämä on toinen suunnitelman kahdesta dokumentoimattomasta oletuksesta.
const probeDate = shiftDateKey(localDateKey(), 7);
console.log(`\n4. schedule.list({ date: "${toFinnishDate(probeDate)}" })  — viikko vai päivä?`);
const probe = await client.schedule.list({ date: toFinnishDate(probeDate) });
const probeDates = distinct(probe.map((l) => l.date)).sort();

if (probe.length === 0) {
  warn("tunteja", "0 — voi olla loma tai rikkoutunut parsinta; tarkista päivämäärä");
} else if (probeDates.length > 1) {
  ok("tulos", `VIIKKO — ${probe.length} tuntia, ${probeDates.length} eri päivää`);
  ok("päivät", probeDates.join(", "));
} else {
  ok("tulos", `YKSI PÄIVÄ — ${probe.length} tuntia päivälle ${probeDates[0]}`);
  warn(
    "seuraus",
    "provider olettaa viikkovastauksen; yhden päivän vastaus tarkoittaa useampaa kutsua",
  );
  problems.push("schedule.list palautti yhden päivän, ei viikkoa — tarkista providerin oletus");
}
if (probeDates.length > 0 && !probeDates.includes(probeDate)) {
  warn("pyydetty päivä", `${probeDate} ei ole vastauksessa — Wilma palautti eri jakson`);
}

// --- 5. Viestilista ------------------------------------------------------
console.log("\n5. messages.list('inbox')");
const inbox = await client.messages.list("inbox");
ok("viestejä", String(inbox.length));

// Tyhjä tulos on sekä täysin normaali (ei viestejä) että rikkoutuneen parsinnan
// allekirjoitus, eikä niitä voi erottaa toisistaan itse tuloksesta. Arkisto on
// halpa ristiintarkistus: jos sieltä löytyy viestejä, parseri toimii ja
// postilaatikko on aidosti tyhjä.
if (inbox.length === 0) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const archive = await client.messages.list("archive");
  if (archive.length > 0) {
    ok("arkisto", `${archive.length} viestiä — parseri toimii, postilaatikko on aidosti tyhjä`);
  } else {
    warn("arkisto", "myös tyhjä — ei voida sanoa toimiiko viestien parsinta lainkaan");
    problems.push(
      "sekä saapuneet että arkisto ovat tyhjiä: viestien parsintaa ei ole todennettu kertaakaan",
    );
  }
}

const firstListed = inbox[0];
if (firstListed) {
  const keys = Object.keys(firstListed).sort();
  ok("listan kentät", keys.join(", "));
  // Tämä on se havainto, jonka takia lähettäjä ja luettu-tila haetaan viestin
  // omista tiedoista. Jos ne alkavat joskus tulla listalta, sen näkee tästä.
  if ("senderName" in firstListed || "status" in firstListed) {
    warn(
      "listalla on detail-kenttiä",
      "senderName/status löytyi listalta — providerin voi ehkä keventää",
    );
  } else {
    ok("listalla ei ole", "senderName eikä status — kuten provider olettaa");
  }
  if (!(firstListed.sentAt instanceof Date)) {
    problems.push(`sentAt ei ole Date vaan ${typeof firstListed.sentAt}`);
    warn("sentAt", `tyyppi ${typeof firstListed.sentAt}, odotettiin Date`);
  }
  if (!firstListed.subject) problems.push("viestin otsikko on tyhjä");
}

// --- 6. Viestin tiedot ja status-kentän merkitys -------------------------
// Suunnitelman toinen dokumentoimaton oletus: mitä Message.status tarkoittaa.
console.log("\n6. messages.get(id)  — mitä status tarkoittaa?");
const sample = inbox.slice(0, 3);
const statuses: Array<{ id: number; status: unknown }> = [];

for (const message of sample) {
  let detail: Message;
  try {
    detail = await client.messages.get(message.wilmaId);
  } catch (err) {
    problems.push(`messages.get(${message.wilmaId}) epäonnistui`);
    warn(`viesti ${message.wilmaId}`, `haku epäonnistui: ${(err as Error).message}`);
    continue;
  }
  statuses.push({ id: message.wilmaId, status: detail.status });
  ok(
    `viesti ${message.wilmaId}`,
    `lähettäjä ${mask(detail.senderName)}, status=${JSON.stringify(detail.status)} ` +
      `(${typeof detail.status}), runko ${detail.content?.length ?? 0} merkkiä`,
  );
  if (!detail.senderName) {
    problems.push(`viestistä ${message.wilmaId} puuttuu senderName myös detail-vastauksessa`);
  }
  if (!detail.content) {
    problems.push(`viestistä ${message.wilmaId} puuttuu runko`);
  }
  // Ei jyskytetä koulun palvelinta.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const values = distinct(statuses.map((s) => JSON.stringify(s.status)));
if (values.length <= 1 && statuses.length > 1) {
  warn(
    "status",
    `kaikilla sama arvo ${values[0]} — luettu/lukematon-tulkintaa ei voi vahvistaa tällä otoksella`,
  );
} else if (values.length > 1) {
  ok("status-arvot", `${values.join(" ja ")} — kenttä erottelee viestejä, tulkinta 0 = lukematon`);
}

// --- Yhteenveto ----------------------------------------------------------
console.log("\n" + "-".repeat(60));
if (problems.length === 0) {
  console.log("savutesti läpi: jokainen käytetty metodi palautti odotetut kentät");
  process.exit(0);
}
console.log(`savutestissä ${problems.length} huomiota:`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
