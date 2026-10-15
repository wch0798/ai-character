import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

const { CLAUDE_FEATURES, describePluginUpdate, withDerivedFlags } = await import("../claude-integration-ui");

describe("Claude 통합 설정", () => {
  it("Claude 기능을 각각 켜고 끌 수 있다", () => {
    const visible = CLAUDE_FEATURES.filter((feature) => !feature.hidden).map((feature) => feature.key);
    expect(visible).toEqual(["claudeMd", "skills", "subagents", "hooks", "mcpPlaywright", "mcpGithub"]);
  });

  it("MCP 전체 스위치는 개별 서버에서 계산하고 사용량 기록은 항상 켠다", () => {
    const base = {
      claudeMd: true, skills: true, subagents: true, hooks: true,
      mcp: true, mcpPlaywright: false, mcpGithub: false, jsonOutput: false,
    };
    expect(withDerivedFlags(base)).toMatchObject({ mcp: false, jsonOutput: true });
    expect(withDerivedFlags({ ...base, mcpGithub: true }).mcp).toBe(true);
  });

  it("플러그인 업데이트 결과를 실패와 함께 알려 준다", () => {
    const text = describePluginUpdate({
      marketplacesUpdated: true,
      updated: ["a@m", "b@m"],
      failed: [["c@m", "network"]],
    });
    expect(text).toContain("업데이트 2개");
    expect(text).toContain("실패 1개(이전 버전 유지): c@m");
  });
});
