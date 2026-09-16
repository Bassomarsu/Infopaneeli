import type { FastifyInstance } from "fastify";
import { requireEditAccess } from "./access.ts";
import { clearDoneShopping, deleteHousehold, readHousehold, saveHousehold } from "../core/household.ts";

export function registerHouseholdRoutes(app: FastifyInstance): void {
  app.get("/api/household", async () => readHousehold());
  /**
   * Tehtyjen tyhjennys yhdellä pyynnöllä. Staattinen `/done` voittaa Fastifyn
   * reitityksessä saman tason `/:id`-parametrin, eikä se voi peittää oikeaa
   * merkintää: tunnisteet ovat randomUUID-muotoisia.
   */
  app.delete("/api/household/shopping/done", async (request, reply) => {
    if (!requireEditAccess(request, reply)) return reply;
    return reply.send({ removed: clearDoneShopping() });
  });
  for (const kind of ["waste", "shopping", "seasonal", "anniversaries"] as const) {
    for (const method of ["POST", "PATCH"] as const) {
      app.route<{ Params: { id?: string } }>({ method, url: `/api/household/${kind}${method === "PATCH" ? "/:id" : ""}`, handler: async (request, reply) => {
        if (!requireEditAccess(request, reply)) return reply;
        try {
          const item = saveHousehold(kind, request.body, request.params.id);
          if (!item) return reply.code(404).send({ error: "Merkintää ei löydy." });
          return reply.code(method === "POST" ? 201 : 200).send(item);
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : "Tallennus epäonnistui." });
        }
      } });
    }
    app.delete<{ Params: { id: string } }>(`/api/household/${kind}/:id`, async (request, reply) => {
      if (!requireEditAccess(request, reply)) return reply;
      if (!deleteHousehold(kind, request.params.id)) return reply.code(404).send({ error: "Merkintää ei löydy." });
      return reply.code(204).send();
    });
  }
}
