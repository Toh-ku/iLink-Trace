import type {
  Overview,
  ProtocolEvent,
  ReplayRun,
} from "@ilink-trace/contracts";
import type { StorageClient } from "@ilink-trace/storage";
import { describe, expect, it } from "vitest";
import { EventHub } from "./event-hub.js";
import { ReplayManager } from "./replay.js";

function storageWithEvent(source: ProtocolEvent): StorageClient & {
  replays: ReplayRun[];
} {
  const replays: ReplayRun[] = [];
  return {
    replays,
    recordExchange: async () => undefined,
    listExchanges: async () => [],
    getExchange: async () => null,
    listEvents: async () => [source],
    getEvent: async (id) => (id === source.id ? source : null),
    overview: async (): Promise<Overview> => ({
      exchanges: 0,
      events: 1,
      inboundMessages: 1,
      outboundMessages: 0,
      failures: 0,
      activeReplays: replays.filter((item) => item.status === "queued").length,
    }),
    createReplay: async (replay) => {
      replays.push(structuredClone(replay));
    },
    updateReplay: async (replay) => {
      const index = replays.findIndex((item) => item.id === replay.id);
      if (index >= 0) replays[index] = structuredClone(replay);
    },
    listReplays: async () => replays,
    close: async () => undefined,
  };
}

function inboundEvent(): ProtocolEvent {
  return {
    id: "event-1",
    exchangeId: "exchange-1",
    accountId: "account-1",
    kind: "inbound_message",
    traceKey: "trace-1",
    summary: "hello",
    data: {
      rawMessage: {
        message_id: "message-1",
        context_token: "<fingerprint:context>",
        item_list: [{ text_item: { text: "hello" } }],
      },
    },
    confidence: "exact",
    parserId: "test",
    parserVersion: 1,
    occurredAt: 1,
  };
}

describe("replay sandbox", () => {
  it("keeps the current cursor and captures a reply without forwarding", async () => {
    const storage = storageWithEvent(inboundEvent());
    const replay = new ReplayManager({
      storage,
      events: new EventHub(),
      hmacKey: Buffer.alloc(32, 1),
      captureMessageContent: true,
      timeoutMs: 10_000,
    });
    const run = await replay.create({
      sourceEventId: "event-1",
      mode: "execution",
    });

    const poll = await replay.handle(
      "account-1",
      "/ilink/bot/getupdates",
      '{"get_updates_buf":"live-cursor"}',
    );
    expect(poll.body.get_updates_buf).toBe("live-cursor");
    expect(JSON.stringify(poll.body)).not.toContain("<fingerprint:context>");

    await replay.handle(
      "account-1",
      "/ilink/bot/sendmessage",
      '{"msg":{"context_token":"temporary","item_list":[{"text_item":{"text":"reply"}}]}}',
    );
    expect(storage.replays.find((item) => item.id === run.id)?.status).toBe(
      "completed",
    );
    expect(
      JSON.stringify(
        storage.replays.find((item) => item.id === run.id)?.capturedReply,
      ),
    ).not.toContain("temporary");
  });

  it("fails closed for an unknown endpoint", async () => {
    const storage = storageWithEvent(inboundEvent());
    const replay = new ReplayManager({
      storage,
      events: new EventHub(),
      hmacKey: Buffer.alloc(32, 2),
      captureMessageContent: true,
    });
    const run = await replay.create({
      sourceEventId: "event-1",
      mode: "fidelity",
    });
    const response = await replay.handle(
      "account-1",
      "/ilink/bot/unknown-side-effect",
      "{}",
    );

    expect(response.statusCode).toBe(409);
    expect(storage.replays.find((item) => item.id === run.id)?.status).toBe(
      "failed",
    );
  });
});
