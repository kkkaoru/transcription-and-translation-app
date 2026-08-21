//! Live tab: device pick, start/stop, caption preview, status pill.

use gpui::prelude::*;
use gpui::{div, px, relative, rgb, Context, ElementId, IntoElement, SharedString};

use crate::capture::CaptureController;
use crate::domain::{format_rms, rms_level_color, rms_to_fraction, CaptureStatus};
use crate::ui::{
    button, card, error_line, heading, muted, status_pill, COLOR_CARD, COLOR_GHOST_HOVER,
};

pub struct LiveCallbacks<V> {
    pub on_refresh: fn(&mut V),
    pub on_toggle_select: fn(&mut V),
    pub on_select_device: fn(&mut V, &str),
    pub on_start: fn(&mut V),
    pub on_stop: fn(&mut V),
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
    cx: &mut Context<V>,
    callbacks: &LiveCallbacks<V>,
) -> impl IntoElement {
    let snapshot = capture.snapshot();
    let callbacks = *callbacks;
    let has_devices = !snapshot.devices.is_empty();
    let selected = snapshot
        .devices
        .iter()
        .find(|device| Some(device.id.as_str()) == snapshot.selected_device_id.as_deref())
        .map(|device| {
            if device.is_default {
                format!("{} (既定)", device.name)
            } else {
                device.name.clone()
            }
        })
        .unwrap_or_else(|| "マイク未検出".to_string());
    let device_count = snapshot.devices.len();
    let source = snapshot.displayed_source_text().to_string();
    let translation = if snapshot.translation_text.is_empty() {
        None
    } else {
        Some(snapshot.translation_text.clone())
    };
    let level = snapshot.last_rms_dbfs;
    let level_fraction = rms_to_fraction(level);
    let level_color = rms_level_color(level);

    let trigger = if has_devices {
        div()
            .id("live-device-select")
            .flex()
            .items_center()
            .justify_between()
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(rgb(0xd5e6f2))
            .bg(rgb(COLOR_CARD))
            .cursor_pointer()
            .hover(|mut style| {
                style.background = Some(rgb(COLOR_GHOST_HOVER).into());
                style
            })
            .on_click(
                cx.listener(move |view, _event, _window, _cx| (callbacks.on_toggle_select)(view)),
            )
            .child(SharedString::from(format!("{selected}（{device_count} 件）")))
    } else {
        div()
            .id("live-device-select")
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(rgb(0xd5e6f2))
            .bg(rgb(COLOR_CARD))
            .child(SharedString::from("マイク未検出"))
    };

    let dropdown = if select_open && has_devices {
        let options = snapshot
            .devices
            .iter()
            .enumerate()
            .map(|(index, device)| {
                let is_selected =
                    Some(device.id.as_str()) == snapshot.selected_device_id.as_deref();
                let label = if device.is_default {
                    format!("{} (既定)", device.name)
                } else {
                    device.name.clone()
                };
                let option_id = ElementId::named_usize("live-device-option", index);
                let option_bg = if is_selected { 0xe0f0f8 } else { COLOR_GHOST_HOVER };
                let hover_fill: gpui::Fill = rgb(option_bg).into();
                let id = device.id.clone();
                div()
                    .id(option_id)
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .hover(move |mut style| {
                        style.background = Some(hover_fill);
                        style
                    })
                    .on_click(cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_select_device)(view, &id)
                    }))
                    .child(SharedString::from(label))
            })
            .collect::<Vec<_>>();
        Some(
            div()
                .flex()
                .flex_col()
                .rounded_md()
                .border_1()
                .border_color(rgb(0xd5e6f2))
                .bg(rgb(COLOR_CARD))
                .children(options),
        )
    } else {
        None
    };

    card()
        .child(heading("ライブ"))
        .child(div().flex().items_center().gap_2().child(status_pill(
            snapshot.status.label(),
            snapshot.status == CaptureStatus::Capturing,
            snapshot.status == CaptureStatus::Error,
        )))
        .child(muted("入力デバイス"))
        .child(trigger)
        .when_some(dropdown, |this, menu| this.child(menu))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(muted(format!("レベル: {}", format_rms(level))))
                .child(div().h(px(8.)).w(px(160.)).rounded_md().bg(rgb(0xd5e6f2)).child(
                    div().h_full().rounded_md().bg(rgb(level_color)).w(relative(level_fraction)),
                )),
        )
        .child(
            div()
                .flex()
                .gap_2()
                .child(button(
                    "live-refresh",
                    "更新",
                    cx.listener(move |view, _event, _window, _cx| (callbacks.on_refresh)(view)),
                ))
                .child(button(
                    "live-start",
                    "開始",
                    cx.listener(move |view, _event, _window, _cx| (callbacks.on_start)(view)),
                ))
                .child(button(
                    "live-stop",
                    "停止",
                    cx.listener(move |view, _event, _window, _cx| (callbacks.on_stop)(view)),
                )),
        )
        .when_some(snapshot.last_error.clone(), |this, error| this.child(error_line(error)))
        .child(div().mt_2().child(SharedString::from("原文")))
        .child(div().text_lg().child(SharedString::from(source)))
        .when_some(translation, |this, text| {
            this.child(div().mt_2().child(SharedString::from("翻訳")))
                .child(div().text_lg().child(SharedString::from(text)))
        })
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
