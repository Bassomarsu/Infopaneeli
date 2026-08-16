import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { registry, type ProviderSnapshot } from "../core/provider.ts";
import { getSettings, SettingsValidationError, updateSettings } from "../core/settings.ts";
import { addNote, deleteNote, listNotes, listReadMessageIds, markMessageRead, setNoteDone } from "../core/store.ts";
import { config } from "../core/config.ts";
import { listCustomSounds, resolveCustomSound } from "../core/alarm-sounds.ts";
import { exitKiosk } from "../core/kiosk.ts";
import { logger } from "../core/logging.ts";
import type { WilmaData } from "../providers/wilma.ts";
import { fullPinEnabled, isLocalRequest, isTrustedRequest, requireEditAccess, verifyEditPin, verifyFullPinOnly } from "./access.ts";

/** Providers whose payload contains the children's school data. */
const SENSITIVE_PROVIDERS = new Set(["wilma"]);

/**
 * Providers the "Testaa yhteys" -painike saa herättää manuaalisesti. Erillinen
 * sallittujen lista, ei suora registry.get(pyynnön id) — tunniste otetaan
 * pyynnöstä, joten se validoidaan tätä vasten ennen kuin sillä tehdään
 * mitään. Reitti on tarkoitettu nimenomaan Wilman katkaisijan avaamiseen
 * (ks. core/provider.ts:n manualTest), ei yleiseksi tavaksi käynnistää minkä
 * tahansa providerin hakua pyynnöstä.
 */
export const MANUALLY_TESTABLE_PROVIDERS = new Set(["wilma"]);

/**
 * Stamps each message with whether it has been opened on this display. Kept
 * out of the cached provider payload on purpose: read state must show up the
 * instant it changes, not wait for the next Wilma poll, and it must not be
 * written into `provider_cache` next to data that actually came from Wilma.
 */
function withLocalReadState(data: WilmaData): WilmaData & { messages: Array<WilmaData["messages"][number] & { localRead: boolean }> } {
  const readIds = listReadMessageIds();
  return {
    ...data,
    messages: data.messages.map((message) => ({ ...message, localRead: readIds.has(message.id) })),
  };
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
        snapshots.wilma = { ...wilma, data: withLocalReadState(wilma.data) };
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      timezone: config.timezone,
      place: config.weather.place,
      settings: getSettings(),
      notes: listNotes(),
      providers: snapshots,
      localClient: local,
    };
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

  // Wilma itself never tells us a message was read (see providers/wilma.ts),
  // so "read" here means "opened on this display" — recorded the moment the
  // dialog opens it. Trusted-only, not requireEditAccess: an EDIT_PIN lets a
  // phone touch the shopping list, but per access.ts's own rule the
  // children's school data stays with the wall display, TRUSTED_HOSTS
  // devices, and FULL_PIN holders (isTrustedRequest covers all three). A
  // phone without full trust never even sees Wilma messages
  // (SENSITIVE_PROVIDERS above), so it has no legitimate reason to call this
  // route at all.
  app.post("/api/wilma/messages/:id/read", async (request, reply) => {
    if (!isTrustedRequest(request)) return reply.code(403).send({ error: "Vain näyttölaitteelta" });
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Virheellinen tunniste" });
    const readAt = markMessageRead(id);
    return { ok: true, readAt };
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
