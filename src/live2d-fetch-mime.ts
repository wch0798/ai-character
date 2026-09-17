import { fetchLive2DBytesViaInvoke } from "./live2d-asset-url";

/**
 * Tauri 임베디드 에셋에서 PNG MIME이 비어 createImageBitmap/Image 디코드가
 * 실패하는 경우를 막기 위해, Live2D 관련 응답 Content-Type을 보정합니다.
 * 사용자(nizima/Booth) 모델 경로는 invoke로 읽습니다.
 */
export function patchLive2DAssetFetchMime(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

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

    if (!/live2d\/|\.png($|\?)|\.moc3($|\?)|\.json($|\?)/i.test(url)) {
      return response;
    }

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
  };
}
