//! Capture-output configuration and Browser Source links.

use gpui::prelude::*;
use gpui::{Context, IntoElement};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::label::Label;
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, StyledExt as _};

use crate::domain::{NativeAppSettings, UiLanguage, NATIVE_BROWSER_SOURCE_HINT};
use crate::i18n::{text, TextKey};
use crate::ui::{card, error_line, heading};

pub struct OutputCallbacks<V> {
    pub on_open_window: fn(&mut V),
    pub on_toggle_window_startup: fn(&mut V),
    pub on_toggle_browser: fn(&mut V),
    pub on_copy_url: fn(&mut V, &mut Context<V>),
}

pub fn render_output<V: 'static>(
    settings: &NativeAppSettings,
    browser_running: bool,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    callbacks: OutputCallbacks<V>,
) -> impl IntoElement {
    let language: UiLanguage = settings.ui_language;
    card(cx)
        .child(heading(text(language, TextKey::Output)))
        .child(
            h_flex()
                .gap_2()
                .child(
                    Button::new("output-window-open")
                        .primary()
                        .label(text(language, TextKey::OpenOutputWindow))
                        .on_click(cx.listener(move |view, _event, _window, _cx| {
                            (callbacks.on_open_window)(view);
                        })),
                )
                .child(
                    Button::new("output-browser-copy-url")
                        .label(text(language, TextKey::CopyBrowserUrl))
                        .on_click(cx.listener(move |view, _event, _window, cx| {
                            (callbacks.on_copy_url)(view, cx);
                        })),
                ),
        )
        .child(
            v_flex()
                .gap_3()
                .child(
                    Switch::new("output-window-startup")
                        .label(text(language, TextKey::OutputWindowAtStartup))
                        .checked(settings.caption_output_open_on_start)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_window_startup)(view);
                        })),
                )
                .child(
                    Switch::new("output-browser-enabled")
                        .label(text(language, TextKey::BrowserSource))
                        .checked(browser_running)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_browser)(view);
                        })),
                ),
        )
        .child(
            v_flex()
                .gap_1()
                .child(Label::new(text(language, TextKey::BrowserSource)).font_semibold())
                .child(Label::new(NATIVE_BROWSER_SOURCE_HINT).text_sm()),
        )
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
}
