import { describe, expect, it } from "vitest";
import {
  decodeTracePage,
  decodeTraceDetail,
  virtualWindow,
  outcomeLabel,
} from "./message-traces";

describe("message page", () => {
  it("keeps the virtual window bounded for 100,000 messages", () => {
    const window = virtualWindow(100_000, 108 * 50_000, 648, 108);
    expect(window.end - window.start).toBe(14);
    expect(window.top).toBe((50_000 - 4) * 108);
    expect(window.bottom).toBeGreaterThan(0);
  });
  it("rejects malformed network DTOs", () => {
    expect(() =>
      decodeTracePage({ items: [{ id: "bad" }], nextCursor: null }),
    ).toThrow("契约校验");
    expect(() => decodeTraceDetail({ trace: {}, spans: [] })).toThrow(
      "契约校验",
    );
    expect(decodeTracePage({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
  it("presents business acceptance without a delivery claim", () => {
    expect(
      outcomeLabel({
        transport: "success",
        http: "success",
        httpStatus: 200,
        json: "valid",
        business: "accepted",
        ret: 0,
        errcode: null,
        delivery: "unknown",
      }),
    ).toContain("业务已接受 · 最终送达未知");
  });
});
