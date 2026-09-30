import { describe, expect, it } from "vitest";
import type { HttpExchange } from "@ilink-trace/contracts";
import { parseExchange, sanitizeJsonBody } from "./index.js";

const hmacKey = Buffer.from("01234567890123456789012345678901");

function exchange(overrides: Partial<HttpExchange>): HttpExchange {
  return {
    id: "exchange-1",
    accountId: "account-1",
    method: "POST",
    path: "/ilink/bot/getupdates",
    query: "",
    upstreamOrigin: "https://example.invalid",
    requestHeaders: {},
    requestBody: '{"get_updates_buf":"cursor-a"}',
    responseStatus: 200,
    responseHeaders: {},
    responseBody: JSON.stringify({
      ret: 0,
      msgs: [
        {
          message_id: "1001",
          from_user_id: "user-secret",
          context_token: "context-secret",
          item_list: [{ type: 1, text_item: { text: "hello" } }],
        },
      ],
      get_updates_buf: "cursor-b",
    }),
    startedAt: 1,
    headersAt: 2,
    completedAt: 3,
    durationMs: 2,
    requestBytes: 10,
    responseBytes: 100,
    requestTruncated: false,
    responseTruncated: false,
    source: "live",
    errorStage: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("iLink parser", () => {
  it("preserves numeric message IDs beyond the safe integer range", () => {
    const parsed = parseExchange(
      exchange({
        responseBody:
          '{"msgs":[{"message_id":9007199254740993,"seq":9007199254740995}]}',
      }),
      { hmacKey, captureMessageContent: false },
    );
    expect(parsed[1]?.data.messageId).toBe("9007199254740993");
    expect(parsed[1]?.data.sequence).toBe("9007199254740995");
  });
  it("correlates inbound and outbound events without retaining context tokens", () => {
    const inbound = parseExchange(exchange({}), {
      hmacKey,
      captureMessageContent: true,
    });
    const outbound = parseExchange(
      exchange({
        id: "exchange-2",
        path: "/ilink/bot/sendmessage",
        requestBody: JSON.stringify({
          msg: {
            to_user_id: "user-secret",
            context_token: "context-secret",
            item_list: [{ type: 1, text_item: { text: "world" } }],
          },
        }),
        responseBody: '{"ret":0}',
      }),
      { hmacKey, captureMessageContent: true },
    );

    const inboundMessage = inbound.find(
      (item) => item.kind === "inbound_message",
    );
    expect(inboundMessage?.traceKey).toBeTruthy();
    expect(outbound[0]?.traceKey).toBe(inboundMessage?.traceKey);
    expect(JSON.stringify([...inbound, ...outbound])).not.toContain(
      "context-secret",
    );
    expect(JSON.stringify(inbound)).not.toContain("user-secret");
    expect(
      sanitizeJsonBody(
        '{"context_token":"context-secret","from_user_id":"user-secret"}',
        hmacKey,
      ),
    ).not.toContain("context-secret");
  });

  it("omits message content when content capture is disabled", () => {
    const events = parseExchange(exchange({}), {
      hmacKey,
      captureMessageContent: false,
    });

    expect(JSON.stringify(events)).not.toContain("hello");
    expect(events[1]?.summary).toBe("收到一条消息");
  });
});
