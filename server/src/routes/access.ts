import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../core/config.ts";

/**
 * The kiosk browser talks to the server over loopback. Anything arriving from
 * elsewhere is a phone on the home network, which is allowed to touch the
 * shopping list but not the children's school data.
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  const ip = request.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function requireEditAccess(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isLocalRequest(request)) return true;

  if (!config.editPin) {
    void reply.code(403).send({ error: "Muokkaus sallittu vain näyttölaitteelta. Aseta EDIT_PIN salliaksesi puhelimen." });
    return false;
  }

  const provided = request.headers["x-edit-pin"];
  if (typeof provided === "string" && provided === config.editPin) return true;

  void reply.code(401).send({ error: "Väärä tai puuttuva PIN" });
  return false;
}
