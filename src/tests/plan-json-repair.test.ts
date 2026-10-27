import { describe, expect, it } from "vitest";
import { parseOrchestrationPlan, repairJsonText } from "../orchestration-plan";

const task = '{ "id": "t1", "title": "t", "target": "claude", "mode": "modify", "prompt": "p, // not a comment }", "dependsOn": [], }';

describe("planner JSON with common slips still parses", () => {
  it("drops trailing commas and comments but keeps string contents", () => {
    const raw = `Here is the plan:\n{\n  // tasks below\n  "summary": "s",\n  "tasks": [${task},],\n}\nDone.`;
    expect(JSON.parse(repairJsonText(raw))).toEqual({
      summary: "s",
      tasks: [{ id: "t1", title: "t", target: "claude", mode: "modify", prompt: "p, // not a comment }", dependsOn: [] }],
    });
    expect(parseOrchestrationPlan(raw).tasks[0].prompt).toBe("p, // not a comment }");
  });

  it("still reports JSON it cannot mend", () => {
    expect(() => parseOrchestrationPlan("{ summary: 's' }")).toThrow(/JSON parse failed/);
  });
});
