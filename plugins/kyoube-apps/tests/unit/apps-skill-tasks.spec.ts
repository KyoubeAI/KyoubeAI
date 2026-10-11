import { describe, expect, it } from "vitest";
import manifest, { APPS_SKILL_KEY, DATA_SKILL_KEY } from "../../src/manifest.js";

describe("kyoube-apps skill for tasks", () => {
  const apps = manifest.skills!.find((skill) => skill.skillKey === APPS_SKILL_KEY)!.markdown;
  const data = manifest.skills!.find((skill) => skill.skillKey === DATA_SKILL_KEY)!.markdown;

  it("teaches the template shape, the calls, the publish rule and the limits", () => {
    for (const phrase of [
      "Tasks: handing work to an agent", "kyoube.tasks.start", "kyoube.tasks.watch", "kyoube.tasks.cancel", "kyoube.tasks.open",
      "tasksConfirmed", "needs a person to publish", "writes", "{{row.", "{{input.", "as data",
      "10 templates", "4,000", "20 fields", "5 inputs", "200 characters", "runMayContinue", "textContent", "ask the person which agent",
    ]) {
      expect(apps).toContain(phrase);
    }
  });

  it("describes the calls in prose and lists agents through the core before naming one", () => {
    for (const call of ["kyoube.tasks.start(", "kyoube.tasks.get(", "kyoube.tasks.list(", "kyoube.tasks.cancel(", "kyoube.tasks.open(", "kyoube.tasks.watch("]) {
      expect(apps).toContain(call);
    }
    expect(apps).not.toContain("- Calls:");
    expect(apps).toContain('"$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents"');
    expect(apps).not.toContain("If you\ncannot list the company's agents");
  });

  it("says a paused or refused agent answers disabled instead of leaving the task waiting", () => {
    expect(apps).toContain("paused agent is refused");
    expect(apps).not.toContain("starts once it\n  is resumed");
  });

  it("explains when to use a task instead of a decision or a connection", () => {
    expect(apps).toContain("typed decision");
    expect(apps).toContain("connection");
  });

  it("handles every error code an app can see", () => {
    for (const code of ["forbidden", "invalid", "not_found", "disabled", "limit", "conflict"]) {
      expect(apps).toContain(`\`${code}\``);
    }
  });

  it("teaches the Data skill how to handle a task sent by an app", () => {
    for (const phrase of ["Sent by the app <slug> (version", "as data", "never instructions", "mark it done", "blocked"]) {
      expect(data).toContain(phrase);
    }
  });
});
