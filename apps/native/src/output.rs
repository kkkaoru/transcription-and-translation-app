//! Capture-output configuration and Browser Source links.

use gpui::prelude::*;
use gpui::{Context, IntoElement};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, Selectable as _};

use crate::domain::{NativeAppSettings, NativeStyleSettings, UiLanguage};
use crate::i18n::{text, TextKey};
use crate::style::parse_rgb;
use crate::ui::{card, error_line, heading, selectable_text};

const CHROMA_KEY_COLORS: &[&str] = &["#00ff00", "#0000ff", "#ff00ff", "#000000", "#ffffff"];

pub struct OutputCallbacks<V> {
    pub on_open_window: fn(&mut V),
    pub on_toggle_window_startup: fn(&mut V),
    pub on_copy_url: fn(&mut V, &mut Context<V>),
    pub on_background_color: fn(&mut V, &str),
}

pub fn render_output<V: 'static>(
    settings: &NativeAppSettings,
    style: &NativeStyleSettings,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    callbacks: OutputCallbacks<V>,
) -> impl IntoElement {
    let language: UiLanguage = settings.ui_language;
    let background_colors = CHROMA_KEY_COLORS.iter().map(|color| {
        let value = (*color).to_string();
        Button::new(format!("output-background-{color}"))
            .label(color.to_uppercase())
            .selected(style.capture_background_color.eq_ignore_ascii_case(color))
            .toggled(style.capture_background_color.eq_ignore_ascii_case(color))
            .on_click(cx.listener(move |view, _event, _window, _cx| {
                (callbacks.on_background_color)(view, &value);
            }))
    });
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
                .gap_2()
                .child(heading(text(language, TextKey::CaptureBackground)))
                .child(h_flex().flex_wrap().gap_2().children(background_colors))
                .child(
                    selectable_text(style.capture_background_color.to_uppercase())
                        .text_color(parse_rgb(&style.capture_background_color)),
                )
                .child(
                    Switch::new("output-window-startup")
                        .label(text(language, TextKey::OutputWindowAtStartup))
                        .checked(settings.caption_output_open_on_start)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_window_startup)(view);
                        })),
                ),
        )
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
}
