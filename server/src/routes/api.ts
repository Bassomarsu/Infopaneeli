import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { registry, type ProviderSnapshot } from "../core/provider.ts";
import { getSettings, SettingsValidationError, updateSettings } from "../core/settings.ts";
import {
  addNote,
  deleteNote,
  listNotes,
  listReadMessageIds,
  markMessageRead,
  markMessagesRead,
  setNoteDone,
} from "../core/store.ts";
import { config } from "../core/config.ts";
import { isPostalCode, lookupPostalCode } from "../core/postal-codes.ts";
import { currentWeatherLocation } from "../providers/weather.ts";
import { listCustomSounds, resolveCustomSound } from "../core/alarm-sounds.ts";
import { exitKiosk } from "../core/kiosk.ts";
import { logger } from "../core/logging.ts";
import type { PaikkyData } from "../providers/paikky.ts";
import type { WilmaData } from "../providers/wilma.ts";
import { buildCalendarMonth, isMonthKey, trimToDashboardWindow, type CalendarData } from "../providers/calendar.ts";
import { fullPinEnabled, isLocalRequest, isTrustedRequest, requireEditAccess, verifyEditPin, verifyFullPinOnly } from "./access.ts";

/**
 * Providers whose payload contains the children's school data. Päikky kuuluu
 * tänne siinä missä Wilmakin: lapsen läsnäolo- ja hoitoaikatieto kertoo
 * suoraan milloin kotona ei ole ketään.
 */
const SENSITIVE_PROVIDERS = new Set(["wilma", "paikky"]);

/**
 * Providers the "Testaa yhteys" -painike saa herättää manuaalisesti. Erillinen
 * sallittujen lista, ei suora registry.get(pyynnön id) — tunniste otetaan
 * pyynnöstä, joten se validoidaan tätä vasten ennen kuin sillä tehdään
 * mitään. Reitti on tarkoitettu nimenomaan Wilman katkaisijan avaamiseen
 * (ks. core/provider.ts:n manualTest), ei yleiseksi tavaksi käynnistää minkä
 * tahansa providerin hakua pyynnöstä. Päikyllä on sama ongelma kuin Wilmalla,
 * mutta pahempana: jäähdytys venyy Wilmalla neljään ja Päikyllä kahteentoista
 * tuntiin, ja tili lukkiutuu jos sitä kierretään hakkaamalla kirjautumista.
 * Siksi Päikyn manuaalitestien vuorokausikatto on 3, ei Wilman 12
 * (ks. providers/paikky.ts).
 */
export const MANUALLY_TESTABLE_PROVIDERS = new Set(["wilma", "paikky"]);

/**
 * Lähteet joiden viesteillä on paikallinen luettu-kirjanpito (ks. core/store.ts:n
 * message_reads). Erillinen sallittujen lista, ei pyynnön `:source`-parametria
 * sellaisenaan — sama syy kuin MANUALLY_TESTABLE_PROVIDERSissa yllä: parametri
 * päätyy tallennettavan rivin avaimeksi, ja mikä tahansa merkkijono menisi
 * tauluun mutta ei vastaisi mitään lähdettä.
 */
const READ_STATE_SOURCES = new Set(["wilma", "paikky"]);

/**
 * Yläraja "merkitse kaikki luetuiksi" -pyynnön listalle. Palvelin ei tiedä mitä
 * käyttäjä näkee lukemattomana, joten tunnisteet tulevat asiakkaalta — ja juuri
 * siksi erän koko rajataan tässä. Kumpikin lähde hakee kerralla parikymmentä
 * viestiä (Wilma: providers/wilma.ts, Päikky: MESSAGE_LIMIT), joten 200 on
 * reilusti yli todellisen tarpeen mutta estää mielivaltaisen suuren kirjoituserän.
 */
const MAX_READ_ALL_IDS = 200;

/**
 * Pisin hyväksytty viestitunniste. Wilman tunniste on numero, mutta Päikyn
 * `uniqueId` on merkkijono, jonka pituudesta ei ole mitään takuuta (ks.
 * docs/paikky-rajapinta.md) — ja tunniste päätyy sellaisenaan tietokantariviksi.
 */
const MAX_MESSAGE_ID_LENGTH = 200;

/**
 * `typeof === "string"` ei ole tässä muodollisuus: `ids`-lista tulee JSON-
 * rungosta, jossa `{"ids":[86921]}` on täysin kelvollinen eikä TypeScriptin
 * `string[]` estä sitä ajonaikana millään tavalla. Numero päätyisi sellaisenaan
 * tietokantaan liukulukuna ja rivi kirjoittuisi muodossa "86921.0", jota mikään
 * haku ei enää löydä (ks. core/store.ts:n asTextId). Siksi ei-merkkijono
 * torjutaan tässä, eikä muunneta hiljaa.
 */
function isValidMessageId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_MESSAGE_ID_LENGTH;
}

/**
 * Stamps each message with whether it has been opened on this display. Kept
 * out of the cached provider payload on purpose: read state must show up the
 * instant it changes, not wait for the next poll, and it must not be written
 * into `provider_cache` next to data that actually came from the source.
 *
 * `localRead` on TÄMÄN näytön kirjanpito eikä lähteen väite. Päikyn oma
 * `unread` jää viestiin koskemattomana sen rinnalle — se voi olla null, "ei
 * tiedossa" (ks. providers/paikky.ts:parseUnread) — ja käyttöliittymä päättää
 * kumpaa käyttää. Kenttiä ei siis yhdistetä täällä.
 *
 * Tunniste merkkijonoksi: Wilman id on numero ja Päikyn merkkijono, ja taulu
 * säilöö kummankin tekstinä (ks. core/store.ts).
 */
function withLocalReadState<T extends { id: string | number }>(
  source: string,
  messages: T[],
): Array<T & { localRead: boolean }> {
  const readIds = listReadMessageIds(source);
  return messages.map((message) => ({ ...message, localRead: readIds.has(String(message.id)) }));
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  // Kertoo mitkä tasot on ylipäätään asetettu .env:ssä — ei koskaan itse
  // koodeja. Puhelimen käyttöliittymä käyttää tätä päättääkseen kannattaako
  // PIN-syöttöä edes tarjota, ja mitä sillä voi saavuttaa (ks.
  // requireEditAccess/verifyEditPin: kumpikin tyhjä antaa 403:n eri
  // viestillä joka tapauksessa, mutta tämä säästää turhalta väärältä-PIN-
  // yritykseltä pelkän tilan selvittämiseksi). fullPinEnabled, ei
  // config.fullPin.length > 0: liian lyhyt FULL_PIN ei ole käytössä
  // lainkaan, ks. access.ts.
  app.get("/api/edit-access", async () => ({
    editPinConfigured: config.editPin.length > 0,
    fullPinConfigured: fullPinEnabled,
  }));

  // Todentaa leipätekstissä annetun PIN:n ja kertoo minkä TASON se avaa
  // ("edit" tai "full") ilman että se vielä tekee mitään kirjoitusta —
  // selain kutsuu tätä ennen kuin tallentaa koodin itselleen. Sama rajoitin
  // ja samat vastauskoodit kuin x-edit-pin-otsikolla varustetuilla
  // kirjoituspyynnöillä (ks. access.ts:n attemptPin).
  app.post("/api/edit-access", async (request, reply) => {
    const body = request.body as { pin?: unknown } | undefined;
    const level = verifyEditPin(request, reply, body?.pin);
    if (level === null) return reply;
    return { ok: true, level };
  });

  // Poistuminen kioskitilasta: selain ei voi sulkea itse kioskiselaimen
  // ikkunaa eikä purkaa --kiosk-tilaa (JS ei koskaan pääse siihen käsiksi),
  // joten ainoa keino on pyytää PALVELINTA lopettamaan kioskiselaimen
  // prosessi (ks. core/kiosk.ts). Työpöytä jää näkyviin sen jälkeen — laite
  // ei siis "sammu", se vain lakkaa olemasta kioski.
  //
  // Tämä on tietoturvan kannalta poikkeuksellisen painava reitti — se antaa
  // pääsyn koko käyttöjärjestelmään, siis myös .env-tiedoston Wilma-
  // salasanaan — joten kolme ehtoa, kaikki pakollisia eikä mikään niistä
  // korvaa toista:
  //   1. isLocalRequest, EI isTrustedRequest: vain fyysinen näyttölaite,
  //      ei TRUSTED_HOSTS-listan laite eikä puhelin jolla on FULL_PIN
  //      tallessa. Näkymätön painike on fyysisesti näytöllä, joten pyynnön
  //      pitää tulla silmukasta — puhelimen ei ole syytä pystyä sulkemaan
  //      kioskia etänä vaikka sillä olisi muuten täydet oikeudet.
  //   2. verifyFullPinOnly: nimenomaan FULL_PIN, EDIT_PIN ei riitä (ks.
  //      access.ts:n kommentti). Käyttää samaa jaettua arvausrajoitinta
  //      kuin kaikki muutkin PIN-yritykset.
  //   3. Jos FULL_PIN ei ole käytössä (tyhjä tai alle 6 merkkiä),
  //      verifyFullPinOnly hylkää AINA — koko ominaisuus on tällöin pois
  //      käytöstä, ei vain suojaamaton.
  app.post("/api/kiosk/exit", async (request, reply) => {
    if (!isLocalRequest(request)) {
      return reply.code(403).send({ error: "Kioskista poistuminen on sallittu vain näyttölaitteelta." });
    }
    const body = request.body as { pin?: unknown } | undefined;
    if (!verifyFullPinOnly(request, reply, body?.pin)) return reply;

    // warn, ei debug: kioskista poistuminen on tietoturvan kannalta
    // merkityksellinen teko (avaa pääsyn koko työpöydälle) ja sen pitää
    // näkyä lokista oletusasetuksillakin. Ei koskaan itse PIN-koodia.
    logger.warn({ event: "kiosk_exit" }, "kioskiselain suljetaan hyväksytyn FULL_PIN-todennuksen jälkeen");

    const result = await exitKiosk();
    if (!result.ok) {
      logger.warn({ event: "kiosk_exit_failed", error: result.error }, "kioskiselaimen sulkeminen epäonnistui");
      return reply.code(500).send({ error: result.error ?? "Kioskiselaimen sulkeminen epäonnistui." });
    }
    return { ok: true };
  });

  app.get("/api/dashboard", async (request) => {
    const snapshots = registry.snapshots();
    const local = isTrustedRequest(request);

    // A phone on the home network gets the shopping list and the weather, but
    // the school data stays on the wall display — unless it's on the
    // TRUSTED_HOSTS list or presents a valid FULL_PIN, in which case
    // isTrustedRequest already says so.
    if (!local) {
      for (const id of SENSITIVE_PROVIDERS) {
        const snapshot = snapshots[id];
        // Deliberately not "idle": that renders as "Haetaan…" and would spin
        // forever on the phone, since nothing is ever coming.
        if (snapshot) {
          snapshots[id] = { ...snapshot, data: null, error: null, fetchedAt: null, status: "hidden" };
        }
      }
    } else {
      const wilma = snapshots.wilma as ProviderSnapshot<WilmaData> | undefined;
      if (wilma?.data) {
        snapshots.wilma = {
          ...wilma,
          data: { ...wilma.data, messages: withLocalReadState("wilma", wilma.data.messages) },
        };
      }
      const paikky = snapshots.paikky as ProviderSnapshot<PaikkyData> | undefined;
      if (paikky?.data) {
        snapshots.paikky = {
          ...paikky,
          data: { ...paikky.data, messages: withLocalReadState("paikky", paikky.data.messages) },
        };
      }
    }

    // Kalenteriprovider laajentaa yli vuoden verran tapahtumia, jotta
    // kuukausinäkymällä on selattavaa myös heti käynnistyksen jälkeen (ks.
    // providers/calendar.ts). Kortti sen sijaan näyttää kahden viikon ikkunan
    // ja piirtää kaiken minkä saa, ja tämä vastaus lähtee selaimelle 60
    // sekunnin välein — koko ikkunan lähettäminen sekä rikkoisi kortin että
    // kymmenkertaistaisi seinänäytön normaalin liikenteen. Rajaus tehdään
    // tässä eikä providerissa, jotta kuukausinäkymä näkee yhä koko datan.
    const calendar = snapshots.calendar as ProviderSnapshot<CalendarData> | undefined;
    if (calendar?.data) {
      snapshots.calendar = { ...calendar, data: trimToDashboardWindow(calendar.data) };
    }

    return {
      generatedAt: new Date().toISOString(),
      timezone: config.timezone,
      // Ratkaistu sijainti, ei config.weather.place: postinumero voi tulla
      // asetuksista, jolloin .env:n paikannimi on väärä. Sama lähde kuin
      // sääproviderilla, jotta otsikko ja haettu sää eivät voi olla eri
      // paikkakunnilta.
      place: currentWeatherLocation().place,
      settings: getSettings(),
      notes: listNotes(),
      providers: snapshots,
      localClient: local,
    };
  });

  // Kalenterin kuukausinäkymä: yksi kuukausi kerrallaan päiväkohtaisesti
  // ryhmiteltynä. Ei omaa pääsyporttia — kalenteri ei ole SENSITIVE_PROVIDERS-
  // joukossa, joten se näkyy dashboardilla puhelimellekin, ja sama data
  // toisessa muodossa ei voi olla arkaluontoisempaa kuin alkuperäinen.
  //
  // Reitti ei koskaan laajenna mitään itse eikä hae verkosta: se lukee
  // providerin viimeisimmän hyötykuorman ja ryhmittelee sen. Jos providerilla
  // ei ole vielä dataa tai sen ikkuna ei ulotu pyydettyyn kuukauteen, vastaus
  // on `covered: false` — "emme tiedä", ei "ei tapahtumia".
  app.get("/api/calendar/month", async (request, reply) => {
    const month = (request.query as { month?: unknown } | undefined)?.month;
    if (!isMonthKey(month)) {
      return reply.code(400).send({ error: "month: odotettu muoto YYYY-MM" });
    }
    const snapshot = registry.get("calendar")?.snapshot() as ProviderSnapshot<CalendarData> | undefined;
    return buildCalendarMonth(month, snapshot?.data ?? null);
  });

  // Postinumero → paikannimi ja koordinaatit. Asetuspaneeli kutsuu tätä sitä
  // mukaa kun numeroa kirjoitetaan, jotta käyttäjä NÄKEE minkä paikan numero
  // tarkoittaa ennen tallennusta — kirjoitusvirhettä ei muuten huomaisi
  // mistään ennen kuin sääkortti näyttää väärää paikkakuntaa.
  //
  // Ei omaa pääsyporttia, sama kuin /api/settings ja /api/calendar/month: haku
  // kohdistuu niputettuun julkiseen avoimen datan aineistoon eikä paljasta
  // mitään tästä kodista. Aineisto on paikallinen, joten reitti ei myöskään voi
  // toimia välityspalvelimena ulospäin.
  //
  // Muoto tarkistetaan ENNEN hakua: `:code` tulee pyynnöstä, ja viisi numeroa
  // on ainoa muoto jolla aineistosta on mitään mieltä hakea.
  app.get("/api/postal-code/:code", async (request, reply) => {
    const code = (request.params as { code: string }).code;
    if (!isPostalCode(code)) {
      return reply.code(400).send({ error: "Postinumero: viisi numeroa" });
    }
    const found = lookupPostalCode(code);
    if (!found) {
      return reply.code(404).send({ error: "Postinumeroa ei löydy" });
    }
    return found;
  });

  app.get("/api/settings", async () => getSettings());

  app.put("/api/settings", async (request, reply) => {
    if (!requireEditAccess(request, reply)) return reply;
    try {
      return updateSettings(request.body);
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Hälytysten omat äänitiedostot (ks. core/alarm-sounds.ts): perhe pudottaa
  // ne käsin config.soundsDir-kansioon, tämä vain listaa ja tarjoilee.
  // Julkinen siinä missä /api/settingskin — soundId ei ole arkaluontoista
  // dataa, ja esikuuntelu paneelissa tarvitsee tämän ilman PIN-koodia.
  // forceRefresh=true: paneeli hakee tämän vain kun se avataan, ei
  // hälytyskellon 20 s:n syklissä, joten tuore levyluku on tässä halpa.
  app.get("/api/alarm-sounds", async () => listCustomSounds(true));

  app.get("/api/alarm-sounds/:id/file", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const sound = resolveCustomSound(id);
    if (!sound) return reply.code(404).send({ error: "Äänitiedostoa ei löydy" });

    // Tiedosto on voinut hävitä listauksen ja tämän pyynnön välillä (perhe
    // poisti/nimesi sen uudelleen juuri nyt) — stat varmistaa sen tuoreesti
    // ennen kuin mitään lähetetään, sen sijaan että striimaus kaatuisi kesken.
    try {
      const stat = await fs.promises.stat(sound.path);
      if (!stat.isFile()) return reply.code(404).send({ error: "Äänitiedostoa ei löydy" });
    } catch {
      return reply.code(404).send({ error: "Äänitiedostoa ei löydy" });
    }

    const stream = fs.createReadStream(sound.path);
    stream.on("error", (err) => {
      request.log.warn({ event: "alarm_sound_stream_error", err }, "hälytysäänen striimaus epäonnistui");
    });
    reply.header("cache-control", "no-store"); // perhe voi korvata tiedoston samalla nimellä — ei vanhentunutta välimuistia
    reply.type(sound.mimeType);
    return reply.send(stream);
  });

  app.get("/api/notes", async () => listNotes());

  app.post("/api/notes", async (request, reply) => {
    if (!requireEditAccess(request, reply)) return reply;
    const body = request.body as { text?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "Teksti puuttuu" });
    if (text.length > 200) return reply.code(400).send({ error: "Teksti on liian pitkä (max 200)" });
    return addNote(text);
  });

  app.patch("/api/notes/:id", async (request, reply) => {
    if (!requireEditAccess(request, reply)) return reply;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Virheellinen tunniste" });
    const body = request.body as { done?: unknown } | undefined;
    if (typeof body?.done !== "boolean") return reply.code(400).send({ error: "done: true tai false" });
    setNoteDone(id, body.done);
    return { ok: true };
  });

  app.delete("/api/notes/:id", async (request, reply) => {
    if (!requireEditAccess(request, reply)) return reply;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Virheellinen tunniste" });
    deleteNote(id);
    return { ok: true };
  });

  // Kumpikaan lähde ei kerro luotettavasti onko viesti luettu (Wilma ei
  // lainkaan, ks. providers/wilma.ts; Päikyn oma väite voi olla "ei tiedossa",
  // ks. providers/paikky.ts:parseUnread), joten "luettu" tarkoittaa tässä
  // "avattu tällä näytöllä" — kirjataan sillä hetkellä kun dialogi avaa sen.
  // Trusted-only, ei requireEditAccess: EDIT_PIN antaa puhelimen koskea
  // muistilistaan, mutta access.ts:n oman säännön mukaan lasten koulu- ja
  // hoitotiedot jäävät näyttölaitteelle, TRUSTED_HOSTS-laitteille ja FULL_PIN:n
  // haltijoille (isTrustedRequest kattaa kaikki kolme). Puhelin ilman täyttä
  // luottamusta ei edes näe näiden lähteiden viestejä (SENSITIVE_PROVIDERS
  // yllä), joten sillä ei ole mitään syytä kutsua näitä reittejä.
  app.post("/api/messages/:source/:id/read", async (request, reply) => {
    if (!isTrustedRequest(request)) return reply.code(403).send({ error: "Vain näyttölaitteelta" });
    const { source, id } = request.params as { source: string; id: string };
    if (!READ_STATE_SOURCES.has(source)) return reply.code(404).send({ error: "Tuntematon lähde" });
    if (!isValidMessageId(id)) return reply.code(400).send({ error: "Virheellinen tunniste" });
    const readAt = markMessageRead(source, id);
    return { ok: true, readAt };
  });

  // "Merkitse kaikki luetuiksi". Tunnisteet tulevat asiakkaalta eikä palvelin
  // päättele niitä itse: luettu-tila on paikallista kirjanpitoa, ja vain selain
  // tietää mitkä viestit se juuri näyttää lukemattomina (esim. Päikyn
  // suodatetut lapset). Palvelin ei siis merkitse mitään mitä käyttäjä ei
  // nähnyt.
  app.post("/api/messages/:source/read-all", async (request, reply) => {
    if (!isTrustedRequest(request)) return reply.code(403).send({ error: "Vain näyttölaitteelta" });
    const { source } = request.params as { source: string };
    if (!READ_STATE_SOURCES.has(source)) return reply.code(404).send({ error: "Tuntematon lähde" });

    const body = request.body as { ids?: unknown } | undefined;
    const ids = body?.ids;
    if (!Array.isArray(ids)) return reply.code(400).send({ error: "ids: lista viestitunnisteita" });
    if (ids.length > MAX_READ_ALL_IDS) {
      return reply.code(400).send({ error: `ids: enintään ${MAX_READ_ALL_IDS} tunnistetta kerralla` });
    }
    if (!ids.every(isValidMessageId)) {
      return reply.code(400).send({ error: "ids: jokaisen tunnisteen on oltava merkkijono" });
    }

    return { ok: true, marked: markMessagesRead(source, ids) };
  });

  // "Testaa yhteys" -painike asetuksissa: yritys herättää Wilma-provider heti
  // sen sijaan että odotettaisiin katkaisijan omaa jäähdytystä (voi venyä
  // neljään tuntiin, ks. core/provider.ts). requireEditAccess riittää — tämä
  // ei paljasta mitään Wilma-dataa, vain onnistuiko haku vai ei, joten
  // FULL_PINiä ei tarvita. Rajoitin (5 min per yritys + vuorokausikatto) on
  // provider.manualTestissä, ei tässä — se koskee providerin tilaa
  // kokonaisuutena riippumatta siitä kuka painaa, ei yhtä IP-osoitetta
  // kerrallaan kuten access.ts:n PIN-rajoitin.
  app.post("/api/providers/:id/test", async (request, reply) => {
    if (!requireEditAccess(request, reply)) return reply;

    const id = (request.params as { id: string }).id;
    if (!MANUALLY_TESTABLE_PROVIDERS.has(id)) {
      return reply.code(404).send({ error: "Tuntematon tai ei-testattava lähde" });
    }
    const provider = registry.get(id);
    if (!provider) {
      return reply.code(404).send({ error: "Tuntematon tai ei-testattava lähde" });
    }

    const result = await provider.manualTest();
    switch (result.outcome) {
      case "ok":
        return { ok: true };
      case "failed":
        return reply.code(502).send({ ok: false, error: result.error });
      case "busy":
        return reply.code(409).send({ error: "Yhteystesti on jo käynnissä" });
      case "rate_limited":
        return reply
          .code(429)
          .header("retry-after", String(result.retryAfterSeconds))
          .send({ error: "Odota hetki ennen seuraavaa yhteystestiä.", retryAfterSeconds: result.retryAfterSeconds });
      case "daily_limit":
        return reply
          .code(429)
          .header("retry-after", String(result.retryAfterSeconds))
          .send({
            error: "Tämän päivän yhteystestien enimmäismäärä on täynnä.",
            retryAfterSeconds: result.retryAfterSeconds,
          });
    }
  });
}
