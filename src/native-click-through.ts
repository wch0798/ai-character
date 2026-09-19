import { invoke } from "@tauri-apps/api/core";

export type HitRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function toScreenRegion(
  originX: number,
  originY: number,
  scale: number,
  box: HitRegion
): HitRegion {
  const factor = scale > 0 ? scale : 1;
  return {
    x: Math.round(originX + box.x * factor),
    y: Math.round(originY + box.y * factor),
    width: Math.round(box.width * factor),
    height: Math.round(box.height * factor),
  };
}

export async function setClickThroughRegions(
  regions: HitRegion[],
  capture: boolean
): Promise<void> {
  await invoke("set_click_through_regions", { regions, capture });
}

export async function setClickThroughCapture(capture: boolean): Promise<void> {
  await invoke("set_click_through_capture", { capture });
}

export async function getScreenCursor(): Promise<{ x: number; y: number }> {
  const pair = await invoke<number[]>("get_screen_cursor");
  return { x: pair[0] ?? 0, y: pair[1] ?? 0 };
}
