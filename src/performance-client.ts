import {
  invoke,
} from "@tauri-apps/api/core";

type InvokeFunction = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

export type ProcessStats = {
  cpuPercent: number;
  memoryMb: number;
};

export async function readProcessStats(
  invokeFunction: InvokeFunction =
    invoke
): Promise<ProcessStats> {
  const result =
    await invokeFunction(
      "get_process_stats"
    );

  if (
    !Array.isArray(result) ||
    result.length < 2 ||
    typeof result[0] !== "number" ||
    typeof result[1] !== "number"
  ) {
    throw new Error(
      "성능 정보 형식이 올바르지 않습니다."
    );
  }

  return {
    cpuPercent: result[0],
    memoryMb: result[1],
  };
}

export function formatPerformanceText(
  fps: number,
  cpuPercent: number,
  memoryMb: number,
  activityLabel = ""
): string {
  const parts = [
    `FPS ${Math.round(fps)}`,
    `CPU ${cpuPercent.toFixed(1)}%`,
  ];
  if (activityLabel.trim()) {
    parts.push(activityLabel.trim());
  }
  parts.push(`RAM ${Math.round(memoryMb)} MB`);
  return parts.join(" · ");
}
