import { describe, expect, it } from "vitest";
import pino from "pino";
import type { HttpExchange } from "@ilink-trace/contracts";
import type { StorageClient } from "@ilink-trace/storage";
import { EventHub } from "./event-hub.js";
import { Recorder } from "./recorder.js";

const exchange: HttpExchange = {
  id: "test-exchange",
  accountId: "test-account",
  method: "POST",
  path: "/ilink/bot/getupdates",
  query: "",
  upstreamOrigin: null,
  requestHeaders: { authorization: "Bearer test-token" },
  requestBody: "{}",
  responseStatus: 200,
  responseHeaders: {},
  responseBody: '{"ret":0,"msgs":[]}',
  startedAt: 1,
  headersAt: 2,
  completedAt: 3,
  durationMs: 2,
  requestBytes: 2,
  responseBytes: 19,
  requestTruncated: false,
  responseTruncated: false,
  source: "live",
  errorStage: null,
  errorMessage: null,
};
function storage(
  recordExchange: StorageClient["recordExchange"],
): StorageClient {
  return {
    recordExchange,
    listTraces: async () => ({ items: [], nextCursor: null }),
    getTrace: async () => null,
    listExchanges: async () => [],
    getExchange: async () => null,
    listEvents: async () => [],
    getEvent: async () => null,
    overview: async () => ({
      exchanges: 0,
      events: 0,
      inboundMessages: 0,
      outboundMessages: 0,
      failures: 0,
      activeReplays: 0,
    }),
    createReplay: async () => undefined,
    updateReplay: async () => undefined,
    listReplays: async () => [],
    close: async () => undefined,
  };
}
describe("Trace recorder notifications", () => {
  it("publishes Trace IDs after committing redacted data", async () => {
    const events = new EventHub();
    const recorder = new Recorder({
      events,
      storage: storage(async (value) => {
        expect(events.since(0)).toHaveLength(0);
        expect(value.requestHeaders.authorization).toBe("<redacted>");
        return [{ id: "test-trace", created: true }];
      }),
      hmacKey: Buffer.alloc(32, 1),
      captureMessageContent: false,
      maxQueueSize: 2,
      logger: pino({ enabled: false }),
    });
    recorder.enqueue(exchange);
    await recorder.flush();
    expect(
      events
        .since(0)
        .some(
          (item) =>
            item.type === "trace.created" && item.entityId === "test-trace",
        ),
    ).toBe(true);
    expect(JSON.stringify(events.since(0))).not.toContain("test-token");
  });
  it("reports a failed write as recording degradation without a false Trace event", async () => {
    const events = new EventHub();
    const recorder = new Recorder({
      events,
      storage: storage(async () => {
        throw new Error("test failure");
      }),
      hmacKey: Buffer.alloc(32, 1),
      captureMessageContent: false,
      maxQueueSize: 2,
      logger: pino({ enabled: false }),
    });
    recorder.enqueue(exchange);
    await recorder.flush();
    expect(recorder.dropped).toBe(1);
    expect(events.since(0).map((item) => item.type)).toEqual([
      "recorder.degraded",
    ]);
  });
});
