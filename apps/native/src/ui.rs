//! Shared GPUI controls.

use gpui::prelude::*;
use std::sync::Arc;

use gpui::{
    div, img, rgb, App, ClickEvent, Context, ImageSource, IntoElement, RenderImage, SharedString,
    Window,
};
use image::{Frame, ImageBuffer, Rgba};
use smallvec::SmallVec;

use crate::domain::{AppTab, UiLanguage};
use crate::i18n::{text, TextKey};

pub const COLOR_BG: u32 = 0xf0f8ff;
pub const COLOR_TEXT: u32 = 0x173f5f;
pub const COLOR_CARD: u32 = 0xffffff;
pub const COLOR_ACCENT: u32 = 0x1aa6a6;
pub const COLOR_MUTED: u32 = 0x4f6f86;
pub const COLOR_ERROR: u32 = 0xb42318;
pub const COLOR_OK: u32 = 0x0f7b4c;
pub const COLOR_BUTTON_HOVER: u32 = 0x159191;
pub const COLOR_GHOST_HOVER: u32 = 0xc5e4f2;

pub fn render_image(image: caption_bridge_render::RgbaImage) -> Arc<RenderImage> {
    let buffer =
        ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(image.width, image.height, image.pixels)
            .unwrap_or_else(|| ImageBuffer::new(image.width, image.height));
    Arc::new(RenderImage::new(SmallVec::from_const([Frame::new(buffer)])))
}

pub fn image_view(image: Arc<RenderImage>) -> impl IntoElement {
    img(ImageSource::Render(image)).size_full()
}

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

pub fn heading(value: impl Into<SharedString>) -> impl IntoElement {
    div().text_lg().child(value.into())
}

pub fn muted(value: impl Into<SharedString>) -> impl IntoElement {
    div().text_color(rgb(COLOR_MUTED)).child(value.into())
}

pub fn editable_text(value: &str, caret: Option<usize>) -> gpui::Div {
    let caret = caret.filter(|index| *index <= value.len() && value.is_char_boundary(*index));
    let (before, after) = caret.map_or((value, ""), |index| value.split_at(index));
    div()
        .flex()
        .items_center()
        .child(SharedString::from(before.to_string()))
        .when(caret.is_some(), |this| {
            this.child(
                div().w(gpui::px(1.5)).h(gpui::px(18.0)).flex_shrink_0().bg(rgb(COLOR_ACCENT)),
            )
        })
        .child(SharedString::from(after.to_string()))
}

pub fn error_line(value: impl Into<SharedString>) -> impl IntoElement {
    div().text_color(rgb(COLOR_ERROR)).child(value.into())
}

pub fn button(
    id: impl Into<gpui::ElementId>,
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

pub fn state_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    active: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let background = if active { rgb(COLOR_OK) } else { rgb(COLOR_MUTED) };
    div()
        .id(id)
        .px_3()
        .py_1()
        .rounded_md()
        .bg(background)
        .text_color(rgb(0xffffff))
        .cursor_pointer()
        .on_click(on_click)
        .child(label.into())
}

fn tab_button<V: 'static>(
    tab: AppTab,
    label: &'static str,
    selected: AppTab,
    cx: &mut Context<V>,
    on_select: fn(&mut V, AppTab),
) -> impl IntoElement {
    let active = selected == tab;
    div()
        .id(gpui::ElementId::Name(format!("tab-{}", tab.label()).into()))
        .px_3()
        .py_1()
        .rounded_md()
        .bg(rgb(if active { COLOR_ACCENT } else { 0xdceef8 }))
        .text_color(rgb(if active { 0xffffff } else { COLOR_TEXT }))
        .cursor_pointer()
        .on_click(cx.listener(move |view, _event, _window, _cx| on_select(view, tab)))
        .child(SharedString::from(label))
}

pub fn tab_bar<V: 'static>(
    selected: AppTab,
    language: UiLanguage,
    cx: &mut Context<V>,
    on_select: fn(&mut V, AppTab),
) -> impl IntoElement {
    div()
        .flex()
        .gap_2()
        .child(tab_button(AppTab::Live, text(language, TextKey::Live), selected, cx, on_select))
        .child(tab_button(AppTab::Style, text(language, TextKey::Style), selected, cx, on_select))
        .child(tab_button(
            AppTab::Dictionary,
            text(language, TextKey::Dictionary),
            selected,
            cx,
            on_select,
        ))
        .child(tab_button(AppTab::Output, text(language, TextKey::Output), selected, cx, on_select))
        .child(tab_button(
            AppTab::Settings,
            text(language, TextKey::Settings),
            selected,
            cx,
            on_select,
        ))
}
