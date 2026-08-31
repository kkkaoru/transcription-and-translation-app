//! Live capture controls and recognition/translation results.

use gpui::prelude::*;
use gpui::{relative, rgb, ClipboardItem, Context, IntoElement, SharedString};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, StyledExt as _};

use crate::capture::CaptureController;
use crate::domain::{
    format_rms, rms_level_color, rms_to_fraction, CaptureStatus, NativeAppSettings, UiLanguage,
};
use crate::i18n::{text, TextKey};
use crate::ui::{button, card, error_line, heading, muted, selectable_text};

pub struct LiveCallbacks<V> {
    pub on_refresh_devices: fn(&mut V),
    pub on_select_device: fn(&mut V, &str),
    pub on_start: fn(&mut V),
    pub on_stop: fn(&mut V),
    pub on_toggle_translation: fn(&mut V),
    pub on_toggle_recognition_result: fn(&mut V),
    pub on_toggle_translation_result: fn(&mut V),
}

impl<V> Clone for LiveCallbacks<V> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<V> Copy for LiveCallbacks<V> {}

pub fn render_live<V: 'static>(
    capture: &CaptureController,
    settings: &NativeAppSettings,
    cx: &mut Context<V>,
    callbacks: &LiveCallbacks<V>,
) -> impl IntoElement {
    let snapshot = capture.snapshot();
    let callbacks = *callbacks;
    let language = settings.ui_language;
    let has_devices = !snapshot.devices.is_empty();
    let selected_device_id = snapshot.selected_device_id.as_deref();
    let selected = snapshot
        .devices
        .iter()
        .find(|device| Some(device.id.as_str()) == selected_device_id)
        .map(|device| device_label(device.name.as_str(), device.is_default, language))
        .unwrap_or_else(|| text(language, TextKey::NoMicrophone).to_string());
    let level = snapshot.last_rms_dbfs;
    let level_fraction = rms_to_fraction(level);
    let level_color = rms_level_color(level);
    let capturing = snapshot.status == CaptureStatus::Capturing;
    let active = matches!(snapshot.status, CaptureStatus::Capturing | CaptureStatus::Stopping);
    let translation_enabled = capture.translation_enabled();
    let status_label = capture_status_label(snapshot.status, language);

    let device_options = snapshot
        .devices
        .iter()
        .map(|device| {
            (
                device.id.clone(),
                device_label(device.name.as_str(), device.is_default, language),
                Some(device.id.as_str()) == selected_device_id,
            )
        })
        .collect::<Vec<_>>();
    let view = cx.entity();
    let on_select_device = callbacks.on_select_device;
    let trigger = Button::new("live-device-select")
        .label(selected)
        .dropdown_caret(true)
        .disabled(!has_devices)
        .dropdown_menu(move |menu, _window, _cx| {
            device_options.iter().fold(menu, |menu, (id, label, selected)| {
                let id = id.clone();
                let view = view.clone();
                menu.item(PopupMenuItem::new(label.clone()).checked(*selected).on_click(
                    move |_event, _window, cx| {
                        view.update(cx, |view, cx| {
                            on_select_device(view, &id);
                            cx.notify();
                        });
                    },
                ))
            })
        });

    let source =
        caption_when_visible(&snapshot.source_text, language, settings.show_recognition_result);
    let translation = caption_when_visible(
        &snapshot.translation_text,
        language,
        settings.show_translation_result && translation_enabled,
    );
    let error_panel = snapshot.last_error.clone().map(|error| {
        let clipboard_error = error.clone();
        h_flex().justify_between().gap_2().child(error_line(error)).child(button(
            "live-copy-error",
            text(language, TextKey::CopyError),
            move |_event, _window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(clipboard_error.clone()));
            },
        ))
    });

    card(cx)
        .child(heading(text(language, TextKey::Live)))
        .child(
            h_flex()
                .justify_between()
                .gap_3()
                .child(muted(text(language, TextKey::InputDevice), cx))
                .child(button(
                    "live-refresh-devices",
                    text(language, TextKey::RefreshDevices),
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_refresh_devices)(view);
                    }),
                )),
        )
        .child(trigger)
        .child(
            h_flex()
                .gap_3()
                .child(muted(
                    format!("{}: {}", text(language, TextKey::Level), format_rms(level)),
                    cx,
                ))
                .child(
                    gpui::div().h_2().w_40().rounded_full().bg(cx.theme().muted).child(
                        gpui::div()
                            .h_full()
                            .rounded_full()
                            // The meter color is measured signal data, not application chrome.
                            .bg(rgb(level_color))
                            .w(relative(level_fraction)),
                    ),
                ),
        )
        .child(
            h_flex()
                .flex_wrap()
                .gap_2()
                .child(selectable_text(status_label).font_semibold())
                .child(
                    Button::new("live-start")
                        .primary()
                        .label(text(language, TextKey::Start))
                        .disabled(active)
                        .on_click(cx.listener(move |view, _event, _window, _cx| {
                            (callbacks.on_start)(view);
                        })),
                )
                .child(
                    Button::new("live-stop")
                        .label(text(language, TextKey::Stop))
                        .disabled(!active)
                        .on_click(cx.listener(move |view, _event, _window, _cx| {
                            (callbacks.on_stop)(view);
                        })),
                )
                .child(
                    Switch::new("live-translation-enabled")
                        .label(text(language, TextKey::Translation))
                        .checked(translation_enabled)
                        .disabled(capturing)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_translation)(view);
                        })),
                )
                .child(
                    Switch::new("live-show-recognition-result")
                        .label(text(language, TextKey::ShowRecognitionResult))
                        .checked(settings.show_recognition_result)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_recognition_result)(view);
                        })),
                )
                .child(
                    Switch::new("live-show-translation-result")
                        .label(text(language, TextKey::ShowTranslationResult))
                        .checked(settings.show_translation_result)
                        .on_click(cx.listener(move |view, _checked, _window, _cx| {
                            (callbacks.on_toggle_translation_result)(view);
                        })),
                ),
        )
        .when_some(error_panel, |this, panel| this.child(panel))
        .when_some(source, |this, source| {
            this.child(
                v_flex()
                    .gap_2()
                    .child(muted(text(language, TextKey::RecognitionResult), cx))
                    .child(selectable_text(source).min_h_7().text_lg()),
            )
        })
        .when_some(translation, |this, translation| {
            this.child(
                v_flex()
                    .gap_2()
                    .child(muted(text(language, TextKey::TranslationResult), cx))
                    .child(selectable_text(translation).min_h_7().text_lg()),
            )
        })
}

fn capture_status_label(status: CaptureStatus, language: UiLanguage) -> &'static str {
    text(
        language,
        match status {
            CaptureStatus::Idle => TextKey::StatusIdle,
            CaptureStatus::Capturing => TextKey::StatusCapturing,
            CaptureStatus::Stopping => TextKey::StatusStopping,
            CaptureStatus::Error => TextKey::StatusError,
        },
    )
}

fn caption_when_visible(value: &str, language: UiLanguage, visible: bool) -> Option<SharedString> {
    visible.then(|| caption_or_placeholder(value, language))
}

fn caption_or_placeholder(value: &str, language: UiLanguage) -> SharedString {
    if value.is_empty() {
        text(language, TextKey::NoCaption).into()
    } else {
        value.to_string().into()
    }
}

fn device_label(name: &str, is_default: bool, language: UiLanguage) -> String {
    if is_default {
        format!("{} ({})", name, text(language, TextKey::DefaultDevice))
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        METER_CLIP_COLOR, METER_CLIP_THRESHOLD_DB, METER_MAX_DB, METER_MIN_DB, METER_NORMAL_COLOR,
        METER_NORMAL_THRESHOLD_DB, METER_QUIET_COLOR,
    };

    #[test]
    fn hidden_results_do_not_allocate_render_text() {
        assert_eq!(caption_when_visible("recognition", UiLanguage::English, false), None);
        assert_eq!(caption_when_visible("translation", UiLanguage::Japanese, false), None);
        assert_eq!(
            caption_when_visible("recognition", UiLanguage::English, true),
            Some(SharedString::from("recognition")),
        );
    }

    #[test]
    fn capture_status_is_expressed_in_text_for_every_state() {
        for status in [
            CaptureStatus::Idle,
            CaptureStatus::Capturing,
            CaptureStatus::Stopping,
            CaptureStatus::Error,
        ] {
            assert!(capture_status_label(status, UiLanguage::English).starts_with("Status: "));
            assert!(capture_status_label(status, UiLanguage::Japanese).starts_with("状態: "));
        }
    }

    #[test]
    fn rms_fraction_clamps_to_zero_and_one() {
        assert_eq!(rms_to_fraction(Some(METER_MIN_DB)), 0.0);
        assert_eq!(rms_to_fraction(Some(METER_MAX_DB)), 1.0);
        assert!((rms_to_fraction(Some(-30.0)) - 0.5).abs() < 0.01);
        assert_eq!(rms_to_fraction(None), 0.0);
        assert_eq!(rms_to_fraction(Some(f32::NEG_INFINITY)), 0.0);
    }

    #[test]
    fn rms_color_changes_at_thresholds() {
        assert_eq!(rms_level_color(Some(METER_MIN_DB)), METER_QUIET_COLOR);
        assert_eq!(rms_level_color(Some(-25.0)), METER_QUIET_COLOR);
        assert_eq!(rms_level_color(Some(METER_NORMAL_THRESHOLD_DB)), METER_NORMAL_COLOR);
        assert_eq!(rms_level_color(Some(METER_CLIP_THRESHOLD_DB)), METER_CLIP_COLOR);
    }
}
