import { describe, expect, it } from "vitest";
import { applyRules, END_MARKER, HANDOFFS_SECTION, removeRules, RULES_BLOCK, rulesBlock } from "../src/agent-rules/block.js";

/** The core's default AGENTS.md (server/src/onboarding-assets/default, 2026.916.1), as the rebrand leaves it, abridged. */
const CORE_DEFAULT = [
  "You are an agent at KyoubeAI company.",
  "",
  "## Execution Contract",
  "",
  "- Start actionable work in the same heartbeat.",
  "- Keep the work moving until it is done. If you need QA to review it, ask them. If you need your boss to review it, ask them.",
  "",
  "Do not let work sit here. You must always update your task with a comment.",
  "",
].join("\n");

function changed(content: string): string {
  const edit = applyRules(content);
  if (edit.kind !== "changed") throw new Error(`expected a change, got ${edit.kind}`);
  return edit.content;
}

describe("applyRules", () => {
  it("puts the block first, drops the core's handoff sentences and adds a Handoffs section", () => {
    const next = changed(CORE_DEFAULT);
    expect(next.startsWith(`${RULES_BLOCK}\n\nYou are an agent at KyoubeAI company.`)).toBe(true);
    expect(next).toContain("- Keep the work moving until it is done.\n");
    expect(next).not.toContain("If you need QA to review it");
    expect(next.endsWith(`\n\n${HANDOFFS_SECTION}`)).toBe(true);
  });

  it("is a no-op on its own output", () => {
    expect(applyRules(changed(CORE_DEFAULT))).toEqual({ kind: "unchanged" });
  });

  it("replaces an outdated or edited block and leaves everything around it byte for byte", () => {
    const old = `Intro\n<!-- kyoube:working-rules v0 old -->\nold text\n${END_MARKER}\nOutro\n\n## Handoffs\n\nQA reviews code.\n`;
    expect(changed(old)).toBe(`Intro\n${RULES_BLOCK}\nOutro\n\n## Handoffs\n\nQA reviews code.\n`);
  });

  it("keeps YAML frontmatter first", () => {
    const withFrontmatter = "---\nname: CTO\nreportsTo: ceo\n---\nYou are the CTO.\n\n## Handoffs\n\nNone.\n";
    expect(changed(withFrontmatter)).toBe(`---\nname: CTO\nreportsTo: ceo\n---\n${RULES_BLOCK}\n\nYou are the CTO.\n\n## Handoffs\n\nNone.\n`);
  });

  it("writes Windows line endings into a CRLF file and is stable on it", () => {
    const crlf = "You are an agent.\r\n\r\n## Handoffs\r\n\r\nNone.\r\n";
    const next = changed(crlf);
    expect(next.startsWith(`${RULES_BLOCK.replaceAll("\n", "\r\n")}\r\n\r\nYou are an agent.`)).toBe(true);
    expect(next.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect(applyRules(next)).toEqual({ kind: "unchanged" });
  });

  it("refuses to guess about incomplete or repeated markers", () => {
    expect(applyRules("<!-- kyoube:working-rules v1. x -->\nno end\n").kind).toBe("corrupt");
    expect(applyRules(`${RULES_BLOCK}\n${RULES_BLOCK}\n`).kind).toBe("corrupt");
    expect(applyRules(`${END_MARKER}\n<!-- kyoube:working-rules v1. x -->\n`).kind).toBe("corrupt");
    expect(applyRules(`${END_MARKER}<!-- kyoube:working-rules v1. x -->\n`).kind).toBe("corrupt");
  });

  it("leaves reworded handoff text and an existing Handoffs section alone", () => {
    const custom = "If you need QA to review it, ask the QA agent.\n\n## Handoffs\n\nQA Agent tests every change.\n";
    const next = changed(custom);
    expect(next).toContain("If you need QA to review it, ask the QA agent.");
    expect(next.match(/^## Handoffs$/gm)?.length).toBe(1);
  });

  it("handles an empty file", () => {
    expect(changed("")).toBe(`${RULES_BLOCK}\n\n${HANDOFFS_SECTION}`);
  });

  it("trims a long run of whitespace in linear time", () => {
    const spaces = " ".repeat(50_000);
    const started = performance.now();
    // Only spaces: the run is trailing and goes.
    expect(changed(spaces)).toBe(`${RULES_BLOCK}\n\n${HANDOFFS_SECTION}`);
    // A word after the run: a backtracking /\s*$/ retries the run from each of its positions.
    expect(changed(`${spaces}x`)).toBe(`${RULES_BLOCK}\n\n${spaces}x\n\n${HANDOFFS_SECTION}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("removeRules", () => {
  it("removes the block and the blank line after it, and nothing else", () => {
    const original = "You are an agent.\n\n## Handoffs\n\nNone.\n";
    expect(removeRules(changed(original))).toEqual({ kind: "changed", content: original });
  });

  it("is a no-op without a block", () => {
    expect(removeRules("You are an agent.\n")).toEqual({ kind: "unchanged" });
  });

  it("refuses to guess about incomplete markers", () => {
    expect(removeRules("<!-- kyoube:working-rules v1. x -->\n").kind).toBe("corrupt");
  });

  it("refuses an end marker right before the start marker", () => {
    expect(removeRules(`${END_MARKER}<!-- kyoube:working-rules v1. x -->\n`).kind).toBe("corrupt");
  });
});

describe("the v2 block", () => {
  it("is v2, has seven rules, and line is the default", () => {
    expect(RULES_BLOCK).toBe(rulesBlock("line"));
    expect(RULES_BLOCK.startsWith("<!-- kyoube:working-rules v2. ")).toBe(true);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(RULES_BLOCK).toMatch(new RegExp(`^${n}\\. \\*\\*`, "m"));
    expect(RULES_BLOCK).not.toMatch(/^8\. /m);
    expect(RULES_BLOCK).toContain("3. **Stuck? Ask one agent, only as a last resort.**");
    expect(RULES_BLOCK).toContain("4. **Out of your scope? Ask before escalating.** If the work itself is outside your scope,");
    expect(RULES_BLOCK).toContain("or rule 5 allows it.");
    expect(RULES_BLOCK).toContain("7. **When an agent asks you a question,** answer it in the card and do nothing else.");
    expect(RULES_BLOCK.endsWith(END_MARKER)).toBe(true);
  });

  it("tells the asker to end its run, and the agent asked to answer without checking out the task", () => {
    const rule3 = [
      "3. **Stuck? Ask one agent, only as a last resort.** First try everything you can yourself.",
      "   If you are still missing one specific answer that another agent has, and your ask level",
      "   allows it, send that agent one `ask_user_questions` card addressed to it",
      "   (`addresseeAgentId`, `continuationPolicy: \"wake_assignee\"`, and `allowOther: true` on",
      "   each question so it can answer in its own words). Say what you tried and exactly what",
      "   you need. Keep the task assigned to yourself, set it to `in_review` and end your run;",
      "   the answer wakes you. One open question per task and three per task in all; the core",
      "   refuses more.",
    ].join("\n");
    const rule7 = [
      "7. **When an agent asks you a question,** answer it in the card and do nothing else.",
      "   Don't check out the task: answer in the run that woke you, with",
      "   `POST /api/issues/{issueId}/interactions/{interactionId}/respond`. Don't take, reassign,",
      "   split or work on its task, and don't create tasks for it. Don't pass the question on:",
      "   if you can't answer, say so in the card.",
    ].join("\n");
    for (const level of ["none", "line", "any"] as const) {
      const block = rulesBlock(level);
      expect(block).toContain(`${rule3}\n   Your ask level: `);
      expect(block).toContain(`${rule7}\n${END_MARKER}`);
    }
  });

  it("differs between levels only in the level line", () => {
    expect(rulesBlock("none")).toContain("   Your ask level: **no agents**. Don't ask other agents; use rule 4.");
    expect(rulesBlock("line")).toContain("   Your ask level: **your line**: the managers above you (your `chainOfCommand`)\n   and the agents below you.");
    expect(rulesBlock("any")).toContain("   Your ask level: **any agent** in the company.");
    const strip = (block: string) => block.split("\n").filter((line) => !line.includes("Your ask level") && line !== "   and the agents below you.").join("\n");
    expect(strip(rulesBlock("none"))).toBe(strip(rulesBlock("line")));
    expect(strip(rulesBlock("any"))).toBe(strip(rulesBlock("line")));
  });

  it("replaces a v1 block, and rewrites the block when the level changes", () => {
    const v1 = `<!-- kyoube:working-rules v1. Managed by KyoubeAI; changes inside this block are replaced. -->\nold\n${END_MARKER}\n\nYou are an agent.\n\n## Handoffs\n\nNone.\n`;
    const once = changed(v1);
    expect(once.startsWith(`${rulesBlock("line")}\n\nYou are an agent.`)).toBe(true);
    const none = applyRules(once, "none");
    expect(none.kind).toBe("changed");
    if (none.kind !== "changed") return;
    expect(none.content.startsWith(rulesBlock("none"))).toBe(true);
    expect(applyRules(none.content, "none")).toEqual({ kind: "unchanged" });
  });
});
