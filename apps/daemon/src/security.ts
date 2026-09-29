import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HeaderMap } from "@ilink-trace/contracts";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

export async function loadOrCreateHmacKey(path: string): Promise<Buffer> {
  try {
    const key = await readFile(path);
    if (key.byteLength >= 32) return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, key, { flag: "wx", mode: 0o600 });
  return key;
}

export function fingerprint(value: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(value).digest("hex").slice(0, 16);
}

export function bearerToken(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function redactHeaders(headers: HeaderMap): HeaderMap {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? "<redacted>" : value,
    ]),
  );
}

export function randomAccessToken(): string {
  return randomBytes(24).toString("base64url");
}
