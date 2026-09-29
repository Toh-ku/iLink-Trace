import { randomUUID } from "node:crypto";
import type { HttpExchange, ProtocolEvent } from "@ilink-trace/contracts";
import { parseExchange, sanitizeJsonBody } from "@ilink-trace/protocol";
import type { StorageClient } from "@ilink-trace/storage";
import type { Logger } from "pino";
import type { EventHub } from "./event-hub.js";
import { redactHeaders } from "./security.js";

export interface RecorderOptions {
  storage: StorageClient;
  events: EventHub;
  hmacKey: Uint8Array;
  captureMessageContent: boolean;
  maxQueueSize: number;
  logger: Logger;
}

export class Recorder {
  readonly #options: RecorderOptions;
  readonly #queue: HttpExchange[] = [];
  #processing = false;
  #closing = false;
  #waiters: Array<() => void> = [];
  #dropped = 0;

  constructor(options: RecorderOptions) {
    this.#options = options;
  }

  get dropped(): number {
    return this.#dropped;
  }

  enqueue(exchange: HttpExchange): void {
    if (this.#closing || this.#queue.length >= this.#options.maxQueueSize) {
      this.#dropped += 1;
      this.#options.events.publish("recorder.degraded", exchange.id);
      return;
    }
    this.#queue.push(exchange);
    if (!this.#processing) void this.#drain();
  }

  async flush(): Promise<void> {
    this.#closing = true;
    if (!this.#processing && this.#queue.length === 0) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  async #drain(): Promise<void> {
    this.#processing = true;
    while (this.#queue.length > 0) {
      const rawExchange = this.#queue.shift();
      if (!rawExchange) continue;
      try {
        let parsed: ProtocolEvent[];
        try {
          parsed = parseExchange(rawExchange, {
            hmacKey: this.#options.hmacKey,
            captureMessageContent: this.#options.captureMessageContent,
          });
        } catch (error) {
          parsed = [
            {
              id: randomUUID(),
              exchangeId: rawExchange.id,
              accountId: rawExchange.accountId,
              kind: "protocol_error",
              traceKey: null,
              summary: "协议解析失败",
              data: {
                reason: error instanceof Error ? error.name : "unknown",
              },
              confidence: "unlinked",
              parserId: "ilink-core",
              parserVersion: 1,
              occurredAt: rawExchange.completedAt,
            },
          ];
        }

        const exchange: HttpExchange = {
          ...rawExchange,
          requestHeaders: redactHeaders(rawExchange.requestHeaders),
          responseHeaders: redactHeaders(rawExchange.responseHeaders),
          requestBody: sanitizeJsonBody(
            rawExchange.requestBody,
            this.#options.hmacKey,
            this.#options.captureMessageContent,
          ),
          responseBody: sanitizeJsonBody(
            rawExchange.responseBody,
            this.#options.hmacKey,
            this.#options.captureMessageContent,
          ),
        };
        await this.#options.storage.recordExchange(exchange, parsed);
        this.#options.events.publish("exchange.created", exchange.id);
        for (const item of parsed) {
          this.#options.events.publish("protocol-event.created", item.id);
        }
      } catch (error) {
        this.#options.logger.error(
          {
            exchangeId: rawExchange.id,
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "failed to persist exchange",
        );
      }
    }
    this.#processing = false;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}
