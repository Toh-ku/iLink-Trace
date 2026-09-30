import { createServer, type Server } from "node:http";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ReplayRun,
} from "@ilink-trace/contracts";
import type { StorageClient } from "@ilink-trace/storage";
import type * as StorageModule from "@ilink-trace/storage";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AccountRegistry } from "./account-registry.js";
import type { DaemonConfig } from "./config.js";
import { EventHub } from "./event-hub.js";
import { createProxyServer } from "./proxy.js";
import { createControlServer } from "./control.js";
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
      return [];
    },
    listTraces: async () => ({ items: [], nextCursor: null }),
    getTrace: async () => null,
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
  it("serves a complete message trace through the real proxy, worker and control API", async () => {
    const upstream = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url?.endsWith("getupdates")
          ? JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: "test-message",
                  from_user_id: "test-user",
                  context_token: "test-context",
                  item_list: [{ text_item: { text: "hello simulator" } }],
                },
              ],
            })
          : '{"ret":0}',
      );
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const module = (await import(
      new URL("../../../packages/storage/dist/index.js", import.meta.url).href
    )) as typeof StorageModule;
    const storage = await module.createStorageClient(":memory:");
    const events = new EventHub();
    const key = Buffer.alloc(32, 8);
    const recorder = new Recorder({
      storage,
      events,
      hmacKey: key,
      captureMessageContent: true,
      maxQueueSize: 10,
      logger: pino({ enabled: false }),
    });
    const registry = new AccountRegistry({
      defaultUpstream: `http://127.0.0.1:${upstreamPort}`,
      allowedHosts: [],
      hmacKey: key,
      allowUnsafeUpstream: true,
    });
    const replay = new ReplayManager({
      storage,
      events,
      hmacKey: key,
      captureMessageContent: true,
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
      defaultUpstream: `http://127.0.0.1:${upstreamPort}`,
      allowedUpstreamHosts: [],
      captureBodyBytes: 1024,
      captureMessageContent: true,
      recorderQueueSize: 10,
      logLevel: "silent",
    };
    const proxy = createProxyServer({ config, registry, recorder, replay });
    servers.push(proxy);
    const proxyPort = await listen(proxy);
    const app = await createControlServer({
      config,
      storage,
      events,
      recorder,
      replay,
      accessToken: "test-control-token",
    });
    try {
      for (const [path, body] of [
        ["getupdates", {}],
        ["getconfig", { ilink_user_id: "test-user" }],
        ["sendtyping", { ilink_user_id: "test-user", status: 1 }],
        [
          "sendmessage",
          {
            msg: {
              context_token: "test-context",
              to_user_id: "test-user",
              item_list: [{ text_item: { text: "hello reply" } }],
            },
          },
        ],
      ] as const) {
        const response = await fetch(
          `http://127.0.0.1:${proxyPort}/ilink/bot/${path}`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer test-bot-token",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        expect(await response.json()).toMatchObject({ ret: 0 });
      }
      await recorder.flush();
      const headers = { authorization: "Bearer test-control-token" };
      expect((await app.inject({ url: "/api/v1/traces" })).statusCode).toBe(
        401,
      );
      expect(
        (await app.inject({ url: "/api/v1/traces?limit=999", headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: "/api/v1/traces?source=invalid", headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: "/api/v1/traces?cursor=invalid", headers }))
          .statusCode,
      ).toBe(400);
      const page = (
        await app.inject({ url: "/api/v1/traces?search=simulator", headers })
      ).json<{ items: Array<{ id: string; replyCount: number }> }>();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.replyCount).toBe(1);
      const result = await app.inject({
        url: `/api/v1/traces/${page.items[0]!.id}`,
        headers,
      });
      expect(result.json<{ spans: unknown[] }>().spans).toHaveLength(4);
      for (const secret of ["test-bot-token", "test-context", "test-user"])
        expect(result.body).not.toContain(secret);
      expect(
        (await app.inject({ url: "/api/v1/traces/missing", headers }))
          .statusCode,
      ).toBe(404);
      const notifications = events.since(0);
      expect(notifications.some((item) => item.type === "trace.created")).toBe(
        true,
      );
      expect(notifications.some((item) => item.type === "trace.updated")).toBe(
        true,
      );
      expect(JSON.stringify(notifications)).not.toContain("hello simulator");
    } finally {
      await app.close();
      await storage.close();
    }
  });
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
