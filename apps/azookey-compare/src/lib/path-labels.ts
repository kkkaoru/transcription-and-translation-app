import type { ComparisonMode } from "./contract";

/** User-visible conversion path after a single utterance is processed. */
export const conversionPathLabel = (mode: ComparisonMode): string =>
  mode === "browser-vibrato"
    ? "Browser Vibrato WASM → Browser AzooKey WASM"
    : "Cloudflare Worker Vibrato → Cloudflare Worker AzooKey WASM";

/**
 * Stage that was in flight when a conversion failed.
 *
 * `worker-connect` sits between the two real stages: the browser pre-pass has
 * already finished, but the Cloudflare Worker was never reached. Folding it into either
 * neighbour would blame a stage that did not fail. `worker-request` is the same
 * idea one step later: the Cloudflare Worker answered, but refused the request (auth,
 * back-pressure, contract) without ever invoking the converter. A
 * `worker-transport` outcome means the client cannot tell whether the Cloudflare Worker
 * received or converted the request (timeout, socket close, or an unknown error).
 */
export type ConversionStage =
  | "setup"
  | "browser-wasm"
  | "browser-azookey"
  | "worker-connect"
  | "worker-request"
  | "worker-transport"
  | "worker";

/**
 * Path a row actually reached. A failed row must not advertise stages it never
 * ran: a browser pre-pass failure never reaches the Cloudflare Worker, and a setup failure
 * (bad auth, missing client) reaches neither.
 */
export const attemptedPathLabel = (mode: ComparisonMode, failedStage?: ConversionStage): string => {
  if (failedStage === undefined) {
    return conversionPathLabel(mode);
  }
  if (failedStage === "setup") {
    return "未実行";
  }
  if (failedStage === "browser-wasm") {
    return mode === "browser-vibrato"
      ? "Browser Vibrato WASM（失敗） / Browser AzooKey WASM 未実行"
      : "Browser Vibrato WASM（失敗） / Cloudflare Worker AzooKey WASM 未実行";
  }
  if (failedStage === "browser-azookey") {
    return "Browser Vibrato WASM → Browser AzooKey WASM（失敗）";
  }
  if (failedStage === "worker-connect") {
    return mode === "browser-vibrato"
      ? "Browser Vibrato WASM 完了 / Cloudflare Worker AzooKey WASM 未実行"
      : "Cloudflare Worker Vibrato / AzooKey WASM 未実行";
  }
  if (failedStage === "worker-request") {
    return mode === "browser-vibrato"
      ? "Browser Vibrato WASM 完了 / Cloudflare Worker がリクエストを拒否（AzooKey WASM 未実行）"
      : "Cloudflare Worker がリクエストを拒否（Vibrato / AzooKey WASM 未実行）";
  }
  if (failedStage === "worker-transport") {
    return mode === "browser-vibrato"
      ? "Browser Vibrato WASM 完了 / Cloudflare Worker 処理結果不明（AzooKey WASM 実行不明）"
      : "Cloudflare Worker 処理結果不明（Vibrato / AzooKey WASM 実行不明）";
  }
  if (mode !== "browser-vibrato") {
    return "Cloudflare Worker Vibrato / AzooKey WASM（失敗）";
  }
  return "Browser Vibrato WASM → Browser AzooKey WASM（失敗）";
};

/** Row states that describe work still in flight. */
type PendingRowState = "queued" | "wasm" | "sending";

/**
 * Path label for one timeline row.
 *
 * A row only knows which stage failed once it has settled, so until then the
 * route is a plan rather than a path that was reached. Marking it keeps an
 * in-flight row from advertising a Cloudflare Worker conversion that has not run yet.
 */
export const rowPathLabel = (
  mode: ComparisonMode,
  state: PendingRowState | "done" | "error",
  failedStage?: ConversionStage,
): string =>
  state === "done" || state === "error"
    ? attemptedPathLabel(mode, failedStage)
    : `${conversionPathLabel(mode)}（予定）`;

/** One box in the live / help architecture diagram. */
export interface ComparisonPathStep {
  id: string;
  title: string;
  detail: string;
  location: "browser" | "worker";
  warning?: string;
}

/**
 * Structured stages for the architecture diagram.
 * Browser mode marks the pre-pass as unconfigured when neither module URL nor
 * an explicit global name is present in the form (runtime may still attempt a
 * historical default global name).
 */
export const comparisonPathSteps = (
  mode: ComparisonMode,
  browserWasmConfigured: boolean,
): ComparisonPathStep[] => {
  const speech: ComparisonPathStep = {
    id: "speech",
    title: "Web Speech",
    detail: "マイク認識",
    location: "browser",
  };
  const azookey: ComparisonPathStep = {
    id: "azookey",
    title: "AzooKey",
    detail: "かな漢字変換",
    location: mode === "browser-vibrato" ? "browser" : "worker",
  };
  if (mode === "worker-vibrato") {
    return [
      speech,
      {
        id: "vibrato",
        title: "Vibrato",
        detail: "読み取り",
        location: "worker",
      },
      azookey,
    ];
  }
  return [
    speech,
    {
      id: "vibrato",
      title: "Vibrato",
      detail: "読み取り",
      location: "browser",
      ...(browserWasmConfigured ? {} : { warning: "未設定" }),
    },
    azookey,
  ];
};

/** Accessible one-line summary of the same path the diagram draws. */
export const comparisonPathSummary = (
  mode: ComparisonMode,
  browserWasmConfigured: boolean,
): string =>
  mode === "worker-vibrato"
    ? "Web Speech → Cloudflare Worker Vibrato → AzooKey WASM"
    : `Web Speech → Browser Vibrato WASM${
        browserWasmConfigured ? "" : "（未設定）"
      } → Browser AzooKey WASM`;
