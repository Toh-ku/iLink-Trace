import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpExchange } from "@ilink-trace/contracts";
import { parseExchange, sanitizeJsonBody } from "@ilink-trace/protocol";
import type { StorageClient } from "./index.js";
import type * as StorageModule from "./index.js";

const hmacKey = Buffer.alloc(32, 9);
const clients: StorageClient[] = [];
const directories: string[] = [];
async function open(path: string): Promise<StorageClient> {
  // Exercise the real compiled worker and migrations, rather than a memory repository mock.
  const module = (await import(
    new URL("../dist/index.js", import.meta.url).href
  )) as typeof StorageModule;
  const client = await module.createStorageClient(path);
  clients.push(client);
  return client;
}
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ilink-trace-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
function http(
  path: string,
  request: unknown,
  response: unknown,
  start: number,
  overrides: Partial<HttpExchange> = {},
): HttpExchange {
  return {
    id: randomUUID(),
    accountId: "test-account",
    method: "POST",
    path: `/ilink/bot/${path}`,
    query: "",
    upstreamOrigin: null,
    requestHeaders: {},
    requestBody: JSON.stringify(request),
    responseStatus: 200,
    responseHeaders: {},
    responseBody: JSON.stringify(response),
    startedAt: start,
    headersAt: start + 5,
    completedAt: start + 10,
    durationMs: 10,
    requestBytes: 0,
    responseBytes: 0,
    requestTruncated: false,
    responseTruncated: false,
    source: "live",
    errorStage: null,
    errorMessage: null,
    ...overrides,
  };
}
async function record(storage: StorageClient, exchange: HttpExchange) {
  const events = parseExchange(exchange, {
    hmacKey,
    captureMessageContent: true,
  });
  await storage.recordExchange(
    {
      ...exchange,
      requestBody: sanitizeJsonBody(exchange.requestBody, hmacKey, true),
      responseBody: sanitizeJsonBody(exchange.responseBody, hmacKey, true),
    },
    events,
  );
  return events;
}
const message = (context = "test-context", text = "test inbound") => ({
  message_id: "9007199254740993",
  from_user_id: "test-user",
  context_token: context,
  item_list: [{ text_item: { text } }],
});

describe("persistent message traces", () => {
  it("learns client identities only from exact links", async () => {
    const storage = await open(":memory:");
    const inbound = await record(
      storage,
      http(
        "getupdates",
        {},
        { msgs: [{ ...message(), run_id: "test-run" }] },
        100,
      ),
    );
    await record(
      storage,
      http(
        "getconfig",
        { run_id: "test-run", client_id: "test-known-client" },
        { ret: 0 },
        120,
      ),
    );
    const exact = await record(
      storage,
      http(
        "sendtyping",
        { client_id: "test-known-client", status: 1 },
        { ret: 0 },
        140,
      ),
    );
    expect(await storage.getEvent(exact[0]!.id)).toMatchObject({
      traceId: inbound[1]!.id,
      confidence: "exact",
      correlationReason: "client_id",
    });
    await record(
      storage,
      http(
        "getconfig",
        { ilink_user_id: "test-user", client_id: "test-guessed-client" },
        { ret: 0 },
        160,
      ),
    );
    const unlinked = await record(
      storage,
      http(
        "sendtyping",
        { client_id: "test-guessed-client", status: 1 },
        { ret: 0 },
        180,
      ),
    );
    expect(await storage.getEvent(unlinked[0]!.id)).toMatchObject({
      traceId: null,
      confidence: "unlinked",
    });
  });
  it("stores the entire inbound/config/typing/reply chain with confidence, timing and redaction", async () => {
    const storage = await open(":memory:");
    const inbound = await record(
      storage,
      http("getupdates", {}, { ret: 0, msgs: [message()] }, 100),
    );
    const traceId = inbound[1]!.id;
    await record(
      storage,
      http("getconfig", { ilink_user_id: "test-user" }, { ret: 0 }, 130),
    );
    await record(
      storage,
      http(
        "sendtyping",
        { ilink_user_id: "test-user", status: 1 },
        { ret: 0 },
        150,
      ),
    );
    await record(
      storage,
      http(
        "sendmessage",
        {
          msg: {
            to_user_id: "test-user",
            context_token: "test-context",
            client_id: "test-client",
            item_list: [{ text_item: { text: "test reply" } }],
          },
        },
        { ret: 0 },
        200,
      ),
    );
    await record(
      storage,
      http(
        "sendtyping",
        { ilink_user_id: "test-user", status: 2 },
        { ret: 0 },
        220,
      ),
    );
    const detail = await storage.getTrace(traceId);
    expect(detail?.spans.map((span) => span.event.kind)).toEqual([
      "inbound_message",
      "config",
      "typing",
      "outbound_message",
      "typing",
    ]);
    expect(detail?.trace).toMatchObject({
      durationMs: 120,
      confidence: "probable",
      replyStatus: "accepted",
      replyCount: 1,
    });
    expect(detail?.spans[3]?.outcome).toMatchObject({
      business: "accepted",
      delivery: "unknown",
    });
    expect(JSON.stringify(detail)).not.toContain("test-context");
    expect(JSON.stringify(detail)).not.toContain("test-user");
    expect(
      (await storage.listTraces({ search: "inbound" })).items,
    ).toHaveLength(1);
    expect((await storage.listTraces({ search: "absent" })).items).toHaveLength(
      0,
    );
    expect(await storage.getTrace("missing")).toBeNull();
  });

  it("paginates stable timestamps, separates replay and accounts, and exposes ambiguous candidates", async () => {
    const storage = await open(":memory:");
    const roots: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const events = await record(
        storage,
        http("getupdates", {}, { msgs: [message()] }, 100),
      );
      roots.push(events[1]!.id);
    }
    const outgoing = await record(
      storage,
      http(
        "sendmessage",
        { msg: { context_token: "test-context", to_user_id: "test-user" } },
        { ret: 0 },
        200,
      ),
    );
    const ambiguous = await storage.getEvent(outgoing[0]!.id);
    expect(ambiguous?.confidence).toBe("ambiguous");
    expect(ambiguous?.traceId).toBeNull();
    expect(ambiguous?.candidateTraceIds?.sort()).toEqual(roots.sort());
    const first = await storage.listTraces({ limit: 2 });
    const second = await storage.listTraces({
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(3);
    expect(second.nextCursor).toBeNull();
    const replay = await record(
      storage,
      http("getupdates", {}, { msgs: [message()] }, 300, { source: "replay" }),
    );
    await record(
      storage,
      http(
        "sendmessage",
        { msg: { context_token: "test-context" } },
        { ret: 0, errcode: 7 },
        400,
        { source: "replay" },
      ),
    );
    expect((await storage.getTrace(replay[1]!.id))?.trace.replyStatus).toBe(
      "rejected",
    );
    await record(
      storage,
      http(
        "sendmessage",
        { msg: { context_token: "test-context" } },
        { ret: 0 },
        500,
        { accountId: "other-account" },
      ),
    );
    expect(
      (await storage.listTraces({ accountId: "other-account" })).items,
    ).toHaveLength(0);
    expect(
      (await storage.listTraces({ source: "live" })).items.every(
        (item) => item.replyCount === 0,
      ),
    ).toBe(true);
  });

  it("upgrades legacy history transactionally and does not duplicate traces on restart", async () => {
    const path = join(await directory(), "history.db");
    const storage = await open(path);
    await record(storage, http("getupdates", {}, { msgs: [message()] }, 100));
    await record(
      storage,
      http(
        "sendmessage",
        { msg: { context_token: "test-context" } },
        { ret: 0 },
        200,
      ),
    );
    await storage.close();
    clients.splice(clients.indexOf(storage), 1);
    const database = new Database(path);
    database.exec(
      "DROP TABLE trace_spans; DROP TABLE message_traces; DROP TABLE schema_migrations;",
    );
    const facts = database
      .prepare("SELECT * FROM http_exchanges ORDER BY id")
      .all();
    database.close();
    const upgraded = await open(path);
    expect((await upgraded.listTraces()).items[0]).toMatchObject({
      replyCount: 1,
      spanCount: 2,
    });
    await upgraded.close();
    clients.splice(clients.indexOf(upgraded), 1);
    const reopened = await open(path);
    expect((await reopened.listTraces()).items).toHaveLength(1);
    const readonly = new Database(path, { readonly: true });
    expect(
      readonly.prepare("SELECT * FROM http_exchanges ORDER BY id").all(),
    ).toEqual(facts);
    expect(
      readonly.prepare("SELECT version FROM schema_migrations").all(),
    ).toEqual([{ version: 2 }]);
    readonly.close();
  });

  it("paginates a long trace without silently discarding calls and records cancellation", async () => {
    const storage = await open(":memory:");
    const inbound = await record(
      storage,
      http("getupdates", {}, { msgs: [message()] }, 100),
    );
    for (let index = 0; index < 101; index += 1)
      await record(
        storage,
        http(
          "sendtyping",
          { context_token: "test-context", status: 1 },
          { ret: 0 },
          120 + index * 20,
        ),
      );
    await record(
      storage,
      http(
        "sendmessage",
        { msg: { context_token: "test-context" } },
        null,
        3000,
        {
          errorStage: "client_aborted",
          responseStatus: null,
          responseBody: null,
        },
      ),
    );
    const first = await storage.getTrace(inbound[1]!.id);
    const second = await storage.getTrace(
      inbound[1]!.id,
      first!.nextSpanOffset!,
    );
    expect(first?.spans).toHaveLength(100);
    expect(second?.spans).toHaveLength(3);
    expect(second?.nextSpanOffset).toBeNull();
    expect(first?.trace.replyStatus).toBe("cancelled");
  });
});
