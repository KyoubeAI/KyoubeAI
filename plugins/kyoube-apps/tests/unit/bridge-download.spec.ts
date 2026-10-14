import type { KyoubeRequest } from "@kyoube/app-sdk";
import { describe, expect, it } from "vitest";
import { APP_BUDGET, appErrorPayload, createAppGuard, handleAppMessage, routeAppRequest, type AppBridgeCallbacks, type StopReason } from "../../src/ui/apps/bridge.js";
import { MAX_DOWNLOAD_BYTES, type DownloadFile } from "../../src/ui/apps/download-rules.js";

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

function frame(overrides: Partial<AppBridgeCallbacks> = {}, clock = { at: 1_000 }) {
  const posted: Array<Record<string, unknown>> = [];
  const target = { postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); } };
  const saved: DownloadFile[] = [];
  const stops: StopReason[] = [];
  const guard = createAppGuard(NONCE, { onStop: (reason) => { stops.push(reason); }, now: () => clock.at });
  const callbacks: AppBridgeCallbacks = {
    context: () => ({}),
    onData: async () => ({ rows: [] }),
    onToast: () => {},
    onOpenApp: () => {},
    onDownload: async (file) => { saved.push(file); },
    isLive: () => stops.length === 0,
    guard,
    ...overrides,
  };
  const send = (data: unknown) => handleAppMessage({ source: target, data }, target, callbacks);
  return { posted, saved, stops, send, clock, guard };
}

const download = (id: string, filename = "a.csv") => request("ui.download", { filename, bytes: new Uint8Array([65]) }, id);

describe("handling ui.download", () => {
  it("hands the routed file to the runner and answers null", async () => {
    const f = frame();
    await f.send(download("d1", "Out.CSV"));
    expect(f.saved).toEqual([{ filename: "Out.csv", mime: "text/csv", bytes: new Uint8Array([65]) }]);
    expect(f.posted).toEqual([{ kyoube: 1, id: "d1", result: null }]);
  });

  it("answers disabled where the runner cannot save", async () => {
    const f = frame({ onDownload: undefined });
    await f.send(download("d1"));
    expect(f.posted[0]).toMatchObject({ id: "d1", error: { code: "disabled" } });
  });

  it("passes the runner's refusal on with its code", async () => {
    const f = frame({ onDownload: async () => { throw new Error("declined: the viewer did not save the file"); } });
    await f.send(download("d1"));
    expect(f.posted[0]).toMatchObject({ id: "d1", error: { code: "declined", message: "declined: the viewer did not save the file" } });
    expect(appErrorPayload(new Error("limit: a save is already waiting for the viewer")).code).toBe("limit");
  });

  it("charges an invalid download a request but not a download", async () => {
    const f = frame();
    for (let i = 0; i < 5; i += 1) await f.send(request("ui.download", { filename: "x.exe", bytes: new Uint8Array([1]) }, `bad${i}`));
    await f.send(download("good"));
    expect(f.saved).toHaveLength(1);
  });

  it(`saves ${APP_BUDGET.downloads} per window and refuses the next with limit`, async () => {
    expect(APP_BUDGET.downloads).toBe(3);
    const f = frame();
    for (let i = 0; i < 4; i += 1) await f.send(download(`d${i}`));
    expect(f.saved).toHaveLength(3);
    expect(f.posted.at(-1)).toMatchObject({ id: "d3", error: { code: "limit", message: "limit: too many downloads" } });
    f.clock.at += APP_BUDGET.windowMs;
    await f.send(download("d4"));
    expect(f.saved).toHaveLength(4);
  });

  it("stops a frame that keeps hitting the downloads limit for three windows", async () => {
    const f = frame();
    for (let w = 0; w < 3; w += 1) {
      for (let i = 0; i < 4; i += 1) await f.send(download(`w${w}d${i}`));
      if (w < 2) f.clock.at += APP_BUDGET.windowMs;
    }
    expect(f.stops).toEqual(["budget"]);
  });
});
