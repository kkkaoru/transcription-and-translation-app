//! Live capture controls and recognition/translation results.

use gpui::prelude::*;
use gpui::{relative, rgb, ClipboardItem, Context, IntoElement, SharedString};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::label::Label;
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, Selectable as _};

use crate::capture::CaptureController;
use crate::domain::{format_rms, rms_level_color, rms_to_fraction, CaptureStatus, UiLanguage};
use crate::i18n::{text, TextKey};
use crate::ui::{button, card, error_line, heading, muted};

pub struct LiveCallbacks<V> {
    pub on_toggle_select: fn(&mut V),
    pub on_refresh_devices: fn(&mut V),
    pub on_select_device: fn(&mut V, &str),
    pub on_start: fn(&mut V),
    pub on_stop: fn(&mut V),
    pub on_toggle_translation: fn(&mut V),
}

impl<V> Clone for LiveCallbacks<V> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<V> Copy for LiveCallbacks<V> {}

pub fn render_live<V: 'static>(
    capture: &CaptureController,
    select_open: bool,
    language: UiLanguage,
    cx: &mut Context<V>,
    callbacks: &LiveCallbacks<V>,
) -> impl IntoElement {
    let snapshot = capture.snapshot();
    let callbacks = *callbacks;
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

    let trigger = Button::new("live-device-select")
        .label(selected)
        .dropdown_caret(true)
        .disabled(!has_devices)
        .on_click(cx.listener(move |view, _event, _window, _cx| {
            (callbacks.on_toggle_select)(view);
        }));

    let dropdown = (select_open && has_devices).then(|| {
        v_flex()
            .gap_2()
            .p_2()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().popover)
            .children(snapshot.devices.iter().map(|device| {
                let id = device.id.clone();
                Button::new(format!("live-device-option-{id}"))
                    .selected(Some(device.id.as_str()) == selected_device_id)
                    .label(device_label(device.name.as_str(), device.is_default, language))
                    .on_click(cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_select_device)(view, &id);
                    }))
            }))
    });

    let source = caption_or_placeholder(&snapshot.source_text, language);
    let translation = caption_or_placeholder(&snapshot.translation_text, language);
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
        .when_some(dropdown, |this, menu| this.child(menu))
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
                .gap_2()
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
                ),
        )
        .when_some(error_panel, |this, panel| this.child(panel))
        .child(
            v_flex()
                .gap_2()
                .child(muted(text(language, TextKey::RecognitionResult), cx))
                .child(Label::new(source).text_lg()),
        )
        .when(translation_enabled, |this| {
            this.child(
                v_flex()
                    .gap_2()
                    .child(muted(text(language, TextKey::TranslationResult), cx))
                    .child(Label::new(translation).text_lg()),
            )
        })
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
