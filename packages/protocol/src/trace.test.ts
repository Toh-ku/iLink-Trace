import { describe, expect, it } from "vitest";
import type {
  HttpExchange,
  ProtocolEvent,
  TraceCandidate,
} from "@ilink-trace/contracts";
import { correlateEvent, observeOutcome, summarizeTrace } from "./trace.js";

const exchange: HttpExchange = {
  id: "http",
  accountId: "a",
  method: "POST",
  path: "/sendmessage",
  query: "",
  upstreamOrigin: null,
  requestHeaders: {},
  requestBody: "{}",
  responseHeaders: {},
  responseBody: '{"ret":0}',
  responseStatus: 200,
  startedAt: 200,
  headersAt: 210,
  completedAt: 220,
  durationMs: 20,
  requestBytes: 2,
  responseBytes: 9,
  requestTruncated: false,
  responseTruncated: false,
  source: "live",
  errorStage: null,
  errorMessage: null,
};
const event: ProtocolEvent = {
  id: "e",
  exchangeId: "http",
  accountId: "a",
  kind: "outbound_message",
  traceKey: "ctx",
  summary: "reply",
  data: { toUserId: "user", ret: 0 },
  confidence: "exact",
  parserId: "test",
  parserVersion: 1,
  occurredAt: 220,
};
const candidate: TraceCandidate = {
  id: "t",
  accountId: "a",
  source: "live",
  startedAt: 100,
  contextFingerprint: "ctx",
  runId: "run",
  clientId: "client",
  userId: "user",
};

describe("message trace correlation", () => {
  it("uses context, run and client identities before a user/time inference", () => {
    expect(correlateEvent(event, exchange, [candidate])).toMatchObject({
      traceId: "t",
      confidence: "exact",
      reason: "context",
    });
    expect(
      correlateEvent(
        { ...event, traceKey: null, data: { runId: "run" } },
        exchange,
        [candidate],
      ),
    ).toMatchObject({ reason: "run_id", confidence: "exact" });
    expect(
      correlateEvent(
        { ...event, traceKey: null, data: { clientId: "client" } },
        exchange,
        [candidate],
      ),
    ).toMatchObject({ reason: "client_id" });
    expect(
      correlateEvent({ ...event, traceKey: null }, exchange, [candidate]),
    ).toMatchObject({ confidence: "probable", reason: "user_window" });
  });
  it("isolates accounts and live/replay, and preserves ambiguity", () => {
    expect(
      correlateEvent(event, exchange, [
        { ...candidate, accountId: "b" },
        { ...candidate, source: "replay" },
      ]).traceId,
    ).toBeNull();
    expect(
      correlateEvent(event, exchange, [candidate, { ...candidate, id: "t2" }]),
    ).toMatchObject({
      traceId: null,
      confidence: "ambiguous",
      candidateTraceIds: ["t", "t2"],
    });
  });
  it("does not infer across an expired time window or conflicting context", () => {
    expect(
      correlateEvent(
        { ...event, traceKey: null },
        { ...exchange, startedAt: 400_000 },
        [candidate],
      ).confidence,
    ).toBe("unlinked");
    expect(
      correlateEvent({ ...event, traceKey: "different" }, exchange, [candidate])
        .confidence,
    ).toBe("unlinked");
  });
  it("creates one trace per inbound even when context is reused", () => {
    expect(
      correlateEvent({ ...event, kind: "inbound_message" }, exchange, [
        candidate,
      ]),
    ).toMatchObject({ traceId: "e", reason: "inbound" });
  });
});

describe("observed facts", () => {
  it("checks both business codes and never claims delivery", () => {
    expect(
      observeOutcome({ ...event, data: { ret: 0, errcode: 9 } }, exchange),
    ).toMatchObject({
      http: "success",
      business: "rejected",
      delivery: "unknown",
    });
    expect(observeOutcome(event, exchange)).toMatchObject({
      business: "accepted",
      delivery: "unknown",
    });
  });
  it("keeps missing, invalid and truncated responses unknown", () => {
    for (const value of [null, "not-json", "{}"]) {
      expect(
        observeOutcome(
          { ...event, data: {} },
          { ...exchange, responseBody: value },
        ).business,
      ).toBe("unknown");
    }
    expect(
      observeOutcome(event, { ...exchange, responseTruncated: true }),
    ).toMatchObject({ json: "truncated", business: "unknown" });
    expect(
      observeOutcome(event, { ...exchange, errorStage: "client_aborted" }),
    ).toMatchObject({ transport: "cancelled", business: "unknown" });
  });
  it("derives a processing gap after inbound arrival and before reply starts", () => {
    const inbound = {
      ...event,
      id: "in",
      kind: "inbound_message" as const,
      occurredAt: 100,
    };
    const result = summarizeTrace(candidate, inbound, [
      { event, exchange, confidence: "exact", reason: "context" },
    ]);
    expect(result.durationMs).toBe(120);
    expect(result.processingGaps).toEqual([
      {
        startedAt: 100,
        completedAt: 200,
        durationMs: 100,
        label: "unobserved processing gap",
      },
    ]);
    expect(result.replyStatus).toBe("accepted");
  });
});
