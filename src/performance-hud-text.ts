export function patchPerformanceHudActivity(
  currentText: string,
  activityLabel: string
): string {
  const parts = currentText
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);

  const fps =
    parts.find((part) => part.startsWith("FPS")) ?? "FPS --";
  const cpu =
    parts.find((part) => part.startsWith("CPU")) ?? "CPU --";
  const ram =
    parts.find((part) => part.startsWith("RAM")) ?? "RAM --";

  return [fps, cpu, activityLabel.trim(), ram]
    .filter(Boolean)
    .join(" · ");
}
