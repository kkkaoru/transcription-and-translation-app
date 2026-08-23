//! Runtime settings and build information.

use gpui::prelude::*;
use gpui::{div, Context, ElementId, IntoElement, SharedString};

use crate::domain::{NativeAppSettings, UiLanguage, BUILD_ID, RECOGNITION_MODE_LABEL};
use crate::i18n::{text, TextKey};
use crate::ui::{button, card, error_line, heading, muted, state_button};

pub struct SettingsCallbacks<V> {
    pub on_language: fn(&mut V, UiLanguage),
    pub on_toggle_translation: fn(&mut V),
    pub on_timeout: fn(&mut V, u64),
    pub on_toggle_syphon: fn(&mut V),
}

pub fn render_settings<V: 'static>(
    settings: &NativeAppSettings,
    translation_model_installed: bool,
    syphon_on: bool,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    callbacks: SettingsCallbacks<V>,
) -> impl IntoElement {
    let language = settings.ui_language;
    let timeout_segments = (1..=10)
        .map(|seconds| {
            let timeout = seconds * 1_000;
            div()
                .id(ElementId::named_usize("caption-timeout", seconds as usize))
                .h(gpui::px(12.0))
                .flex_1()
                .rounded_md()
                .bg(gpui::rgb(if settings.caption_timeout_ms >= timeout {
                    0x1aa6a6
                } else {
                    0xd5e6f2
                }))
                .cursor_pointer()
                .on_click(cx.listener(move |view, _event, _window, _cx| {
                    (callbacks.on_timeout)(view, timeout)
                }))
        })
        .collect::<Vec<_>>();

    card()
        .child(heading(text(language, TextKey::Settings)))
        .child(muted(text(language, TextKey::UiLanguage)))
        .child(
            div()
                .flex()
                .gap_2()
                .child(button(
                    "language-japanese",
                    text(language, TextKey::Japanese),
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_language)(view, UiLanguage::Japanese)
                    }),
                ))
                .child(button(
                    "language-english",
                    text(language, TextKey::English),
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_language)(view, UiLanguage::English)
                    }),
                )),
        )
        .child(muted(format!(
            "{}: {}",
            text(language, TextKey::TranslationModel),
            text(
                language,
                if translation_model_installed { TextKey::Installed } else { TextKey::Missing }
            )
        )))
        .child(state_button(
            "translation-enabled",
            format!(
                "{}: {}",
                text(language, TextKey::Translation),
                text(
                    language,
                    if settings.translation_enabled { TextKey::Enabled } else { TextKey::Disabled }
                )
            ),
            settings.translation_enabled,
            cx.listener(move |view, _event, _window, _cx| (callbacks.on_toggle_translation)(view)),
        ))
        .child(SharedString::from(format!(
            "{}: {} ms",
            text(language, TextKey::CaptionTimeout),
            settings.caption_timeout_ms
        )))
        .child(div().flex().gap_1().children(timeout_segments))
        .child(muted(format!(
            "{}: {RECOGNITION_MODE_LABEL}",
            text(language, TextKey::RecognitionEngine)
        )))
        .child(state_button(
            "settings-syphon",
            format!(
                "{}: {}",
                text(language, TextKey::Syphon),
                text(language, if syphon_on { TextKey::On } else { TextKey::Off })
            ),
            syphon_on,
            cx.listener(move |view, _event, _window, _cx| (callbacks.on_toggle_syphon)(view)),
        ))
        .child(muted(format!("{}: {BUILD_ID}", text(language, TextKey::BuildId))))
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
}
