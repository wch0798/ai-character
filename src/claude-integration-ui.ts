import { invoke } from "@tauri-apps/api/core";
import { errorText, sectionShell, toggleRow, withBusy, type MakeButton } from "./settings-controls";

export type ClaudeIntegrationSettings = {
  claudeMd: boolean;
  skills: boolean;
  subagents: boolean;
  hooks: boolean;
  mcp: boolean;
  mcpPlaywright: boolean;
  mcpGithub: boolean;
  jsonOutput: boolean;
};

type ClaudeIntegrationStatus = {
  settings: ClaudeIntegrationSettings;
  playwrightAvailable: boolean;
  githubTokenPresent: boolean;
  mcpList: string;
};

type PluginUpdateReport = {
  marketplacesUpdated: boolean;
  updated: string[];
  failed: Array<[string, string]>;
};

type FeatureKey = keyof ClaudeIntegrationSettings;

/** `mcp` is derived from the individual servers and `jsonOutput` must stay on for usage tracking. */
export const CLAUDE_FEATURES: Array<{ key: FeatureKey; label: string; help: string; hidden?: boolean }> = [
  { key: "claudeMd", label: "작업 규칙 안내 (CLAUDE.md)", help: "작업 규칙과 자동으로 찾은 테스트 명령을 알려 줍니다." },
  { key: "skills", label: "작업 순서 안내 (검토 · 테스트 · 보고)", help: "검토, 테스트, 보고서 작성 순서를 스킬로 제공합니다." },
  { key: "subagents", label: "도우미 AI (검토 · 테스트 · 문서 담당)", help: "필요할 때 검토·테스트·문서 담당을 따로 부릅니다." },
  { key: "hooks", label: "자동 검사 (수정 후 검사 · 끝날 때 테스트)", help: "파일을 고친 뒤 형식 검사를, 작업이 끝날 때 테스트를 자동으로 실행합니다. 작업 폴더 보호와 위험 명령 차단은 이 설정과 상관없이 항상 켜져 있습니다." },
  { key: "mcpPlaywright", label: "브라우저 조작 연결 (Playwright)", help: "Claude가 웹 페이지를 열어 확인할 수 있게 합니다. Node.js가 필요합니다." },
  { key: "mcpGithub", label: "GitHub 연결", help: "GitHub 토큰(GITHUB_TOKEN)이 있을 때만 연결합니다. 이 연결을 켠 동안에만 Claude가 토큰을 쓸 수 있습니다." },
  { key: "mcp", label: "MCP", help: "", hidden: true },
  { key: "jsonOutput", label: "사용량 기록", help: "", hidden: true },
];

export function describePluginUpdate(report: PluginUpdateReport): string {
  const parts = [report.marketplacesUpdated ? "마켓 목록 갱신" : "마켓 목록 갱신 실패"];
  parts.push(`업데이트 ${report.updated.length}개`);
  if (report.failed.length > 0) {
    parts.push(`실패 ${report.failed.length}개(이전 버전 유지): ${report.failed.map(([id]) => id).join(", ")}`);
  }
  return parts.join(" · ");
}

export function withDerivedFlags(value: ClaudeIntegrationSettings): ClaudeIntegrationSettings {
  return { ...value, mcp: value.mcpPlaywright || value.mcpGithub, jsonOutput: true };
}

export function createClaudeIntegrationSection(
  makeButton: MakeButton,
  setMessage: (text: string) => void
): { section: HTMLElement; refresh: () => Promise<void> } {
  const { section } = sectionShell("Claude 기능");
  const lead = document.createElement("div");
  lead.className = "ai-settings-help";
  lead.textContent = "파일을 고칠 때 같이 켜지는 도구입니다. 대화와 정보 조사는 이 기능을 쓰지 않습니다.";
  section.append(lead);
  const inputs = new Map<FeatureKey, HTMLInputElement>();
  for (const feature of CLAUDE_FEATURES.filter((item) => !item.hidden)) {
    const { root, input } = toggleRow(feature.label, feature.help);
    inputs.set(feature.key, input);
    section.append(root);
  }

  const actions = document.createElement("div");
  actions.className = "ai-settings-ghost-row";
  const saveButton = makeButton("저장", "ai-settings-action");
  const statusButton = makeButton("연결 상태 확인", "ai-settings-ghost");
  actions.append(saveButton, statusButton);
  const status = document.createElement("div");
  status.className = "ai-settings-help";
  status.hidden = true;
  section.append(actions, status);

  let current: ClaudeIntegrationSettings | null = null;

  const render = (value: ClaudeIntegrationSettings): void => {
    current = value;
    for (const [key, input] of inputs) {
      input.checked = value[key];
    }
  };

  const readSettings = (): ClaudeIntegrationSettings => {
    const value = { ...(current as ClaudeIntegrationSettings) };
    for (const [key, input] of inputs) {
      value[key] = input.checked;
    }
    return withDerivedFlags(value);
  };

  const refresh = async (): Promise<void> => {
    render(await invoke<ClaudeIntegrationSettings>("get_claude_integration_settings"));
  };

  saveButton.addEventListener("click", () => {
    void withBusy([saveButton], async () => {
      try {
        if (!current) {
          setMessage("설정을 아직 불러오지 못해 다시 불러옵니다. 확인 후 저장하세요.");
          await refresh();
          return;
        }
        render(await invoke<ClaudeIntegrationSettings>("set_claude_integration_settings", { value: readSettings() }));
        setMessage("Claude 기능 설정을 저장했습니다. 다음 실행부터 적용됩니다.");
      } catch (error) {
        setMessage(`Claude 기능 저장 실패: ${errorText(error)}`);
      }
    });
  });

  statusButton.addEventListener("click", () => {
    void withBusy([statusButton], async () => {
      status.hidden = false;
      status.textContent = "연결 상태를 확인하는 중…";
      try {
        const result = await invoke<ClaudeIntegrationStatus>("get_claude_integration_status");
        const servers = result.mcpList.trim() ? result.mcpList.trim().split("\n").length : 0;
        status.textContent = [
          result.playwrightAvailable ? "Playwright 준비됨" : "Playwright: Node.js 필요",
          result.githubTokenPresent ? "GitHub 토큰 있음" : "GitHub 토큰 없음",
          `등록된 연결 ${servers}개`,
        ].join(" · ");
        status.title = result.mcpList;
      } catch (error) {
        status.textContent = `상태 확인 실패: ${errorText(error)}`;
      }
    });
  });

  return { section, refresh };
}

export async function updateClaudePlugins(): Promise<string> {
  return describePluginUpdate(await invoke<PluginUpdateReport>("update_claude_plugins"));
}
