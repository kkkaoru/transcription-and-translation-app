//! Shared pale-sky GPUI chrome used by every tab.

use gpui::prelude::*;
use gpui::{
    div, px, rgb, App, ClickEvent, Context, InteractiveElement, IntoElement, SharedString, Window,
};

use crate::domain::AppTab;

pub const COLOR_BG: u32 = 0xf0f8ff;
pub const COLOR_TEXT: u32 = 0x173f5f;
pub const COLOR_CARD: u32 = 0xffffff;
pub const COLOR_ACCENT: u32 = 0x1aa6a6;
pub const COLOR_MUTED: u32 = 0x4f6f86;
pub const COLOR_ERROR: u32 = 0xb42318;
pub const COLOR_OK: u32 = 0x0f7b4c;
pub const COLOR_BUTTON_HOVER: u32 = 0x159191;
pub const COLOR_GHOST_HOVER: u32 = 0xc5e4f2;

pub fn sky_page() -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap_3()
        .p_4()
        .size_full()
        .bg(rgb(COLOR_BG))
        .text_color(rgb(COLOR_TEXT))
        .text_sm()
}

pub fn card() -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap_2()
        .p_3()
        .rounded_md()
        .bg(rgb(COLOR_CARD))
        .border_1()
        .border_color(rgb(0xd5e6f2))
}

pub fn heading(text: impl Into<SharedString>) -> impl IntoElement {
    div().text_lg().child(text.into())
}

pub fn muted(text: impl Into<SharedString>) -> impl IntoElement {
    div().text_color(rgb(COLOR_MUTED)).child(text.into())
}

pub fn error_line(text: impl Into<SharedString>) -> impl IntoElement {
    div().text_color(rgb(COLOR_ERROR)).child(text.into())
}

pub fn button(
    id: &'static str,
    label: impl Into<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let hover_fill: gpui::Fill = rgb(COLOR_BUTTON_HOVER).into();
    div()
        .id(id)
        .px_3()
        .py_1()
        .rounded_md()
        .bg(rgb(COLOR_ACCENT))
        .text_color(rgb(0xffffff))
        .cursor_pointer()
        .hover(move |mut style| {
            style.background = Some(hover_fill);
            style
        })
        .on_click(on_click)
        .child(label.into())
}

pub fn ghost_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    active: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let background = if active { rgb(COLOR_ACCENT) } else { rgb(0xdceef8) };
    let color = if active { rgb(0xffffff) } else { rgb(COLOR_TEXT) };
    let hover_color = if active { COLOR_BUTTON_HOVER } else { COLOR_GHOST_HOVER };
    let hover_fill: gpui::Fill = rgb(hover_color).into();
    div()
        .id(id)
        .px_3()
        .py_1()
        .rounded_md()
        .bg(background)
        .text_color(color)
        .cursor_pointer()
        .hover(move |mut style| {
            style.background = Some(hover_fill);
            style
        })
        .on_click(on_click)
        .child(label.into())
}

pub fn tab_bar<V: 'static>(
    selected: AppTab,
    cx: &mut Context<V>,
    on_select: fn(&mut V, AppTab),
) -> impl IntoElement {
    let live = AppTab::Live;
    let style = AppTab::Style;
    let dictionary = AppTab::Dictionary;
    let settings = AppTab::Settings;
    div()
        .flex()
        .gap_2()
        .child(ghost_button(
            "tab-live",
            format!("{} Live", live.japanese_label()),
            selected == live,
            cx.listener(move |view, _event, _window, _cx| on_select(view, live)),
        ))
        .child(ghost_button(
            "tab-style",
            format!("{} Style", style.japanese_label()),
            selected == style,
            cx.listener(move |view, _event, _window, _cx| on_select(view, style)),
        ))
        .child(ghost_button(
            "tab-dictionary",
            format!("{} Dictionary", dictionary.japanese_label()),
            selected == dictionary,
            cx.listener(move |view, _event, _window, _cx| on_select(view, dictionary)),
        ))
        .child(ghost_button(
            "tab-settings",
            format!("{} Settings", settings.japanese_label()),
            selected == settings,
            cx.listener(move |view, _event, _window, _cx| on_select(view, settings)),
        ))
}

pub fn field_row(
    label: impl Into<SharedString>,
    value: impl Into<SharedString>,
    minus_id: &'static str,
    plus_id: &'static str,
    on_minus: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_plus: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_2()
        .child(div().w(px(220.)).child(label.into()))
        .child(div().w(px(140.)).child(value.into()))
        .child(button(minus_id, "−", on_minus))
        .child(button(plus_id, "+", on_plus))
}

pub fn status_pill(
    label: impl Into<SharedString>,
    capturing: bool,
    error: bool,
) -> impl IntoElement {
    let color = if error {
        rgb(COLOR_ERROR)
    } else if capturing {
        rgb(COLOR_OK)
    } else {
        rgb(COLOR_MUTED)
    };
    div().px_2().py_1().rounded_md().bg(color).text_color(rgb(0xffffff)).child(label.into())
}
