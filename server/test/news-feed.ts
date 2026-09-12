/**
 * Ylen RSS-syötteen jäsennys. Syöte tulee verkosta eikä sen muodosta ole
 * mitään takuuta, joten `parseNewsFeed` on kirjoitettu totaaliksi: se ei saa
 * heittää millään syötteellä, ja yhden rikkinäisen jutun on pudottava pois
 * ilman että se vie mukanaan ehjiä.
 *
 * Aja:  npm run test:news --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { Provider } from "../src/core/provider.ts";
import { createNewsProvider, parseNewsFeed, resetHiddenFetchGuard, shouldFetchNews } from "../src/providers/news.ts";
import { updateSettings } from "../src/core/settings.ts";
import { db, writeCache } from "../src/core/store.ts";

/** Rakentaa yhden `<item>`-lohkon samassa muodossa kuin Ylen syöte. */
function item(fields: Record<string, string>): string {
  const inner = Object.entries(fields)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`)
    .join("");
  return `<item>${inner}</item>`;
}

function feed(...items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Yle Uutiset | Pääuutiset</title><link>https://yle.fi/uutiset</link><ttl>5</ttl>${items.join("")}</channel></rss>`;
}

/**
 * Katkelma oikeasta syötteestä 12.9.2026, kentät ja järjestys sellaisenaan.
 * Tämä on ainoa testi, joka kuvaa syötteen TODELLISEN muodon — muut käyttävät
 * rakennettuja lohkoja, jotka voisivat ajautua siitä huomaamatta erilleen.
 */
const REAL_SAMPLE = `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Yle Uutiset | Pääuutiset</title><description>Ylen pääuutiset nopeasti ja luotettavasti</description><link>https://yle.fi/uutiset</link><atom:link href="https://yle.fi/rss/uutiset/paauutiset" rel="self" type="application/rss+xml"/><copyright>Yle | Katso RSS-syötteen käyttöehdot: https://yle.fi/aihe/a/20-10008076</copyright><language>fi</language><ttl>5</ttl><category>Pääuutiset</category><lastBuildDate>Sat, 12 Sep 2026 13:18:09 +0300</lastBuildDate><item><title>Tampereen väkiluku pieneni ensimmäistä kertaa 18 vuoteen</title><link>https://yle.fi/a/74-20245318?origin=rss</link><description>Synkkä työttömyystilanne vaikuttaa jo kaupungin vetovoimaan.</description><category>Työllisyys</category><category>Tampere</category><guid isPermaLink="false">https://yle.fi/a/74-20245318</guid><pubDate>Sat, 12 Sep 2026 10:22:17 +0300</pubDate></item><item><title>Suomen korkein toimistorakennus nousee keskelle Helsingin siluettia – pilvenpiirtäjän voi nähdä jo Suomenlinnasta asti</title><link>https://yle.fi/a/74-20244240?origin=rss</link><description>Pilvenpiirtäjästä tulee Helsingin uusi maamerkki ja Elisan pääkonttori alkukesällä 2028.</description><category>Rakennukset</category><guid isPermaLink="false">https://yle.fi/a/74-20244240</guid><pubDate>Sat, 12 Sep 2026 12:56:21 +0300</pubDate></item></channel></rss>`;

function testRealSample(): void {
  const items = parseNewsFeed(REAL_SAMPLE);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: "https://yle.fi/a/74-20245318",
    title: "Tampereen väkiluku pieneni ensimmäistä kertaa 18 vuoteen",
    link: "https://yle.fi/a/74-20245318?origin=rss",
    publishedAt: "2026-09-12T07:22:17.000Z",
    summary: "Synkkä työttömyystilanne vaikuttaa jo kaupungin vetovoimaan.",
  });
  // Kanavan oma <title>/<link> ei saa vuotaa jutuiksi, eikä <atom:link>
  // saa osua <link>-hakuun.
  assert.equal(items[1]?.link, "https://yle.fi/a/74-20244240?origin=rss");
  assert.equal(items[1]?.title.includes("–"), true, "ajatusviiva säilyy sellaisenaan");
  console.log("ok  oikea syöte jäsentyy kenttä kentältä odotetusti");
}

function testLinkIsPassedThroughVerbatim(): void {
  // Käyttöehtojen vaatimus: linkin on johdettava suoraan juttuun. Siksi
  // `?origin=rss` EI saa kadota eikä linkkiä korvata guidilla.
  const items = parseNewsFeed(REAL_SAMPLE);
  assert.equal(items[0]?.link, "https://yle.fi/a/74-20245318?origin=rss");
  assert.notEqual(items[0]?.link, items[0]?.id, "guid ja link ovat eri osoitteet, kumpikin omassa kentässään");
  console.log("ok  link välitetään sellaisenaan, origin-parametri mukaan lukien");
}

function testEntitiesAreDecoded(): void {
  const items = parseNewsFeed(
    feed(
      item({
        title: "Talous &amp; politiikka: &quot;ei n&#228;in&quot; &#8217;26",
        link: "https://yle.fi/a/1",
        description: "Kello 5 &lt; 6 &amp;&amp; 7 &gt; 6",
        pubDate: "Sat, 12 Sep 2026 10:22:17 +0300",
      }),
    ),
  );
  assert.equal(items[0]?.title, 'Talous & politiikka: "ei näin" ’26');
  assert.equal(items[0]?.summary, "Kello 5 < 6 && 7 > 6");
  console.log("ok  nimetyt, desimaaliset ja heksa-entiteetit puretaan");
}

function testDoubleEscapedEntityIsNotDecodedTwice(): void {
  // `&amp;lt;` tarkoittaa kirjaimellista tekstiä "&lt;", ei merkkiä "<".
  // Ketjutettu replace purkaisi tämän väärin.
  const items = parseNewsFeed(
    feed(item({ title: "&amp;lt;otsikko&amp;gt;", link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
  );
  assert.equal(items[0]?.title, "&lt;otsikko&gt;");
  console.log("ok  kahdesti koodattua entiteettiä ei pureta kahdesti");
}

function testUnknownEntityIsLeftAlone(): void {
  const items = parseNewsFeed(
    feed(item({ title: "Firma &tuntematon; Oy", link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
  );
  assert.equal(items[0]?.title, "Firma &tuntematon; Oy");
  console.log("ok  tuntematon entiteetti jätetään koskemattomaksi");
}

function testCdataIsUnwrapped(): void {
  const items = parseNewsFeed(
    feed(
      item({
        title: "<![CDATA[Otsikko & sen jatko]]>",
        link: "https://yle.fi/a/1",
        description: "<![CDATA[Ingressi, jossa on &amp; kirjaimellisena]]>",
        pubDate: "Sat, 12 Sep 2026 10:22:17 +0300",
      }),
    ),
  );
  assert.equal(items[0]?.title, "Otsikko & sen jatko");
  // CDATA:n sisällä entiteetti on tekstiä, ei entiteetti.
  assert.equal(items[0]?.summary, "Ingressi, jossa on &amp; kirjaimellisena");
  console.log("ok  CDATA puretaan eikä sen sisältöä entiteettipureta");
}

function testUnterminatedCdataDoesNotThrow(): void {
  const broken = `<rss><channel><item><title><![CDATA[Katkennut otsikko</title><link>https://yle.fi/a/1</link><pubDate>Sat, 12 Sep 2026 10:22:17 +0300</pubDate></item></channel></rss>`;
  const items = parseNewsFeed(broken);
  assert.equal(Array.isArray(items), true);
  console.log("ok  sulkematon CDATA ei kaada jäsennintä");
}

function testWhitespaceIsCollapsed(): void {
  const items = parseNewsFeed(
    feed(
      item({
        title: "\n      Otsikko\n      kahdella rivillä\n    ",
        link: "\n  https://yle.fi/a/1\n  ",
        pubDate: "Sat, 12 Sep 2026 10:22:17 +0300",
      }),
    ),
  );
  assert.equal(items[0]?.title, "Otsikko kahdella rivillä");
  assert.equal(items[0]?.link, "https://yle.fi/a/1");
  console.log("ok  XML:n sisennykset tiivistyvät yhteen välilyöntiin");
}

function testLongTitleIsNotTruncated(): void {
  const long = "Sana ".repeat(80).trim();
  const items = parseNewsFeed(
    feed(item({ title: long, link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
  );
  assert.equal(items[0]?.title, long, "katkaisu on näyttöpuolen asia, ei palvelimen");
  console.log("ok  pitkää otsikkoa ei katkaista palvelimella");
}

function testMissingDescriptionBecomesNull(): void {
  const items = parseNewsFeed(
    feed(item({ title: "Otsikko", link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
  );
  assert.equal(items[0]?.summary, null);
  console.log("ok  puuttuva description on null eikä tyhjä merkkijono");
}

function testEmptyDescriptionBecomesNull(): void {
  const items = parseNewsFeed(
    feed(
      item({ title: "Otsikko", link: "https://yle.fi/a/1", description: "   ", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" }),
    ),
  );
  assert.equal(items[0]?.summary, null);
  console.log("ok  tyhjä description on null");
}

function testGuidFallsBackToLink(): void {
  const items = parseNewsFeed(
    feed(item({ title: "Otsikko", link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
  );
  assert.equal(items[0]?.id, "https://yle.fi/a/1");
  console.log("ok  ilman guidia tunnisteeksi kelpaa linkki");
}

function testBrokenItemsAreSkippedButOthersSurvive(): void {
  const good = item({
    title: "Kelvollinen",
    link: "https://yle.fi/a/ok",
    pubDate: "Sat, 12 Sep 2026 10:22:17 +0300",
  });
  const cases: Array<[string, string]> = [
    ["otsikko puuttuu", item({ link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })],
    ["otsikko on tyhjä", item({ title: "   ", link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })],
    ["linkki puuttuu", item({ title: "Otsikko", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })],
    ["pubDate puuttuu", item({ title: "Otsikko", link: "https://yle.fi/a/1" })],
    [
      "pubDate ei ole tulkittavissa",
      item({ title: "Otsikko", link: "https://yle.fi/a/1", pubDate: "joskus viime viikolla" }),
    ],
    ["linkki ei ole osoite", item({ title: "Otsikko", link: "ei tämä mikään osoite ole", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })],
  ];

  for (const [why, broken] of cases) {
    const items = parseNewsFeed(feed(broken, good));
    assert.equal(items.length, 1, `${why}: rikkinäinen juttu pitää pudota`);
    assert.equal(items[0]?.title, "Kelvollinen", `${why}: ehjä juttu ei saa pudota mukana`);
  }
  console.log("ok  vajaa juttu pudotetaan, muut säilyvät");
}

function testNonHttpLinkIsRejected(): void {
  // Osoite päätyy selaimessa href-attribuuttiin, joten javascript:-skeema
  // olisi suoraan koodin suoritus näyttölaitteella.
  for (const link of ["javascript:alert(1)", "data:text/html,<script>x</script>", "file:///etc/passwd"]) {
    const items = parseNewsFeed(
      feed(item({ title: "Otsikko", link, pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
    );
    assert.deepEqual(items, [], `${link} ei saa päästä läpi`);
  }
  console.log("ok  vain http(s)-linkit kelpaavat");
}

/**
 * Isäntärajoitus. Kaksi syytä, kumpikin yksin riittävä: Ylen ehdot vaativat
 * että linkki johtaa Ylen sivustolle, ja kaapattu syöte veisi perheen
 * puhelimen minne tahansa osoitteeseen luotetun lähteen nimissä.
 */
function testOnlyYleHostsAreAccepted(): void {
  const accepted = [
    "https://yle.fi/a/74-20245318?origin=rss",
    "https://yle.fi/uutiset/3-12345",
    "https://areena.yle.fi/1-50000",
  ];
  for (const link of accepted) {
    const items = parseNewsFeed(feed(item({ title: "Otsikko", link, pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })));
    assert.equal(items.length, 1, `${link} pitäisi kelvata`);
    assert.equal(items[0]?.link, link, "osoite välitetään sellaisenaan");
  }

  const rejected = [
    "https://example.invalid/ostatuotteita",
    // Pelkkä http pudotetaan vaikka isäntä olisi oikea: syöte antaa aina
    // https, joten sallivuudesta ei ole hyötyä — mutta kaapattu http-linkki
    // avautuisi salaamattomana osoitteella joka näyttää oikealta.
    "http://yle.fi/a/74-4",
    "http://areena.yle.fi/1-50000",
    // Protokollaton ja punycode-huijaus.
    "//yle.fi/a/1",
    "https://xn--yle-fia.fi/a/1",
    // Pelkkä endsWith("yle.fi") ilman pistettä päästäisi nämä läpi.
    "https://notyle.fi/a/1",
    "https://myle.fi/a/1",
    "https://yle.fi.example.com/a/1",
    "https://evil.com/?u=https://yle.fi/a/1",
    "https://yle.fi.evil.com/a/1",
    // Skeematarkistus on yhä voimassa.
    "javascript:alert(1)",
    "data:text/html,<script>x</script>",
    "file:///etc/passwd",
    "ei tämä mikään osoite ole",
  ];
  for (const link of rejected) {
    const items = parseNewsFeed(feed(item({ title: "Otsikko", link, pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })));
    assert.deepEqual(items, [], `${link} ei saa päästä läpi`);
  }

  // Isot kirjaimet eivät kierrä tarkistusta: URL normalisoi isäntänimen.
  const upper = parseNewsFeed(
    feed(item({ title: "Otsikko", link: "HTTPS://YLE.FI/a/1", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" })),
  );
  assert.equal(upper.length, 1, "YLE.FI on sama isäntä kuin yle.fi");

  // Yksi kelvollinen juttu vieraan linkin vieressä säilyy.
  const mixed = parseNewsFeed(
    feed(
      item({ title: "Vieras", link: "https://example.invalid/x", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" }),
      item({ title: "Ylen juttu", link: "https://yle.fi/a/2", pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" }),
    ),
  );
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]?.title, "Ylen juttu");
  console.log("ok  vain https ja yle.fi (tai sen aliverkkotunnus) kelpaa linkiksi");
}

/**
 * Jäsennyksen työmäärä ei saa kasvaa neliöllisesti syötteen pituuteen nähden.
 *
 * Aiempi säännöllisiin lausekkeisiin perustuva toteutus jumitti KOKO
 * tapahtumasilmukan kymmeniksi sekunneiksi syötteillä jotka mahtuvat
 * MAX_FEED_BYTESin alle — mitattuna 40 s / 1,14 Mt. Syöte tulee
 * kolmannelta osapuolelta eikä siihen tarvita hyökkääjää, vain rikkinäistä
 * XML:ää. Providerin `timeoutMs` ei voi keskeyttää synkronista työtä.
 *
 * Aikabudjetti on tahallisen löysä (2 s) verrattuna mitattuun (1–4 ms):
 * testin on tarkoitus havaita ALGORITMIN muutos neliölliseksi, ei koneen
 * kuormaa. Neliöllinen toteutus ylittää tämän 10–20-kertaisesti.
 */
function testParsingIsLinearNotQuadratic(): void {
  const BUDGET_MS = 2000;
  const cases: Array<[string, string]> = [
    ["120 000 avaavaa <title> ilman sulkevaa", `<rss><channel><item>${"<title>".repeat(120_000)}</item></channel></rss>`],
    ["200 000 avaavaa <item> ilman sulkevaa", `<rss><channel>${"<item>".repeat(200_000)}</channel></rss>`],
    ["150 000 avaavaa <link> ilman sulkevaa", `<rss><channel><item>${"<link>".repeat(150_000)}</item></channel></rss>`],
    ["sekalaisia avaavia tageja", `<rss><channel><item>${"<title><link><guid>".repeat(50_000)}</item></channel></rss>`],
    ["2 Mt tyhjiä <item></item>-pareja", `<rss><channel>${"<item></item>".repeat(160_000)}</channel></rss>`],
    ["yksi <item> jossa 2 Mt roskaa", `<rss><channel><item>${"x".repeat(2_000_000)}</item></channel></rss>`],
    ["2 Mt pelkkiä <-merkkejä", "<".repeat(2_000_000)],
    ["2 Mt pelkkiä &-merkkejä", `<rss><channel><item><title>${"&".repeat(1_900_000)}</title></item></channel></rss>`],
    ["2 Mt avaamattomia CDATA-lohkoja", `<rss><channel><item><title>${"<![CDATA[".repeat(200_000)}</title></item></channel></rss>`],
    ["2 Mt entiteettialkuja", `<rss><channel><item><title>${"&#x".repeat(600_000)}</title></item></channel></rss>`],
  ];

  for (const [why, xml] of cases) {
    const started = performance.now();
    parseNewsFeed(xml);
    const took = performance.now() - started;
    assert.ok(took < BUDGET_MS, `${why}: jäsennys kesti ${took.toFixed(0)} ms (raja ${BUDGET_MS} ms)`);
  }
  console.log("ok  jäsennys pysyy lineaarisena myös kokokaton rajalla");
}

function testDuplicateGuidsAreDropped(): void {
  const one = item({
    title: "Ensimmäinen",
    link: "https://yle.fi/a/1?origin=rss",
    guid: "https://yle.fi/a/1",
    pubDate: "Sat, 12 Sep 2026 10:22:17 +0300",
  });
  const again = item({
    title: "Sama juttu uudestaan",
    link: "https://yle.fi/a/1?origin=rss",
    guid: "https://yle.fi/a/1",
    pubDate: "Sat, 12 Sep 2026 11:22:17 +0300",
  });
  const items = parseNewsFeed(feed(one, again));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.title, "Ensimmäinen", "ensimmäinen esiintymä voittaa");
  console.log("ok  sama guid kahdesti tuottaa yhden jutun");
}

function testOrderIsPreserved(): void {
  const items = parseNewsFeed(
    feed(
      item({ title: "A", link: "https://yle.fi/a/1", pubDate: "Sat, 12 Sep 2026 08:00:00 +0300" }),
      item({ title: "B", link: "https://yle.fi/a/2", pubDate: "Sat, 12 Sep 2026 12:00:00 +0300" }),
      item({ title: "C", link: "https://yle.fi/a/3", pubDate: "Sat, 12 Sep 2026 10:00:00 +0300" }),
    ),
  );
  assert.deepEqual(
    items.map((i) => i.title),
    ["A", "B", "C"],
    "syötteen järjestys on toimituksellinen, palvelin ei järjestä sitä uudelleen",
  );
  console.log("ok  syötteen järjestys säilyy");
}

function testItemCount(): void {
  const many = Array.from({ length: 60 }, (_, i) =>
    item({ title: `Juttu ${i}`, link: `https://yle.fi/a/${i}`, pubDate: "Sat, 12 Sep 2026 10:22:17 +0300" }),
  );
  const items = parseNewsFeed(feed(...many));
  assert.equal(items.length, 30, "poikkeavan pitkä syöte rajataan");
  assert.equal(items[0]?.title, "Juttu 0");
  console.log("ok  juttujen määrä on ylhäältä rajattu");
}

function testGarbageInputReturnsEmptyList(): void {
  const cases: Array<[string, string]> = [
    ["tyhjä vastaus", ""],
    ["pelkkää välilyöntiä", "   \n  "],
    ["HTML-virhesivu", "<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body><h1>503</h1></body></html>"],
    ["JSON", '{"error":"not found"}'],
    ["kesken katkennut XML", '<rss version="2.0"><channel><item><title>Otsikko</title><link>https://yle.fi/a/1</li'],
    ["item ilman sulkevaa tagia", "<rss><channel><item><title>Otsikko</title></channel></rss>"],
    ["kanava ilman juttuja", feed()],
    ["pelkkä < -merkki", "<"],
    ["binäärinen roska", " <item"],
  ];
  for (const [why, xml] of cases) {
    const items = parseNewsFeed(xml);
    assert.deepEqual(items, [], `${why} ei saa tuottaa juttuja`);
  }
  console.log("ok  rikkinäinen syöte tuottaa tyhjän listan eikä poikkeusta");
}

function testHtmlErrorPageWithItemWordDoesNotProduceNews(): void {
  // Ei riitä että HTML-sivu palauttaa tyhjän listan vahingossa: sivu joka
  // sisältää sanan "item" ei saa tuottaa juttua ilman linkkiä ja aikaa.
  const html = "<html><body><div class=\"item\"><title>Virhe</title></div></body></html>";
  assert.deepEqual(parseNewsFeed(html), []);
  console.log("ok  HTML-sivun 'item' ei muutu uutiseksi");
}

function testHiddenPanelStopsFetching(): void {
  updateSettings({ hiddenPanels: [] });
  assert.equal(shouldFetchNews(), true, "näkyvä kortti haetaan");

  updateSettings({ hiddenPanels: ["news"] });
  assert.equal(shouldFetchNews(), false, "piilotettua korttia ei haeta");

  updateSettings({ hiddenPanels: ["weather"] });
  assert.equal(shouldFetchNews(), true, "toisen kortin piilotus ei estä uutishakua");

  updateSettings({ hiddenPanels: [] });
  console.log("ok  hiddenPanels ohjaa uutisproviderin hakukierroksia");
}

/**
 * Väite "piilotettu kortti ei hae" ei ole pelkkä predikaatti vaan sen ja
 * provider.ts:n `shouldRun`-portin yhteistoiminta, joten se todennetaan
 * oikealla Providerilla eikä vain shouldFetchNewsia kutsumalla. Haku on
 * valheellinen (ei verkkoa), intervalli pitkä ettei ajastin ehdi laukaista
 * ylimääräistä kierrosta kesken testin.
 */
async function testHiddenPanelSkipsRealProviderCycles(): Promise<void> {
  let calls = 0;
  const provider = new Provider<{ n: number }>({
    id: `test-news-gate-${process.pid}`,
    intervalMs: 60_000,
    initialDelayMs: 60_000,
    shouldRun: shouldFetchNews,
    fetch: async () => ({ n: ++calls }),
  });

  try {
    updateSettings({ hiddenPanels: [] });
    await provider.runOnce();
    assert.equal(calls, 1, "näkyvä kortti hakee");

    updateSettings({ hiddenPanels: ["news"] });
    await provider.runOnce();
    await provider.runOnce();
    assert.equal(calls, 1, "piilotettu kortti ei tee yhtään hakua");
    assert.deepEqual(provider.snapshot().data, { n: 1 }, "vanha data säilyy portin takana");

    updateSettings({ hiddenPanels: [] });
    await provider.runOnce();
    assert.equal(calls, 2, "käyttöön palautettu kortti hakee taas ilman uudelleenkäynnistystä");
  } finally {
    provider.stop();
    updateSettings({ hiddenPanels: [] });
  }
  console.log("ok  piilotettu kortti ohittaa hakukierrokset, käyttöön palautettu jatkaa");
}

/**
 * Portin toinen puoli: ENSIMMÄINEN haku tehdään vaikka kortti olisi piilossa
 * jo käynnistettäessä (provider.ts ohittaa shouldRunin kun dataa ei ole
 * lainkaan). Näin käyttöön otetulla kortilla on heti jotain näytettävää.
 */
async function testFirstFetchRunsEvenWhenHidden(): Promise<void> {
  let calls = 0;
  const provider = new Provider<{ n: number }>({
    id: `test-news-cold-${process.pid}`,
    intervalMs: 60_000,
    initialDelayMs: 60_000,
    shouldRun: shouldFetchNews,
    fetch: async () => ({ n: ++calls }),
  });

  try {
    updateSettings({ hiddenPanels: ["news"] });
    await provider.runOnce();
    assert.equal(calls, 1, "tyhjä provideri hakee kerran myös piilotettuna");
    await provider.runOnce();
    assert.equal(calls, 1, "sen jälkeen portti pitää");
  } finally {
    provider.stop();
    updateSettings({ hiddenPanels: [] });
  }
  console.log("ok  ensimmäinen haku tehdään vaikka kortti olisi piilossa");
}

/**
 * Piilotettu kortti ei saa hakea syötettä ikuisesti.
 *
 * `shouldRun` yksin ei riitä: provider.ts ohittaa sen niin kauan kuin dataa
 * ei ole kertaakaan saatu, ja epäonnistunut haku ei aseta dataa — joten
 * pysyvästi pois kytketty kortti, jonka syöte on poikki, hakisi
 * perääntymisen tahdissa loputtomiin. Tämä testi LASKEE todelliset
 * verkkopyynnöt oikeaa createNewsProvideria vastaan, ei tarkista
 * shouldFetchNewsin paluuarvoa.
 */
async function testHiddenCardMakesAtMostOneNetworkAttempt(): Promise<void> {
  const realFetch = globalThis.fetch;
  let httpCalls = 0;
  globalThis.fetch = (async () => {
    httpCalls++;
    throw new Error("verkko poikki (simuloitu)");
  }) as typeof globalThis.fetch;

  // Kylmä käynnistys: ei välimuistiriviä, jolloin provider.ts:n ohitus on
  // voimassa ja tämä on se tilanne jossa ikuinen haku tapahtuisi.
  db.exec("DELETE FROM provider_cache WHERE id = 'news'");
  updateSettings({ hiddenPanels: ["news"] });
  resetHiddenFetchGuard();

  const provider = createNewsProvider();
  try {
    for (let i = 0; i < 12; i++) await provider.runOnce();
    assert.equal(httpCalls, 1, "piilotettu kortti saa yrittää kerran, ei kahdestitoista");

    // Käyttöön palautus nollaa laskurin, eikä jää jumiin yhteen yritykseen.
    updateSettings({ hiddenPanels: [] });
    await provider.runOnce();
    assert.equal(httpCalls, 2, "näkyviin palautettu kortti hakee taas");
    await provider.runOnce();
    assert.equal(httpCalls, 3, "…ja jatkaa normaalisti joka kierroksella");
  } finally {
    provider.stop();
    globalThis.fetch = realFetch;
    db.exec("DELETE FROM provider_cache WHERE id = 'news'");
    updateSettings({ hiddenPanels: [] });
    resetHiddenFetchGuard();
  }
  console.log("ok  piilotettu kortti tekee enintään yhden verkkopyynnön vaikka syöte olisi poikki");
}

/**
 * Toinen puoli samasta asiasta: kun välimuistissa ON dataa (tavallinen
 * tilanne, koska kortti ehti näkyä ennen piilottamista), yhtään pyyntöä ei
 * lähde — ei edes sitä yhtä.
 */
async function testHiddenCardWithCachedDataMakesNoRequests(): Promise<void> {
  const realFetch = globalThis.fetch;
  let httpCalls = 0;
  globalThis.fetch = (async () => {
    httpCalls++;
    throw new Error("tätä ei olisi pitänyt kutsua");
  }) as typeof globalThis.fetch;

  writeCache(
    "news",
    { items: [{ id: "x", title: "Vanha otsikko", link: "https://yle.fi/a/x", publishedAt: "2026-09-12T00:00:00.000Z", summary: null }] },
    new Date().toISOString(),
  );
  updateSettings({ hiddenPanels: ["news"] });
  resetHiddenFetchGuard();

  const provider = createNewsProvider();
  try {
    for (let i = 0; i < 12; i++) await provider.runOnce();
    assert.equal(httpCalls, 0, "lämpimällä välimuistilla piilotettu kortti ei hae lainkaan");
    assert.equal(provider.snapshot().status, "stale", "vanha data säilyy näytettäväksi jos kortti otetaan käyttöön");
  } finally {
    provider.stop();
    globalThis.fetch = realFetch;
    db.exec("DELETE FROM provider_cache WHERE id = 'news'");
    updateSettings({ hiddenPanels: [] });
    resetHiddenFetchGuard();
  }
  console.log("ok  piilotettu kortti lämpimällä välimuistilla ei tee yhtään pyyntöä");
}

testRealSample();
testLinkIsPassedThroughVerbatim();
testEntitiesAreDecoded();
testDoubleEscapedEntityIsNotDecodedTwice();
testUnknownEntityIsLeftAlone();
testCdataIsUnwrapped();
testUnterminatedCdataDoesNotThrow();
testWhitespaceIsCollapsed();
testLongTitleIsNotTruncated();
testMissingDescriptionBecomesNull();
testEmptyDescriptionBecomesNull();
testGuidFallsBackToLink();
testBrokenItemsAreSkippedButOthersSurvive();
testNonHttpLinkIsRejected();
testDuplicateGuidsAreDropped();
testOnlyYleHostsAreAccepted();
testParsingIsLinearNotQuadratic();
testOrderIsPreserved();
testItemCount();
testGarbageInputReturnsEmptyList();
testHtmlErrorPageWithItemWordDoesNotProduceNews();
testHiddenPanelStopsFetching();
await testHiddenPanelSkipsRealProviderCycles();
await testFirstFetchRunsEvenWhenHidden();
await testHiddenCardMakesAtMostOneNetworkAttempt();
await testHiddenCardWithCachedDataMakesNoRequests();

console.log("\nuutissyötteen jäsennys ok");
