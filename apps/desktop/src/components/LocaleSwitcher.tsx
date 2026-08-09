import { useI18n } from "../i18n/I18nProvider";
import type { Locale } from "../i18n/messages";

export const LocaleSwitcher = () => {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="locale-switcher">
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        aria-label={t("app.uiLanguage")}
      >
        <option value="ja">{t("locale.ja")}</option>
        <option value="en">{t("locale.en")}</option>
      </select>
    </label>
  );
};
