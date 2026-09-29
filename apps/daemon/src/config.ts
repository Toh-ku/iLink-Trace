import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DaemonConfig {
  proxyHost: string;
  proxyPort: number;
  controlHost: string;
  controlPort: number;
  publicProxyOrigin: string;
  databasePath: string;
  keyPath: string;
  webRoot: string;
  defaultUpstream: string;
  allowedUpstreamHosts: string[];
  captureBodyBytes: number;
  captureMessageContent: boolean;
  recorderQueueSize: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function loadConfig(environment = process.env): DaemonConfig {
  const proxyHost = environment.ILINK_TRACE_PROXY_HOST ?? "127.0.0.1";
  const proxyPort = positiveInteger(environment.ILINK_TRACE_PROXY_PORT, 8787);
  const controlHost = environment.ILINK_TRACE_CONTROL_HOST ?? "127.0.0.1";
  const controlPort = positiveInteger(
    environment.ILINK_TRACE_CONTROL_PORT,
    8788,
  );
  const dataDirectory = resolve(
    environment.ILINK_TRACE_DATA_DIR ?? ".ilink-trace",
  );

  return {
    proxyHost,
    proxyPort,
    controlHost,
    controlPort,
    publicProxyOrigin:
      environment.ILINK_TRACE_PUBLIC_PROXY_ORIGIN ??
      `http://${proxyHost}:${String(proxyPort)}`,
    databasePath: resolve(dataDirectory, "trace.db"),
    keyPath: resolve(dataDirectory, "trace.key"),
    webRoot: resolve(
      environment.ILINK_TRACE_WEB_ROOT ??
        fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    defaultUpstream:
      environment.ILINK_TRACE_UPSTREAM ?? "https://ilinkai.weixin.qq.com",
    allowedUpstreamHosts: (
      environment.ILINK_TRACE_ALLOWED_UPSTREAM_HOSTS ?? "weixin.qq.com"
    )
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    captureBodyBytes: positiveInteger(
      environment.ILINK_TRACE_CAPTURE_BODY_BYTES,
      1024 * 1024,
    ),
    captureMessageContent: booleanValue(
      environment.ILINK_TRACE_CAPTURE_MESSAGE_CONTENT,
      false,
    ),
    recorderQueueSize: positiveInteger(
      environment.ILINK_TRACE_RECORDER_QUEUE_SIZE,
      500,
    ),
  };
}
