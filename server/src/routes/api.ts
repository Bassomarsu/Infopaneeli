import type { FastifyInstance } from "fastify";
import { registry } from "../core/provider.ts";
import { getSettings, SettingsValidationError, updateSettings } from "../core/settings.ts";
import { addNote, deleteNote, listNotes, setNoteDone } from "../core/store.ts";
import { config } from "../core/config.ts";
import { isLocalRequest, requireEditAccess } from "./access.ts";

/** Providers whose payload contains the children's school data. */
const SENSITIVE_PROVIDERS = new Set(["wilma"]);

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.get("/api/dashboard", async (request) => {
    const snapshots = registry.snapshots();
    const local = isLocalRequest(request);

    // A phone on the home network gets the shopping list and the weather, but
    // the school data stays on the wall display.
    if (!local) {
      for (const id of SENSITIVE_PROVIDERS) {
        const snapshot = snapshots[id];
        // Deliberately not "idle": that renders as "Haetaan…" and would spin
        // forever on the phone, since nothing is ever coming.
        if (snapshot) {
          snapshots[id] = { ...snapshot, data: null, error: null, fetchedAt: null, status: "hidden" };
        }
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
}
