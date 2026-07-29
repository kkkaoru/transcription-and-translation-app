import { I18nProvider } from "./i18n/I18nProvider";
import { MainApp } from "./live/MainApp";
import { OverlayApp } from "./overlay/OverlayApp";

const isOverlayRoute = (): boolean =>
  new URLSearchParams(window.location.search).get("overlay") === "1";

export const App = () => (
  <I18nProvider>{isOverlayRoute() ? <OverlayApp /> : <MainApp />}</I18nProvider>
);
