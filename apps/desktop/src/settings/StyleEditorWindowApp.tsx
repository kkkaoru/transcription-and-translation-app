import { useEffect, useState } from "react";
import { bridge } from "../core/bridge";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import { CaptionStyleView } from "./CaptionStyleView";

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

  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];

    void bridge
      .getConfig()
      .then((next) => {
        if (mounted) {
          setConfig(next);
          setReady(true);
        }
      })
      .catch(() => {
        if (mounted) {
          setReady(true);
          setNoticeKey("message.initializeFailed");
        }
      });

    void bridge
      .listenConfig((next) => {
        if (mounted) {
          setConfig(next);
        }
      })
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch(() => undefined);

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
      await bridge.saveConfig(config);
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
