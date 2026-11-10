import { describe, expect, it } from "vitest";
import { findCoreAction } from "../src/guidance/lifecycle.ts";
import type { LearnedAction } from "../src/learn/learner.ts";

const save = (id: string, method: string, path: string, triggers: [string, number][]): LearnedAction => ({
  id, label: id, method, path, seen: triggers.reduce((n, [, c]) => n + c, 0), firstSeen: 1, lastSeen: 1, statuses: { "2xx": 10 },
  fields: {}, triggers: triggers.map(([label, count]) => ({ type: "click" as const, label, count })), triggerPages: {}, review: "suggested",
});

describe("main action", () => {
  it("picks what people come to make, not a tag chip, an editor button or a background sync (how a tracker's traffic looks)", () => {
    const core = findCoreAction([
      // Toggling tags on a job: user-made chips and one-letter editor buttons.
      save("job.update", "PATCH", "/rest/v1/jobs", [["Phase 1:1", 7], ["B", 6], ["VIP", 5], ["D", 4], ["Urgent", 4], ["Not urgent", 3], ["No label", 2], ["Neither", 2]]),
      // Saved after whatever was clicked: a background sync.
      save("account.update", "PATCH", "/rest/v1/accounts", [["Accounts", 4], ["Sign in with Xero", 2], ["Jobs", 2], ["Previous month", 1], ["Settings", 1], ["Reconnect", 1]]),
      save("job.create", "POST", "/rest/v1/jobs", [["Save job", 5], ["Import 8 jobs", 1], ["Import 1 job", 1]]),
      save("insight_tag.delete", "DELETE", "/rest/v1/insight_tags", [["Delete the tag", 9]]),
    ]);
    expect(core?.action.id).toBe("job.create");
    expect(core?.reason).toContain('"Save job" pressed 7 times');
    expect(core?.reason).toContain("creates something");
  });

  it("with a few presses, making something beats changing it, as in a learner's run (how a task list looks to one)", () => {
    const core = findCoreAction([
      save("task.update", "PATCH", "/api/tasks/:id", [["Mark done", 3]]),
      save("project.create", "POST", "/api/projects", [["New project", 1]]),
    ]);
    expect(core?.action.id).toBe("project.create");
  });

  it("never picks looking after the system, however often it was pressed", () => {
    const core = findCoreAction([save("db.create", "POST", "/db.htm", [["INITIALIZE", 9]]), save("contact.create", "POST", "/contact.htm", [["Send", 1]])].map((a) => ({ ...a, uiLabel: a.triggers[0]!.label })));
    expect(core?.action.id).toBe("contact.create");
  });

  it("a save behind a button is a candidate whatever its address says", () => {
    expect(findCoreAction([save("check_in.create", "POST", "/check-in", [["Check in", 1]]), save("get_started.create", "POST", "/get-started", [["Get started", 2]])])?.action.id).toBe("get_started.create");
  });

  it("still picks an edit when editing is what the product is for", () => {
    const core = findCoreAction([
      save("document.update", "PATCH", "/api/documents/:id", [["Save changes", 30]]),
      save("comment.create", "POST", "/api/comments", [["Comment", 4]]),
    ]);
    expect(core?.action.id).toBe("document.update");
  });
});
