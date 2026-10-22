import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import type { PolicyReader } from "@kyoube/visibility";
import { NotifyError } from "./errors.js";
import { PLUGIN_ID, SUBSCRIBED_EVENTS } from "./manifest.js";
import { testMessage } from "./messages.js";
import { Notifier, type NotifierDeps } from "./notifier.js";
import { readPublicUrl, readTestEndpoint } from "./runtime-config.js";
import { activeMembers } from "./routing.js";
import { NotifyStore, type DeviceRecord } from "./store.js";
import { createVisibilityGate } from "./visibility.js";
import { parseSubscription } from "./webpush/endpoints.js";
import { sendPush, type PushTransport } from "./webpush/send.js";
import { vapidSubject } from "./webpush/vapid.js";

export interface NotifyPluginDeps {
  transport?: PushTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  configPath?: string;
  testEndpointPath?: string;
  /** How long one push request may take before it counts as a network error. Default 10 s. */
  pushTimeoutMs?: number;
  /** Test seam: where the visibility policy is read from (default: the app's policy files, re-checked every two seconds). */
  policyReader?: PolicyReader;
}

/** What the UI sees of a device: everything but the browser's keys. */
export type DeviceView = Omit<DeviceRecord, "p256dh" | "auth">;
const view = ({ p256dh: _p, auth: _a, ...rest }: DeviceRecord): DeviceView => rest;

function userOf(context: PluginPerformActionContext): string {
  const actor = context.actor;
  if (actor.type !== "user" || !actor.userId) throw new NotifyError("forbidden", "notifications are for signed-in people");
  return actor.userId;
}

function deviceIdParam(params: Record<string, unknown>): string {
  const value = params.deviceId;
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value)) throw new NotifyError("invalid", "deviceId is required");
  return value;
}

export function createNotifyPlugin(deps: NotifyPluginDeps = {}): PaperclipPlugin {
  let ready = false;

  return definePlugin({
    async setup(ctx: PluginContext) {
      const now = deps.now ?? (() => Date.now());
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const store = new NotifyStore(ctx.state, now);
      const vapid = await store.vapid();
      const subject = vapidSubject(await readPublicUrl(deps.configPath));
      // Node's fetch, not ctx.http.fetch: the SDK bridge stringifies a binary body ("12,255,...")
      // and drops `redirect`. No redirects: the endpoint allowlist only vouches for the first hop,
      // so a 3xx comes back as a refusal.
      const transport: PushTransport = deps.transport ?? (async (url, init) => {
        const response = await fetch(url, { method: init.method, headers: init.headers, body: new Uint8Array(init.body), redirect: "manual", signal: AbortSignal.timeout(deps.pushTimeoutMs ?? 10_000) });
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status };
      });
      const notifier = new Notifier({
        issues: ctx.issues as unknown as NotifierDeps["issues"],
        approvals: ctx.approvals as unknown as NotifierDeps["approvals"],
        agents: ctx.agents as unknown as NotifierDeps["agents"],
        companies: ctx.companies as unknown as NotifierDeps["companies"],
        members: ctx.access.members,
        visibility: createVisibilityGate({ reader: deps.policyReader, issues: ctx.issues as unknown as Parameters<typeof createVisibilityGate>[0]["issues"] }),
        store,
        send: (target, message) => sendPush(target, message, { vapid, subject, transport, nowSeconds: () => Math.floor(now() / 1000), sleep }),
        logger: ctx.logger,
      });

      for (const name of SUBSCRIBED_EVENTS) ctx.events.on(name, (event) => notifier.handle(event));

      ctx.actions.register("notify.config", async (_params, context) => {
        const userId = userOf(context);
        // Failure notices go to owners and admins of the host's company only (see routing.failureRecipients).
        const role = context.companyId ? activeMembers(await ctx.access.members.list({ companyId: context.companyId })).find((member) => member.userId === userId)?.role : undefined;
        return { publicKey: vapid.publicKey, prefs: await store.prefs(userId), devices: (await store.devices(userId)).map(view), canReceiveFailures: role === "owner" || role === "admin" };
      });

      ctx.actions.register("notify.subscribe", async (params, context) => {
        const userId = userOf(context);
        const target = parseSubscription(params.subscription, await readTestEndpoint(deps.testEndpointPath));
        const label = typeof params.label === "string" ? params.label : "";
        return view(await store.addDevice(userId, target, label));
      });

      ctx.actions.register("notify.unsubscribe", async (params, context) => {
        return { ok: await store.removeDevice(userOf(context), deviceIdParam(params)) };
      });

      ctx.actions.register("notify.prefs", async (params, context) => {
        const patch: { failures?: boolean; comments?: boolean } = {};
        if (typeof params.failures === "boolean") patch.failures = params.failures;
        if (typeof params.comments === "boolean") patch.comments = params.comments;
        return store.setPrefs(userOf(context), patch);
      });

      ctx.actions.register("notify.test", async (params, context) => {
        const userId = userOf(context);
        const deviceId = deviceIdParam(params);
        const device = (await store.devices(userId)).find((item) => item.id === deviceId);
        if (!device) throw new NotifyError("not_found", "no such device");
        return notifier.sendTo(userId, device, testMessage());
      });

      ready = true;
      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onHealth() {
      return ready ? { status: "ok", message: `${PLUGIN_ID} ready` } : { status: "degraded", message: `${PLUGIN_ID} not ready` };
    },

    async onShutdown() {
      ready = false;
    },
  });
}
