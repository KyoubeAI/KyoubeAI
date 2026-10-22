import { compileCompanyPolicy, compileIndex, writePolicyFiles, type CompanyPolicy } from "@kyoube/visibility";
import type { GroupStore } from "./store.js";

export interface VisibilityWriterDeps {
  store: Pick<GroupStore, "visibilityInput" | "allModes">;
  dir: string;
  now?: () => Date;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WriteReport { companies: number; needToKnow: number }

interface Queued { promise: Promise<WriteReport>; resolve: (report: WriteReport) => void; reject: (error: unknown) => void }

/**
 * Compiles every company's groups into the policy files the core reads (docs/groups.md): on every
 * change, at worker start and on the five-minute job. Never two writes at once: a call while a
 * write runs waits for it, then one more write runs for all such calls, so the last change made
 * before a call is always in the files that call waits for.
 */
export class VisibilityWriter {
  private running: Promise<WriteReport> | null = null;
  private queued: Queued | null = null;

  constructor(private readonly deps: VisibilityWriterDeps) {}

  write(): Promise<WriteReport> {
    if (!this.running) return this.start();
    if (!this.queued) {
      let resolve!: Queued["resolve"];
      let reject!: Queued["reject"];
      const promise = new Promise<WriteReport>((res, rej) => { resolve = res; reject = rej; });
      this.queued = { promise, resolve, reject };
    }
    return this.queued.promise;
  }

  private start(): Promise<WriteReport> {
    const run = this.writeOnce().finally(() => this.next());
    this.running = run;
    return run;
  }

  /** Runs synchronously as a write settles, so no call can slip in between the two writes. */
  private next(): void {
    const queued = this.queued;
    this.queued = null;
    this.running = null;
    if (queued) this.start().then(queued.resolve, queued.reject);
  }

  private async writeOnce(): Promise<WriteReport> {
    const writtenAt = (this.deps.now?.() ?? new Date()).toISOString();
    const modes = await this.deps.store.allModes();
    const companies: CompanyPolicy[] = [];
    for (const { companyId, mode } of modes) {
      if (mode !== "need_to_know") continue;
      try {
        // The mode comes from the same read as the index, so the index and the files agree.
        const { groups } = await this.deps.store.visibilityInput(companyId);
        const policy = compileCompanyPolicy({ companyId, mode, groups, writtenAt });
        if (policy) companies.push(policy);
      } catch (error) {
        // One company's failure must not keep every other company's policy stale. Its file goes,
        // and a need-to-know company without a readable file is closed, never open.
        this.deps.log("visibility policy compile failed; the core treats the company as closed", { companyId, error: String(error) });
      }
    }
    await writePolicyFiles({ dir: this.deps.dir, index: compileIndex(modes, writtenAt), companies });
    return { companies: modes.length, needToKnow: companies.length };
  }
}
