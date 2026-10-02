import {
  request as httpRequest,
  createServer,
  type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as protocol from "@ilink-trace/protocol";
import { AccountRegistry } from "./account-registry.js";
import {
  close,
  createHarness,
  listen,
  memoryStorage,
  rawRequest,
  testKey,
} from "./testing/proxy-harness.js";

const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
async function setup(...args: Parameters<typeof createHarness>) {
  const harness = await createHarness(...args);
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  vi.restoreAllMocks();
});

describe("proxy reliability against local simulators", () => {
  it("preserves a real 35 second long poll", async () => {
    const h = await setup((_request, response) => {
      const timer = setTimeout(
        () => response.end('{"ret":0,"msgs":[]}'),
        35_000,
      );
      response.once("close", () => clearTimeout(timer));
    });
    const started = Date.now();
    const result = await rawRequest(h.origin, "/ilink/bot/getupdates");
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('{"ret":0,"msgs":[]}');
    expect(Date.now() - started).toBeGreaterThanOrEqual(35_000);
    await h.recorder.flush();
    expect(h.exchanges[0]?.errorStage).toBeNull();
  }, 45_000);

  it("cancels an upstream long poll when the client disconnects", async () => {
    let upstreamClosed = false;
    const h = await setup((_request, response) => {
      response.once("close", () => {
        upstreamClosed = true;
      });
    });
    const client = httpRequest(`${h.origin}/ilink/bot/getupdates`, {
      method: "POST",
    });
    client.on("error", () => undefined);
    client.end("{}");
    try {
      await expect.poll(() => h.requests.length).toBe(1);
      client.destroy();
      await expect.poll(() => upstreamClosed).toBe(true);
      await expect.poll(() => h.exchanges.length).toBe(1);
      expect(h.exchanges[0]?.errorStage).toBe("client_aborted");
    } finally {
      client.destroy();
    }
  });

  it("records an upstream header timeout without forging success", async () => {
    const h = await setup(() => undefined, { upstreamHeadersTimeoutMs: 50 });
    const result = await rawRequest(h.origin, "/ilink/bot/getconfig");
    expect(result.status).toBe(502);
    await h.recorder.flush();
    expect(h.exchanges[0]).toMatchObject({
      errorStage: "upstream",
      errorMessage: "HeadersTimeoutError",
    });
  });

  it("aborts a partially delivered response when the upstream stream breaks", async () => {
    const h = await setup((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write('{"ret":');
      const timer = setTimeout(() => response.destroy(), 20);
      response.once("close", () => clearTimeout(timer));
    });
    await expect(
      rawRequest(h.origin, "/ilink/bot/getupdates"),
    ).rejects.toThrow();
    await expect.poll(() => h.exchanges.length).toBe(1);
    expect(h.exchanges[0]).toMatchObject({
      responseStatus: 200,
      errorStage: "upstream",
    });
  });

  it("forwards large request and response bodies completely while bounding capture", async () => {
    const body = JSON.stringify({ text: "x".repeat(32_768) });
    const h = await setup((_request, response, bytes) => response.end(bytes), {
      captureBodyBytes: 64,
    });
    const result = await rawRequest(h.origin, "/ilink/bot/sendmessage", {
      body,
    });
    expect(result.body.toString()).toBe(body);
    expect(h.requests[0]?.body.toString()).toBe(body);
    await h.recorder.flush();
    expect(h.exchanges[0]).toMatchObject({
      requestBytes: Buffer.byteLength(body),
      responseBytes: Buffer.byteLength(body),
      requestTruncated: true,
      responseTruncated: true,
      errorStage: null,
    });
    expect(h.exchanges[0]?.requestBody).toBe("<non-json body omitted>");
  });

  it.each(["identity", "gzip"])(
    "preserves %s response bytes and treats non-JSON as observation only",
    async (encoding) => {
      const plain = Buffer.from("test non-JSON response");
      const body = encoding === "gzip" ? gzipSync(plain) : plain;
      const h = await setup((_request, response) => {
        response.writeHead(418, {
          "content-type": "text/plain",
          "content-encoding": encoding,
        });
        response.end(body);
      });
      const result = await rawRequest(h.origin, "/ilink/bot/getupdates");
      expect(result.status).toBe(418);
      expect(result.headers["content-encoding"]).toBe(encoding);
      expect(result.body).toEqual(body);
      await h.recorder.flush();
      expect(h.exchanges[0]?.responseBody).toBe("<non-json body omitted>");
      expect(h.exchanges[0]?.errorStage).toBeNull();
    },
  );

  it("removes connection-nominated headers in both directions and preserves repeated headers", async () => {
    const h = await setup((_request, response) => {
      response.writeHead(200, {
        connection: "x-upstream-hop, close",
        "x-upstream-hop": "remove",
        "set-cookie": ["a=test", "b=test"],
        "x-end-to-end": "keep",
      });
      response.end("ok");
    });
    const result = await rawRequest(h.origin, "/test?debug=1", {
      method: "PUT",
      headers: {
        connection: "x-client-hop, close",
        "x-client-hop": "remove",
        "x-end-to-end": "keep",
      },
      body: "test body",
    });
    expect(h.requests[0]).toMatchObject({
      method: "PUT",
      path: "/test?debug=1",
    });
    expect(h.requests[0]?.headers["x-client-hop"]).toBeUndefined();
    expect(h.requests[0]?.headers["x-end-to-end"]).toBe("keep");
    expect(result.headers["x-upstream-hop"]).toBeUndefined();
    expect(result.headers["set-cookie"]).toEqual(["a=test", "b=test"]);
    expect(result.headers["x-end-to-end"]).toBe("keep");
  });

  it("rewrites bootstrap Content-Length, redacts credentials and routes the registered account", async () => {
    const regional = createServer((_request, response) =>
      response.end("regional"),
    );
    const regionalOrigin = await listen(regional);
    try {
      const h = await setup((_request, response) => {
        const body = JSON.stringify({
          status: "confirmed",
          baseurl: regionalOrigin,
          bot_token: "test-login-token",
          qrcode: "test-qr-secret",
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
      });
      const result = await rawRequest(h.origin, "/ilink/bot/get_qrcode_status");
      expect(JSON.parse(result.body.toString())).toMatchObject({
        baseurl: h.origin,
        bot_token: "test-login-token",
      });
      expect(Number(result.headers["content-length"])).toBe(
        result.body.byteLength,
      );
      expect(
        (
          await rawRequest(h.origin, "/ilink/bot/getconfig", {
            headers: { authorization: "Bearer test-login-token" },
          })
        ).body.toString(),
      ).toBe("regional");
      await h.recorder.flush();
      for (const secret of ["test-login-token", "test-qr-secret"])
        expect(JSON.stringify(h.exchanges)).not.toContain(secret);
    } finally {
      await close(regional);
    }
  });

  it("uses a validated regional redirect for subsequent bootstrap requests", async () => {
    const regional = createServer((_request, response) =>
      response.end("redirected"),
    );
    const regionalOrigin = await listen(regional);
    try {
      const h = await setup((_request, response) =>
        response.end(
          JSON.stringify({
            status: "scaned_but_redirect",
            redirect_host: regionalOrigin,
          }),
        ),
      );
      const first = await rawRequest(h.origin, "/ilink/bot/get_qrcode_status");
      expect(JSON.parse(first.body.toString())).toMatchObject({
        redirect_host: h.origin,
      });
      expect(
        (
          await rawRequest(h.origin, "/ilink/bot/get_qrcode_status")
        ).body.toString(),
      ).toBe("redirected");
      expect(h.requests).toHaveLength(1);
    } finally {
      await close(regional);
    }
  });

  it("does not select upstream from Host, Forwarded or query and isolates account routes", async () => {
    const regional = createServer((_request, response) =>
      response.end("account-b"),
    );
    const regionalOrigin = await listen(regional);
    try {
      const h = await setup((_request, response) => response.end("account-a"));
      h.registry.registerToken("test-account-b", regionalOrigin);
      const [a, b] = await Promise.all([
        rawRequest(
          h.origin,
          `/test?upstream=${encodeURIComponent(regionalOrigin)}`,
          {
            headers: {
              host: new URL(regionalOrigin).host,
              forwarded: `host=${new URL(regionalOrigin).host}`,
              authorization: "Bearer test-account-a",
            },
          },
        ),
        rawRequest(h.origin, "/test", {
          headers: { authorization: "Bearer test-account-b" },
        }),
      ]);
      expect(a.body.toString()).toBe("account-a");
      expect(b.body.toString()).toBe("account-b");
    } finally {
      await close(regional);
    }
  });

  it.each([
    "http://api.weixin.qq.com",
    "https://user:pass@api.weixin.qq.com",
    "https://127.0.0.1",
    "https://api.weixin.qq.com:444",
    "https://weixin.qq.com.attacker.invalid",
  ])(
    "rejects unsafe discovered upstream %s without replacing the account route",
    (upstream) => {
      const registry = new AccountRegistry({
        defaultUpstream: "https://api.weixin.qq.com",
        allowedHosts: ["weixin.qq.com"],
        hmacKey: testKey,
      });
      expect(() => registry.registerToken("test-token", upstream)).toThrow();
      expect(() => registry.setBootstrapUpstream(upstream)).toThrow();
      expect(registry.resolve("Bearer test-token").upstream.origin).toBe(
        "https://api.weixin.qq.com",
      );
    },
  );

  it("keeps forwarding when storage rejects writes and reports degradation", async () => {
    const memory = memoryStorage();
    memory.storage.recordExchange = async () => {
      throw new Error("test database failure");
    };
    const h = await setup((_request, response) => response.end('{"ret":0}'), {
      storage: memory.storage,
    });
    for (let index = 0; index < 2; index++)
      expect((await rawRequest(h.origin, "/ilink/bot/getupdates")).status).toBe(
        200,
      );
    await h.recorder.flush();
    expect(h.recorder.dropped).toBe(2);
    expect(h.events.since(0).map((event) => event.type)).toEqual([
      "recorder.degraded",
      "recorder.degraded",
    ]);
  });

  it("keeps forwarding with a stalled database and a full recorder queue", async () => {
    const memory = memoryStorage();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    memory.storage.recordExchange = async () => {
      await stalled;
      return [];
    };
    const h = await setup((_request, response) => response.end('{"ret":0}'), {
      storage: memory.storage,
      maxQueueSize: 1,
    });
    try {
      for (let index = 0; index < 3; index++)
        expect(
          (await rawRequest(h.origin, "/ilink/bot/getupdates")).status,
        ).toBe(200);
      expect(h.recorder.dropped).toBe(1);
      expect(
        h.events.since(0).some((event) => event.type === "recorder.degraded"),
      ).toBe(true);
    } finally {
      release();
    }
  });

  it("does not change the upstream response when the parser throws", async () => {
    vi.spyOn(protocol, "parseExchange").mockImplementationOnce(() => {
      throw new Error("test parser failure");
    });
    const h = await setup((_request, response) =>
      response.end('{"ret":0,"unknown_field":true}'),
    );
    const result = await rawRequest(h.origin, "/ilink/bot/getupdates");
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('{"ret":0,"unknown_field":true}');
    await h.recorder.flush();
    expect(h.exchanges[0]?.events[0]).toMatchObject({
      kind: "protocol_error",
      data: { reason: "Error" },
    });
    expect(h.exchanges[0]?.errorStage).toBeNull();
  });

  it("cancels upstream streaming after a paused response client disconnects", async () => {
    let upstreamClosed = false;
    const h = await setup(
      (_request, response) => {
        response.writeHead(200);
        const timer = setInterval(() => {
          if (!response.writableNeedDrain)
            response.write(Buffer.alloc(32_768, 120));
        }, 1);
        response.once("close", () => {
          clearInterval(timer);
          upstreamClosed = true;
        });
      },
      { captureBodyBytes: 64 },
    );
    let downstream: ServerResponse | undefined;
    h.proxy.on("request", (_request, response) => {
      downstream = response;
    });
    const client = httpRequest(`${h.origin}/test`, { method: "POST" });
    client.on("error", () => undefined);
    client.on("response", (response) => {
      response.on("error", () => undefined);
      response.pause();
    });
    client.end("{}");
    try {
      await expect
        .poll(() => downstream?.writableNeedDrain, { timeout: 5000 })
        .toBe(true);
      client.destroy();
      await expect.poll(() => upstreamClosed).toBe(true);
      await expect.poll(() => h.exchanges.length).toBe(1);
      expect(h.exchanges[0]?.errorStage).toBe("client_aborted");
    } finally {
      client.destroy();
    }
  });
});
