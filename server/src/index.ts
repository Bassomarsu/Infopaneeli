import fs from "node:fs";
import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./core/config.ts";
import { logger } from "./core/logging.ts";
import { registry } from "./core/provider.ts";
import { trustedHosts } from "./core/trusted-hosts.ts";
import { registerApiRoutes } from "./routes/api.ts";
import { createElectricityProvider } from "./providers/electricity.ts";
import { createWeatherProvider } from "./providers/weather.ts";
import { createCalendarProvider } from "./providers/calendar.ts";
import { createWilmaProvider } from "./providers/wilma.ts";

const app = Fastify({
  // Widened to the base type on purpose: passing the concrete pino logger type
  // specialises FastifyInstance and every route module would have to repeat
  // that generic signature.
  loggerInstance: logger as FastifyBaseLogger,
});

// Fastify's per-request logs are emitted at `info`, so the default `warn` level
// already drops them — the kiosk polling every minute costs nothing. Raising
// LOG_LEVEL to debug turns them back on, which is exactly when you want them.

// Each provider staggers its own first run so startup does not fire four
// outbound requests at once.
registry.register(createWilmaProvider());
registry.register(createElectricityProvider());
registry.register(createWeatherProvider());
registry.register(createCalendarProvider());

// Resolves TRUSTED_HOSTS hostnames in the background and on a timer; never
// blocks startup and never throws (see core/trusted-hosts.ts).
trustedHosts.start();

await registerApiRoutes(app);

// The built Vue app is optional during backend development.
if (fs.existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async () => ({
    message: "Frontend ei ole vielä käännetty. Aja `npm run build` tai kehityksessä `npm run dev:web`.",
  }));
}

registry.startAll();

async function shutdown(signal: string): Promise<void> {
  logger.warn({ event: "shutdown", signal }, "shutting down");
  registry.stopAll();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// An unhandled rejection must reach the log — this process is meant to run
// unattended for months on a wall.
process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandled_rejection", err: reason }, "unhandled rejection");
});

try {
  await app.listen({ port: config.port, host: config.host });
  logger.warn(
    { event: "started", port: config.port, logLevel: config.logLevel },
    "infonäyttö server started",
  );
} catch (err) {
  logger.error({ event: "listen_failed", err }, "server failed to start");
  process.exit(1);
}
