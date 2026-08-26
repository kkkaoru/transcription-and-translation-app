//! Shared GPUI Component compositions.

use std::sync::Arc;

use gpui::prelude::*;
use gpui::{
    img, App, ClickEvent, Context, ImageSource, IntoElement, RenderImage, SharedString, Window,
};
use gpui_component::alert::Alert;
use gpui_component::button::Button;
use gpui_component::label::Label;
use gpui_component::tab::{Tab, TabBar};
use gpui_component::{v_flex, ActiveTheme as _, StyledExt as _};
use image::{Frame, ImageBuffer, Rgba};
use smallvec::SmallVec;

use crate::domain::{AppTab, UiLanguage};
use crate::i18n::{text, TextKey};

pub fn render_image(image: caption_bridge_render::RgbaImage) -> Arc<RenderImage> {
    let buffer =
        ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(image.width, image.height, image.pixels)
            .unwrap_or_else(|| ImageBuffer::new(image.width, image.height));
    Arc::new(RenderImage::new(SmallVec::from_const([Frame::new(buffer)])))
}

pub fn image_view(image: Arc<RenderImage>) -> impl IntoElement {
    img(ImageSource::Render(image)).size_full()
}

pub fn sky_page(cx: &App) -> gpui::Div {
    v_flex()
        .gap_3()
        .p_4()
        .size_full()
        .bg(cx.theme().background)
        .text_color(cx.theme().foreground)
        .text_base()
}

pub fn card(cx: &App) -> gpui::Div {
    v_flex()
        .gap_3()
        .p_4()
        .rounded(cx.theme().radius)
        .bg(cx.theme().group_box)
        .border_1()
        .border_color(cx.theme().border)
}

pub fn heading(value: impl Into<SharedString>) -> impl IntoElement {
    Label::new(value).font_semibold()
}

pub fn muted(value: impl Into<SharedString>, cx: &App) -> impl IntoElement {
    Label::new(value).text_sm().text_color(cx.theme().muted_foreground)
}

pub fn editable_text(value: &str, caret: Option<usize>, cx: &App) -> gpui::Div {
    let caret = caret.filter(|index| *index <= value.len() && value.is_char_boundary(*index));
    let (before, after) = caret.map_or((value, ""), |index| value.split_at(index));
    gpui_component::h_flex()
        .child(SharedString::from(before.to_string()))
        .when(caret.is_some(), |this| {
            this.child(gpui::div().w_0p5().h_4().flex_shrink_0().bg(cx.theme().primary))
        })
        .child(SharedString::from(after.to_string()))
}

pub fn error_line(value: impl Into<gpui_component::text::Text>) -> impl IntoElement {
    Alert::error("inline-error", value).banner()
}

pub fn button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    Button::new(id).label(label).on_click(on_click)
}

pub fn danger_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    _cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Button {
    Button::new(id).outline().label(label).on_click(on_click)
}

pub fn tab_bar<V: 'static>(
    selected: AppTab,
    language: UiLanguage,
    cx: &mut Context<V>,
    on_select: fn(&mut V, AppTab),
) -> impl IntoElement {
    let tabs = [AppTab::Live, AppTab::Style, AppTab::Dictionary, AppTab::Settings];
    let selected_index = tabs.iter().position(|tab| *tab == selected).unwrap_or_default();

    TabBar::new("main-tabs")
        .pill()
        .selected_index(selected_index)
        .on_click(cx.listener(move |view, index, _window, _cx| {
            if let Some(tab) = tabs.get(*index).copied() {
                on_select(view, tab);
            }
        }))
        .child(Tab::new().label(text(language, TextKey::Live)))
        .child(Tab::new().label(text(language, TextKey::Style)))
        .child(Tab::new().label(text(language, TextKey::Dictionary)))
        .child(Tab::new().label(text(language, TextKey::Settings)))
}
