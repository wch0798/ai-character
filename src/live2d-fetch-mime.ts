import { fetchLive2DBytesViaInvoke } from "./live2d-asset-url";

type FetchFn = typeof fetch;

function nativeFetch(): FetchFn {
  const holder = window as unknown as { __aiCharacterNativeFetch?: FetchFn };
  if (!holder.__aiCharacterNativeFetch) {
    holder.__aiCharacterNativeFetch = window.fetch.bind(window);
  }
  return holder.__aiCharacterNativeFetch;
}

export function isTauriInternalFetchUrl(url: string): boolean {
  const value = url.trim();
  if (!value) {
    return false;
  }
  return (
    /^(ipc|tauri):/i.test(value) ||
    /(?:^|\/)ipc\.localhost\b/i.test(value) ||
    /__tauri_ipc__/i.test(value)
  );
}

export function shouldPatchLive2DFetch(url: string): boolean {
  if (!url || isTauriInternalFetchUrl(url)) {
    return false;
  }
  return /(?:^|[/?])live2d\/|\.moc3(?:$|\?)|\.model3\.json(?:$|\?)/i.test(url);
}

/**
 * 프로덕션 Tauri 에셋에서 PNG MIME이 비어 텍스처 디코드가 실패하는 경우를 막습니다.
 * 개발 서버는 MIME이 정상이고, window.fetch를 가로채면 IPC가 깨지므로 패치하지 않습니다.
 */
export function patchLive2DAssetFetchMime(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  if (import.meta.env.DEV) {
    return;
  }
  const flagged = window as unknown as { __aiCharacterFetchPatched?: boolean };
  if (flagged.__aiCharacterFetchPatched) {
    return;
  }
  flagged.__aiCharacterFetchPatched = true;

  const originalFetch = nativeFetch();

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!shouldPatchLive2DFetch(url)) {
      return originalFetch(input, init);
    }

    return (async () => {
      const userBytes = await fetchLive2DBytesViaInvoke(url);
      if (userBytes) {
        const contentType = /\.png($|\?)/i.test(url)
          ? "image/png"
          : /\.json($|\?)/i.test(url)
            ? "application/json"
            : "application/octet-stream";
        return new Response(userBytes.slice().buffer, {
          status: 200,
          headers: { "content-type": contentType },
        });
      }

      const response = await originalFetch(input, init);
      const headerType = response.headers.get("content-type") ?? "";
      const needsPng =
        /\.png($|\?)/i.test(url) && !headerType.includes("image/png");
      const needsJson =
        /\.json($|\?)/i.test(url) && !headerType.includes("json");
      const needsBinary =
        /\.moc3($|\?)/i.test(url) &&
        !headerType.includes("octet-stream") &&
        !headerType.includes("binary");

      if (!needsPng && !needsJson && !needsBinary) {
        return response;
      }

      const buffer = await response.arrayBuffer();
      const contentType = needsPng
        ? "image/png"
        : needsJson
          ? "application/json"
          : "application/octet-stream";

      return new Response(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "content-type": contentType,
          "cache-control": response.headers.get("cache-control") ?? "public",
        },
      });
    })();
  };
}
