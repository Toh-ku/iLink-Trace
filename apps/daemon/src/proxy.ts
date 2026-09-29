import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { HeaderMap, HttpExchange } from "@ilink-trace/contracts";
import { request as upstreamRequest, type Dispatcher } from "undici";
import { AccountRegistry } from "./account-registry.js";
import type { DaemonConfig } from "./config.js";
import type { Recorder } from "./recorder.js";
import type { ReplayManager } from "./replay.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class CaptureBuffer {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  bytes = 0;
  capturedBytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    const remaining = this.#limit - this.capturedBytes;
    if (remaining <= 0) return;
    const captured = Buffer.from(chunk).subarray(0, remaining);
    this.#chunks.push(captured);
    this.capturedBytes += captured.byteLength;
  }

  reset(): void {
    this.#chunks.length = 0;
    this.bytes = 0;
    this.capturedBytes = 0;
  }

  get truncated(): boolean {
    return this.bytes > this.capturedBytes;
  }

  text(): string | null {
    return this.capturedBytes === 0
      ? null
      : Buffer.concat(this.#chunks).toString("utf8");
  }
}

function headerMap(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): HeaderMap {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name.toLowerCase(), value]],
    ),
  );
}

function forwardHeaders(headers: HeaderMap): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
        name.toLowerCase() !== "host",
    ),
  );
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())
        ? []
        : [[name, value]],
    ),
  );
}

function targetUrl(upstream: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, "http://trace.invalid");
  const target = new URL(upstream);
  const basePath = target.pathname.replace(/\/$/, "");
  target.pathname = `${basePath}${incoming.pathname}`.replace(/\/{2,}/g, "/");
  target.search = incoming.search;
  return target;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rewriteBootstrapResponse(
  body: Buffer,
  registry: AccountRegistry,
  publicProxyOrigin: string,
): { body: Buffer; accountId: string | null } {
  let value: Record<string, unknown> | null = null;
  try {
    value = asObject(JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return { body, accountId: null };
  }
  if (!value) return { body, accountId: null };

  let accountId: string | null = null;
  const realBaseUrl = typeof value.baseurl === "string" ? value.baseurl : null;
  const token = typeof value.bot_token === "string" ? value.bot_token : null;
  if (realBaseUrl && token) {
    accountId = registry.registerToken(token, realBaseUrl);
    value.baseurl = publicProxyOrigin;
  }

  if (
    typeof value.redirect_host === "string" &&
    value.redirect_host.length > 0
  ) {
    const redirect = value.redirect_host.includes("://")
      ? value.redirect_host
      : `https://${value.redirect_host}`;
    registry.setBootstrapUpstream(redirect);
    const local = new URL(publicProxyOrigin);
    value.redirect_host = value.redirect_host.includes("://")
      ? local.origin
      : local.host;
  }

  return { body: Buffer.from(JSON.stringify(value)), accountId };
}

async function writeChunk(
  response: ServerResponse,
  chunk: Uint8Array,
): Promise<void> {
  if (!response.write(chunk)) await once(response, "drain");
}

export interface ProxyServerOptions {
  config: DaemonConfig;
  registry: AccountRegistry;
  recorder: Recorder;
  replay: ReplayManager;
}

export function createProxyServer(options: ProxyServerOptions): Server {
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    const id = randomUUID();
    const requestCapture = new CaptureBuffer(options.config.captureBodyBytes);
    const responseCapture = new CaptureBuffer(options.config.captureBodyBytes);
    const abortController = new AbortController();
    let errorStage: string | null = null;
    let errorMessage: string | null = null;
    let responseStatus: number | null = null;
    let headersAt: number | null = null;
    let storedResponseHeaders: HeaderMap = {};
    let route = options.registry.resolve(request.headers.authorization);
    let source: HttpExchange["source"] = "live";
    const incomingUrl = new URL(request.url ?? "/", "http://trace.invalid");

    request.once("aborted", () => abortController.abort());
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort();
    });

    try {
      if (route.accountId && options.replay.hasActive(route.accountId)) {
        source = "replay";
        for await (const chunk of request) {
          requestCapture.add(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          );
        }
        headersAt = Date.now();
        const sandbox = requestCapture.truncated
          ? {
              statusCode: 413,
              body: { ret: -1, errmsg: "replay request body is too large" },
            }
          : await options.replay.handle(
              route.accountId,
              incomingUrl.pathname,
              requestCapture.text(),
            );
        const body = Buffer.from(JSON.stringify(sandbox.body));
        responseStatus = sandbox.statusCode;
        storedResponseHeaders = {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(body.byteLength),
        };
        responseCapture.add(body);
        response.writeHead(responseStatus, storedResponseHeaders);
        response.end(body);
        return;
      }

      const requestBody =
        request.method === "GET" || request.method === "HEAD"
          ? null
          : Readable.from(
              (async function* () {
                for await (const chunk of request) {
                  const bytes = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk);
                  requestCapture.add(bytes);
                  yield bytes;
                }
              })(),
            );
      const target = targetUrl(route.upstream, request.url ?? "/");
      const outgoingHeaders = forwardHeaders(headerMap(request.headers));
      outgoingHeaders["accept-encoding"] = "identity";
      const upstreamResponse = await upstreamRequest(target, {
        method: (request.method ?? "GET") as Dispatcher.HttpMethod,
        headers: outgoingHeaders,
        body: requestBody,
        signal: abortController.signal,
        headersTimeout: 70_000,
        bodyTimeout: 0,
      });
      headersAt = Date.now();
      responseStatus = upstreamResponse.statusCode;
      const rawResponseHeaders = responseHeaders(upstreamResponse.headers);
      storedResponseHeaders = headerMap(upstreamResponse.headers);
      const isBootstrapStatus = (request.url ?? "")
        .toLowerCase()
        .includes("/get_qrcode_status");

      if (isBootstrapStatus) {
        const held: Buffer[] = [];
        let passthrough = false;
        response.statusCode = responseStatus;
        for await (const chunk of upstreamResponse.body) {
          const bytes = Buffer.from(chunk);
          responseCapture.add(bytes);
          if (
            !passthrough &&
            responseCapture.bytes <= options.config.captureBodyBytes
          ) {
            held.push(bytes);
          } else {
            if (!passthrough) {
              response.writeHead(responseStatus, rawResponseHeaders);
              for (const buffered of held) await writeChunk(response, buffered);
              passthrough = true;
            }
            await writeChunk(response, bytes);
          }
        }
        if (!passthrough) {
          const rewritten = rewriteBootstrapResponse(
            Buffer.concat(held),
            options.registry,
            options.config.publicProxyOrigin,
          );
          if (rewritten.accountId)
            route = { ...route, accountId: rewritten.accountId };
          delete rawResponseHeaders["content-length"];
          rawResponseHeaders["content-length"] = String(
            rewritten.body.byteLength,
          );
          response.writeHead(responseStatus, rawResponseHeaders);
          response.end(rewritten.body);
          responseCapture.reset();
          responseCapture.add(rewritten.body);
          storedResponseHeaders = headerMap(rawResponseHeaders);
        } else {
          response.end();
        }
      } else {
        response.writeHead(responseStatus, rawResponseHeaders);
        for await (const chunk of upstreamResponse.body) {
          const bytes = Buffer.from(chunk);
          responseCapture.add(bytes);
          await writeChunk(response, bytes);
        }
        response.end();
      }
    } catch (error) {
      errorStage = abortController.signal.aborted
        ? "client_aborted"
        : "upstream";
      errorMessage = error instanceof Error ? error.name : "unknown";
      if (!response.headersSent) {
        responseStatus = 502;
        response.writeHead(502, { "content-type": "application/json" });
        response.end('{"error":"upstream_unavailable"}');
      } else {
        response.destroy();
      }
    } finally {
      const completedAt = Date.now();
      const exchange: HttpExchange = {
        id,
        accountId: route.accountId,
        method: request.method ?? "GET",
        path: incomingUrl.pathname,
        query: incomingUrl.search,
        upstreamOrigin: route.upstream.origin,
        requestHeaders: headerMap(request.headers),
        requestBody: requestCapture.text(),
        responseStatus,
        responseHeaders: storedResponseHeaders,
        responseBody: responseCapture.text(),
        startedAt,
        headersAt,
        completedAt,
        durationMs: completedAt - startedAt,
        requestBytes: requestCapture.bytes,
        responseBytes: responseCapture.bytes,
        requestTruncated: requestCapture.truncated,
        responseTruncated: responseCapture.truncated,
        source,
        errorStage,
        errorMessage,
      };
      options.recorder.enqueue(exchange);
    }
  });
}
