export const CONTRACT_VERSION = 1;

export type HeaderValue = string | string[];
export type HeaderMap = Record<string, HeaderValue>;
export type ExchangeSource = "live" | "replay";

export interface HttpExchange {
  id: string;
  accountId: string | null;
  method: string;
  path: string;
  query: string;
  upstreamOrigin: string | null;
  requestHeaders: HeaderMap;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: HeaderMap;
  responseBody: string | null;
  startedAt: number;
  headersAt: number | null;
  completedAt: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
  source: ExchangeSource;
  errorStage: string | null;
  errorMessage: string | null;
}

export type ProtocolEventKind =
  | "qr_status"
  | "poll"
  | "inbound_message"
  | "config"
  | "typing"
  | "outbound_message"
  | "upload_url"
  | "lifecycle"
  | "protocol_error";

export type CorrelationConfidence =
  "exact" | "probable" | "ambiguous" | "unlinked";

export interface ProtocolEvent {
  id: string;
  exchangeId: string;
  accountId: string | null;
  kind: ProtocolEventKind;
  traceKey: string | null;
  summary: string;
  data: Record<string, unknown>;
  confidence: CorrelationConfidence;
  parserId: string;
  parserVersion: number;
  occurredAt: number;
  traceId?: string | null;
  correlationReason?: CorrelationReason;
  candidateTraceIds?: string[];
}

export interface ExchangeDetail extends HttpExchange {
  events: ProtocolEvent[];
}

export interface Overview {
  exchanges: number;
  events: number;
  inboundMessages: number;
  outboundMessages: number;
  failures: number;
  activeReplays: number;
}

export type ReplayMode = "fidelity" | "execution";
export type ReplayStatus =
  | "queued"
  | "sandbox"
  | "draining"
  | "completed"
  | "cancelled"
  | "failed"
  | "timed_out";

export interface ReplayRun {
  id: string;
  accountId: string;
  sourceEventId: string;
  mode: ReplayMode;
  status: ReplayStatus;
  currentCursor: string | null;
  inboundMessage: Record<string, unknown>;
  capturedReply: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface CreateReplayInput {
  sourceEventId: string;
  mode: ReplayMode;
}

export interface TraceEventNotification {
  id: number;
  type:
    | "exchange.created"
    | "protocol-event.created"
    | "trace.created"
    | "trace.updated"
    | "replay.updated"
    | "recorder.degraded";
  entityId: string;
  occurredAt: number;
}

export interface TraceCandidate {
  id: string;
  accountId: string | null;
  source: ExchangeSource;
  startedAt: number;
  contextFingerprint: string | null;
  runId: string | null;
  clientId: string | null;
  userId: string | null;
}

export type CorrelationReason =
  | "inbound"
  | "context"
  | "run_id"
  | "client_id"
  | "user_window"
  | "ambiguous"
  | "unlinked";
export interface TraceLink {
  traceId: string | null;
  confidence: CorrelationConfidence;
  reason: CorrelationReason;
  candidateTraceIds: string[];
}
export interface ObservedStatus {
  transport: "success" | "failed" | "cancelled" | "unknown";
  http: "success" | "failed" | "unknown";
  httpStatus: number | null;
  json: "valid" | "invalid" | "truncated" | "unavailable";
  business: "accepted" | "rejected" | "unknown";
  ret: number | null;
  errcode: number | null;
  delivery: "unknown";
}
export interface ProcessingGap {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  label: "unobserved processing gap";
}
export interface MessageTrace extends TraceCandidate {
  inboundEventId: string;
  inboundSummary: string;
  inboundText: string | null;
  messageId: string | null;
  messageType: number | null;
  updatedAt: number;
  durationMs: number;
  replyCount: number;
  replyStatus:
    | "none"
    | "accepted"
    | "rejected"
    | "network_error"
    | "cancelled"
    | "unknown";
  confidence: CorrelationConfidence;
  spanCount: number;
  processingGaps: ProcessingGap[];
}
export interface TraceSpan {
  event: ProtocolEvent;
  exchange: HttpExchange;
  confidence: CorrelationConfidence;
  reason: CorrelationReason;
  outcome: ObservedStatus;
}
export interface TraceDetail {
  trace: MessageTrace;
  spans: TraceSpan[];
  nextSpanOffset: number | null;
}
export interface TraceListQuery {
  limit?: number;
  cursor?: string;
  accountId?: string;
  userId?: string;
  source?: ExchangeSource;
  search?: string;
}
export interface TracePage {
  items: MessageTrace[];
  nextCursor: string | null;
}

// Shared JSON Schema keeps HTTP query validation independent of the server framework.
export const traceListQuerySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: {
      type: "string",
      maxLength: 300,
      pattern: "^[0-9]{1,15}:[A-Za-z0-9-]{1,100}$",
    },
    accountId: { type: "string", minLength: 1, maxLength: 100 },
    userId: { type: "string", minLength: 1, maxLength: 100 },
    source: { type: "string", enum: ["live", "replay"] },
    search: { type: "string", maxLength: 100 },
  },
};
