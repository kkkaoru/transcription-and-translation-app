export const COMPARE_WORKER_MAX_ASSET_BYTES = 25 * 1024 * 1024;

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

export const withCompareStaticAssetHeaders = (pathname: string, response: Response): Response => {
  const type = compareStaticAssetContentType(pathname);
  if (!type) {
    return response;
  }
  const current = response.headers.get("content-type") ?? "";
  if (current.toLowerCase().includes(type.toLowerCase())) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Type", type);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
