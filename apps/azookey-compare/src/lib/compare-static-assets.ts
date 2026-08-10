export const COMPARE_WORKER_MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** HTML must not be long-cached; hashed `/_next/static/*` can stay immutable. */
export const COMPARE_HTML_CACHE_CONTROL = "no-store";
export const COMPARE_HASHED_STATIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

const COMPARE_STATIC_ASSET_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".mjs": "text/javascript",
};

export const isOversizedCompareOrtAsset = (name: string, bytes: number): boolean =>
  /ort-wasm-simd-threaded\.(jsep|jspi|asyncify)\./u.test(name) ||
  (/ort-wasm.*\.wasm$/u.test(name) && bytes >= COMPARE_WORKER_MAX_ASSET_BYTES);

export const compareStaticAssetContentType = (pathname: string): string | undefined => {
  const lower = pathname.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }
  return COMPARE_STATIC_ASSET_TYPES[lower.slice(dot)];
};

export const isHashedNextStaticPath = (pathname: string): boolean =>
  pathname === "/_next/static" || pathname.startsWith("/_next/static/");

export const isCompareHtmlPath = (pathname: string): boolean => {
  if (pathname === "/" || pathname === "") {
    return true;
  }
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return true;
  }
  const lastSegment = pathname.split("/").pop() ?? "";
  return lastSegment.length > 0 && !lastSegment.includes(".");
};

export const isHtmlContentType = (contentType: string | null | undefined): boolean =>
  (contentType ?? "").toLowerCase().includes("text/html");

export const compareAssetCacheControl = (
  pathname: string,
  contentType?: string | null,
): string | undefined => {
  if (isHtmlContentType(contentType) || isCompareHtmlPath(pathname)) {
    return COMPARE_HTML_CACHE_CONTROL;
  }
  if (isHashedNextStaticPath(pathname)) {
    return COMPARE_HASHED_STATIC_CACHE_CONTROL;
  }
  return undefined;
};

export const withCompareStaticAssetHeaders = (pathname: string, response: Response): Response => {
  const headers = new Headers(response.headers);
  let changed = false;

  const type = compareStaticAssetContentType(pathname);
  if (type) {
    const current = headers.get("content-type") ?? "";
    if (!current.toLowerCase().includes(type.toLowerCase())) {
      headers.set("Content-Type", type);
      changed = true;
    }
  }

  const cacheControl = compareAssetCacheControl(pathname, headers.get("content-type"));
  if (cacheControl && headers.get("cache-control") !== cacheControl) {
    headers.set("Cache-Control", cacheControl);
    changed = true;
  }

  if (!changed) {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
