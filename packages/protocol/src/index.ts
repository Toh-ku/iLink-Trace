import { createHmac, randomUUID } from "node:crypto";
import type {
  HttpExchange,
  ProtocolEvent,
  ProtocolEventKind,
} from "@ilink-trace/contracts";

export const PARSER_API_VERSION = 1;

export interface RawExchangeForParsing extends Omit<
  HttpExchange,
  "requestBody" | "responseBody"
> {
  requestBody: string | null;
  responseBody: string | null;
}

export interface ParserOptions {
  hmacKey: Uint8Array;
  captureMessageContent: boolean;
}

const PARSER_ID = "ilink-core";
const PARSER_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fingerprint(value: unknown, key: Uint8Array): string | null {
  const text = stringValue(value);
  if (!text) return null;
  return createHmac("sha256", key).update(text).digest("hex").slice(0, 16);
}

function messageText(
  message: Record<string, unknown>,
  include: boolean,
): string | null {
  if (!include) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const parts: string[] = [];
  for (const item of items) {
    const itemRecord = asRecord(item);
    const textItem = asRecord(itemRecord?.text_item);
    const text = stringValue(textItem?.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function event(
  exchange: RawExchangeForParsing,
  kind: ProtocolEventKind,
  summary: string,
  data: Record<string, unknown>,
  traceKey: string | null = null,
): ProtocolEvent {
  return {
    id: randomUUID(),
    exchangeId: exchange.id,
    accountId: exchange.accountId,
    kind,
    traceKey,
    summary,
    data,
    confidence: traceKey ? "exact" : "unlinked",
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    occurredAt: exchange.completedAt,
  };
}

function responseOutcome(
  response: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ret: numberValue(response?.ret),
    errcode: numberValue(response?.errcode),
    errmsg: stringValue(response?.errmsg),
  };
}

export function parseExchange(
  exchange: RawExchangeForParsing,
  options: ParserOptions,
): ProtocolEvent[] {
  const request = asRecord(parseJson(exchange.requestBody));
  const response = asRecord(parseJson(exchange.responseBody));
  const endpoint = exchange.path.toLowerCase();

  if (endpoint.endsWith("/get_qrcode_status")) {
    return [
      event(
        exchange,
        "qr_status",
        `二维码状态：${stringValue(response?.status) ?? "unknown"}`,
        {
          status: stringValue(response?.status),
          accountId: fingerprint(response?.ilink_bot_id, options.hmacKey),
          userId: fingerprint(response?.ilink_user_id, options.hmacKey),
          baseurl: stringValue(response?.baseurl),
          redirectHost: stringValue(response?.redirect_host),
        },
      ),
    ];
  }

  if (endpoint.endsWith("/getupdates")) {
    const messages = Array.isArray(response?.msgs) ? response.msgs : [];
    const events: ProtocolEvent[] = [
      event(exchange, "poll", `长轮询返回 ${String(messages.length)} 条消息`, {
        messageCount: messages.length,
        cursorPresent: Boolean(stringValue(response?.get_updates_buf)),
        longPollingTimeoutMs: numberValue(response?.longpolling_timeout_ms),
        ...responseOutcome(response),
      }),
    ];
    for (const rawMessage of messages) {
      const message = asRecord(rawMessage);
      if (!message) continue;
      const traceKey = fingerprint(message.context_token, options.hmacKey);
      events.push(
        event(
          exchange,
          "inbound_message",
          messageText(message, options.captureMessageContent) ?? "收到一条消息",
          {
            messageId:
              stringValue(message.message_id) ??
              numberValue(message.message_id),
            sequence: stringValue(message.seq) ?? numberValue(message.seq),
            fromUserId: fingerprint(message.from_user_id, options.hmacKey),
            toUserId: fingerprint(message.to_user_id, options.hmacKey),
            contextFingerprint: traceKey,
            runId: stringValue(message.run_id),
            messageType: numberValue(message.message_type),
            text: messageText(message, options.captureMessageContent),
            rawMessage: sanitizeProtocolValue(
              message,
              options.hmacKey,
              options.captureMessageContent,
            ),
          },
          traceKey,
        ),
      );
    }
    return events;
  }

  if (endpoint.endsWith("/getconfig")) {
    const traceKey = fingerprint(request?.context_token, options.hmacKey);
    return [
      event(
        exchange,
        "config",
        response?.typing_ticket ? "获取 typing ticket" : "获取配置",
        {
          userId: fingerprint(request?.ilink_user_id, options.hmacKey),
          contextFingerprint: traceKey,
          typingTicketPresent: Boolean(stringValue(response?.typing_ticket)),
          ...responseOutcome(response),
        },
        traceKey,
      ),
    ];
  }

  if (endpoint.endsWith("/sendtyping")) {
    const status = numberValue(request?.status);
    return [
      event(exchange, "typing", status === 1 ? "开始输入" : "结束输入", {
        userId: fingerprint(request?.ilink_user_id, options.hmacKey),
        status,
        ...responseOutcome(response),
      }),
    ];
  }

  if (endpoint.endsWith("/sendmessage")) {
    const message = asRecord(request?.msg);
    const traceKey = fingerprint(message?.context_token, options.hmacKey);
    return [
      event(
        exchange,
        "outbound_message",
        message
          ? (messageText(message, options.captureMessageContent) ??
              "发送一条消息")
          : "发送消息",
        {
          toUserId: fingerprint(message?.to_user_id, options.hmacKey),
          contextFingerprint: traceKey,
          clientId: stringValue(message?.client_id),
          runId: stringValue(message?.run_id),
          text: message
            ? messageText(message, options.captureMessageContent)
            : null,
          messageType: numberValue(message?.message_type),
          ...responseOutcome(response),
        },
        traceKey,
      ),
    ];
  }

  if (endpoint.endsWith("/getuploadurl")) {
    return [
      event(exchange, "upload_url", "获取媒体上传地址", {
        mediaType: numberValue(request?.media_type),
        rawSize: numberValue(request?.rawsize),
        uploadUrlPresent: Boolean(stringValue(response?.upload_full_url)),
        ...responseOutcome(response),
      }),
    ];
  }

  if (
    endpoint.endsWith("/msg/notifystart") ||
    endpoint.endsWith("/msg/notifystop")
  ) {
    return [
      event(
        exchange,
        "lifecycle",
        endpoint.endsWith("notifystart") ? "Bot 启动通知" : "Bot 停止通知",
        {
          ...responseOutcome(response),
        },
      ),
    ];
  }

  return [];
}

export function sanitizeProtocolValue(
  value: unknown,
  key: Uint8Array,
  captureMessageContent = false,
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      sanitizeProtocolValue(item, key, captureMessageContent),
    );
  const record = asRecord(value);
  if (!record) return value;

  const result: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(record)) {
    const normalized = field.toLowerCase();
    if (normalized === "bot_token" || normalized === "authorization") {
      result[field] = "<redacted>";
    } else if (normalized === "context_token") {
      result[field] =
        `<fingerprint:${fingerprint(fieldValue, key) ?? "missing"}>`;
    } else if (
      normalized === "from_user_id" ||
      normalized === "to_user_id" ||
      normalized === "ilink_user_id" ||
      normalized === "ilink_bot_id"
    ) {
      result[field] =
        `<fingerprint:${fingerprint(fieldValue, key) ?? "missing"}>`;
    } else if (normalized === "qrcode" || normalized === "verify_code") {
      result[field] = "<redacted>";
    } else if (normalized === "text" && !captureMessageContent) {
      result[field] = "<redacted>";
    } else {
      result[field] = sanitizeProtocolValue(
        fieldValue,
        key,
        captureMessageContent,
      );
    }
  }
  return result;
}

export function sanitizeJsonBody(
  text: string | null,
  key: Uint8Array,
  captureMessageContent = false,
): string | null {
  if (!text) return text;
  const value = parseJson(text);
  if (value === null) return "<non-json body omitted>";
  return JSON.stringify(
    sanitizeProtocolValue(value, key, captureMessageContent),
  );
}
