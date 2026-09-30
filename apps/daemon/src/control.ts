import { existsSync } from "node:fs";
import {
  traceListQuerySchema,
  type TraceListQuery,
} from "@ilink-trace/contracts";
import type { StorageClient } from "@ilink-trace/storage";
import staticFiles from "@fastify/static";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { DaemonConfig } from "./config.js";
import type { EventHub } from "./event-hub.js";
import type { Recorder } from "./recorder.js";
import type { ReplayManager } from "./replay.js";

export interface ControlServerOptions {
  config: DaemonConfig;
  storage: StorageClient;
  events: EventHub;
  recorder: Recorder;
  replay: ReplayManager;
  accessToken: string;
}

function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function createControlServer(
  options: ControlServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const expectedOrigin = `http://${options.config.controlHost}:${String(options.config.controlPort)}`;

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    const origin = request.headers.origin;
    if (origin && origin !== expectedOrigin) {
      await reply.code(403).send({ error: "origin_not_allowed" });
      return reply;
    }
    const query = request.query as { access_token?: string };
    const supplied =
      bearer(request.headers.authorization) ?? query.access_token;
    if (supplied !== options.accessToken) {
      await reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.get("/api/v1/health", () => ({
    status: "ok",
    recorderDropped: options.recorder.dropped,
    time: Date.now(),
  }));
  app.get("/api/v1/overview", async () => options.storage.overview());
  app.get(
    "/api/v1/traces",
    { schema: { querystring: traceListQuerySchema } },
    async (request) =>
      options.storage.listTraces(request.query as TraceListQuery),
  );
  app.get(
    "/api/v1/traces/:id",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
        }),
        querystring: Type.Object({
          spanOffset: Type.Optional(
            Type.Integer({ minimum: 0, maximum: 1_000_000 }),
          ),
        }),
      },
    },
    async (request, reply) => {
      const value = await options.storage.getTrace(
        (request.params as { id: string }).id,
        (request.query as { spanOffset?: number }).spanOffset ?? 0,
      );
      return value ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.get(
    "/api/v1/exchanges",
    {
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
      },
    },
    async (request) => {
      const query = request.query as { limit?: number };
      return options.storage.listExchanges(query.limit ?? 100);
    },
  );
  app.get(
    "/api/v1/exchanges/:id",
    { schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) } },
    async (request, reply) => {
      const value = await options.storage.getExchange(
        (request.params as { id: string }).id,
      );
      return value ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.get(
    "/api/v1/protocol-events",
    {
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
      },
    },
    async (request) => {
      const query = request.query as { limit?: number };
      return options.storage.listEvents(query.limit ?? 200);
    },
  );
  app.get("/api/v1/replays", async () => options.storage.listReplays());
  app.post(
    "/api/v1/replays",
    {
      schema: {
        body: Type.Object({
          sourceEventId: Type.String({ minLength: 1 }),
          mode: Type.Union([
            Type.Literal("fidelity"),
            Type.Literal("execution"),
          ]),
        }),
      },
    },
    async (request, reply) => {
      try {
        return await options.replay.create(
          request.body as {
            sourceEventId: string;
            mode: "fidelity" | "execution";
          },
        );
      } catch (error) {
        return reply.code(409).send({
          error: "replay_not_created",
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
    },
  );
  app.post(
    "/api/v1/replays/:id/cancel",
    { schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) } },
    async (request, reply) => {
      const replay = await options.replay.cancel(
        (request.params as { id: string }).id,
      );
      return replay ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.get("/api/v1/export", async (_request, reply) => {
    reply.header(
      "content-disposition",
      `attachment; filename="ilink-trace-${Date.now()}.json"`,
    );
    return {
      format: "ilink-trace-export",
      version: 1,
      exportedAt: Date.now(),
      exchanges: await options.storage.listExchanges(500),
      events: await options.storage.listEvents(500),
      replays: await options.storage.listReplays(),
    };
  });

  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const lastId = Number(request.headers["last-event-id"] ?? 0);
    const send = (notification: ReturnType<EventHub["publish"]>) => {
      response.write(`id: ${String(notification.id)}\n`);
      response.write(`event: ${notification.type}\n`);
      response.write(`data: ${JSON.stringify(notification)}\n\n`);
    };
    for (const notification of options.events.since(
      Number.isFinite(lastId) ? lastId : 0,
    )) {
      send(notification);
    }
    response.write(": connected\n\n");
    const unsubscribe = options.events.subscribe(send);
    const heartbeat = setInterval(
      () => response.write(": heartbeat\n\n"),
      20_000,
    );
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (existsSync(options.config.webRoot)) {
    await app.register(staticFiles, {
      root: options.config.webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", () => ({
      name: "iLink Trace",
      status: "web console is not built; run pnpm build",
    }));
  }

  return app;
}
