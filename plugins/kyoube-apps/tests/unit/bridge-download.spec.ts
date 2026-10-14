import type { KyoubeRequest } from "@kyoube/app-sdk";
import { describe, expect, it } from "vitest";
import { routeAppRequest } from "../../src/ui/apps/bridge.js";
import { MAX_DOWNLOAD_BYTES } from "../../src/ui/apps/download-rules.js";

const NONCE = "TESTnonce_0123456789-x";

function request(method: string, params: Record<string, unknown>, id = "1"): KyoubeRequest {
  return { kyoube: 1, id, method, params, nonce: NONCE } as unknown as KyoubeRequest;
}

describe("routing ui.download", () => {
  it("routes a good request with the cleaned name, the type and the bytes, and nothing else", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(routeAppRequest(request("ui.download", { filename: " Balloons.XLSX", bytes, mime: "text/html", extra: 1 })))
      .toEqual({ kind: "download", filename: "Balloons.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes });
  });

  it("refuses missing, empty or non-Uint8Array bytes as invalid", () => {
    for (const bytes of [undefined, "abc", [1, 2], { 0: 1 }, new Uint8Array(0), new Uint16Array([1]), new ArrayBuffer(3)]) {
      expect(routeAppRequest(request("ui.download", { filename: "a.csv", bytes }))).toMatchObject({ kind: "reject", code: "invalid" });
    }
  });

  it("accepts exactly 25 MB and refuses one byte more as too_large", () => {
    expect(routeAppRequest(request("ui.download", { filename: "a.zip", bytes: new Uint8Array(MAX_DOWNLOAD_BYTES) }))).toMatchObject({ kind: "download" });
    expect(routeAppRequest(request("ui.download", { filename: "a.zip", bytes: new Uint8Array(MAX_DOWNLOAD_BYTES + 1) }))).toMatchObject({ kind: "reject", code: "too_large" });
  });

  it("refuses a bad name as invalid", () => {
    expect(routeAppRequest(request("ui.download", { filename: "x.html", bytes: new Uint8Array([1]) }))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(request("ui.download", { bytes: new Uint8Array([1]) }))).toMatchObject({ kind: "reject", code: "invalid" });
  });
});
