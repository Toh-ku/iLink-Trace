import type {
  MessageTrace,
  ObservedStatus,
  TraceDetail,
  TracePage,
  TraceSpan,
} from "@ilink-trace/contracts";

export const confidenceLabels = {
  exact: "精确关联",
  probable: "推断关联",
  ambiguous: "关联歧义",
  unlinked: "未关联",
} as const;
export const replyLabels: Record<MessageTrace["replyStatus"], string> = {
  none: "尚未观察到回复",
  accepted: "业务已接受 · 最终送达未知",
  rejected: "回复被拒绝",
  network_error: "回复网络失败",
  cancelled: "回复已取消",
  unknown: "回复状态未知",
};
export function duration(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}
export function outcomeLabel(outcome: ObservedStatus): string {
  const network = {
    success: "网络完成",
    failed: "网络失败",
    cancelled: "请求取消",
    unknown: "网络未知",
  }[outcome.transport];
  const json = {
    valid: "JSON 可解析",
    invalid: "JSON 解析失败",
    truncated: "响应已截断",
    unavailable: "响应未捕获",
  }[outcome.json];
  const business = {
    accepted: "业务已接受",
    rejected: "业务拒绝",
    unknown: "业务状态未知",
  }[outcome.business];
  return `${network} · HTTP ${outcome.httpStatus ?? "未知"} · ${json} · ${business} · 最终送达未知`;
}

export function virtualWindow(
  count: number,
  scrollTop: number,
  height: number,
  rowHeight: number,
  overscan = 4,
) {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(
    count,
    Math.ceil((scrollTop + height) / rowHeight) + overscan,
  );
  return {
    start,
    end,
    top: start * rowHeight,
    bottom: Math.max(0, (count - end) * rowHeight),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function oneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}
function isTrace(value: unknown): value is MessageTrace {
  return (
    record(value) &&
    ["id", "inboundEventId", "inboundSummary"].every(
      (key) => typeof value[key] === "string",
    ) &&
    [
      "accountId",
      "userId",
      "contextFingerprint",
      "runId",
      "clientId",
      "inboundText",
      "messageId",
    ].every((key) => nullableString(value[key])) &&
    ["startedAt", "updatedAt", "durationMs", "replyCount", "spanCount"].every(
      (key) => finite(value[key]),
    ) &&
    (value.messageType === null || finite(value.messageType)) &&
    oneOf(value.source, ["live", "replay"]) &&
    oneOf(value.confidence, Object.keys(confidenceLabels)) &&
    oneOf(value.replyStatus, Object.keys(replyLabels)) &&
    Array.isArray(value.processingGaps) &&
    value.processingGaps.every(
      (gap) =>
        record(gap) &&
        gap.label === "unobserved processing gap" &&
        ["startedAt", "completedAt", "durationMs"].every((key) =>
          finite(gap[key]),
        ),
    )
  );
}
function isSpan(value: unknown): value is TraceSpan {
  if (
    !record(value) ||
    !record(value.event) ||
    !record(value.exchange) ||
    !record(value.outcome)
  )
    return false;
  const { event, exchange, outcome } = value;
  return (
    ["id", "exchangeId", "summary", "parserId"].every(
      (key) => typeof event[key] === "string",
    ) &&
    record(event.data) &&
    nullableString(event.accountId) &&
    nullableString(event.traceKey) &&
    finite(event.occurredAt) &&
    finite(event.parserVersion) &&
    oneOf(event.kind, [
      "qr_status",
      "poll",
      "inbound_message",
      "config",
      "typing",
      "outbound_message",
      "upload_url",
      "lifecycle",
      "protocol_error",
    ]) &&
    oneOf(event.confidence, Object.keys(confidenceLabels)) &&
    oneOf(value.confidence, Object.keys(confidenceLabels)) &&
    oneOf(value.reason, [
      "inbound",
      "context",
      "run_id",
      "client_id",
      "user_window",
      "ambiguous",
      "unlinked",
    ]) &&
    ["id", "method", "path", "query"].every(
      (key) => typeof exchange[key] === "string",
    ) &&
    [
      "startedAt",
      "completedAt",
      "durationMs",
      "requestBytes",
      "responseBytes",
    ].every((key) => finite(exchange[key])) &&
    (exchange.responseStatus === null || finite(exchange.responseStatus)) &&
    (exchange.headersAt === null || finite(exchange.headersAt)) &&
    [
      "accountId",
      "upstreamOrigin",
      "requestBody",
      "responseBody",
      "errorStage",
      "errorMessage",
    ].every((key) => nullableString(exchange[key])) &&
    record(exchange.requestHeaders) &&
    record(exchange.responseHeaders) &&
    typeof exchange.requestTruncated === "boolean" &&
    typeof exchange.responseTruncated === "boolean" &&
    oneOf(exchange.source, ["live", "replay"]) &&
    oneOf(outcome.transport, ["success", "failed", "cancelled", "unknown"]) &&
    oneOf(outcome.http, ["success", "failed", "unknown"]) &&
    oneOf(outcome.json, ["valid", "invalid", "truncated", "unavailable"]) &&
    oneOf(outcome.business, ["accepted", "rejected", "unknown"]) &&
    outcome.delivery === "unknown" &&
    ["httpStatus", "ret", "errcode"].every(
      (key) => outcome[key] === null || finite(outcome[key]),
    )
  );
}
export function decodeTracePage(value: unknown): TracePage {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isTrace) ||
    !nullableString(value.nextCursor)
  )
    throw new Error("Trace 列表契约校验失败");
  return value as unknown as TracePage;
}
export function decodeTraceDetail(value: unknown): TraceDetail {
  if (
    !record(value) ||
    !isTrace(value.trace) ||
    !Array.isArray(value.spans) ||
    !value.spans.every(isSpan) ||
    !(value.nextSpanOffset === null || finite(value.nextSpanOffset))
  )
    throw new Error("Trace 详情契约校验失败");
  return value as unknown as TraceDetail;
}
