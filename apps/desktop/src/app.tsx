import { I18nProvider } from "./i18n/I18nProvider";
import { MainApp } from "./live/MainApp";
import { OverlayApp } from "./overlay/OverlayApp";

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

export const App = () => (
  <I18nProvider>{isCaptionSurfaceRoute() ? <OverlayApp /> : <MainApp />}</I18nProvider>
);
