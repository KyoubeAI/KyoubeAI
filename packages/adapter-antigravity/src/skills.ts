import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE } from "./constants.js";
import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "./types.js";

interface RuntimeSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  versionId: string | null;
  currentVersionId: string | null;
  sourceStatus: "available" | "missing";
  missingDetail: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveAntigravityHome(config: Record<string, unknown>): string {
  const env = asObject(config.env);
  const configuredHome =
    asNonEmptyString(env.HOME) ??
    asNonEmptyString(process.env.PAPERCLIP_HOME) ??
    os.homedir();
  return path.resolve(configuredHome);
}

export function resolveAntigravitySkillsHome(config: Record<string, unknown>): string {
  return path.join(resolveAntigravityHome(config), ".gemini", "config", "skills");
}

function readConfiguredRuntimeSkills(config: Record<string, unknown>): RuntimeSkillEntry[] {
  const raw = config.paperclipRuntimeSkills;
  if (!Array.isArray(raw)) return [];
  const entries: RuntimeSkillEntry[] = [];
  for (const item of raw) {
    const obj = asObject(item);
    const key = asNonEmptyString(obj.key) ?? asNonEmptyString(obj.name);
    const runtimeName = asNonEmptyString(obj.runtimeName) ?? asNonEmptyString(obj.name);
    const source = asNonEmptyString(obj.source);
    if (!key || !runtimeName || !source) continue;
    entries.push({
      key,
      runtimeName,
      source,
      versionId: asNonEmptyString(obj.versionId),
      currentVersionId: asNonEmptyString(obj.currentVersionId),
      sourceStatus: obj.sourceStatus === "missing" ? "missing" : "available",
      missingDetail: asNonEmptyString(obj.missingDetail),
    });
  }
  return entries;
}

function canonicalizeDesiredSkillReference(
  reference: string,
  availableEntries: RuntimeSkillEntry[],
): string {
  const norm = reference.trim().toLowerCase();
  if (!norm) return "";
  const exact = availableEntries.find((entry) => entry.key.trim().toLowerCase() === norm);
  if (exact) return exact.key;
  const byRuntimeName = availableEntries.filter(
    (entry) => entry.runtimeName.trim().toLowerCase() === norm,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;
  const bySlug = availableEntries.filter(
    (entry) => entry.key.trim().toLowerCase().split("/").pop() === norm,
  );
  if (bySlug.length === 1) return bySlug[0]!.key;
  return norm;
}

export function resolveDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: RuntimeSkillEntry[],
): string[] {
  const syncObj = asObject(config.paperclipSkillSync);
  if (Object.prototype.hasOwnProperty.call(syncObj, "desiredSkills")) {
    const rawList = Array.isArray(syncObj.desiredSkills) ? syncObj.desiredSkills : [];
    const out = new Set<string>();
    for (const item of rawList) {
      const rawKey =
        typeof item === "string"
          ? item
          : asNonEmptyString(asObject(item).key) ?? "";
      const canonical = canonicalizeDesiredSkillReference(rawKey, availableEntries);
      if (canonical) out.add(canonical);
    }
    return [...out];
  }
  return availableEntries.map((entry) => entry.key);
}

async function readInstalledTargets(
  skillsHome: string,
): Promise<Map<string, { targetPath: string | null; kind: "symlink" | "directory" | "file" }>> {
  const out = new Map<string, { targetPath: string | null; kind: "symlink" | "directory" | "file" }>();
  const dirents = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  for (const dirent of dirents) {
    const fullPath = path.join(skillsHome, dirent.name);
    if (dirent.isSymbolicLink()) {
      const linkTarget = await fs.readlink(fullPath).catch(() => null);
      out.set(dirent.name, {
        targetPath: linkTarget ? path.resolve(path.dirname(fullPath), linkTarget) : null,
        kind: "symlink",
      });
    } else if (dirent.isDirectory()) {
      out.set(dirent.name, { targetPath: fullPath, kind: "directory" });
    } else {
      out.set(dirent.name, { targetPath: fullPath, kind: "file" });
    }
  }
  return out;
}

async function ensureSkillSymlink(source: string, target: string): Promise<void> {
  const resolvedSource = path.resolve(source);
  const existingLink = await fs.readlink(target).catch(() => null);
  if (existingLink) {
    const resolvedExisting = path.resolve(path.dirname(target), existingLink);
    if (resolvedExisting === resolvedSource) return;
    await fs.unlink(target).catch(() => {});
  } else {
    const stat = await fs.lstat(target).catch(() => null);
    if (stat) return;
  }
  await fs.symlink(resolvedSource, target, "dir");
}

export async function reconcileAntigravitySkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
): Promise<string[]> {
  const availableEntries = readConfiguredRuntimeSkills(config);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(
        new Set(
          requestedDesiredSkills
            .map((ref) => canonicalizeDesiredSkillReference(ref, availableEntries))
            .filter(Boolean),
        ),
      )
    : resolveDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveAntigravitySkillsHome(config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledTargets(skillsHome);
  const availableByRuntimeName = new Map(
    availableEntries.map((entry) => [entry.runtimeName, entry]),
  );

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || entry.sourceStatus === "missing") continue;
    const target = path.join(skillsHome, entry.runtimeName);
    await ensureSkillSymlink(entry.source, target);
    const linkedSource = await fs.readlink(target).catch(() => null);
    const resolvedSource = linkedSource
      ? path.resolve(path.dirname(target), linkedSource)
      : null;
    if (resolvedSource !== path.resolve(entry.source)) {
      throw new Error(
        `Cannot reconcile Antigravity skill "${entry.key}" because ${target} is occupied by another installation.`,
      );
    }
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== path.resolve(available.source)) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return desiredSkills;
}

async function buildSkillSnapshot(
  config: Record<string, unknown>,
  desiredOverride?: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = readConfiguredRuntimeSkills(config);
  const desiredSkills = desiredOverride
    ? Array.from(
        new Set(
          desiredOverride
            .map((ref) => canonicalizeDesiredSkillReference(ref, availableEntries))
            .filter(Boolean),
        ),
      )
    : resolveDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveAntigravitySkillsHome(config);
  const installed = await readInstalledTargets(skillsHome);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    if (available.sourceStatus === "missing") {
      entries.push({
        key: available.key,
        runtimeName: available.runtimeName,
        versionId: available.versionId,
        currentVersionId: available.currentVersionId,
        desired,
        managed: true,
        state: "missing",
        origin: "company_managed",
        originLabel: "Managed by KyoubeAI",
        readOnly: false,
        sourcePath: null,
        targetPath: path.join(skillsHome, available.runtimeName),
        detail:
          available.missingDetail ??
          "KyoubeAI cannot find this skill in the local runtime skills directory.",
      });
      continue;
    }

    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;
    const resolvedSource = path.resolve(available.source);

    if (installedEntry?.targetPath === resolvedSource) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = "Linked into ~/.gemini/config/skills for Antigravity CLI.";
    } else if (installedEntry) {
      state = "external";
      detail = desired
        ? "An external skill with the same runtime name already exists in ~/.gemini/config/skills."
        : "Installed outside KyoubeAI management.";
    } else if (desired) {
      managed = true;
      state = "configured";
      detail = "Will be linked into ~/.gemini/config/skills on the next run or skill sync.";
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      versionId: available.versionId,
      currentVersionId: available.currentVersionId,
      desired,
      managed,
      state,
      origin: "company_managed",
      originLabel: "Managed by KyoubeAI",
      readOnly: false,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the KyoubeAI skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "KyoubeAI cannot find this skill in the local runtime skills directory.",
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.gemini/config/skills",
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: "Installed in ~/.gemini/config/skills outside KyoubeAI management.",
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  return {
    adapterType: ADAPTER_TYPE,
    supported: true,
    mode: "persistent",
    desiredSkills,
    desiredSkillEntries: desiredSkills.map((key) => ({
      key,
      versionId: availableByKey.get(key)?.versionId ?? null,
    })),
    entries,
    warnings,
  };
}

export async function listAntigravitySkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildSkillSnapshot(ctx.config ?? {});
}

export async function syncAntigravitySkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const config = ctx.config ?? {};
  const reconciled = await reconcileAntigravitySkills(config, desiredSkills);
  return buildSkillSnapshot(config, reconciled);
}
