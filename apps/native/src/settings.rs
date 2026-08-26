//! Runtime settings and build information.

use gpui::prelude::*;
use gpui::{div, Context, ElementId, IntoElement, SharedString};
use rust_lib_kotoba_beacon_companion::api::simple::MobileCapabilities;

use crate::domain::{NativeAppSettings, UiLanguage, BUILD_ID, RECOGNITION_MODE_LABEL};
use crate::i18n::{text, TextKey};
use crate::ui::{button, card, error_line, heading, muted, state_button};

pub struct SettingsRuntimeInfo<'a> {
    pub translation_model_installed: bool,
    pub syphon_on: bool,
    pub companion_endpoint: Option<&'a str>,
    pub companion_pairing_token: Option<&'a str>,
    pub companion_device: Option<&'a str>,
    pub companion_capabilities: Option<&'a MobileCapabilities>,
    pub companion_saved_devices: usize,
    pub persist_error: Option<&'a str>,
}

pub struct SettingsCallbacks<V> {
    pub on_language: fn(&mut V, UiLanguage),
    pub on_toggle_translation: fn(&mut V),
    pub on_timeout: fn(&mut V, u64),
    pub on_toggle_syphon: fn(&mut V),
    pub on_toggle_companion_asr: fn(&mut V),
    pub on_toggle_companion_azookey: fn(&mut V),
    pub on_toggle_companion_translation: fn(&mut V),
    pub on_copy_companion_endpoint: fn(&mut V, &mut Context<V>),
    pub on_copy_companion_token: fn(&mut V, &mut Context<V>),
}

pub fn render_settings<V: 'static>(
    settings: &NativeAppSettings,
    runtime: &SettingsRuntimeInfo<'_>,
    cx: &mut Context<V>,
    callbacks: SettingsCallbacks<V>,
) -> impl IntoElement {
    let language = settings.ui_language;
    let translation_model_installed = runtime.translation_model_installed;
    let syphon_on = runtime.syphon_on;
    let companion_endpoint = runtime.companion_endpoint;
    let companion_pairing_token = runtime.companion_pairing_token;
    let companion_device = runtime.companion_device;
    let companion_capabilities = runtime.companion_capabilities;
    let companion_saved_devices = runtime.companion_saved_devices;
    let persist_error = runtime.persist_error;
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
        .child(muted(match language {
            UiLanguage::Japanese => "モバイル連携（Desktop / Mobileを個別選択）",
            UiLanguage::English => "Mobile companion (select Desktop / Mobile per stage)",
        }))
        .child(state_button(
            "companion-asr",
            format!("ASR: {}", if settings.companion_asr_on_mobile { "Mobile" } else { "Desktop" }),
            settings.companion_asr_on_mobile,
            cx.listener(move |view, _event, _window, _cx| {
                (callbacks.on_toggle_companion_asr)(view)
            }),
        ))
        .child(state_button(
            "companion-azookey",
            format!(
                "AzooKey: {}",
                if settings.companion_azookey_on_mobile { "Mobile" } else { "Desktop" }
            ),
            settings.companion_azookey_on_mobile,
            cx.listener(move |view, _event, _window, _cx| {
                (callbacks.on_toggle_companion_azookey)(view)
            }),
        ))
        .child(state_button(
            "companion-translation",
            format!(
                "Translation: {}",
                if settings.companion_translation_on_mobile { "Mobile" } else { "Desktop" }
            ),
            settings.companion_translation_on_mobile,
            cx.listener(move |view, _event, _window, _cx| {
                (callbacks.on_toggle_companion_translation)(view)
            }),
        ))
        .when_some(companion_endpoint.map(str::to_string), |this, endpoint| {
            this.child(muted(format!("LAN endpoint: {endpoint}"))).child(button(
                "copy-companion-endpoint",
                "Copy LAN endpoint",
                cx.listener(move |view, _event, _window, cx| {
                    (callbacks.on_copy_companion_endpoint)(view, cx)
                }),
            ))
        })
        .when_some(companion_pairing_token.map(str::to_string), |this, token| {
            this.child(muted(format!("Pairing token: {token}"))).child(button(
                "copy-companion-token",
                "Copy pairing token",
                cx.listener(move |view, _event, _window, cx| {
                    (callbacks.on_copy_companion_token)(view, cx)
                }),
            ))
        })
        .child(muted(format!("Companion: {}", companion_device.unwrap_or("not connected"))))
        .child(muted(format!("Saved device routes: {companion_saved_devices}")))
        .when_some(companion_capabilities.cloned(), |this, capabilities| {
            this.child(muted(format!(
                "Mobile APIs — ASR: {}, AzooKey: {}, Translation: {}",
                availability_label(capabilities.asr_available),
                availability_label(capabilities.azookey_available),
                availability_label(capabilities.translation_available),
            )))
        })
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

fn availability_label(available: bool) -> &'static str {
    if available {
        "Available"
    } else {
        "Unavailable"
    }
}
