import { convertFileSrc, invoke } from "@tauri-apps/api/core";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function toLive2DRelative(path: string): string {
  return path.trim().replace(/^\//, "").replace(/^live2d\//, "");
}

function decodeLive2DPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || !/%[0-9A-Fa-f]{2}/.test(trimmed)) {
    return trimmed;
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "" : normalized.slice(0, idx);
}

function joinFs(baseDir: string, relative: string): string {
  if (!relative || relative.includes("://") || relative.startsWith("data:")) {
    return relative;
  }
  if (relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative)) {
    return relative.replace(/\\/g, "/");
  }
  const base = baseDir.replace(/\\/g, "/").replace(/\/$/, "");
  return `${base}/${relative.replace(/^\.\//, "")}`;
}

function joinRelative(baseDir: string, relative: string): string {
  if (!relative || relative.includes("://") || relative.startsWith("data:")) {
    return relative;
  }
  if (relative.startsWith("/")) {
    return toLive2DRelative(relative);
  }
  return baseDir ? `${baseDir}/${relative}` : relative;
}

/** Avoid String.fromCharCode(...spread) which can stack-overflow on large PNGs. */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    let part = "";
    for (let j = 0; j < slice.length; j += 1) {
      part += String.fromCharCode(slice[j]!);
    }
    binary += part;
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function isUserLive2DPath(path: string): boolean {
  const relative = toLive2DRelative(path);
  return relative.startsWith("user/");
}

async function debugLog(message: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("append_debug_log", { message });
  } catch {
    // ignore
  }
}

async function resolveAbsPath(relative: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const path = decodeLive2DPath(toLive2DRelative(relative));
  try {
    return await invoke<string>("resolve_live2d_abs_path", { path });
  } catch (error) {
    console.warn("Live2D abs path 실패:", path, error);
    await debugLog(`abs path fail: ${path} :: ${String(error)}`);
    return null;
  }
}

async function readResourceBase64(relative: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const path = decodeLive2DPath(toLive2DRelative(relative));
  try {
    return await invoke<string>("read_live2d_bytes", { path });
  } catch (error) {
    console.warn("Live2D invoke 읽기 실패:", path, error);
    return null;
  }
}

async function readResourceBytes(relative: string): Promise<Uint8Array | null> {
  const encoded = await readResourceBase64(relative);
  if (!encoded) return null;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readBytesForLive2D(webPath: string, relative: string): Promise<Uint8Array> {
  const fromResource = await readResourceBytes(relative);
  if (fromResource) return fromResource;

  if (isUserLive2DPath(relative) || isUserLive2DPath(webPath)) {
    throw new Error(`사용자 Live2D 에셋 없음: ${relative}`);
  }

  const response = await fetch(webPath.startsWith("/") ? webPath : `/${webPath}`);
  if (!response.ok) {
    throw new Error(`Live2D 에셋 요청 실패: ${webPath} (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function toAssetUrl(absFilePath: string): string {
  // WebView2/convertFileSrc는 슬래시 정규화가 더 안정적
  return convertFileSrc(absFilePath.replace(/\\/g, "/"));
}

async function assetFileToObjectUrl(absPath: string, mime: string): Promise<string> {
  const url = toAssetUrl(absPath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`asset 로드 실패 (${response.status}): ${absPath}`);
  }
  const buffer = await response.arrayBuffer();
  return URL.createObjectURL(new Blob([buffer], { type: mime }));
}

async function textureToDisplayUrl(absPath: string, live2dRelative: string): Promise<string> {
  // Bundled models already work with data: URL from invoke base64.
  // Prefer the same path for user textures (WKWebView/WebGL friendly).
  try {
    const encoded = await readResourceBase64(live2dRelative);
    if (encoded && encoded.length > 0 && encoded.length < 45_000_000) {
      await debugLog(
        `texture data-url ok: ${live2dRelative} bytes~${Math.round((encoded.length * 3) / 4)}`
      );
      return `data:image/png;base64,${encoded}`;
    }
  } catch (error) {
    await debugLog(`texture invoke fail: ${live2dRelative} :: ${String(error)}`);
  }
  // Large texture fallback: asset protocol → blob URL
  try {
    const url = await assetFileToObjectUrl(absPath, "image/png");
    await debugLog(`texture blob-url ok: ${absPath}`);
    return url;
  } catch (error) {
    await debugLog(`texture asset fail: ${absPath} :: ${String(error)}`);
    throw new Error(`텍스처 로드 실패: ${absPath}`);
  }
}

async function bytesFromLive2DRelative(live2dRelative: string): Promise<Uint8Array | null> {
  return readResourceBytes(live2dRelative);
}

async function fileToObjectUrlFromInvoke(
  live2dRelative: string,
  mime: string
): Promise<string | null> {
  const bytes = await bytesFromLive2DRelative(live2dRelative);
  if (!bytes || bytes.byteLength === 0) return null;
  if (bytes.byteLength > 40 * 1024 * 1024) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mime }));
}

async function rewriteUserFileReferencesAsync(
  modelJson: {
    FileReferences?: Record<string, unknown>;
    [key: string]: unknown;
  },
  modelAbsPath: string,
  userRelBase: string
): Promise<void> {
  const baseDir = dirname(modelAbsPath);
  const refs = modelJson.FileReferences;
  if (!refs) return;

  const rewriteBinary = async (value: unknown, mime: string): Promise<unknown> => {
    if (typeof value !== "string" || !value) return value;
    if (value.includes("://") || value.startsWith("data:")) return value;
    const live2dRel = joinRelative(userRelBase, value);
    const abs = joinFs(baseDir, value);
    const fromInvoke = await fileToObjectUrlFromInvoke(live2dRel, mime);
    if (fromInvoke) {
      await debugLog(`blob invoke ok: ${live2dRel}`);
      return fromInvoke;
    }
    try {
      const url = await assetFileToObjectUrl(abs, mime);
      await debugLog(`blob asset ok: ${abs}`);
      return url;
    } catch (error) {
      await debugLog(`blob fail: ${live2dRel} :: ${String(error)}`);
      return toAssetUrl(abs);
    }
  };

  if (typeof refs.Moc === "string") {
    refs.Moc = await rewriteBinary(refs.Moc, "application/octet-stream");
  }
  if (typeof refs.Physics === "string") {
    refs.Physics = await rewriteBinary(refs.Physics, "application/json");
  }
  if (typeof refs.Pose === "string") {
    refs.Pose = await rewriteBinary(refs.Pose, "application/json");
  }
  if (typeof refs.DisplayInfo === "string") {
    refs.DisplayInfo = await rewriteBinary(refs.DisplayInfo, "application/json");
  }
  if (Array.isArray(refs.Expressions)) {
    const next = [];
    for (const item of refs.Expressions) {
      if (!item || typeof item !== "object") {
        next.push(item);
        continue;
      }
      const row = { ...(item as Record<string, unknown>) };
      if (typeof row.File === "string") {
        row.File = await rewriteBinary(row.File, "application/json");
      }
      next.push(row);
    }
    refs.Expressions = next;
  }
  if (refs.Motions && typeof refs.Motions === "object") {
    const motions = refs.Motions as Record<string, unknown>;
    for (const [group, items] of Object.entries(motions)) {
      if (!Array.isArray(items)) continue;
      const nextItems = [];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          nextItems.push(item);
          continue;
        }
        const row = { ...(item as Record<string, unknown>) };
        if (typeof row.File === "string") {
          row.File = await rewriteBinary(row.File, "application/json");
        }
        if (typeof row.Sound === "string") {
          row.Sound = await rewriteBinary(row.Sound, "audio/mpeg");
        }
        nextItems.push(row);
      }
      motions[group] = nextItems;
    }
  }
}

/**
 * 사용자 모델: 모든 바이너리/텍스처를 blob·data URL로 바꿉니다.
 * (asset:// 경로는 WKWebView Live2D에서 종종 비가시/실패)
 */
async function resolveUserLive2DModelSource(
  absolutePath: string,
  relative: string
): Promise<Record<string, unknown>> {
  const abs = await resolveAbsPath(relative);
  if (!abs) {
    throw new Error(`사용자 Live2D 경로 해석 실패: ${relative}`);
  }

  const modelBytes = await readBytesForLive2D(absolutePath, relative);
  const modelJson = JSON.parse(new TextDecoder().decode(modelBytes)) as {
    FileReferences?: Record<string, unknown>;
    [key: string]: unknown;
  };

  const userRelBase = dirname(relative); // user/Folder
  await rewriteUserFileReferencesAsync(modelJson, abs, userRelBase);

  const baseDir = dirname(abs);
  const refs = modelJson.FileReferences;
  if (refs && Array.isArray(refs.Textures)) {
    const next: string[] = [];
    for (const item of refs.Textures) {
      if (typeof item !== "string") continue;
      if (item.includes("://") || item.startsWith("data:")) {
        next.push(item);
        continue;
      }
      const absTex = joinFs(baseDir, item);
      const live2dRel = joinRelative(userRelBase, item);
      next.push(await textureToDisplayUrl(absTex, live2dRel));
    }
    refs.Textures = next;
  }

  // Live2D/WKWebView는 url에 일본어가 있으면 텍스처가 안 그려지는 경우가 있음.
  // 참조는 이미 blob/data 절대 URL이므로 ASCII placeholder만 둡니다.
  modelJson.url = "https://tauri.localhost/live2d/user-runtime/";
  await debugLog(
    `user model ready: ${relative} textures=${
      Array.isArray(refs?.Textures) ? refs.Textures.length : 0
    } mocType=${String((refs as { Moc?: string } | undefined)?.Moc ?? "").slice(0, 24)}`
  );
  return modelJson;
}

/**
 * moc/motion 등은 상대경로 유지(임베디드 URL 기준),
 * 번들 모델 PNG 텍스처만 data: URL 로 바꿔 WKWebView 디코드 문제를 피합니다.
 */
export async function resolveLive2DModelSource(
  modelPath: string
): Promise<Record<string, unknown> | string> {
  const trimmed = modelPath.trim();
  if (!trimmed) return trimmed;

  const absolutePath = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const relative = decodeLive2DPath(toLive2DRelative(absolutePath));
  const userModel = isUserLive2DPath(relative);

  if (userModel) {
    return resolveUserLive2DModelSource(absolutePath, relative);
  }

  if (!import.meta.env.PROD) {
    return absolutePath;
  }

  const baseDir = dirname(relative);
  const modelBytes = await readBytesForLive2D(absolutePath, relative);
  const modelJson = JSON.parse(new TextDecoder().decode(modelBytes)) as {
    FileReferences?: { Textures?: unknown; [key: string]: unknown };
    [key: string]: unknown;
  };

  const textures = modelJson.FileReferences?.Textures;
  if (Array.isArray(textures)) {
    const next: string[] = [];
    for (const item of textures) {
      if (typeof item !== "string") continue;
      const rel = joinRelative(baseDir, item);
      const web = `/live2d/${rel}`;
      const encoded = await readResourceBase64(rel);
      if (encoded) {
        next.push(`data:image/png;base64,${encoded}`);
        continue;
      }
      const bytes = await readBytesForLive2D(web, rel);
      next.push(bytesToDataUrl(bytes, "image/png"));
    }
    modelJson.FileReferences = {
      ...modelJson.FileReferences,
      Textures: next,
    };
  }

  modelJson.url = absolutePath;
  return modelJson as Record<string, unknown>;
}

export async function resolveLive2DAssetUrl(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** fetch 가로채기에서 사용자 Live2D 경로를 invoke로 제공합니다. */
export async function fetchLive2DBytesViaInvoke(
  url: string
): Promise<Uint8Array | null> {
  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    decodedUrl = url;
  }

  if (/asset\.localhost|asset:\/\//i.test(decodedUrl)) {
    return null;
  }

  const match = decodedUrl.match(/live2d\/(user\/[^?#]+)/i);
  if (!match) return null;
  return readResourceBytes(match[1]);
}
