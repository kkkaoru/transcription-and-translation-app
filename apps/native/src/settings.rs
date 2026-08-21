//! Settings tab: recognition mode, overlay, Syphon, identity.

use gpui::prelude::*;
use gpui::{div, Context, IntoElement, SharedString};

use crate::domain::{
    NativeAppSettings, BUNDLE_ID, NATIVE_BROWSER_SOURCE_HINT, NATIVE_PARAPPER_PORT, PRODUCT_NAME,
    RECOGNITION_MODE_LABEL,
};
use crate::ui::{button, card, error_line, heading, muted};

pub struct SettingsCallbacks<V> {
    pub on_open_overlay: fn(&mut V),
    pub on_hide_overlay: fn(&mut V),
    pub on_toggle_syphon: fn(&mut V),
}

pub fn render_settings<V: 'static>(
    settings: &NativeAppSettings,
    overlay_open: bool,
    syphon_on: bool,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    callbacks: SettingsCallbacks<V>,
) -> impl IntoElement {
    card()
        .child(heading("設定"))
        .child(muted(format!("認識モード: {RECOGNITION_MODE_LABEL}（既定）")))
        .child(muted(format!("保存済みモード: {}", settings.recognition_mode)))
        .child(muted(format!("オーバーレイ: {}", if overlay_open { "表示中" } else { "非表示" })))
        .child(muted(format!("Syphon: {}", if syphon_on { "配信中" } else { "停止" })))
        .child(
            div()
                .flex()
                .gap_2()
                .child(button(
                    "settings-overlay-open",
                    "オーバーレイを開く",
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_open_overlay)(view)
                    }),
                ))
                .child(button(
                    "settings-overlay-hide",
                    "オーバーレイを隠す",
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_hide_overlay)(view)
                    }),
                ))
                .child(button(
                    "settings-syphon",
                    if syphon_on { "Syphon を停止" } else { "Syphon を開始" },
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_toggle_syphon)(view)
                    }),
                )),
        )
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
        .child(muted(format!("Browser-source: {NATIVE_BROWSER_SOURCE_HINT}")))
        .child(muted(format!("Parapper port: {NATIVE_PARAPPER_PORT}")))
        .child(div().mt_2().child(SharedString::from(PRODUCT_NAME)))
        .child(SharedString::from(format!("bundle id: {BUNDLE_ID}")))
        .child(SharedString::from("binary: kotoba-beacon-native"))
}
