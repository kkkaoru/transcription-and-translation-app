const COMPARE_STATIC_ASSET_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".mjs": "text/javascript",
};

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
