//! Runtime settings and build information.

use gpui::prelude::*;
use gpui::{Context, IntoElement};
use gpui_component::button::Button;
use gpui_component::group_box::{GroupBox, GroupBoxVariants as _};
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, Disableable as _, Selectable as _, StyledExt as _};
use rust_lib_kotoba_beacon_companion::api::simple::{
    ExecutionDevice, MobileCapabilities, PipelineRoute,
};

use crate::domain::{NativeAppSettings, UiLanguage, BUILD_ID, RECOGNITION_MODE_LABEL};
use crate::i18n::{text, TextKey};
use crate::ui::{card, error_line, heading, muted, selectable_text};

pub struct SettingsRuntimeInfo<'a> {
    pub translation_model_installed: bool,
    pub syphon_on: bool,
    pub companion_endpoint: Option<&'a str>,
    pub companion_pairing_token: Option<&'a str>,
    pub companion_device: Option<&'a str>,
    pub companion_session_id: Option<&'a str>,
    pub companion_route: Option<PipelineRoute>,
    pub companion_capabilities: Option<&'a MobileCapabilities>,
    pub persist_error: Option<&'a str>,
}

pub struct SettingsCallbacks<V> {
    pub on_toggle_details: fn(&mut V),
    pub on_language: fn(&mut V, UiLanguage),
    pub on_toggle_translation: fn(&mut V),
    pub on_timeout: fn(&mut V, u64),
    pub on_toggle_syphon: fn(&mut V),
    pub on_toggle_companion: fn(&mut V),
    pub on_copy_companion_endpoint: fn(&mut V, &mut Context<V>),
    pub on_copy_companion_token: fn(&mut V, &mut Context<V>),
}

pub fn render_settings<V: 'static>(
    settings: &NativeAppSettings,
    show_details: bool,
    runtime: &SettingsRuntimeInfo<'_>,
    cx: &mut Context<V>,
    callbacks: SettingsCallbacks<V>,
) -> impl IntoElement {
    let language = settings.ui_language;
    let companion_endpoint = runtime.companion_endpoint.map(str::to_string);
    let companion_token = runtime.companion_pairing_token.map(str::to_string);
    let content = card(cx)
        .flex_shrink_0()
        .child(
            h_flex()
                .justify_between()
                .gap_3()
                .child(heading(text(language, TextKey::Settings)))
                .child(
                    Switch::new("settings-show-details")
                        .label(text(language, TextKey::ShowDetails))
                        .checked(show_details)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_details)(view);
                        })),
                ),
        )
        .child(
            GroupBox::new().outline().title(text(language, TextKey::UiLanguage)).child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("language-japanese")
                            .selected(language == UiLanguage::Japanese)
                            .toggled(language == UiLanguage::Japanese)
                            .label(text(language, TextKey::Japanese))
                            .on_click(cx.listener(move |view, _event, _window, _cx| {
                                (callbacks.on_language)(view, UiLanguage::Japanese);
                            })),
                    )
                    .child(
                        Button::new("language-english")
                            .selected(language == UiLanguage::English)
                            .toggled(language == UiLanguage::English)
                            .label(text(language, TextKey::English))
                            .on_click(cx.listener(move |view, _event, _window, _cx| {
                                (callbacks.on_language)(view, UiLanguage::English);
                            })),
                    ),
            ),
        )
        .child(
            GroupBox::new().outline().title(text(language, TextKey::Translation)).child(
                v_flex()
                    .gap_2()
                    .child(
                        Switch::new("translation-enabled")
                            .label(text(language, TextKey::Translation))
                            .checked(settings.translation_enabled)
                            .on_click(cx.listener(move |view, _checked, _window, _cx| {
                                (callbacks.on_toggle_translation)(view);
                            })),
                    )
                    .when(show_details, |this| {
                        this.child(muted(
                            format!(
                                "{}: {}",
                                text(language, TextKey::TranslationModel),
                                text(
                                    language,
                                    if runtime.translation_model_installed {
                                        TextKey::Installed
                                    } else {
                                        TextKey::Missing
                                    },
                                ),
                            ),
                            cx,
                        ))
                    }),
            ),
        )
        .child(
            GroupBox::new().outline().title(text(language, TextKey::MobileCompanion)).child(
                v_flex()
                    .gap_3()
                    .child(
                        Switch::new("settings-mobile-companion-enabled")
                            .label(text(language, TextKey::MobileCompanion))
                            .checked(settings.companion_enabled)
                            .on_click(cx.listener(move |view, _checked, _window, _cx| {
                                (callbacks.on_toggle_companion)(view);
                            })),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .child(
                                Button::new("copy-companion-endpoint")
                                    .label(text(language, TextKey::CopyLanEndpoint))
                                    .disabled(!settings.companion_enabled)
                                    .on_click(cx.listener(move |view, _event, _window, cx| {
                                        (callbacks.on_copy_companion_endpoint)(view, cx);
                                    })),
                            )
                            .when_some(
                                show_details.then_some(companion_endpoint).flatten(),
                                |this, endpoint| {
                                    this.child(
                                        selectable_text(format!(
                                            "{}: {endpoint}",
                                            text(language, TextKey::LanEndpoint)
                                        ))
                                        .text_sm(),
                                    )
                                },
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .child(
                                Button::new("copy-companion-token")
                                    .label(text(language, TextKey::CopyPairingToken))
                                    .disabled(!settings.companion_enabled)
                                    .on_click(cx.listener(move |view, _event, _window, cx| {
                                        (callbacks.on_copy_companion_token)(view, cx);
                                    })),
                            )
                            .when_some(
                                show_details.then_some(companion_token).flatten(),
                                |this, token| {
                                    this.child(
                                        selectable_text(format!(
                                            "{}: {token}",
                                            text(language, TextKey::PairingToken)
                                        ))
                                        .text_sm(),
                                    )
                                },
                            ),
                    )
                    .when(show_details, |this| this.child(companion_status(runtime, language))),
            ),
        )
        .child(GroupBox::new().outline().title(text(language, TextKey::CaptionTimeout)).child(
            h_flex().flex_wrap().gap_2().children((1_u64..=10).map(|seconds| {
                let timeout = seconds * 1_000;
                Button::new(format!("caption-timeout-{seconds}"))
                    .selected(settings.caption_timeout_ms == timeout)
                    .toggled(settings.caption_timeout_ms == timeout)
                    .label(format!("{seconds}s"))
                    .on_click(cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_timeout)(view, timeout);
                    }))
            })),
        ))
        .child(
            GroupBox::new().outline().title(text(language, TextKey::RecognitionEngine)).child(
                v_flex()
                    .gap_2()
                    .child(
                        Switch::new("settings-syphon")
                            .label(text(language, TextKey::Syphon))
                            .checked(runtime.syphon_on)
                            .on_click(cx.listener(move |view, _checked, _window, _cx| {
                                (callbacks.on_toggle_syphon)(view);
                            })),
                    )
                    .when(show_details, |this| {
                        this.child(selectable_text(RECOGNITION_MODE_LABEL).text_sm()).child(muted(
                            format!("{}: {BUILD_ID}", text(language, TextKey::BuildId),),
                            cx,
                        ))
                    }),
            ),
        )
        .when_some(runtime.persist_error.map(str::to_string), |this, error| {
            this.child(error_line(error))
        });

    v_flex().id("settings-scroll").size_full().min_h_0().overflow_y_scroll().pb_3().child(content)
}

fn companion_status(runtime: &SettingsRuntimeInfo<'_>, language: UiLanguage) -> impl IntoElement {
    let connection_status = text(
        language,
        if runtime.companion_session_id.is_some() {
            TextKey::ConnectedAuthenticated
        } else {
            TextKey::WaitingMobileCompanion
        },
    );
    v_flex()
        .gap_2()
        .child(
            selectable_text(format!(
                "{}: {connection_status}",
                text(language, TextKey::Connection)
            ))
            .font_semibold(),
        )
        .child(selectable_text(format!(
            "{}: Bonjour / UDP 18184",
            text(language, TextKey::AutomaticDiscovery)
        )))
        .child(selectable_text(format!(
            "{}: {}",
            text(language, TextKey::Companion),
            runtime.companion_device.unwrap_or(text(language, TextKey::NotConnected)),
        )))
        .when_some(runtime.companion_session_id.map(str::to_string), |this, session_id| {
            this.child(selectable_text(format!(
                "{}: {session_id}",
                text(language, TextKey::Session)
            )))
        })
        .when_some(runtime.companion_route, |this, route| {
            this.child(selectable_text(format!(
                "{}: {}",
                text(language, TextKey::SynchronizedRoute),
                localized_pipeline_route(route, language)
            )))
        })
        .when_some(runtime.companion_capabilities.cloned(), |this, capabilities| {
            this.child(selectable_text(format!(
                "{}: {}",
                text(language, TextKey::MobilePlatform),
                capabilities.platform
            )))
            .child(selectable_text(format!(
                "{} — ASR: {}, AzooKey: {}, {}: {}",
                text(language, TextKey::MobileApis),
                availability_label(capabilities.asr_available, language),
                availability_label(capabilities.azookey_available, language),
                text(language, TextKey::Translation),
                availability_label(capabilities.translation_available, language),
            )))
        })
}

fn localized_pipeline_route(route: PipelineRoute, language: UiLanguage) -> String {
    format!(
        "ASR: {}, AzooKey: {}, {}: {}",
        execution_device_label(route.asr, language),
        execution_device_label(route.azookey, language),
        text(language, TextKey::Translation),
        execution_device_label(route.translation, language),
    )
}

fn execution_device_label(device: ExecutionDevice, language: UiLanguage) -> &'static str {
    match device {
        ExecutionDevice::Desktop => text(language, TextKey::Desktop),
        ExecutionDevice::Mobile => text(language, TextKey::Mobile),
    }
}

fn availability_label(available: bool, language: UiLanguage) -> &'static str {
    text(language, if available { TextKey::Available } else { TextKey::Unavailable })
}
