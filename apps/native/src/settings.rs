//! Runtime settings and build information.

use gpui::prelude::*;
use gpui::{Context, IntoElement};
use gpui_component::button::{Button, ButtonGroup};
use gpui_component::group_box::{GroupBox, GroupBoxVariants as _};
use gpui_component::label::Label;
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, Selectable as _, StyledExt as _};
use rust_lib_kotoba_beacon_companion::api::simple::{
    ExecutionDevice, MobileCapabilities, PipelineRoute,
};

use crate::domain::{NativeAppSettings, UiLanguage, BUILD_ID, RECOGNITION_MODE_LABEL};
use crate::i18n::{text, TextKey};
use crate::ui::{button, card, error_line, heading, muted};

pub struct SettingsRuntimeInfo<'a> {
    pub translation_model_installed: bool,
    pub syphon_on: bool,
    pub companion_endpoint: Option<&'a str>,
    pub companion_pairing_token: Option<&'a str>,
    pub companion_device: Option<&'a str>,
    pub companion_session_id: Option<&'a str>,
    pub companion_route: Option<PipelineRoute>,
    pub companion_capabilities: Option<&'a MobileCapabilities>,
    pub companion_saved_devices: usize,
    pub persist_error: Option<&'a str>,
}

pub struct SettingsCallbacks<V> {
    pub on_toggle_details: fn(&mut V),
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
    show_details: bool,
    runtime: &SettingsRuntimeInfo<'_>,
    cx: &mut Context<V>,
    callbacks: SettingsCallbacks<V>,
) -> impl IntoElement {
    let language = settings.ui_language;
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
                    .child(muted(text(language, TextKey::ProcessingAssignment), cx))
                    .child(stage_location_control(
                        "companion-asr",
                        "ASR",
                        language,
                        settings.companion_asr_on_mobile,
                        cx,
                        callbacks.on_toggle_companion_asr,
                    ))
                    .child(stage_location_control(
                        "companion-azookey",
                        "AzooKey",
                        language,
                        settings.companion_azookey_on_mobile,
                        cx,
                        callbacks.on_toggle_companion_azookey,
                    ))
                    .child(stage_location_control(
                        "companion-translation",
                        text(language, TextKey::Translation),
                        language,
                        settings.companion_translation_on_mobile,
                        cx,
                        callbacks.on_toggle_companion_translation,
                    ))
                    .when_some(runtime.companion_endpoint.map(str::to_string), |this, endpoint| {
                        this.child(
                            h_flex()
                                .gap_3()
                                .child(button(
                                    "copy-companion-endpoint",
                                    text(language, TextKey::CopyLanEndpoint),
                                    cx.listener(move |view, _event, _window, cx| {
                                        (callbacks.on_copy_companion_endpoint)(view, cx);
                                    }),
                                ))
                                .when(show_details, |this| {
                                    this.child(
                                        Label::new(format!(
                                            "{}: {endpoint}",
                                            text(language, TextKey::LanEndpoint)
                                        ))
                                        .text_sm(),
                                    )
                                }),
                        )
                    })
                    .when_some(
                        runtime.companion_pairing_token.map(str::to_string),
                        |this, token| {
                            this.child(
                                h_flex()
                                    .gap_3()
                                    .child(button(
                                        "copy-companion-token",
                                        text(language, TextKey::CopyPairingToken),
                                        cx.listener(move |view, _event, _window, cx| {
                                            (callbacks.on_copy_companion_token)(view, cx);
                                        }),
                                    ))
                                    .when(show_details, |this| {
                                        this.child(
                                            Label::new(format!(
                                                "{}: {token}",
                                                text(language, TextKey::PairingToken)
                                            ))
                                            .text_sm(),
                                        )
                                    }),
                            )
                        },
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
                        this.child(Label::new(RECOGNITION_MODE_LABEL).text_sm()).child(muted(
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

fn stage_location_control<V: 'static>(
    id: &'static str,
    stage: &'static str,
    language: UiLanguage,
    mobile: bool,
    cx: &mut Context<V>,
    on_change: fn(&mut V),
) -> impl IntoElement {
    h_flex().gap_3().child(Label::new(stage).w_24().font_semibold()).child(
        ButtonGroup::new(id)
            .w_56()
            .outline()
            .on_click(cx.listener(move |view, selected: &Vec<usize>, _window, _cx| {
                if selected.first().is_some_and(|index| (*index == 1) != mobile) {
                    on_change(view);
                }
            }))
            .child(
                Button::new(format!("{id}-desktop"))
                    .flex_1()
                    .label(text(language, TextKey::Desktop))
                    .accessibility_id(format!("{stage}: {}", text(language, TextKey::Desktop)))
                    .selected(!mobile),
            )
            .child(
                Button::new(format!("{id}-mobile"))
                    .flex_1()
                    .label(text(language, TextKey::Mobile))
                    .accessibility_id(format!("{stage}: {}", text(language, TextKey::Mobile)))
                    .selected(mobile),
            ),
    )
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
            Label::new(format!("{}: {connection_status}", text(language, TextKey::Connection)))
                .font_semibold(),
        )
        .child(Label::new(format!(
            "{}: Bonjour / UDP 18184",
            text(language, TextKey::AutomaticDiscovery)
        )))
        .child(Label::new(format!(
            "{}: {}",
            text(language, TextKey::Companion),
            runtime.companion_device.unwrap_or(text(language, TextKey::NotConnected)),
        )))
        .when_some(runtime.companion_session_id.map(str::to_string), |this, session_id| {
            this.child(Label::new(format!("{}: {session_id}", text(language, TextKey::Session))))
        })
        .when_some(runtime.companion_route, |this, route| {
            this.child(Label::new(format!(
                "{}: {}",
                text(language, TextKey::SynchronizedRoute),
                localized_pipeline_route(route, language)
            )))
        })
        .child(Label::new(format!(
            "{}: {}",
            text(language, TextKey::SavedDeviceRoutes),
            runtime.companion_saved_devices,
        )))
        .when_some(runtime.companion_capabilities.cloned(), |this, capabilities| {
            this.child(Label::new(format!(
                "{}: {}",
                text(language, TextKey::MobilePlatform),
                capabilities.platform
            )))
            .child(Label::new(format!(
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
