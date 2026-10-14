import { describe, expect, it, vi } from "vitest";
import { appLabel, createDownloadController, DOWNLOAD_PROMPT_MS, formatSize, saveFile, type PendingSave, type SaveEnv } from "../../src/ui/apps/download.js";
import type { DownloadFile } from "../../src/ui/apps/download-rules.js";

const file: DownloadFile = { filename: "Balloons.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: new Uint8Array([80, 75, 3, 4]) };

function fakeEnv() {
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const blobs: Blob[] = [];
  const anchor = {
    href: "", download: "", rel: "", style: { display: "" },
    click: () => { events.push(`click ${anchor.download} ${anchor.href}`); },
    remove: () => { events.push("remove"); },
  };
  const env: SaveEnv = {
    document: {
      createElement: () => anchor as unknown as HTMLAnchorElement,
      body: { appendChild: () => { events.push("append"); } },
    },
    url: {
      createObjectURL: (blob) => { blobs.push(blob); return "blob:host/1"; },
      revokeObjectURL: (url) => { events.push(`revoke ${url}`); },
    },
    defer: (fn) => { deferred.push(fn); },
  };
  return { env, events, deferred, blobs, anchor };
}

function controller(active: boolean) {
  const saved: DownloadFile[] = [];
  const prompts: Array<PendingSave | null> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const c = createDownloadController({
    isActive: () => active,
    save: (f) => { saved.push(f); },
    onPrompt: (p) => { prompts.push(p); },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  return { c, saved, prompts, timers, current: () => prompts.at(-1) ?? null };
}

describe("saveFile", () => {
  it("clicks a host-page anchor for a blob of the chosen type, then revokes it later", async () => {
    const f = fakeEnv();
    saveFile(file, f.env);
    expect(f.events).toEqual(["append", "click Balloons.xlsx blob:host/1", "remove"]);
    expect(f.anchor.rel).toBe("noopener");
    expect(f.blobs[0]!.type).toBe(file.mime);
    expect(new Uint8Array(await f.blobs[0]!.arrayBuffer())).toEqual(file.bytes);
    expect(f.deferred).toHaveLength(1);
    f.deferred[0]!();
    expect(f.events.at(-1)).toBe("revoke blob:host/1");
  });
});

describe("createDownloadController", () => {
  it("saves at once when the viewer just clicked", async () => {
    const k = controller(true);
    await expect(k.c.request(file)).resolves.toBeUndefined();
    expect(k.saved).toEqual([file]);
    expect(k.prompts).toEqual([]);
  });

  it("prompts when the viewer has not just clicked, and saves on Save", async () => {
    const k = controller(false);
    const done = k.c.request(file);
    expect(k.saved).toEqual([]);
    expect(k.current()).toMatchObject({ filename: "Balloons.xlsx", size: 4 });
    expect(k.timers[0]!.ms).toBe(DOWNLOAD_PROMPT_MS);
    k.current()!.save();
    await expect(done).resolves.toBeUndefined();
    expect(k.saved).toEqual([file]);
    expect(k.current()).toBeNull();
    expect(k.timers[0]!.cleared).toBe(true);
  });

  it("answers declined on Dismiss and when the prompt times out", async () => {
    const k = controller(false);
    const dismissed = k.c.request(file);
    k.current()!.dismiss();
    await expect(dismissed).rejects.toThrow(/^declined: /);
    const timedOut = k.c.request(file);
    k.timers[1]!.fn();
    await expect(timedOut).rejects.toThrow(/^declined: /);
    expect(k.saved).toEqual([]);
    expect(k.current()).toBeNull();
  });

  it("saves at most once: a double click, or Save after the timeout, does nothing more", async () => {
    const k = controller(false);
    const done = k.c.request(file);
    const pending = k.current()!;
    pending.save();
    pending.save();
    pending.dismiss();
    await expect(done).resolves.toBeUndefined();
    expect(k.saved).toHaveLength(1);
    const late = k.c.request(file);
    const second = k.current()!;
    k.timers[1]!.fn();
    second.save();
    await expect(late).rejects.toThrow(/^declined: /);
    expect(k.saved).toHaveLength(1);
  });

  it("refuses a second request while one is waiting, with limit", async () => {
    const k = controller(false);
    void k.c.request(file).catch(() => {});
    await expect(k.c.request(file)).rejects.toThrow(/^limit: /);
  });

  it("dispose rejects a waiting save as disabled and clears the bar, and the controller still works after", async () => {
    const k = controller(false);
    const waiting = k.c.request(file);
    k.c.dispose();
    await expect(waiting).rejects.toThrow(/^disabled: /);
    expect(k.current()).toBeNull();
    // React may run an effect's cleanup and then the effect again (StrictMode): dispose is not terminal.
    const again = k.c.request(file);
    k.current()!.save();
    await expect(again).resolves.toBeUndefined();
  });

  it("passes a save that throws on as the rejection", async () => {
    const saved = createDownloadController({ isActive: () => true, save: () => { throw new Error("quota"); }, onPrompt: () => {}, setTimeout: vi.fn(), clearTimeout: vi.fn() });
    await expect(saved.request(file)).rejects.toThrow("quota");
  });
});

describe("labels", () => {
  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(42_100)).toBe("41 KB");
    expect(formatSize(25 * 1024 * 1024)).toBe("25.0 MB");
  });
  it("names the app, or falls back", () => {
    expect(appLabel({ app: { name: "Balloon sheets" } })).toBe("Balloon sheets");
    expect(appLabel({ app: { name: "" } })).toBe("This app");
    expect(appLabel(null)).toBe("This app");
  });
});
