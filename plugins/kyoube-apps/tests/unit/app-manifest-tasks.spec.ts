// tests/unit/app-manifest-tasks.spec.ts
import { describe, expect, it } from "vitest";
import { placeholdersIn, taskTemplatesChanged, templateChanges, validateAppManifest } from "../../src/apps/manifest.js";

const base = { name: "Triage", slug: "triage", tables: [{ name: "tickets" }] };
const tpl = (overrides: Record<string, unknown> = {}) => ({
  agent: "Support Agent",
  title: "Reply to {{row.subject}}",
  instructions: "Draft a {{input.tone}} reply to the ticket.",
  table: "tickets",
  fields: ["subject", "body"],
  inputs: { tone: { type: "choice", options: ["warm", "formal"] } },
  writes: ["body"],
  ...overrides,
});
const manifest = (tasks: Record<string, unknown>) => ({ ...base, tasks });
const bad = (overrides: Record<string, unknown>, message = "invalid") =>
  expect(() => validateAppManifest(manifest({ reply: tpl(overrides) }))).toThrow(message);
/** A template with no placeholders, so a test about one part is not tripped by another. */
const plain = { title: "T", instructions: "I", writes: [], inputs: {} };

describe("task templates in the manifest", () => {
  it("normalises a full template", () => {
    expect(validateAppManifest(manifest({ reply: tpl() })).tasks).toEqual({
      reply: {
        agent: "Support Agent", title: "Reply to {{row.subject}}", instructions: "Draft a {{input.tone}} reply to the ticket.",
        table: "tickets", fields: ["subject", "body"], inputs: { tone: { type: "choice", options: ["warm", "formal"] } }, writes: ["body"],
      },
    });
  });

  it("fills defaults for a template with no table, inputs or writes", () => {
    const m = validateAppManifest(manifest({ note: { agent: "A", title: "T", instructions: "Do it." } }));
    expect(m.tasks).toEqual({ note: { agent: "A", title: "T", instructions: "Do it.", table: null, fields: [], inputs: {}, writes: [] } });
  });

  it("leaves a manifest without templates exactly as before", () => {
    expect(validateAppManifest(base)).not.toHaveProperty("tasks");
    expect(validateAppManifest({ ...base, tasks: {} })).not.toHaveProperty("tasks");
  });

  it("keeps the key order as given and defaults number bounds to null, text maxLength to 200", () => {
    const m = validateAppManifest(manifest({
      b: tpl({ ...plain, inputs: { n: { type: "number" }, t: { type: "text" }, r: { type: "number", min: 1, max: 5 } } }),
      a: tpl(plain),
    }));
    expect(Object.keys(m.tasks!)).toEqual(["b", "a"]);
    expect(m.tasks!.b!.inputs).toEqual({
      n: { type: "number", min: null, max: null }, t: { type: "text", maxLength: 200 }, r: { type: "number", min: 1, max: 5 },
    });
  });

  it("takes at most ten templates, with keys like ^[a-z][a-z0-9_]{0,39}$", () => {
    const t = { agent: "A", title: "T", instructions: "I" };
    expect(() => validateAppManifest(manifest(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`t${i}`, t]))))).toThrow("invalid");
    expect(validateAppManifest(manifest(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, t])))).tasks).toBeDefined();
    expect(() => validateAppManifest(manifest({ Reply: t }))).toThrow("invalid");
    expect(() => validateAppManifest(manifest({ "1a": t }))).toThrow("invalid");
    expect(() => validateAppManifest(manifest({ [`a${"b".repeat(40)}`]: t }))).toThrow("invalid");
  });

  it("refuses unknown keys inside a template or an input", () => {
    bad({ priority: "high" });
    bad({ ...plain, inputs: { tone: { type: "text", extra: 1 } } });
  });

  it("bounds the agent, title and instructions", () => {
    bad({ agent: "" });
    bad({ agent: "a".repeat(121) });
    bad({ title: "" });
    bad({ title: "t".repeat(201) });
    bad({ instructions: "" });
    bad({ instructions: "i".repeat(4001) });
  });

  it("needs a declared table, and fields only with a table", () => {
    bad({ ...plain, table: "orders" }, 'uses table "orders", which the manifest does not declare');
    bad({ ...plain, table: undefined }, "fields");
    bad({ ...plain, fields: undefined }, "fields");
  });

  it("checks the fields: identifiers, no repeats, 1 to 20", () => {
    bad({ ...plain, fields: ["subject", "subject"] }, "twice");
    bad({ ...plain, fields: ["Subject"] });
    bad({ ...plain, fields: ["id"] }, "system column");
    bad({ ...plain, fields: [] });
    bad({ ...plain, fields: Array.from({ length: 21 }, (_, i) => `f${i}`) });
  });

  it("checks the inputs", () => {
    const sixInputs = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`i${i}`, { type: "text" }]));
    bad({ ...plain, inputs: sixInputs }, "at most 5 inputs");
    bad({ ...plain, inputs: { Tone: { type: "text" } } });
    bad({ ...plain, inputs: { tone: { type: "choice", options: [] } } });
    bad({ ...plain, inputs: { tone: { type: "choice", options: Array.from({ length: 21 }, (_, i) => `o${i}`) } } });
    bad({ ...plain, inputs: { tone: { type: "choice", options: ["x".repeat(101)] } } });
    bad({ ...plain, inputs: { tone: { type: "number", min: 5, max: 1 } } }, "min");
    bad({ ...plain, inputs: { tone: { type: "text", maxLength: 201 } } });
    bad({ ...plain, inputs: { tone: { type: "text", maxLength: 0 } } });
    bad({ ...plain, inputs: { tone: { type: "date" } } });
  });

  it("checks writes: a table, a subset of fields, no repeats", () => {
    bad({ ...plain, writes: ["status"] }, "writes");
    bad({ ...plain, writes: ["body", "body"] }, "twice");
    bad({ ...plain, table: undefined, fields: undefined, writes: ["body"] }, "writes");
  });

  it("accepts row and input placeholders, with or without inner whitespace", () => {
    expect(validateAppManifest(manifest({ reply: tpl({ title: "{{ row.subject }}", instructions: "{{ input.tone }} {{row.body}}" }) })).tasks).toBeDefined();
  });

  it("refuses placeholders that name no field or input, in the title or the instructions", () => {
    bad({ title: "{{row.priority}}" }, 'unknown placeholder {{row.priority}} in task "reply" title');
    bad({ instructions: "{{row.priority}}" }, 'in task "reply" instructions');
    bad({ title: "{{input.mood}}" }, "unknown placeholder");
    bad({ title: "{{foo}}" }, 'unknown placeholder {{foo}} in task "reply" title');
    bad({ title: "{{ row.x.y }}" }, "unknown placeholder");
    bad({ title: "{{}}" }, "unknown placeholder");
  });

  it("refuses a row placeholder when the template has no table", () => {
    expect(() => validateAppManifest(manifest({ note: { agent: "A", title: "{{row.subject}}", instructions: "I" } }))).toThrow("unknown placeholder");
  });
});

describe("placeholdersIn", () => {
  it("classifies every {{…}}", () => {
    expect(placeholdersIn("a {{row.x}} b {{ input.y }} c {{z}} d {{row.a.b}}")).toEqual([
      { kind: "row", name: "x", raw: "{{row.x}}" },
      { kind: "input", name: "y", raw: "{{ input.y }}" },
      { kind: "other", name: "z", raw: "{{z}}" },
      { kind: "other", name: "row.a.b", raw: "{{row.a.b}}" },
    ]);
    expect(placeholdersIn("none here")).toEqual([]);
  });
});

describe("templateChanges and taskTemplatesChanged", () => {
  const current = validateAppManifest(manifest({ reply: tpl() }));
  const next = (t: Record<string, unknown>) => validateAppManifest(manifest(t));

  it("marks every template as added against a null current", () => {
    expect(templateChanges(null, current)).toEqual([{ key: "reply", added: true, changed: false }]);
    expect(taskTemplatesChanged(null, current)).toBe(true);
  });
  it("is false for an unchanged set and when the target declares none", () => {
    expect(templateChanges(current, current)).toEqual([{ key: "reply", added: false, changed: false }]);
    expect(taskTemplatesChanged(current, current)).toBe(false);
    expect(taskTemplatesChanged(null, validateAppManifest(base))).toBe(false);
    expect(templateChanges(null, validateAppManifest(base))).toEqual([]);
  });
  it("counts an added template", () => {
    const t = next({ reply: tpl(), other: tpl() });
    expect(templateChanges(current, t)).toEqual([
      { key: "reply", added: false, changed: false }, { key: "other", added: true, changed: false },
    ]);
    expect(taskTemplatesChanged(current, t)).toBe(true);
  });
  it("counts changed instructions or a changed agent", () => {
    expect(templateChanges(current, next({ reply: tpl({ instructions: "Ignore the ticket." }) }))).toEqual([{ key: "reply", added: false, changed: true }]);
    expect(taskTemplatesChanged(current, next({ reply: tpl({ instructions: "Ignore the ticket." }) }))).toBe(true);
    expect(taskTemplatesChanged(current, next({ reply: tpl({ agent: "Other Agent" }) }))).toBe(true);
  });
  it("does not count the same inputs written in a different key order", () => {
    const a = next({ reply: tpl({ inputs: { tone: { type: "text", maxLength: 50 } }, instructions: "{{input.tone}}" }) });
    const b = next({ reply: tpl({ inputs: { tone: { maxLength: 50, type: "text" } }, instructions: "{{input.tone}}" }) });
    expect(taskTemplatesChanged(a, b)).toBe(false);
  });
  it("never counts a removal", () => {
    const two = next({ reply: tpl(), other: tpl() });
    expect(taskTemplatesChanged(two, current)).toBe(false);
    expect(taskTemplatesChanged(two, validateAppManifest(base))).toBe(false);
  });
});
