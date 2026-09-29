import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ReplayRun,
} from "@ilink-trace/contracts";
import type { StorageRequest, StorageResponse } from "./worker-contract.js";

interface WorkerOptions {
  databasePath: string;
}

const port = parentPort;
if (!port) throw new Error("storage worker requires a parent port");

const options = workerData as WorkerOptions;
let database: Database.Database | null = null;

function db(): Database.Database {
  if (!database) throw new Error("storage is not initialized");
  return database;
}

const migration = `
  CREATE TABLE IF NOT EXISTS http_exchanges (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query TEXT NOT NULL,
    upstream_origin TEXT,
    request_headers_json TEXT NOT NULL,
    request_body TEXT,
    response_status INTEGER,
    response_headers_json TEXT NOT NULL,
    response_body TEXT,
    started_at INTEGER NOT NULL,
    headers_at INTEGER,
    completed_at INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    request_bytes INTEGER NOT NULL,
    response_bytes INTEGER NOT NULL,
    request_truncated INTEGER NOT NULL,
    response_truncated INTEGER NOT NULL,
    source TEXT NOT NULL,
    error_stage TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_http_exchanges_completed_at
    ON http_exchanges(completed_at DESC);

  CREATE TABLE IF NOT EXISTS protocol_events (
    id TEXT PRIMARY KEY,
    exchange_id TEXT NOT NULL REFERENCES http_exchanges(id) ON DELETE CASCADE,
    account_id TEXT,
    kind TEXT NOT NULL,
    trace_key TEXT,
    summary TEXT NOT NULL,
    data_json TEXT NOT NULL,
    confidence TEXT NOT NULL,
    parser_id TEXT NOT NULL,
    parser_version INTEGER NOT NULL,
    occurred_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_protocol_events_occurred_at
    ON protocol_events(occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_protocol_events_trace_key
    ON protocol_events(trace_key, occurred_at);

  CREATE TABLE IF NOT EXISTS replay_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    current_cursor TEXT,
    inbound_message_json TEXT NOT NULL,
    captured_reply_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_replay_runs_updated_at
    ON replay_runs(updated_at DESC);
`;

function initialize(): void {
  database = new Database(options.databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(migration);
  database
    .prepare(
      `UPDATE replay_runs
       SET status = 'failed', error = 'daemon restarted during replay', updated_at = ?
       WHERE status IN ('queued', 'sandbox', 'draining')`,
    )
    .run(Date.now());
}

function exchangeFromRow(row: Record<string, unknown>): HttpExchange {
  return {
    id: String(row.id),
    accountId: row.account_id === null ? null : String(row.account_id),
    method: String(row.method),
    path: String(row.path),
    query: String(row.query),
    upstreamOrigin:
      row.upstream_origin === null ? null : String(row.upstream_origin),
    requestHeaders: JSON.parse(
      String(row.request_headers_json),
    ) as HttpExchange["requestHeaders"],
    requestBody: row.request_body === null ? null : String(row.request_body),
    responseStatus:
      row.response_status === null ? null : Number(row.response_status),
    responseHeaders: JSON.parse(
      String(row.response_headers_json),
    ) as HttpExchange["responseHeaders"],
    responseBody: row.response_body === null ? null : String(row.response_body),
    startedAt: Number(row.started_at),
    headersAt: row.headers_at === null ? null : Number(row.headers_at),
    completedAt: Number(row.completed_at),
    durationMs: Number(row.duration_ms),
    requestBytes: Number(row.request_bytes),
    responseBytes: Number(row.response_bytes),
    requestTruncated: Boolean(row.request_truncated),
    responseTruncated: Boolean(row.response_truncated),
    source: String(row.source) as HttpExchange["source"],
    errorStage: row.error_stage === null ? null : String(row.error_stage),
    errorMessage: row.error_message === null ? null : String(row.error_message),
  };
}

function eventFromRow(row: Record<string, unknown>): ProtocolEvent {
  return {
    id: String(row.id),
    exchangeId: String(row.exchange_id),
    accountId: row.account_id === null ? null : String(row.account_id),
    kind: String(row.kind) as ProtocolEvent["kind"],
    traceKey: row.trace_key === null ? null : String(row.trace_key),
    summary: String(row.summary),
    data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    confidence: String(row.confidence) as ProtocolEvent["confidence"],
    parserId: String(row.parser_id),
    parserVersion: Number(row.parser_version),
    occurredAt: Number(row.occurred_at),
  };
}

function replayFromRow(row: Record<string, unknown>): ReplayRun {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    sourceEventId: String(row.source_event_id),
    mode: String(row.mode) as ReplayRun["mode"],
    status: String(row.status) as ReplayRun["status"],
    currentCursor:
      row.current_cursor === null ? null : String(row.current_cursor),
    inboundMessage: JSON.parse(String(row.inbound_message_json)) as Record<
      string,
      unknown
    >,
    capturedReply:
      row.captured_reply_json === null
        ? null
        : (JSON.parse(String(row.captured_reply_json)) as Record<
            string,
            unknown
          >),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    error: row.error === null ? null : String(row.error),
  };
}

function recordExchange(exchange: HttpExchange, events: ProtocolEvent[]): void {
  const insertExchange = db().prepare(`
    INSERT INTO http_exchanges VALUES (
      @id, @accountId, @method, @path, @query, @upstreamOrigin,
      @requestHeaders, @requestBody, @responseStatus, @responseHeaders, @responseBody,
      @startedAt, @headersAt, @completedAt, @durationMs, @requestBytes, @responseBytes,
      @requestTruncated, @responseTruncated, @source, @errorStage, @errorMessage
    )
  `);
  const insertEvent = db().prepare(`
    INSERT INTO protocol_events VALUES (
      @id, @exchangeId, @accountId, @kind, @traceKey, @summary, @data,
      @confidence, @parserId, @parserVersion, @occurredAt
    )
  `);
  db().transaction(() => {
    insertExchange.run({
      ...exchange,
      requestHeaders: JSON.stringify(exchange.requestHeaders),
      responseHeaders: JSON.stringify(exchange.responseHeaders),
      requestTruncated: Number(exchange.requestTruncated),
      responseTruncated: Number(exchange.responseTruncated),
    });
    for (const item of events)
      insertEvent.run({ ...item, data: JSON.stringify(item.data) });
  })();
}

function upsertReplay(replay: ReplayRun): void {
  db()
    .prepare(
      `INSERT INTO replay_runs VALUES (
        @id, @accountId, @sourceEventId, @mode, @status, @currentCursor,
        @inboundMessage, @capturedReply, @createdAt, @updatedAt, @error
      ) ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        current_cursor = excluded.current_cursor,
        captured_reply_json = excluded.captured_reply_json,
        updated_at = excluded.updated_at,
        error = excluded.error`,
    )
    .run({
      ...replay,
      inboundMessage: JSON.stringify(replay.inboundMessage),
      capturedReply: replay.capturedReply
        ? JSON.stringify(replay.capturedReply)
        : null,
    });
}

function handle(request: StorageRequest): unknown {
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  switch (request.operation) {
    case "initialize":
      initialize();
      return null;
    case "recordExchange": {
      const value = payload as unknown as {
        exchange: HttpExchange;
        events: ProtocolEvent[];
      };
      recordExchange(value.exchange, value.events);
      return null;
    }
    case "listExchanges":
      return db()
        .prepare(
          "SELECT * FROM http_exchanges ORDER BY completed_at DESC LIMIT ?",
        )
        .all(Number(payload.limit))
        .map((row) => exchangeFromRow(row as Record<string, unknown>));
    case "getExchange": {
      const row = db()
        .prepare("SELECT * FROM http_exchanges WHERE id = ?")
        .get(String(payload.id)) as Record<string, unknown> | undefined;
      if (!row) return null;
      const events = db()
        .prepare(
          "SELECT * FROM protocol_events WHERE exchange_id = ? ORDER BY occurred_at ASC",
        )
        .all(String(payload.id))
        .map((item) => eventFromRow(item as Record<string, unknown>));
      return { ...exchangeFromRow(row), events } satisfies ExchangeDetail;
    }
    case "listEvents":
      return db()
        .prepare(
          "SELECT * FROM protocol_events ORDER BY occurred_at DESC LIMIT ?",
        )
        .all(Number(payload.limit))
        .map((row) => eventFromRow(row as Record<string, unknown>));
    case "getEvent": {
      const row = db()
        .prepare("SELECT * FROM protocol_events WHERE id = ?")
        .get(String(payload.id)) as Record<string, unknown> | undefined;
      return row ? eventFromRow(row) : null;
    }
    case "overview": {
      const counts = db()
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM http_exchanges) AS exchanges,
            (SELECT COUNT(*) FROM protocol_events) AS events,
            (SELECT COUNT(*) FROM protocol_events WHERE kind = 'inbound_message') AS inbound_messages,
            (SELECT COUNT(*) FROM protocol_events WHERE kind = 'outbound_message') AS outbound_messages,
            (SELECT COUNT(*) FROM http_exchanges WHERE error_stage IS NOT NULL OR response_status >= 400) AS failures,
            (SELECT COUNT(*) FROM replay_runs WHERE status IN ('queued', 'sandbox', 'draining')) AS active_replays`,
        )
        .get() as Record<string, number>;
      return {
        exchanges: Number(counts.exchanges ?? 0),
        events: Number(counts.events ?? 0),
        inboundMessages: Number(counts.inbound_messages ?? 0),
        outboundMessages: Number(counts.outbound_messages ?? 0),
        failures: Number(counts.failures ?? 0),
        activeReplays: Number(counts.active_replays ?? 0),
      } satisfies Overview;
    }
    case "createReplay":
    case "updateReplay":
      upsertReplay((payload as unknown as { replay: ReplayRun }).replay);
      return null;
    case "listReplays":
      return db()
        .prepare("SELECT * FROM replay_runs ORDER BY updated_at DESC")
        .all()
        .map((row) => replayFromRow(row as Record<string, unknown>));
    case "close":
      database?.close();
      database = null;
      return null;
  }
}

port.on("message", (request: StorageRequest) => {
  try {
    const result = handle(request);
    port.postMessage({
      id: request.id,
      ok: true,
      result,
    } satisfies StorageResponse);
  } catch (error) {
    port.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies StorageResponse);
  }
});
