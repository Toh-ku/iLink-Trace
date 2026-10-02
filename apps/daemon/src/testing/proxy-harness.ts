import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  type IncomingHttpHeaders,
} from "node:http";
import type {
  ExchangeDetail,
  ProtocolEvent,
  ReplayRun,
} from "@ilink-trace/contracts";
import type { StorageClient } from "@ilink-trace/storage";
import pino from "pino";
import { AccountRegistry } from "../account-registry.js";
import { loadConfig } from "../config.js";
import { EventHub } from "../event-hub.js";
import { createProxyServer } from "../proxy.js";
import { Recorder } from "../recorder.js";
import { ReplayManager } from "../replay.js";

export const testKey = Buffer.alloc(32, 6);

export function memoryStorage() {
  const exchanges: ExchangeDetail[] = [];
  const sourceEvents: ProtocolEvent[] = [];
  const replays: ReplayRun[] = [];
  const storage: StorageClient = {
    recordExchange: (exchange, events) => {
      exchanges.push({ ...exchange, events });
      return Promise.resolve([]);
    },
    listTraces: () => Promise.resolve({ items: [], nextCursor: null }),
    getTrace: () => Promise.resolve(null),
    listExchanges: () => Promise.resolve(exchanges),
    getExchange: (id) =>
      Promise.resolve(exchanges.find((item) => item.id === id) ?? null),
    listEvents: () =>
      Promise.resolve([
        ...sourceEvents,
        ...exchanges.flatMap((item) => item.events),
      ]),
    getEvent: (id) =>
      Promise.resolve(sourceEvents.find((item) => item.id === id) ?? null),
    overview: () =>
      Promise.resolve({
        exchanges: exchanges.length,
        events: 0,
        inboundMessages: 0,
        outboundMessages: 0,
        failures: 0,
        activeReplays: 0,
      }),
    createReplay: (run) => {
      replays.push(structuredClone(run));
      return Promise.resolve();
    },
    updateReplay: (run) => {
      const index = replays.findIndex((item) => item.id === run.id);
      if (index >= 0) replays[index] = structuredClone(run);
      return Promise.resolve();
    },
    listReplays: () => Promise.resolve(replays),
    close: () => Promise.resolve(),
  };
  return { storage, exchanges, sourceEvents, replays };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
) => void | ServerResponse | Promise<void>;

export async function createHarness(
  handler: Handler,
  options: {
    captureBodyBytes?: number;
    timeoutMs?: number;
    upstreamHeadersTimeoutMs?: number;
    storage?: StorageClient;
    maxQueueSize?: number;
  } = {},
) {
  const memory = memoryStorage();
  const storage = options.storage ?? memory.storage;
  const requests: Array<{
    path: string;
    method: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }> = [];
  const upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes: unknown = chunk;
        if (!(bytes instanceof Uint8Array))
          throw new Error("invalid simulator chunk");
        size += bytes.byteLength;
        if (size > 128 * 1024)
          throw new Error("simulator fixture body is too large");
        chunks.push(Buffer.from(bytes));
      }
      const body = Buffer.concat(chunks);
      requests.push({
        path: request.url ?? "/",
        method: request.method ?? "GET",
        headers: request.headers,
        body,
      });
      await handler(request, response, body);
    })().catch(() => response.destroy());
  });
  const upstreamOrigin = await listen(upstream);
  const events = new EventHub();
  const registry = new AccountRegistry({
    defaultUpstream: upstreamOrigin,
    allowedHosts: [],
    hmacKey: testKey,
    allowUnsafeUpstream: true,
  });
  const recorder = new Recorder({
    storage,
    events,
    hmacKey: testKey,
    captureMessageContent: true,
    maxQueueSize: options.maxQueueSize ?? 10,
    logger: pino({ enabled: false }),
  });
  const replay = new ReplayManager({
    storage,
    events,
    hmacKey: testKey,
    captureMessageContent: true,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  const config = {
    ...loadConfig(),
    defaultUpstream: upstreamOrigin,
    captureBodyBytes: options.captureBodyBytes ?? 1024,
  };
  const proxy = createProxyServer({
    config,
    registry,
    recorder,
    replay,
    ...(options.upstreamHeadersTimeoutMs === undefined
      ? {}
      : { upstreamHeadersTimeoutMs: options.upstreamHeadersTimeoutMs }),
  });
  const origin = await listen(proxy);
  config.publicProxyOrigin = origin;
  return {
    ...memory,
    storage,
    requests,
    upstream,
    upstreamOrigin,
    events,
    registry,
    recorder,
    replay,
    proxy,
    origin,
    async dispose() {
      for (const run of await storage.listReplays())
        if (replay.hasActive(run.accountId)) await replay.cancel(run.id);
      await close(proxy);
      await close(upstream);
      await recorder.flush();
    },
  };
}

export function rawRequest(
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: IncomingHttpHeaders;
    body?: string | Buffer;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      { method: options.method ?? "POST", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    if (options.timeoutMs !== undefined)
      request.setTimeout(options.timeoutMs, () =>
        request.destroy(new Error("test request timed out")),
      );
    request.end(options.body ?? "{}");
  });
}

export function inboundEvent(
  accountId: string,
  id = "test-inbound",
): ProtocolEvent {
  return {
    id,
    exchangeId: "test-exchange",
    accountId,
    kind: "inbound_message",
    traceKey: "test-context-fingerprint",
    summary: "test message",
    data: {
      rawMessage: {
        message_id: "test-message",
        item_list: [{ text_item: { text: "test message" } }],
      },
    },
    confidence: "exact",
    parserId: "test",
    parserVersion: 1,
    occurredAt: 1,
  };
}
