import type {
  HttpExchange,
  ProtocolEvent,
  TraceCandidate,
  TraceLink,
  ObservedStatus,
  MessageTrace,
  TraceSpan,
  ProcessingGap,
} from "@ilink-trace/contracts";

export const CORRELATION_WINDOW_MS = 5 * 60_000;
export function textField(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function correlateEvent(
  event: ProtocolEvent,
  exchange: HttpExchange,
  candidates: readonly TraceCandidate[],
): TraceLink {
  if (event.kind === "inbound_message") {
    return {
      traceId: event.id,
      confidence: "exact",
      reason: "inbound",
      candidateTraceIds: [],
    };
  }
  const eligible = candidates.filter(
    (item) =>
      event.accountId !== null &&
      item.accountId === event.accountId &&
      item.source === exchange.source &&
      item.startedAt <= exchange.startedAt,
  );
  const choose = (
    matches: TraceCandidate[],
    reason: TraceLink["reason"],
  ): TraceLink => {
    if (matches.length === 1)
      return {
        traceId: matches[0]!.id,
        confidence: reason === "user_window" ? "probable" : "exact",
        reason,
        candidateTraceIds: [],
      };
    if (matches.length > 1)
      return {
        traceId: null,
        confidence: "ambiguous",
        reason: "ambiguous",
        candidateTraceIds: matches.map((item) => item.id),
      };
    return {
      traceId: null,
      confidence: "unlinked",
      reason: "unlinked",
      candidateTraceIds: [],
    };
  };
  const identities = [
    [event.traceKey, "contextFingerprint", "context"],
    [textField(event.data, "runId"), "runId", "run_id"],
    [textField(event.data, "clientId"), "clientId", "client_id"],
  ] as const;
  for (const [value, field, reason] of identities) {
    if (!value) continue;
    const matches = eligible.filter((item) => item[field] === value);
    if (matches.length) return choose(matches, reason);
  }
  // An explicit, conflicting identity must never be downgraded to a user guess.
  if (event.traceKey || textField(event.data, "runId"))
    return choose([], "unlinked");
  if (
    !["config", "typing", "outbound_message", "upload_url"].includes(event.kind)
  )
    return choose([], "unlinked");
  const userId =
    textField(event.data, "userId") ?? textField(event.data, "toUserId");
  return choose(
    eligible.filter(
      (item) =>
        userId !== null &&
        item.userId === userId &&
        exchange.startedAt - item.startedAt <= CORRELATION_WINDOW_MS,
    ),
    "user_window",
  );
}

export function observeOutcome(
  event: ProtocolEvent,
  exchange: HttpExchange,
): ObservedStatus {
  let json: ObservedStatus["json"] = "unavailable";
  if (exchange.responseTruncated) json = "truncated";
  else if (exchange.responseBody !== null) {
    try {
      const value: unknown = JSON.parse(exchange.responseBody);
      json =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? "valid"
          : "invalid";
    } catch {
      json = "invalid";
    }
  }
  const number = (key: string): number | null =>
    typeof event.data[key] === "number" && Number.isFinite(event.data[key])
      ? event.data[key]
      : null;
  const ret = number("ret");
  const errcode = number("errcode");
  const transport = exchange.errorStage
    ? exchange.errorStage.includes("abort") ||
      exchange.errorStage.includes("cancel")
      ? "cancelled"
      : "failed"
    : exchange.responseStatus === null
      ? "unknown"
      : "success";
  const http =
    exchange.responseStatus === null
      ? "unknown"
      : exchange.responseStatus >= 200 && exchange.responseStatus < 300
        ? "success"
        : "failed";
  let business: ObservedStatus["business"] = "unknown";
  if (transport === "success" && http === "success" && json === "valid") {
    if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0))
      business = "rejected";
    else if (ret === 0 || errcode === 0) business = "accepted";
  }
  return {
    transport,
    http,
    httpStatus: exchange.responseStatus,
    json,
    business,
    ret,
    errcode,
    delivery: "unknown",
  };
}

export function summarizeTrace(
  candidate: TraceCandidate,
  inbound: ProtocolEvent,
  spans: readonly Omit<TraceSpan, "outcome">[],
): MessageTrace {
  const ordered = [...spans].sort(
    (a, b) => a.exchange.startedAt - b.exchange.startedAt,
  );
  const replies = ordered.filter(
    (span) => span.event.kind === "outbound_message",
  );
  const updatedAt = Math.max(
    inbound.occurredAt,
    ...ordered.map((span) => span.exchange.completedAt),
  );
  const processingGaps: ProcessingGap[] = [];
  // Gaps are measured between observed HTTP activity after message arrival; poll wait is excluded.
  let observedEnd = inbound.occurredAt;
  for (const span of ordered.filter(
    (item) => item.event.kind !== "inbound_message",
  )) {
    if (span.exchange.startedAt > observedEnd)
      processingGaps.push({
        startedAt: observedEnd,
        completedAt: span.exchange.startedAt,
        durationMs: span.exchange.startedAt - observedEnd,
        label: "unobserved processing gap",
      });
    observedEnd = Math.max(observedEnd, span.exchange.completedAt);
  }
  const outcomes = replies.map((item) =>
    observeOutcome(item.event, item.exchange),
  );
  let replyStatus: MessageTrace["replyStatus"] = "none";
  if (outcomes.length) {
    if (outcomes.some((item) => item.transport === "failed"))
      replyStatus = "network_error";
    else if (outcomes.some((item) => item.transport === "cancelled"))
      replyStatus = "cancelled";
    else if (
      outcomes.some(
        (item) => item.business === "rejected" || item.http === "failed",
      )
    )
      replyStatus = "rejected";
    else if (outcomes.every((item) => item.business === "accepted"))
      replyStatus = "accepted";
    else replyStatus = "unknown";
  }
  return {
    ...candidate,
    inboundEventId: inbound.id,
    inboundSummary: inbound.summary,
    inboundText: textField(inbound.data, "text"),
    messageId:
      typeof inbound.data.messageId === "string" ||
      typeof inbound.data.messageId === "number"
        ? String(inbound.data.messageId)
        : null,
    messageType:
      typeof inbound.data.messageType === "number"
        ? inbound.data.messageType
        : null,
    updatedAt,
    durationMs: updatedAt - inbound.occurredAt,
    replyCount: replies.length,
    replyStatus,
    confidence: ordered.some((item) => item.confidence === "probable")
      ? "probable"
      : "exact",
    spanCount: ordered.length,
    processingGaps,
  };
}
