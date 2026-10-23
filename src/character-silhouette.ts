/**
 * Where the character actually is, for click-through. One box around the whole model also
 * covers the empty space beside a small character (hat brim to staff tip), so clicks there
 * opened the chat instead of reaching the window behind. Instead, every visible part of the
 * Live2D model gives its own box; the boxes are snapped to a grid and merged into a few
 * rectangles that follow the character's outline.
 */
export type Box = { x: number; y: number; width: number; height: number };

/** Grid cell in CSS pixels: fine enough to follow the outline, coarse enough to stay stable
 * while the character breathes. */
export const SILHOUETTE_CELL = 12;

/** Covered grid cells → rectangles: runs along each row, then identical runs stacked. */
export function rectsFromBoxes(boxes: Box[], cell = SILHOUETTE_CELL, pad = 4): Box[] {
  const rows = new Map<number, Set<number>>();
  for (const box of boxes) {
    if (!(box.width > 0 && box.height > 0) || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
    const x0 = Math.floor((box.x - pad) / cell);
    const x1 = Math.floor((box.x + box.width + pad) / cell);
    const y0 = Math.floor((box.y - pad) / cell);
    const y1 = Math.floor((box.y + box.height + pad) / cell);
    for (let row = y0; row <= y1; row += 1) {
      const cells = rows.get(row) ?? new Set<number>();
      for (let column = x0; column <= x1; column += 1) cells.add(column);
      rows.set(row, cells);
    }
  }

  // Runs of consecutive cells per row, as "start:end" keys.
  const runsByRow = new Map<number, string[]>();
  for (const [row, cells] of rows) {
    const sorted = [...cells].sort((a, b) => a - b);
    const runs: string[] = [];
    let start = sorted[0];
    for (let index = 1; index <= sorted.length; index += 1) {
      if (index === sorted.length || sorted[index] !== sorted[index - 1] + 1) {
        runs.push(`${start}:${sorted[index - 1]}`);
        start = sorted[index];
      }
    }
    runsByRow.set(row, runs);
  }

  // Stack the same run over consecutive rows into one rectangle.
  const rects: Box[] = [];
  const open = new Map<string, { top: number; bottom: number }>();
  const flush = (key: string, span: { top: number; bottom: number }) => {
    const [start, end] = key.split(":").map(Number);
    rects.push({ x: start * cell, y: span.top * cell, width: (end - start + 1) * cell, height: (span.bottom - span.top + 1) * cell });
  };
  for (const row of [...runsByRow.keys()].sort((a, b) => a - b)) {
    const runs = new Set(runsByRow.get(row));
    for (const [key, span] of open) {
      if (runs.has(key) && span.bottom === row - 1) {
        span.bottom = row;
        runs.delete(key);
      } else {
        flush(key, span);
        open.delete(key);
      }
    }
    for (const key of runs) open.set(key, { top: row, bottom: row });
  }
  for (const [key, span] of open) flush(key, span);
  return rects;
}

/** True when most of the outline lies inside the old whole-model box (a sanity check). */
export function silhouetteFits(rects: Box[], box: Box): boolean {
  if (!rects.length) return false;
  let total = 0;
  let inside = 0;
  for (const rect of rects) {
    total += rect.width * rect.height;
    const width = Math.min(rect.x + rect.width, box.x + box.width) - Math.max(rect.x, box.x);
    const height = Math.min(rect.y + rect.height, box.y + box.height) - Math.max(rect.y, box.y);
    if (width > 0 && height > 0) inside += width * height;
  }
  return total > 0 && inside / total >= 0.6;
}

type Matrix = { apply(point: { x: number; y: number }): { x: number; y: number } };

type Live2DLike = {
  worldTransform?: Matrix;
  internalModel?: {
    localTransform?: Matrix;
    getDrawableIDs?(): string[];
    getDrawableIndex?(id: string): number;
    getDrawableBounds?(index: number, bounds?: Box): Box;
    coreModel?: {
      getDrawableOpacity?(index: number): number;
      getDrawableDynamicFlagIsVisible?(index: number): boolean;
    };
  };
};

/** Boxes of the model's visible parts in canvas (CSS pixel) coordinates; [] if unavailable. */
export function visiblePartBoxes(model: unknown): Box[] {
  const live = model as Live2DLike;
  const internal = live.internalModel;
  const world = live.worldTransform;
  const local = internal?.localTransform;
  if (!internal?.getDrawableIDs || !internal.getDrawableIndex || !internal.getDrawableBounds || !world || !local) return [];
  const core = internal.coreModel;
  const boxes: Box[] = [];
  const scratch: Box = { x: 0, y: 0, width: 0, height: 0 };
  for (const id of internal.getDrawableIDs()) {
    const index = internal.getDrawableIndex(id);
    if (index < 0) continue;
    if (core?.getDrawableDynamicFlagIsVisible && !core.getDrawableDynamicFlagIsVisible(index)) continue;
    if (core?.getDrawableOpacity && core.getDrawableOpacity(index) < 0.05) continue;
    const part = internal.getDrawableBounds(index, scratch);
    // All four corners: the character sways (rotates) while it works.
    const corners = [
      { x: part.x, y: part.y },
      { x: part.x + part.width, y: part.y },
      { x: part.x, y: part.y + part.height },
      { x: part.x + part.width, y: part.y + part.height },
    ].map((point) => world.apply(local.apply(point)));
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    boxes.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
  }
  return boxes;
}
