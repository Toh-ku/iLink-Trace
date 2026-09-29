import { isIP } from "node:net";
import { bearerToken, fingerprint } from "./security.js";

export interface AccountRoute {
  accountId: string | null;
  upstream: URL;
}

export interface AccountRegistryOptions {
  defaultUpstream: string;
  allowedHosts: string[];
  hmacKey: Uint8Array;
  allowUnsafeUpstream?: boolean;
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}

export class AccountRegistry {
  readonly #allowedHosts: string[];
  readonly #allowUnsafe: boolean;
  readonly #hmacKey: Uint8Array;
  readonly #routes = new Map<string, URL>();
  #bootstrapUpstream: URL;

  constructor(options: AccountRegistryOptions) {
    this.#allowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
    this.#allowUnsafe = options.allowUnsafeUpstream ?? false;
    this.#hmacKey = options.hmacKey;
    this.#bootstrapUpstream = this.validate(options.defaultUpstream);
  }

  validate(value: string): URL {
    const url = new URL(value);
    if (url.username || url.password)
      throw new Error("upstream URL must not include userinfo");
    if (!this.#allowUnsafe && url.protocol !== "https:")
      throw new Error("upstream URL must use HTTPS");
    if (!this.#allowUnsafe && url.port && url.port !== "443")
      throw new Error("upstream URL uses a disallowed port");
    const hostname = url.hostname.toLowerCase();
    const allowed = this.#allowedHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
    if (!this.#allowUnsafe && (!allowed || isPrivateHost(hostname))) {
      throw new Error("upstream host is not allowlisted");
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url;
  }

  resolve(authorization: string | string[] | undefined): AccountRoute {
    const token = bearerToken(authorization);
    if (!token)
      return { accountId: null, upstream: new URL(this.#bootstrapUpstream) };
    const accountId = fingerprint(token, this.#hmacKey);
    return {
      accountId,
      upstream: new URL(this.#routes.get(accountId) ?? this.#bootstrapUpstream),
    };
  }

  registerToken(token: string, upstream: string): string {
    const accountId = fingerprint(token, this.#hmacKey);
    this.#routes.set(accountId, this.validate(upstream));
    return accountId;
  }

  setBootstrapUpstream(upstream: string): void {
    this.#bootstrapUpstream = this.validate(upstream);
  }
}
