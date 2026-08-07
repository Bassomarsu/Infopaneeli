import type { FastifyInstance } from "fastify";
import { registry, type ProviderSnapshot } from "../core/provider.ts";
import { getSettings, SettingsValidationError, updateSettings } from "../core/settings.ts";
import { addNote, deleteNote, listNotes, listReadMessageIds, markMessageRead, setNoteDone } from "../core/store.ts";
import { config } from "../core/config.ts";
import type { WilmaData } from "../providers/wilma.ts";
import { fullPinEnabled, isTrustedRequest, requireEditAccess, verifyEditPin } from "./access.ts";

/** Providers whose payload contains the children's school data. */
const SENSITIVE_PROVIDERS = new Set(["wilma"]);

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
}
