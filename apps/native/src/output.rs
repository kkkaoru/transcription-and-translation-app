//! Capture-output configuration and Browser Source links.

use gpui::prelude::*;
use gpui::{Context, IntoElement};

use crate::domain::{
    NativeAppSettings, UiLanguage, NATIVE_BROWSER_SOURCE_HINT, NATIVE_VERTICAL_BROWSER_SOURCE_HINT,
};
use crate::i18n::{text, TextKey};
use crate::ui::{card, error_line, heading, muted, state_button};

pub struct OutputCallbacks<V> {
    pub on_toggle_window_startup: fn(&mut V),
    pub on_toggle_browser: fn(&mut V),
}

pub fn render_output<V: 'static>(
    settings: &NativeAppSettings,
    browser_running: bool,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    callbacks: OutputCallbacks<V>,
) -> impl IntoElement {
    let language: UiLanguage = settings.ui_language;
    card()
        .child(heading(text(language, TextKey::Output)))
        .child(state_button(
            "output-window-startup",
            format!(
                "{}: {}",
                text(language, TextKey::OutputWindowAtStartup),
                text(
                    language,
                    if settings.caption_output_open_on_start { TextKey::On } else { TextKey::Off }
                )
            ),
            settings.caption_output_open_on_start,
            cx.listener(move |view, _event, _window, _cx| {
                (callbacks.on_toggle_window_startup)(view)
            }),
        ))
        .child(state_button(
            "output-browser-enabled",
            format!(
                "{}: {}",
                text(language, TextKey::BrowserSource),
                text(language, if browser_running { TextKey::On } else { TextKey::Off })
            ),
            browser_running,
            cx.listener(move |view, _event, _window, _cx| (callbacks.on_toggle_browser)(view)),
        ))
        .child(muted(format!(
            "{}: {NATIVE_BROWSER_SOURCE_HINT}",
            text(language, TextKey::Horizontal)
        )))
        .child(muted(format!(
            "{}: {NATIVE_VERTICAL_BROWSER_SOURCE_HINT}",
            text(language, TextKey::Vertical)
        )))
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
}
