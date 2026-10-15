import { getAlertSettings, setAlertSettings, type AlertSettings } from "./alerts-client";
import { clampNumber, errorText, numberField, sectionShell, toggleRow } from "./settings-controls";

/** Dollar limits keep cents; anything unparsable falls back to the previous value. */
export function parseCostLimit(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(10_000, Math.max(0, Math.round(parsed * 100) / 100));
}

export function createAlertsSection(setMessage: (text: string) => void): { section: HTMLElement; refresh: () => Promise<void> } {
  const { section } = sectionShell("알림·사용량 경고");
  const desktop = toggleRow(
    "데스크톱 알림",
    "20초 넘게 걸린 답변이 끝났을 때(다른 창을 보고 있을 때만), 웹 응답이 필요할 때, 예약 작업 실패·승인 필요, 새 버전 준비, 사용량 경고를 OS 알림으로 알려 줍니다."
  );
  const cost = numberField("하루 유료 한도($)", {
    min: 0,
    max: 10_000,
    step: 0.1,
    tooltip: "오늘 유료 API 사용액이 이 금액의 80%를 넘으면 경고, 넘으면 한도 도달 알림을 보냅니다. 0이면 끕니다.",
  });
  const calls = numberField("하루 호출 경고(회)", {
    min: 0,
    max: 1_000_000,
    tooltip: "오늘 AI 호출 수가 이 값을 넘으면 경고합니다. 0이면 끕니다.",
  });
  const block = toggleRow(
    "한도 도달 시 유료 호출 막기",
    "오늘 유료 사용액이 하루 한도에 닿으면 그날은 유료 API를 호출하지 않고 무료 경로로 넘깁니다. 승인을 받아 둔 호출도 막습니다."
  );
  section.append(desktop.root, cost.root, block.root, calls.root);

  let current: AlertSettings = { desktop: true, dailyCostLimitUsd: 1, dailyCallWarn: 300, blockPaidOverLimit: true };
  const paint = (value: AlertSettings) => {
    current = value;
    desktop.input.checked = value.desktop;
    block.input.checked = value.blockPaidOverLimit;
    cost.input.value = String(value.dailyCostLimitUsd);
    calls.input.value = String(value.dailyCallWarn);
  };

  const save = async (next: AlertSettings) => {
    const controls = [desktop.input, cost.input, block.input, calls.input];
    controls.forEach((control) => (control.disabled = true));
    try {
      paint(await setAlertSettings(next));
      setMessage("알림 설정을 저장했습니다.");
    } catch (error) {
      paint(current);
      setMessage(`알림 설정 저장 실패: ${errorText(error)}`);
    } finally {
      controls.forEach((control) => (control.disabled = false));
    }
  };

  desktop.input.addEventListener("change", () => void save({ ...current, desktop: desktop.input.checked }));
  block.input.addEventListener("change", () => void save({ ...current, blockPaidOverLimit: block.input.checked }));
  cost.input.addEventListener("change", () =>
    void save({ ...current, dailyCostLimitUsd: parseCostLimit(cost.input.value, current.dailyCostLimitUsd) })
  );
  calls.input.addEventListener("change", () =>
    void save({ ...current, dailyCallWarn: clampNumber(calls.input.value, 0, 1_000_000, current.dailyCallWarn) })
  );

  return {
    section,
    refresh: async () => paint(await getAlertSettings()),
  };
}
