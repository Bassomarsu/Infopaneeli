import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../core/config.ts";
import { logger } from "../core/logging.ts";
import { normalizeAddress, trustedHosts } from "../core/trusted-hosts.ts";

/**
 * The kiosk browser talks to the server over loopback. Anything arriving from
 * elsewhere is a phone on the home network, which is allowed to touch the
 * shopping list but not the children's school data.
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  const ip = request.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * True for the display itself, or for a device on the TRUSTED_HOSTS list in
 * .env (core/trusted-hosts.ts). This is the one place that decision is made —
 * api.ts checks this instead of isLocalRequest wherever "does this client get
 * the full picture" matters, so a trusted phone stays indistinguishable from
 * the wall display everywhere and the list doesn't need to be known outside
 * this file.
 */
export function isTrustedRequest(request: FastifyRequest): boolean {
  if (isLocalRequest(request)) return true;

  const trusted = trustedHosts.isTrusted(request.ip);
  if (trusted) {
    // Individual grants stay at debug — fine-grained enough to confirm the
    // feature works, quiet enough not to add a line per request in the
    // default `warn` log.
    logger.debug({ event: "trusted_host_access", ip: normalizeAddress(request.ip) }, "request from trusted host");
  }
  return trusted;
}

export function requireEditAccess(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isTrustedRequest(request)) return true;

  if (!config.editPin) {
    void reply.code(403).send({ error: "Muokkaus sallittu vain näyttölaitteelta. Aseta EDIT_PIN salliaksesi puhelimen." });
    return false;
  }

  const provided = request.headers["x-edit-pin"];
  if (typeof provided === "string" && provided === config.editPin) return true;

  void reply.code(401).send({ error: "Väärä tai puuttuva PIN" });
  return false;
}
