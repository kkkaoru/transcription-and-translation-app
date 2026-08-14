import { I18nProvider } from "./i18n/I18nProvider";
import { MainApp } from "./live/MainApp";
import { OverlayApp } from "./overlay/OverlayApp";
import { CustomDictionaryWindowApp } from "./settings/CustomDictionaryWindowApp";
import { StyleEditorWindowApp } from "./settings/StyleEditorWindowApp";

/** Caption surfaces: always-on native Syphon/Spout renderer, or Window Capture plate. */
const isCaptionSurfaceRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("native") === "1" ||
    params.get("transparent") === "1" ||
    // Legacy query used by older builds / tests.
    params.get("overlay") === "1"
  );
};

/** Legacy direct-window route; current UI exposes dictionary management as a main tab. */
const isCustomDictionaryRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return params.get("custom-dictionary") === "1";
};

/** Legacy direct-window route; current UI exposes caption styling as a main tab. */
const isStyleEditorRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return params.get("style-editor") === "1";
};

export const App = () => (
  <I18nProvider>
    {isCaptionSurfaceRoute() ? (
      <OverlayApp />
    ) : isStyleEditorRoute() ? (
      <StyleEditorWindowApp />
    ) : isCustomDictionaryRoute() ? (
      <CustomDictionaryWindowApp />
    ) : (
      <MainApp />
    )}
  </I18nProvider>
);
