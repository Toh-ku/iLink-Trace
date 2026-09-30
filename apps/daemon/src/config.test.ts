import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadDotEnv } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryEnvFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ilink-trace-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env");
  await writeFile(path, contents, "utf8");
  return path;
}

describe(".env configuration", () => {
  it("uses built-in defaults when .env is absent", () => {
    expect(loadDotEnv(join(tmpdir(), "missing-ilink-trace.env"))).toEqual({});
    expect(loadConfig({}).proxyPort).toBe(8787);
  });

  it("loads daemon configuration from a dotenv file", async () => {
    const path = await temporaryEnvFile(`
ILINK_TRACE_PROXY_PORT=9876
ILINK_TRACE_CAPTURE_MESSAGE_CONTENT=true
ILINK_TRACE_LOG_LEVEL=debug
`);

    const config = loadConfig(loadDotEnv(path));

    expect(config.proxyPort).toBe(9876);
    expect(config.captureMessageContent).toBe(true);
    expect(config.logLevel).toBe("debug");
  });
});
