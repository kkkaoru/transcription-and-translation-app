import { useEffect, useRef, useState } from "react";
import { bridge } from "../core/bridge";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import { CaptionStyleView } from "./CaptionStyleView";

const sameConfig = (left: AppConfig, right: AppConfig): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const mergeStyleOverlay = (
  base: AppConfig["overlay"],
  patch: AppConfig["overlay"],
): AppConfig["overlay"] => ({
  ...base,
  gapPx: patch.gapPx,
  safeAreaPx: patch.safeAreaPx,
  captionXPercent: patch.captionXPercent,
  captionYPercent: patch.captionYPercent,
  captionMaxChars: patch.captionMaxChars,
  source: patch.source,
  translation: patch.translation,
});

/** Keep the editor's style draft; adopt every non-style field from `base`. */
const withLocalStyleOverlay = (base: AppConfig, overlay: AppConfig["overlay"]): AppConfig => ({
  ...base,
  overlay: mergeStyleOverlay(base.overlay, overlay),
});

/**
 * Second-window shell for caption style editing.
 *
 * Shares the same getConfig / saveConfig / config:update path as the main
 * window so overlay and live preview stay in sync. Peer workers own preview
 * polish and FontFamilyCombobox / TextStyleEditor details inside CaptionStyleView.
 */
export const StyleEditorWindowApp = () => {
  const { t } = useI18n();
  const [config, setConfig] = useState<AppConfig>(() => createDefaultConfig());
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [noticeKey, setNoticeKey] = useState<MessageKey | null>(null);
  const configRef = useRef(config);
  const committedRef = useRef<AppConfig | null>(null);
  configRef.current = config;

  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];
    let appliedRemote = false;

    const applyRemote = (next: AppConfig) => {
      appliedRemote = true;
      const committed = committedRef.current;
      const local = configRef.current;
      // Accept remote when there is no baseline yet, the draft is clean, or the
      // payload matches the local draft (save echo). When the overlay draft is
      // dirty, still adopt remote non-overlay fields so a later style save
      // cannot roll back MainApp updates.
      if (committed === null || sameConfig(local, committed) || sameConfig(local, next)) {
        committedRef.current = next;
        configRef.current = next;
        setConfig(next);
      } else {
        const merged = withLocalStyleOverlay(next, local.overlay);
        committedRef.current = next;
        configRef.current = merged;
        setConfig(merged);
      }
      setReady(true);
    };

    // Register the listener before the initial snapshot so an intervening
    // config:update cannot be missed, and so a late getConfig cannot win.
    const initialize = async () => {
      try {
        const dispose = await bridge.listenConfig((next) => {
          if (mounted) {
            applyRemote(next);
          }
        });
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
          return;
        }
      } catch {
        if (!mounted) {
          return;
        }
        setNoticeKey("message.initializeFailed");
      }

      try {
        const next = await bridge.getConfig();
        if (!mounted || appliedRemote) {
          return;
        }
        committedRef.current = next;
        configRef.current = next;
        setConfig(next);
        setReady(true);
      } catch {
        if (mounted && !appliedRemote) {
          setReady(true);
          setNoticeKey("message.initializeFailed");
        }
      }
    };

    void initialize();

    return () => {
      mounted = false;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const localOverlay = configRef.current.overlay;
      const latest = await bridge.getConfig();
      const payload = withLocalStyleOverlay(latest, localOverlay);
      await bridge.saveConfig(payload);
      committedRef.current = payload;
      configRef.current = payload;
      setConfig(payload);
      setNoticeKey("message.saved");
    } catch {
      setNoticeKey("message.saveFailed");
    } finally {
      setSaving(false);
    }
  };

  if (!ready) {
    return (
      <div className="app-shell" data-testid="style-editor-window">
        <main className="content" />
      </div>
    );
  }

  return (
    <div className="app-shell" data-testid="style-editor-window">
      <div className="workspace">
        <main className="content">
          {noticeKey ? (
            <div className="notice" role="status">
              <span className="notice-text">{t(noticeKey)}</span>
              <button
                type="button"
                onClick={() => setNoticeKey(null)}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </div>
          ) : null}
          <CaptionStyleView
            config={config}
            saving={saving}
            onConfigChange={setConfig}
            onSave={() => void save()}
          />
        </main>
      </div>
    </div>
  );
};
