import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHarness,
  inboundEvent,
  memoryStorage,
  rawRequest,
  testKey,
} from "./testing/proxy-harness.js";
import { fingerprint } from "./security.js";

const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
async function setup(options: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness(
    (_request, response) =>
      response.end('{"ret":0,"get_updates_buf":"real-next"}'),
    options,
  );
  harnesses.push(h);
  h.sourceEvents.push(inboundEvent(fingerprint("test-replay-token", testKey)));
  return h;
}
const headers = { authorization: "Bearer test-replay-token" };
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

describe("replay network isolation", () => {
  it("does not overwrite completion while its commit is pending or the timeout fires", async () => {
    const h = await setup({ timeoutMs: 500 });
    const run = await h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    const update = h.storage.updateReplay.bind(h.storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.storage.updateReplay = async (value) => {
      await gate;
      await update(value);
    };
    const sent = rawRequest(h.origin, "/ilink/bot/sendmessage", { headers });
    try {
      await expect.poll(() => run.status).toBe("completed");
      expect(
        (
          await rawRequest(h.origin, "/ilink/bot/sendtyping", {
            headers,
            timeoutMs: 1000,
          })
        ).status,
      ).toBe(409);
      await new Promise<void>((resolve) => setTimeout(resolve, 650));
      expect(run.status).toBe("completed");
      expect(h.replay.hasActive(run.accountId)).toBe(true);
      expect(h.requests).toHaveLength(0);
    } finally {
      release();
      await sent;
    }
    expect(h.replays[0]?.status).toBe("completed");
    expect(h.replay.hasActive(run.accountId)).toBe(false);
  });
  it.each(["execution", "fidelity"] as const)(
    "isolates the entire %s replay and resumes LIVE after completion",
    async (mode) => {
      const h = await setup();
      const run = await h.replay.create({
        sourceEventId: "test-inbound",
        mode,
      });
      // QUEUED is isolated too: do not let a pre-injection side effect escape.
      expect(
        (await rawRequest(h.origin, "/ilink/bot/getconfig", { headers }))
          .status,
      ).toBe(200);
      const poll = await rawRequest(h.origin, "/ilink/bot/getupdates", {
        headers,
        body: '{"get_updates_buf":"live-cursor"}',
      });
      expect(JSON.parse(poll.body.toString())).toMatchObject({
        get_updates_buf: "live-cursor",
        msgs: [{ item_list: [{ text_item: { text: "test message" } }] }],
      });
      for (const endpoint of [
        "sendtyping",
        "getconfig",
        "msg/notifystart",
        "msg/notifystop",
      ]) {
        expect(
          (await rawRequest(h.origin, `/ilink/bot/${endpoint}`, { headers }))
            .status,
        ).toBe(200);
      }
      expect(h.replays[0]?.status).toBe("draining");
      expect(
        (await rawRequest(h.origin, "/ilink/bot/getuploadurl", { headers }))
          .status,
      ).toBe(409);
      const second = await rawRequest(h.origin, "/ilink/bot/getupdates", {
        headers,
        body: '{"get_updates_buf":"current-cursor"}',
      });
      expect(JSON.parse(second.body.toString())).toMatchObject({
        get_updates_buf: "current-cursor",
        msgs: [],
      });
      expect(
        (
          await rawRequest(h.origin, "/ilink/bot/sendmessage", {
            headers,
            body: '{"msg":{"context_token":"test-temporary-context","text":"test reply"}}',
          })
        ).status,
      ).toBe(200);
      expect(h.requests).toHaveLength(0);
      expect(h.replays[0]).toMatchObject({ id: run.id, status: "completed" });
      expect(JSON.stringify(h.replays)).not.toContain("test-temporary-context");
      expect(h.replay.hasActive(run.accountId)).toBe(false);
      const live = await rawRequest(h.origin, "/ilink/bot/getupdates", {
        headers,
      });
      expect(JSON.parse(live.body.toString())).toMatchObject({
        get_updates_buf: "real-next",
      });
      expect(h.requests).toHaveLength(1);
    },
  );

  it("blocks upload and unknown endpoints, remains quarantined, and resumes LIVE after explicit cancellation", async () => {
    const h = await setup();
    const run = await h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    expect(
      (await rawRequest(h.origin, "/ilink/bot/getuploadurl", { headers }))
        .status,
    ).toBe(409);
    expect(
      (await rawRequest(h.origin, "/cdn/upload", { headers })).status,
    ).toBe(409);
    for (const endpoint of [
      "sendmessage",
      "sendtyping",
      "getupdates",
      "unknown-side-effect",
    ])
      expect(
        (await rawRequest(h.origin, `/ilink/bot/${endpoint}`, { headers }))
          .status,
      ).toBe(409);
    expect(h.requests).toHaveLength(0);
    expect(h.replays[0]?.status).toBe("failed");
    await h.replay.cancel(run.id);
    expect(
      (await rawRequest(h.origin, "/ilink/bot/getupdates", { headers })).status,
    ).toBe(200);
    expect(h.requests).toHaveLength(1);
  });

  it("rejects malformed and oversized sandbox requests without reaching upstream", async () => {
    const h = await setup({ captureBodyBytes: 64 });
    await h.replay.create({ sourceEventId: "test-inbound", mode: "fidelity" });
    expect(
      (
        await rawRequest(h.origin, "/ilink/bot/sendmessage", {
          headers,
          body: "{invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await rawRequest(h.origin, "/ilink/bot/sendmessage", {
          headers,
          body: JSON.stringify({ text: "x".repeat(256) }),
        })
      ).status,
    ).toBe(413);
    expect(h.requests).toHaveLength(0);
  });

  it("allows another account to remain LIVE during a replay", async () => {
    const h = await setup();
    await h.replay.create({ sourceEventId: "test-inbound", mode: "execution" });
    expect(
      (
        await rawRequest(h.origin, "/ilink/bot/sendmessage", {
          headers: { authorization: "Bearer test-other-token" },
        })
      ).status,
    ).toBe(200);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.headers.authorization).toBe(
      "Bearer test-other-token",
    );
    expect(
      (await rawRequest(h.origin, "/ilink/bot/sendtyping", { headers })).status,
    ).toBe(200);
    expect(h.requests).toHaveLength(1);
  });

  it("resumes LIVE after timeout and persists the timeout result", async () => {
    const h = await setup({ timeoutMs: 100 });
    const run = await h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    await expect.poll(() => h.replays[0]?.status).toBe("timed_out");
    expect(h.replay.hasActive(run.accountId)).toBe(false);
    expect(
      (await rawRequest(h.origin, "/ilink/bot/getupdates", { headers })).status,
    ).toBe(200);
    expect(h.requests).toHaveLength(1);
  });

  it("reserves the account before asynchronous replay creation completes", async () => {
    const memory = memoryStorage();
    const accountId = fingerprint("test-replay-token", testKey);
    memory.sourceEvents.push(inboundEvent(accountId));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = memory.storage.createReplay.bind(memory.storage);
    memory.storage.createReplay = async (run) => {
      await gate;
      await create(run);
    };
    const h = await setup({ storage: memory.storage });
    const first = h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    try {
      await expect.poll(() => h.replay.hasActive(accountId)).toBe(true);
      await expect(
        h.replay.create({ sourceEventId: "test-inbound", mode: "execution" }),
      ).rejects.toThrow("active replay");
    } finally {
      release();
      await first;
    }
    expect(memory.replays).toHaveLength(1);
  });

  it("refuses replay while an account still has an in-flight LIVE long poll", async () => {
    const h = await setup();
    h.upstream.removeAllListeners("request");
    let received = false;
    h.upstream.on("request", (request, response) => {
      request.resume();
      received = true;
      response.on("error", () => undefined);
    });
    const client = httpRequest(`${h.origin}/ilink/bot/getupdates`, {
      method: "POST",
      headers,
    });
    client.on("error", () => undefined);
    client.end("{}");
    try {
      await expect.poll(() => received).toBe(true);
      await expect(
        h.replay.create({ sourceEventId: "test-inbound", mode: "execution" }),
      ).rejects.toThrow("in-flight");
    } finally {
      client.destroy();
    }
    await expect.poll(() => h.exchanges.length).toBe(1);
    const run = await h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    expect(run.status).toBe("queued");
  });

  it("keeps an account isolated when persisting completion fails, then allows cancellation after recovery", async () => {
    const h = await setup();
    const run = await h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    const update = h.storage.updateReplay.bind(h.storage);
    h.storage.updateReplay = async () => {
      throw new Error("test database failure");
    };
    expect(
      (await rawRequest(h.origin, "/ilink/bot/sendmessage", { headers }))
        .status,
    ).toBe(502);
    expect(h.replay.hasActive(run.accountId)).toBe(true);
    h.storage.updateReplay = update;
    expect(
      (await rawRequest(h.origin, "/ilink/bot/getupdates", { headers })).status,
    ).toBe(409);
    expect(h.requests).toHaveLength(0);
    await h.replay.cancel(run.id);
    expect(h.replay.hasActive(run.accountId)).toBe(false);
  });

  it("releases a failed creation reservation and allows a retry", async () => {
    const h = await setup();
    const create = h.storage.createReplay.bind(h.storage);
    h.storage.createReplay = async () => {
      throw new Error("test creation failure");
    };
    await expect(
      h.replay.create({ sourceEventId: "test-inbound", mode: "execution" }),
    ).rejects.toThrow("test creation failure");
    expect(h.replay.hasActive(fingerprint("test-replay-token", testKey))).toBe(
      false,
    );
    h.storage.createReplay = create;
    expect(
      (
        await h.replay.create({
          sourceEventId: "test-inbound",
          mode: "execution",
        })
      ).status,
    ).toBe("queued");
  });

  it("keeps isolation when timeout persistence fails without an unhandled rejection", async () => {
    const h = await setup({ timeoutMs: 50 });
    const run = await h.replay.create({
      sourceEventId: "test-inbound",
      mode: "execution",
    });
    const update = h.storage.updateReplay.bind(h.storage);
    h.storage.updateReplay = async () => {
      throw new Error("test timeout write failure");
    };
    await expect.poll(() => run.status).toBe("failed");
    expect(h.replay.hasActive(run.accountId)).toBe(true);
    expect(
      (await rawRequest(h.origin, "/ilink/bot/sendmessage", { headers }))
        .status,
    ).toBe(409);
    expect(h.requests).toHaveLength(0);
    h.storage.updateReplay = update;
    await h.replay.cancel(run.id);
    expect(h.replay.hasActive(run.accountId)).toBe(false);
  });
});
