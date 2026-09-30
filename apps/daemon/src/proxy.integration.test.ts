import { createServer, type Server } from "node:http";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ReplayRun,
} from "@ilink-trace/contracts";
import type { StorageClient } from "@ilink-trace/storage";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AccountRegistry } from "./account-registry.js";
import type { DaemonConfig } from "./config.js";
import { EventHub } from "./event-hub.js";
import { createProxyServer } from "./proxy.js";
import { Recorder } from "./recorder.js";
import { ReplayManager } from "./replay.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function memoryStorage(): StorageClient & { exchanges: ExchangeDetail[] } {
  const exchanges: ExchangeDetail[] = [];
  const replays: ReplayRun[] = [];
  return {
    exchanges,
    recordExchange: async (exchange: HttpExchange, events: ProtocolEvent[]) => {
      exchanges.push({ ...exchange, events });
    },
    listExchanges: async () => exchanges,
    getExchange: async (id) => exchanges.find((item) => item.id === id) ?? null,
    listEvents: async () => exchanges.flatMap((item) => item.events),
    getEvent: async (id) =>
      exchanges.flatMap((item) => item.events).find((item) => item.id === id) ??
      null,
    overview: async (): Promise<Overview> => ({
      exchanges: exchanges.length,
      events: exchanges.reduce((total, item) => total + item.events.length, 0),
      inboundMessages: 0,
      outboundMessages: 0,
      failures: 0,
      activeReplays: 0,
    }),
    createReplay: async (replay) => void replays.push(replay),
    updateReplay: async () => undefined,
    listReplays: async () => replays,
    close: async () => undefined,
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("capture proxy", () => {
  it("forwards a JSON exchange and persists only redacted credentials", async () => {
    let upstreamRequest: {
      path: string;
      authorization: string | undefined;
      body: string;
    } | null = null;
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamRequest = {
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ret":0,"msgs":[],"get_updates_buf":"next"}');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const storage = memoryStorage();
    const events = new EventHub();
    const key = Buffer.alloc(32, 7);
    const recorder = new Recorder({
      storage,
      events,
      hmacKey: key,
      captureMessageContent: false,
      maxQueueSize: 10,
      logger: pino({ enabled: false }),
    });
    const registry = new AccountRegistry({
      defaultUpstream: `http://127.0.0.1:${String(upstreamPort)}`,
      allowedHosts: [],
      hmacKey: key,
      allowUnsafeUpstream: true,
    });
    const replay = new ReplayManager({
      storage,
      events,
      hmacKey: key,
      captureMessageContent: false,
    });
    const config: DaemonConfig = {
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      controlHost: "127.0.0.1",
      controlPort: 0,
      publicProxyOrigin: "http://127.0.0.1",
      databasePath: ":memory:",
      keyPath: "unused",
      webRoot: "unused",
      defaultUpstream: `http://127.0.0.1:${String(upstreamPort)}`,
      allowedUpstreamHosts: [],
      captureBodyBytes: 1024,
      captureMessageContent: false,
      recorderQueueSize: 10,
      logLevel: "silent",
    };
    const proxy = createProxyServer({ config, registry, recorder, replay });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    const response = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/ilink/bot/getupdates?debug=1`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: '{"get_updates_buf":"cursor"}',
      },
    );
    expect(await response.json()).toMatchObject({
      ret: 0,
      get_updates_buf: "next",
    });
    await recorder.flush();

    expect(upstreamRequest).toEqual({
      path: "/ilink/bot/getupdates?debug=1",
      authorization: "Bearer test-token",
      body: '{"get_updates_buf":"cursor"}',
    });
    expect(storage.exchanges).toHaveLength(1);
    expect(storage.exchanges[0]?.requestHeaders.authorization).toBe(
      "<redacted>",
    );
    expect(JSON.stringify(storage.exchanges[0])).not.toContain("test-token");
  });
});
