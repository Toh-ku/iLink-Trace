import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createStorageClient } from "@ilink-trace/storage";
import pino from "pino";
import { AccountRegistry } from "./account-registry.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { createControlServer } from "./control.js";
import { EventHub } from "./event-hub.js";
import { createProxyServer } from "./proxy.js";
import { Recorder } from "./recorder.js";
import { ReplayManager } from "./replay.js";
import { loadOrCreateHmacKey, randomAccessToken } from "./security.js";

const config = loadConfig(loadDotEnv());
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "bot_token",
      "context_token",
      "accessToken",
    ],
    censor: "<redacted>",
  },
});

await mkdir(dirname(config.databasePath), { recursive: true });
const hmacKey = await loadOrCreateHmacKey(config.keyPath);
const storage = await createStorageClient(config.databasePath);
const events = new EventHub();
const recorder = new Recorder({
  storage,
  events,
  hmacKey,
  captureMessageContent: config.captureMessageContent,
  maxQueueSize: config.recorderQueueSize,
  logger,
});
const registry = new AccountRegistry({
  defaultUpstream: config.defaultUpstream,
  allowedHosts: config.allowedUpstreamHosts,
  hmacKey,
});
const replay = new ReplayManager({
  storage,
  events,
  hmacKey,
  captureMessageContent: config.captureMessageContent,
});
const proxy = createProxyServer({ config, registry, recorder, replay });
const accessToken = randomAccessToken();
const control = await createControlServer({
  config,
  storage,
  events,
  recorder,
  replay,
  accessToken,
});

await new Promise<void>((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(config.proxyPort, config.proxyHost, resolve);
});
await control.listen({ port: config.controlPort, host: config.controlHost });

logger.info(
  {
    proxy: config.publicProxyOrigin,
    control: `http://${config.controlHost}:${String(config.controlPort)}`,
    captureMessageContent: config.captureMessageContent,
  },
  "iLink Trace started",
);
process.stderr.write(
  `iLink Trace console: http://${config.controlHost}:${String(config.controlPort)}/?token=${accessToken}\n`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  await Promise.all([
    new Promise<void>((resolve) => proxy.close(() => resolve())),
    control.close(),
  ]);
  await recorder.flush();
  await storage.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}
