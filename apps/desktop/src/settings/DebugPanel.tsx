import { useState } from "react";
import { bridge } from "../core/bridge";
import { useI18n } from "../i18n/I18nProvider";

export function DebugPanel() {
  const { t } = useI18n();
  const [debugInfo, setDebugInfo] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInfo = async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await bridge.getDebugInfo();
      setDebugInfo(info);
    } catch (e) {
      setDebugInfo(null);
      setError(String(e));
    }
    setLoading(false);
  };

  const copyToClipboard = async () => {
    if (!debugInfo) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(debugInfo, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="panel settings-section debug-panel">
      <details>
        <summary className="debug-summary">
          <span className="eyebrow">{t("debug.eyebrow")}</span>
          <span className="debug-summary-title">{t("debug.title")}</span>
        </summary>
        <div className="debug-content">
          <p className="download-lead">{t("debug.lead")}</p>
          <div className="debug-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void fetchInfo()}
              disabled={loading}
            >
              {loading ? t("debug.loading") : t("debug.refresh")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void copyToClipboard()}
              disabled={!debugInfo}
            >
              {copied ? t("debug.copied") : t("debug.copy")}
            </button>
          </div>
          {error ? (
            <div className="download-message error notice" role="alert">
              <span className="notice-text">{error}</span>
              <button className="notice-dismiss" type="button" onClick={() => setError(null)}>
                {t("common.close")}
              </button>
            </div>
          ) : null}
          {debugInfo ? (
            <pre className="debug-output" tabIndex={0}>
              {JSON.stringify(debugInfo, null, 2)}
            </pre>
          ) : (
            <p className="download-empty">{t("debug.empty")}</p>
          )}
        </div>
      </details>
    </section>
  );
}
