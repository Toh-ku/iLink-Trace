import { describe, expect, it } from "vitest";
import type { HttpExchange, ProtocolEvent } from "@ilink-trace/contracts";
import {
  buildTrajectoryTimeline,
  categoryForEvent,
  describeObservedOutcome,
} from "./trajectory";

function event(
  kind: ProtocolEvent["kind"],
  occurredAt: number,
  exchangeId = `exchange-${kind}`,
): ProtocolEvent {
  return {
    id: `event-${kind}`,
    exchangeId,
    accountId: "account-1",
    kind,
    traceKey: "trace-1",
    summary: kind,
    data: {},
    confidence: "exact",
    parserId: "test",
    parserVersion: 1,
    occurredAt,
  };
}

function exchange(
  id: string,
  startedAt: number,
  completedAt: number,
  responseStatus = 200,
): HttpExchange {
  return {
    id,
    accountId: "account-1",
    method: "POST",
    path: "/ilink/sendmessage",
    query: "",
    upstreamOrigin: "https://example.invalid",
    requestHeaders: {},
    requestBody: null,
    responseStatus,
    responseHeaders: {},
    responseBody: null,
    startedAt,
    headersAt: null,
    completedAt,
    durationMs: completedAt - startedAt,
    requestBytes: 0,
    responseBytes: 0,
    requestTruncated: false,
    responseTruncated: false,
    source: "live",
    errorStage: null,
    errorMessage: null,
  };
}

describe("trajectory presentation", () => {
  it("separates user, result, tool, system, and error records", () => {
    expect(categoryForEvent("inbound_message")).toBe("user");
    expect(categoryForEvent("outbound_message")).toBe("result");
    expect(categoryForEvent("typing")).toBe("tool");
    expect(categoryForEvent("poll")).toBe("system");
    expect(categoryForEvent("protocol_error")).toBe("error");
  });

  it("projects real exchange timings into stable lanes", () => {
    const events = [
      event("outbound_message", 1_500, "outbound"),
      event("inbound_message", 1_100, "inbound"),
      event("typing", 1_300, "typing"),
    ];
    const exchanges = [
      exchange("inbound", 1_000, 1_100),
      exchange("typing", 1_200, 1_300),
      exchange("outbound", 1_400, 1_500),
    ];

    const timeline = buildTrajectoryTimeline(events, exchanges, "time");

    expect(timeline.spans.map((span) => span.event.id)).toEqual([
      "event-inbound_message",
      "event-typing",
      "event-outbound_message",
    ]);
    expect(timeline.spans.map((span) => span.lane)).toEqual([0, 1, 2]);
    expect(timeline.spans[0]?.leftPercent).toBe(0);
    expect(timeline.spans[2]?.rightPercent).toBe(100);
  });

  it("keeps transport, business acceptance, and delivery distinct", () => {
    const outbound = {
      ...event("outbound_message", 1_100, "outbound"),
      data: { ret: 0 },
    };
    const observedExchange = exchange("outbound", 1_000, 1_100);

    expect(describeObservedOutcome(outbound, observedExchange)).toEqual({
      tone: "success",
      transport: "HTTP 200",
      business: "业务已接受",
      delivery: "最终送达未知",
    });
  });
});
