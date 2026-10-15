import { getPolicySettings, refreshFreeModels, setPolicySettings, type PolicySettings } from "./automatic-provider";
import { clampNumber, errorText, numberField, sectionShell, toggleRow, withBusy, type MakeButton } from "./settings-controls";

type CountResult = { Ok: number } | { Err: string };

export function describeModelRefresh(result: { openrouter?: CountResult; gemini?: CountResult } | null): string {
  const part = (label: string, value: CountResult | undefined): string => {
    if (!value) {
      return `${label}: -`;
    }
    if ("Ok" in value) {
      return value.Ok > 0 ? `${label} ${value.Ok}개` : `${label}: 키 없음`;
    }
    return `${label}: 실패`;
  };
  return `무료 모델 목록 · ${part("OpenRouter", result?.openrouter)} · ${part("Gemini", result?.gemini)}`;
}

export function createPolicySection(
  makeButton: MakeButton,
  setMessage: (text: string) => void
): { section: HTMLElement; refresh: () => Promise<void> } {
  const { section } = sectionShell("비용 · 승인");
  const openrouter = toggleRow("OpenRouter 무료 모델 사용", "Gemini 다음 순서로 가격이 0인 모델만 씁니다.");
  const cache = toggleRow("같은 질문은 캐시 재사용", "관련 파일이 바뀌면 캐시는 자동으로 무효화됩니다.");
  const sessionCalls = numberField("작업당 최대 호출", { min: 1, max: 500 });
  const retries = numberField("호출당 재시도", { min: 0, max: 6 });
  const paidCalls = numberField("유료 승인 1회당 호출", {
    min: 1,
    max: 100,
    tooltip: "유료 API는 승인 창에서 허락한 뒤에만 호출합니다.",
  });
  const paidMinutes = numberField("유료 승인 유지(분)", { min: 1, max: 1440 });

  const actions = document.createElement("div");
  actions.className = "ai-settings-ghost-row";
  const saveButton = makeButton("저장", "ai-settings-action");
  const refreshModelsButton = makeButton("무료 모델 목록 새로고침", "ai-settings-ghost");
  actions.append(saveButton, refreshModelsButton);
  section.append(
    openrouter.root,
    cache.root,
    sessionCalls.root,
    retries.root,
    paidCalls.root,
    paidMinutes.root,
    actions
  );

  let current: PolicySettings | null = null;

  const render = (value: PolicySettings): void => {
    current = value;
    openrouter.input.checked = value.openrouterEnabled;
    cache.input.checked = value.promptCacheEnabled;
    sessionCalls.input.value = String(value.maxCallsPerSession);
    retries.input.value = String(value.maxRetriesPerCall);
    paidCalls.input.value = String(value.paidMaxCallsPerApproval);
    paidMinutes.input.value = String(value.paidApprovalMinutes);
  };

  const refresh = async (): Promise<void> => {
    render(await getPolicySettings());
  };

  saveButton.addEventListener("click", () => {
    void withBusy([saveButton], async () => {
      if (!current) {
        setMessage("설정을 아직 불러오지 못해 다시 불러옵니다. 확인 후 저장하세요.");
        await refresh().catch((error) => setMessage(`비용·승인 설정을 불러오지 못했습니다: ${errorText(error)}`));
        return;
      }
      try {
        render(
          await setPolicySettings({
            ...current,
            openrouterEnabled: openrouter.input.checked,
            promptCacheEnabled: cache.input.checked,
            maxCallsPerSession: clampNumber(sessionCalls.input.value, 1, 500, current.maxCallsPerSession),
            maxRetriesPerCall: clampNumber(retries.input.value, 0, 6, current.maxRetriesPerCall),
            paidMaxCallsPerApproval: clampNumber(paidCalls.input.value, 1, 100, current.paidMaxCallsPerApproval),
            paidApprovalMinutes: clampNumber(paidMinutes.input.value, 1, 1440, current.paidApprovalMinutes),
          })
        );
        setMessage("비용·승인 설정을 저장했습니다.");
      } catch (error) {
        setMessage(`비용·승인 설정 저장 실패: ${errorText(error)}`);
      }
    });
  });

  refreshModelsButton.addEventListener("click", () => {
    void (async () => {
      refreshModelsButton.disabled = true;
      setMessage("무료 모델 목록을 받는 중…");
      try {
        setMessage(describeModelRefresh((await refreshFreeModels(true)) as never));
      } catch (error) {
        setMessage(`무료 모델 목록 새로고침 실패: ${errorText(error)}`);
      } finally {
        refreshModelsButton.disabled = false;
      }
    })();
  });

  return { section, refresh };
}
