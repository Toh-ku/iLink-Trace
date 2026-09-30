import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ReplayRun,
  TraceCandidate,
  TraceDetail,
  TraceSpan,
  MessageTrace,
  TraceListQuery,
  TracePage,
} from "@ilink-trace/contracts";
import {
  correlateEvent,
  observeOutcome,
  summarizeTrace,
  textField,
  CORRELATION_WINDOW_MS,
} from "@ilink-trace/protocol";
import { messageTraceMigration } from "./migrations/002-message-traces.js";
import type { StorageRequest, StorageResponse } from "./worker-contract.js";

interface WorkerOptions {
  databasePath: string;
}

type DatabaseRow = Record<string, string | number | null>;

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
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  );
  if (
    !database
      .prepare("SELECT version FROM schema_migrations WHERE version = 2")
      .get()
  ) {
    database.transaction(() => {
      db().exec(messageTraceMigration);
      // Historical observations are kept intact; only new derived tables are backfilled.
      let offset = 0;
      while (true) {
        // Finalize the read before writing derived rows; SQLite iterators retain a busy statement.
        const rows = db()
          .prepare(
            "SELECT e.* FROM protocol_events e JOIN http_exchanges h ON h.id = e.exchange_id ORDER BY e.occurred_at, CASE WHEN e.kind = 'inbound_message' THEN 0 ELSE 1 END, e.id LIMIT 200 OFFSET ?",
          )
          .all(offset);
        for (const row of rows) {
          const item = eventFromRow(row as DatabaseRow);
          const http = db()
            .prepare("SELECT * FROM http_exchanges WHERE id = ?")
            .get(item.exchangeId) as DatabaseRow;
          linkEvent(item, exchangeFromRow(http));
        }
        if (rows.length < 200) break;
        offset += rows.length;
      }
      db().prepare("INSERT INTO schema_migrations VALUES (2)").run();
    })();
  }
  database
    .prepare(
      `UPDATE replay_runs
       SET status = 'failed', error = 'daemon restarted during replay', updated_at = ?
       WHERE status IN ('queued', 'sandbox', 'draining')`,
    )
    .run(Date.now());
}

function exchangeFromRow(row: DatabaseRow): HttpExchange {
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

function eventFromRow(row: DatabaseRow): ProtocolEvent {
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
    ...(row.candidates_json === undefined
      ? {}
      : {
          traceId: row.trace_id === null ? null : String(row.trace_id),
          correlationReason: String(row.reason) as NonNullable<
            ProtocolEvent["correlationReason"]
          >,
          candidateTraceIds: JSON.parse(
            String(row.candidates_json),
          ) as string[],
        }),
  };
}

function replayFromRow(row: DatabaseRow): ReplayRun {
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

function candidateFromRow(row: DatabaseRow): TraceCandidate {
  const field = (key: string) => (row[key] === null ? null : String(row[key]));
  return {
    id: String(row.id),
    accountId: field("account_id"),
    source: String(row.source) as TraceCandidate["source"],
    startedAt: Number(row.started_at),
    contextFingerprint: field("context_fingerprint"),
    runId: field("run_id"),
    clientId: field("client_id"),
    userId: field("user_id"),
  };
}

function traceSpans(id: string, limit: number, offset = 0): TraceSpan[] {
  return db()
    .prepare(
      `SELECT e.*, s.confidence AS link_confidence, s.reason AS link_reason
    FROM trace_spans s JOIN protocol_events e ON e.id = s.event_id
    JOIN http_exchanges h ON h.id = e.exchange_id
    WHERE s.trace_id = ? ORDER BY h.started_at, e.occurred_at, e.id LIMIT ? OFFSET ?`,
    )
    .all(id, limit, offset)
    .map((raw) => {
      const row = raw as DatabaseRow;
      const event = eventFromRow(row);
      const http = db()
        .prepare("SELECT * FROM http_exchanges WHERE id = ?")
        .get(event.exchangeId) as DatabaseRow;
      const exchange = exchangeFromRow(http);
      return {
        event,
        exchange,
        confidence: String(row.link_confidence) as TraceSpan["confidence"],
        reason: String(row.link_reason) as TraceSpan["reason"],
        outcome: observeOutcome(event, exchange),
      };
    });
}

function linkEvent(item: ProtocolEvent, exchange: HttpExchange): string | null {
  const candidates = db()
    .prepare(
      `SELECT * FROM message_traces
    WHERE account_id = ? AND source = ? AND started_at <= ? AND (
      context_fingerprint = ? OR run_id = ? OR client_id = ? OR (user_id = ? AND started_at >= ?)
    )`,
    )
    .all(
      item.accountId,
      exchange.source,
      exchange.startedAt,
      item.traceKey,
      textField(item.data, "runId"),
      textField(item.data, "clientId"),
      textField(item.data, "userId") ?? textField(item.data, "toUserId"),
      exchange.startedAt - CORRELATION_WINDOW_MS,
    )
    .map((row) => candidateFromRow(row as DatabaseRow));
  const link = correlateEvent(item, exchange, candidates);
  if (item.kind === "inbound_message") {
    const candidate: TraceCandidate = {
      id: item.id,
      accountId: item.accountId,
      source: exchange.source,
      startedAt: item.occurredAt,
      contextFingerprint: item.traceKey,
      runId: textField(item.data, "runId"),
      clientId: textField(item.data, "clientId"),
      userId: textField(item.data, "fromUserId"),
    };
    db()
      .prepare(
        "INSERT INTO message_traces VALUES (@id, @accountId, @source, @startedAt, @contextFingerprint, @runId, @clientId, @userId, @summary)",
      )
      .run({
        ...candidate,
        summary: JSON.stringify(summarizeTrace(candidate, item, [])),
      });
  }
  db()
    .prepare("INSERT INTO trace_spans VALUES (?, ?, ?, ?, ?)")
    .run(
      item.id,
      link.traceId,
      link.confidence,
      link.reason,
      JSON.stringify(link.candidateTraceIds),
    );
  // Keep parser facts separate from correlation; API events expose the actual association confidence.
  db()
    .prepare("UPDATE protocol_events SET confidence = ? WHERE id = ?")
    .run(link.confidence, item.id);
  if (!link.traceId) return null;
  if (link.confidence === "exact") {
    // A user/time guess must not become an exact identity for later events.
    db()
      .prepare(
        "UPDATE message_traces SET run_id = COALESCE(run_id, ?), client_id = COALESCE(client_id, ?) WHERE id = ?",
      )
      .run(
        textField(item.data, "runId"),
        textField(item.data, "clientId"),
        link.traceId,
      );
  }
  const row = db()
    .prepare("SELECT * FROM message_traces WHERE id = ?")
    .get(link.traceId) as DatabaseRow;
  const inbound = eventFromRow(
    db()
      .prepare("SELECT * FROM protocol_events WHERE id = ?")
      .get(link.traceId) as DatabaseRow,
  );
  const spans = traceSpans(link.traceId, -1);
  db()
    .prepare("UPDATE message_traces SET summary_json = ? WHERE id = ?")
    .run(
      JSON.stringify(summarizeTrace(candidateFromRow(row), inbound, spans)),
      link.traceId,
    );
  return link.traceId;
}

function listTraces(query: TraceListQuery): TracePage {
  const clauses: string[] = [];
  const bindings: Array<string | number> = [];
  for (const [key, column] of [
    ["accountId", "account_id"],
    ["userId", "user_id"],
    ["source", "source"],
  ] as const) {
    if (query[key]) {
      clauses.push(`${column} = ?`);
      bindings.push(query[key]);
    }
  }
  if (query.search) {
    clauses.push(
      "instr(lower(json_extract(summary_json, '$.inboundSummary')), lower(?)) > 0",
    );
    bindings.push(query.search);
  }
  if (query.cursor) {
    const [time, id] = query.cursor.split(":");
    clauses.push("(started_at < ? OR (started_at = ? AND id < ?))");
    bindings.push(Number(time), Number(time), id ?? "");
  }
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const rows = db()
    .prepare(
      `SELECT summary_json FROM message_traces ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(...bindings, limit + 1) as DatabaseRow[];
  const items = rows
    .slice(0, limit)
    .map((row) => JSON.parse(String(row.summary_json)) as MessageTrace);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last ? `${last.startedAt}:${last.id}` : null,
  };
}

function getTrace(id: string, offset: number): TraceDetail | null {
  const row = db()
    .prepare("SELECT summary_json FROM message_traces WHERE id = ?")
    .get(id) as DatabaseRow | undefined;
  if (!row) return null;
  const trace = JSON.parse(String(row.summary_json)) as MessageTrace;
  const spans = traceSpans(id, 100, offset);
  return {
    trace,
    spans,
    nextSpanOffset:
      offset + spans.length < trace.spanCount ? offset + spans.length : null,
  };
}

function recordExchange(
  exchange: HttpExchange,
  events: ProtocolEvent[],
): Array<{ id: string; created: boolean }> {
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
  const changed = new Map<string, boolean>();
  db().transaction(() => {
    insertExchange.run({
      ...exchange,
      requestHeaders: JSON.stringify(exchange.requestHeaders),
      responseHeaders: JSON.stringify(exchange.responseHeaders),
      requestTruncated: Number(exchange.requestTruncated),
      responseTruncated: Number(exchange.responseTruncated),
    });
    for (const item of events) {
      insertEvent.run({ ...item, data: JSON.stringify(item.data) });
      const id = linkEvent(item, exchange);
      if (id)
        changed.set(
          id,
          changed.get(id) === true || item.kind === "inbound_message",
        );
    }
  })();
  return [...changed].map(([id, created]) => ({ id, created }));
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
      return recordExchange(value.exchange, value.events);
    }
    case "listTraces":
      return listTraces(payload);
    case "getTrace":
      return getTrace(
        String(payload.id),
        Math.max(0, Number(payload.spanOffset ?? 0)),
      );
    case "listExchanges":
      return db()
        .prepare(
          "SELECT * FROM http_exchanges ORDER BY completed_at DESC LIMIT ?",
        )
        .all(Number(payload.limit))
        .map((row) => exchangeFromRow(row as DatabaseRow));
    case "getExchange": {
      const row = db()
        .prepare("SELECT * FROM http_exchanges WHERE id = ?")
        .get(String(payload.id)) as DatabaseRow | undefined;
      if (!row) return null;
      const events = db()
        .prepare(
          "SELECT e.*, s.trace_id, s.reason, s.candidates_json FROM protocol_events e LEFT JOIN trace_spans s ON s.event_id = e.id WHERE exchange_id = ? ORDER BY occurred_at ASC, e.id",
        )
        .all(String(payload.id))
        .map((item) => eventFromRow(item as DatabaseRow));
      return { ...exchangeFromRow(row), events } satisfies ExchangeDetail;
    }
    case "listEvents":
      return db()
        .prepare(
          "SELECT e.*, s.trace_id, s.reason, s.candidates_json FROM protocol_events e LEFT JOIN trace_spans s ON s.event_id = e.id ORDER BY occurred_at DESC, e.id DESC LIMIT ?",
        )
        .all(Number(payload.limit))
        .map((row) => eventFromRow(row as DatabaseRow));
    case "getEvent": {
      const row = db()
        .prepare(
          "SELECT e.*, s.trace_id, s.reason, s.candidates_json FROM protocol_events e LEFT JOIN trace_spans s ON s.event_id = e.id WHERE e.id = ?",
        )
        .get(String(payload.id)) as DatabaseRow | undefined;
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
        .map((row) => replayFromRow(row as DatabaseRow));
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
