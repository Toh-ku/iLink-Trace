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
  type: "exchange.created" | "protocol-event.created" | "replay.updated";
  entityId: string;
  occurredAt: number;
}
