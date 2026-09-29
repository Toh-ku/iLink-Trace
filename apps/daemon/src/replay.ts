import { randomUUID } from "node:crypto";
import type { CreateReplayInput, ReplayRun } from "@ilink-trace/contracts";
import { sanitizeProtocolValue } from "@ilink-trace/protocol";
import type { StorageClient } from "@ilink-trace/storage";
import type { EventHub } from "./event-hub.js";

export interface SandboxResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface ReplayManagerOptions {
  storage: StorageClient;
  events: EventHub;
  hmacKey: Uint8Array;
  captureMessageContent: boolean;
  timeoutMs?: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function containsRedactedText(value: unknown): boolean {
  const record = asObject(value);
  if (!record) return false;
  const textItem = asObject(record.text_item);
  if (textItem?.text === "<redacted>") return true;
  return Array.isArray(record.item_list)
    ? record.item_list.some(containsRedactedText)
    : false;
}

function executionMessage(
  source: Record<string, unknown>,
  replayId: string,
): Record<string, unknown> {
  const message = structuredClone(source);
  const suffix = replayId.slice(0, 8);
  message.message_id = `trace-replay-${suffix}`;
  message.seq = `trace-replay-${suffix}`;
  message.create_time_ms = Date.now();
  message.context_token = `trace-replay-context-${suffix}`;
  return message;
}

export class ReplayManager {
  readonly #options: ReplayManagerOptions;
  readonly #activeByAccount = new Map<string, ReplayRun>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(options: ReplayManagerOptions) {
    this.#options = options;
  }

  hasActive(accountId: string | null): boolean {
    return accountId !== null && this.#activeByAccount.has(accountId);
  }

  async create(input: CreateReplayInput): Promise<ReplayRun> {
    const source = await this.#options.storage.getEvent(input.sourceEventId);
    if (!source || source.kind !== "inbound_message") {
      throw new Error("source event must be an inbound message");
    }
    if (!source.accountId) throw new Error("source event has no account");
    if (this.#activeByAccount.has(source.accountId)) {
      throw new Error("this account already has an active replay");
    }
    const rawMessage = asObject(source.data.rawMessage);
    if (!rawMessage) throw new Error("source message payload is unavailable");
    if (containsRedactedText(rawMessage)) {
      throw new Error(
        "message content was not captured; enable ILINK_TRACE_CAPTURE_MESSAGE_CONTENT before recording",
      );
    }

    const now = Date.now();
    const replay: ReplayRun = {
      id: randomUUID(),
      accountId: source.accountId,
      sourceEventId: source.id,
      mode: input.mode,
      status: "queued",
      currentCursor: null,
      inboundMessage: rawMessage,
      capturedReply: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    await this.#options.storage.createReplay(replay);
    this.#activeByAccount.set(replay.accountId, replay);
    this.#scheduleTimeout(replay);
    this.#options.events.publish("replay.updated", replay.id);
    return replay;
  }

  async cancel(id: string): Promise<ReplayRun | null> {
    const replay = [...this.#activeByAccount.values()].find(
      (candidate) => candidate.id === id,
    );
    if (!replay) return null;
    return this.#finish(replay, "cancelled", null);
  }

  async handle(
    accountId: string,
    path: string,
    requestBody: string | null,
  ): Promise<SandboxResponse> {
    const replay = this.#activeByAccount.get(accountId);
    if (!replay) {
      return {
        statusCode: 409,
        body: { ret: -1, errmsg: "replay is not active" },
      };
    }
    const endpoint = path.toLowerCase();
    let request: Record<string, unknown> | null = null;
    try {
      request = asObject(requestBody ? JSON.parse(requestBody) : null);
    } catch {
      return {
        statusCode: 400,
        body: { ret: -1, errmsg: "invalid JSON in replay request" },
      };
    }

    if (endpoint.endsWith("/getupdates")) {
      const cursor =
        typeof request?.get_updates_buf === "string"
          ? request.get_updates_buf
          : null;
      const message =
        replay.mode === "execution"
          ? executionMessage(replay.inboundMessage, replay.id)
          : structuredClone(replay.inboundMessage);
      replay.status = "sandbox";
      replay.currentCursor = cursor;
      replay.updatedAt = Date.now();
      await this.#update(replay);
      return {
        statusCode: 200,
        body: {
          ret: 0,
          msgs: [message],
          get_updates_buf: cursor,
          longpolling_timeout_ms: 0,
        },
      };
    }

    if (endpoint.endsWith("/getconfig")) {
      return {
        statusCode: 200,
        body: {
          ret: 0,
          typing_ticket: `trace-replay-${replay.id.slice(0, 8)}`,
        },
      };
    }

    if (endpoint.endsWith("/sendtyping")) {
      replay.status = "draining";
      replay.updatedAt = Date.now();
      await this.#update(replay);
      return { statusCode: 200, body: { ret: 0 } };
    }

    if (endpoint.endsWith("/sendmessage")) {
      const captured = asObject(request?.msg) ?? request ?? {};
      replay.capturedReply = sanitizeProtocolValue(
        captured,
        this.#options.hmacKey,
        this.#options.captureMessageContent,
      ) as Record<string, unknown>;
      await this.#finish(replay, "completed", null);
      return { statusCode: 200, body: { ret: 0 } };
    }

    if (
      endpoint.endsWith("/msg/notifystart") ||
      endpoint.endsWith("/msg/notifystop")
    ) {
      return { statusCode: 200, body: { ret: 0 } };
    }

    if (endpoint.endsWith("/getuploadurl")) {
      return {
        statusCode: 409,
        body: { ret: -1, errmsg: "media upload is blocked during replay" },
      };
    }

    await this.#finish(replay, "failed", `unknown replay endpoint: ${path}`);
    return {
      statusCode: 409,
      body: { ret: -1, errmsg: "endpoint is blocked during replay" },
    };
  }

  async #update(replay: ReplayRun): Promise<void> {
    await this.#options.storage.updateReplay(replay);
    this.#options.events.publish("replay.updated", replay.id);
  }

  async #finish(
    replay: ReplayRun,
    status: ReplayRun["status"],
    error: string | null,
  ): Promise<ReplayRun> {
    replay.status = status;
    replay.error = error;
    replay.updatedAt = Date.now();
    this.#activeByAccount.delete(replay.accountId);
    const timer = this.#timers.get(replay.id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(replay.id);
    await this.#update(replay);
    return replay;
  }

  #scheduleTimeout(replay: ReplayRun): void {
    const timer = setTimeout(() => {
      void this.#finish(replay, "timed_out", "replay timed out");
    }, this.#options.timeoutMs ?? 60_000);
    timer.unref();
    this.#timers.set(replay.id, timer);
  }
}
