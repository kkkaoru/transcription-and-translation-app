//! Scrollable Native caption style editor with continuous range and color controls.

use std::{rc::Rc, sync::Arc};

use gpui::prelude::*;
use gpui::{
    canvas, div, px, relative, rems, Bounds, Context, IntoElement, MouseDownEvent, MouseMoveEvent,
    Pixels, Point, RenderImage, SharedString,
};
use gpui_component::button::Button;
use gpui_component::label::Label;
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, ActiveTheme as _, Selectable as _, StyledExt as _};

use crate::domain::{NativeStyleProfile, NativeStyleSettings, UiLanguage};
use crate::i18n::{text, TextKey};
use crate::ui::{
    button, card, editable_text, error_line, heading, image_view, muted, render_image,
};

const PREVIEW_WIDTH_PX: f32 = 560.0;
const PREVIEW_HEIGHT_PX: f32 = 157.5;

macro_rules! slider {
    ($id:expr, $label:expr, $value:expr, $min:expr, $max:expr, $step:expr, $style:expr, $cx:expr, $on_change:expr, $set:expr $(,)?) => {
        slider_control(
            SliderSpec {
                id: $id,
                label: $label,
                value: $value,
                min: $min,
                max: $max,
                step: $step,
                set: $set,
            },
            $style,
            $cx,
            $on_change,
        )
    };
}

macro_rules! color_picker {
    ($id:expr, $label:expr, $value:expr, $active:expr, $language:expr, $on_toggle:expr, $style:expr, $cx:expr, $on_change:expr, $set:expr $(,)?) => {
        color_picker_control(
            ColorPickerSpec { id: $id, label: $label, value: $value, active: $active, set: $set },
            $style,
            $cx,
            $on_change,
            $on_toggle,
        )
    };
}

macro_rules! toggle {
    ($id:expr, $label:expr, $value:expr, $language:expr, $style:expr, $cx:expr, $on_change:expr, $set:expr $(,)?) => {
        toggle_control(
            ToggleSpec { id: $id, label: $label, value: $value, set: $set },
            $style,
            $cx,
            $on_change,
        )
    };
}

pub struct StyleCallbacks<V> {
    pub on_add_profile: fn(&mut V),
    pub on_select_profile: fn(&mut V, &str),
    pub on_delete_profile: fn(&mut V),
    pub on_change: fn(&mut V, NativeStyleSettings),
    pub on_font_focus: fn(&mut V, &mut gpui::Window, &mut Context<V>),
    pub on_font_select: fn(&mut V, &str),
    pub on_preview_source_focus: fn(&mut V, &mut gpui::Window, &mut Context<V>),
    pub on_preview_translation_focus: fn(&mut V, &mut gpui::Window, &mut Context<V>),
    pub on_color_toggle: fn(&mut V, &str),
}

pub struct StyleViewState<'a> {
    pub profiles: &'a [NativeStyleProfile],
    pub selected_profile_id: &'a str,
    pub preview_source: &'a str,
    pub preview_translation: &'a str,
    pub preview_image: Arc<RenderImage>,
    pub fonts: FontPickerState<'a>,
    pub language: UiLanguage,
    pub active_color_picker: Option<&'a str>,
    pub preview_source_caret: Option<usize>,
    pub preview_translation_caret: Option<usize>,
    pub persist_error: Option<&'a str>,
}

pub struct FontPickerState<'a> {
    pub query: &'a str,
    pub families: &'a [String],
    pub open: bool,
    pub caret: Option<usize>,
}

struct ColorPickerSpec<'a> {
    id: &'static str,
    label: &'static str,
    value: &'a str,
    active: bool,
    set: fn(&mut NativeStyleSettings, &str),
}

struct SliderSpec {
    id: &'static str,
    label: &'static str,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    set: fn(&mut NativeStyleSettings, f32),
}

struct RangeSpec {
    id: String,
    label: &'static str,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    accent: gpui::Rgba,
}

struct ColorSquareSpec {
    id: String,
    hue: f32,
    saturation: f32,
    brightness: f32,
    set: fn(&mut NativeStyleSettings, &str),
}

struct HueBarSpec {
    id: String,
    hue: f32,
    saturation: f32,
    brightness: f32,
    set: fn(&mut NativeStyleSettings, &str),
}

struct ToggleSpec {
    id: &'static str,
    label: &'static str,
    value: bool,
    set: fn(&mut NativeStyleSettings, bool),
}

type RangeUpdate<V> = Rc<dyn Fn(&mut V, f32)>;

pub fn render_style<V: 'static>(
    style: &NativeStyleSettings,
    state: StyleViewState<'_>,
    cx: &mut Context<V>,
    callbacks: StyleCallbacks<V>,
) -> impl IntoElement {
    let StyleViewState {
        profiles,
        selected_profile_id,
        preview_source,
        preview_translation,
        preview_image,
        fonts,
        language,
        active_color_picker,
        preview_source_caret,
        preview_translation_caret,
        persist_error,
    } = state;

    let mut profile_buttons = h_flex().flex_wrap().gap_2();
    for profile in profiles {
        let id = profile.id.clone();
        let label = if profile.id == selected_profile_id {
            format!("✓ {}", profile.name)
        } else {
            profile.name.clone()
        };
        profile_buttons = profile_buttons.child(button(
            format!("style-profile-{}", profile.id),
            label,
            cx.listener(move |view, _event, _window, _cx| (callbacks.on_select_profile)(view, &id)),
        ));
    }
    let profiles = card(cx)
        .flex_shrink_0()
        .child(heading(text(language, TextKey::StyleProfiles)))
        .child(profile_buttons)
        .child(
            h_flex()
                .flex_wrap()
                .gap_2()
                .child(button(
                    "style-profile-add",
                    text(language, TextKey::AddStyle),
                    cx.listener(move |view, _event, _window, _cx| (callbacks.on_add_profile)(view)),
                ))
                .child(button(
                    "style-profile-delete",
                    text(language, TextKey::DeleteStyle),
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_delete_profile)(view)
                    }),
                )),
        );

    let preview_image = div()
        .w(px(PREVIEW_WIDTH_PX))
        .h(px(PREVIEW_HEIGHT_PX))
        .flex_shrink_0()
        .rounded_md()
        .overflow_hidden()
        .bg(parse_rgb(&style.preview_background_color))
        .child(image_view(preview_image));
    let preview_controls = v_flex()
        .flex_1()
        .min_w_0()
        .gap_2()
        .child(preview_input(
            "preview-source-input",
            text(language, TextKey::PreviewRecognition),
            preview_source,
            preview_source_caret,
            cx,
            callbacks.on_preview_source_focus,
        ))
        .child(preview_input(
            "preview-translation-input",
            text(language, TextKey::PreviewTranslation),
            preview_translation,
            preview_translation_caret,
            cx,
            callbacks.on_preview_translation_focus,
        ))
        .child(color_picker!(
            "preview-background",
            text(language, TextKey::PreviewBackground),
            &style.preview_background_color,
            active_color_picker == Some("preview-background"),
            language,
            callbacks.on_color_toggle,
            style,
            cx,
            callbacks.on_change,
            |next, color| next.preview_background_color = color.to_string(),
        ));
    let preview = card(cx)
        .flex_shrink_0()
        .child(heading(text(language, TextKey::Preview)))
        .child(h_flex().items_start().gap_3().child(preview_image).child(preview_controls));

    let typography = setting_section(
        text(language, TextKey::Typography),
        div()
            .child(font_picker(style, fonts, language, cx, &callbacks))
            .child(slider!(
                "font-weight",
                text(language, TextKey::FontWeight),
                f32::from(style.font_weight),
                100.0,
                900.0,
                10.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.font_weight = value.round() as u16,
            ))
            .child(slider!(
                "letter-spacing",
                text(language, TextKey::LetterSpacing),
                style.letter_spacing_px,
                0.0,
                8.0,
                0.1,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.letter_spacing_px = value,
            ))
            .child(slider!(
                "line-height",
                text(language, TextKey::LineHeight),
                style.line_height,
                0.8,
                2.0,
                0.05,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.line_height = value,
            )),
        cx,
    );

    let source = setting_section(
        text(language, TextKey::RecognitionText),
        div()
            .child(slider!(
                "source-size",
                text(language, TextKey::SourceSize),
                style.source_font_size_px,
                12.0,
                72.0,
                1.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.source_font_size_px = value,
            ))
            .child(color_picker!(
                "source-color",
                text(language, TextKey::SourceColor),
                &style.source_color,
                active_color_picker == Some("source-color"),
                language,
                callbacks.on_color_toggle,
                style,
                cx,
                callbacks.on_change,
                |next, color| next.source_color = color.to_string(),
            ))
            .child(slider!(
                "source-opacity",
                text(language, TextKey::SourceOpacity),
                style.source_opacity,
                0.0,
                1.0,
                0.01,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.source_opacity = value,
            ))
            .child(slider!(
                "source-max",
                text(language, TextKey::SourceMaxChars),
                style.source_max_chars as f32,
                8.0,
                80.0,
                1.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.source_max_chars = value.round() as usize,
            )),
        cx,
    );

    let translation = setting_section(
        text(language, TextKey::TranslationText),
        div()
            .child(slider!(
                "translation-size",
                text(language, TextKey::TranslationSize),
                style.translation_font_size_px,
                12.0,
                72.0,
                1.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.translation_font_size_px = value,
            ))
            .child(color_picker!(
                "translation-color",
                text(language, TextKey::TranslationColor),
                &style.translation_color,
                active_color_picker == Some("translation-color"),
                language,
                callbacks.on_color_toggle,
                style,
                cx,
                callbacks.on_change,
                |next, color| next.translation_color = color.to_string(),
            ))
            .child(slider!(
                "translation-opacity",
                text(language, TextKey::TranslationOpacity),
                style.translation_opacity,
                0.0,
                1.0,
                0.01,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.translation_opacity = value,
            ))
            .child(slider!(
                "translation-max",
                text(language, TextKey::TranslationMaxChars),
                style.translation_max_chars as f32,
                8.0,
                80.0,
                1.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.translation_max_chars = value.round() as usize,
            )),
        cx,
    );

    let placement = setting_section(
        text(language, TextKey::Placement),
        div()
            .child(slider!(
                "position-x",
                text(language, TextKey::PositionX),
                style.caption_x_percent,
                5.0,
                95.0,
                0.5,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.caption_x_percent = value,
            ))
            .child(slider!(
                "position-y",
                text(language, TextKey::PositionY),
                style.caption_y_percent,
                5.0,
                95.0,
                0.5,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.caption_y_percent = value,
            )),
        cx,
    );

    let background = setting_section(
        text(language, TextKey::Background),
        div()
            .child(toggle!(
                "background-enabled",
                text(language, TextKey::Background),
                style.background_enabled,
                language,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.background_enabled = value,
            ))
            .child(color_picker!(
                "background-color",
                text(language, TextKey::BackgroundColor),
                &style.background_color,
                active_color_picker == Some("background-color"),
                language,
                callbacks.on_color_toggle,
                style,
                cx,
                callbacks.on_change,
                |next, color| next.background_color = color.to_string(),
            ))
            .child(slider!(
                "background-opacity",
                text(language, TextKey::BackgroundOpacity),
                style.background_opacity,
                0.0,
                1.0,
                0.01,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.background_opacity = value,
            )),
        cx,
    );

    let shadow = setting_section(
        text(language, TextKey::Shadow),
        div()
            .child(toggle!(
                "shadow-enabled",
                text(language, TextKey::Shadow),
                style.shadow_enabled,
                language,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.shadow_enabled = value,
            ))
            .child(color_picker!(
                "shadow-color",
                text(language, TextKey::ShadowColor),
                &style.shadow_color,
                active_color_picker == Some("shadow-color"),
                language,
                callbacks.on_color_toggle,
                style,
                cx,
                callbacks.on_change,
                |next, color| next.shadow_color = color.to_string(),
            ))
            .child(slider!(
                "shadow-blur",
                text(language, TextKey::ShadowBlur),
                style.shadow_blur_px,
                0.0,
                20.0,
                0.5,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.shadow_blur_px = value,
            ))
            .child(slider!(
                "shadow-antialias",
                text(language, TextKey::ShadowAntialias),
                f32::from(style.shadow_antialias),
                1.0,
                4.0,
                1.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.shadow_antialias = value.round() as u8,
            ))
            .child(slider!(
                "shadow-x",
                text(language, TextKey::ShadowOffsetX),
                style.shadow_offset_x,
                -10.0,
                10.0,
                0.5,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.shadow_offset_x = value,
            ))
            .child(slider!(
                "shadow-y",
                text(language, TextKey::ShadowOffsetY),
                style.shadow_offset_y,
                -10.0,
                10.0,
                0.5,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.shadow_offset_y = value,
            )),
        cx,
    );

    let outline = setting_section(
        text(language, TextKey::Outline),
        div()
            .child(toggle!(
                "outline-enabled",
                text(language, TextKey::Outline),
                style.outline_enabled,
                language,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.outline_enabled = value,
            ))
            .child(color_picker!(
                "outline-color",
                text(language, TextKey::OutlineColor),
                &style.outline_color,
                active_color_picker == Some("outline-color"),
                language,
                callbacks.on_color_toggle,
                style,
                cx,
                callbacks.on_change,
                |next, color| next.outline_color = color.to_string(),
            ))
            .child(slider!(
                "outline-width",
                text(language, TextKey::OutlineWidth),
                style.outline_width_px,
                0.0,
                8.0,
                0.25,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.outline_width_px = value,
            )),
        cx,
    );

    v_flex()
        .size_full()
        .min_h_0()
        .gap_3()
        .child(profiles)
        .child(preview)
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
        .child(
            v_flex()
                .id("style-settings-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .pr_3()
                .pb_3()
                .gap_3()
                .child(typography)
                .child(h_flex().items_start().gap_3().child(source).child(translation))
                .child(placement)
                .child(h_flex().items_start().gap_3().child(background).child(shadow))
                .child(outline),
        )
}

fn setting_section(title: &'static str, content: gpui::Div, cx: &gpui::App) -> gpui::Div {
    card(cx)
        .flex_1()
        .gap_3()
        .child(Label::new(title).font_semibold())
        .child(content.flex().flex_col().gap_3())
}

fn preview_input<V: 'static>(
    id: &'static str,
    label: &'static str,
    value: &str,
    caret: Option<usize>,
    cx: &mut Context<V>,
    on_focus: fn(&mut V, &mut gpui::Window, &mut Context<V>),
) -> impl IntoElement {
    v_flex().flex_1().gap_2().child(muted(label)).child(
        h_flex()
            .id(id)
            .min_h_8()
            .px_3()
            .py_2()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(if caret.is_some() { cx.theme().primary } else { cx.theme().input })
            .bg(cx.theme().background)
            .cursor_text()
            .on_click(cx.listener(move |view, _event, window, cx| on_focus(view, window, cx)))
            .child(editable_text(value, caret, cx)),
    )
}

fn font_picker<V: 'static>(
    style: &NativeStyleSettings,
    state: FontPickerState<'_>,
    language: UiLanguage,
    cx: &mut Context<V>,
    callbacks: &StyleCallbacks<V>,
) -> impl IntoElement {
    let on_font_focus = callbacks.on_font_focus;
    let on_font_select = callbacks.on_font_select;
    let displayed_font = if state.query.is_empty() && state.caret.is_none() {
        editable_text(&style.font_family, None, cx)
    } else {
        editable_text(state.query, state.caret, cx)
    };
    let mut picker = v_flex().gap_2().child(muted(text(language, TextKey::FontFamily))).child(
        h_flex()
            .id("font-search")
            .min_h_8()
            .px_3()
            .py_2()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(if state.caret.is_some() { cx.theme().primary } else { cx.theme().input })
            .bg(cx.theme().background)
            .cursor_text()
            .on_click(cx.listener(move |view, _event, window, cx| {
                on_font_focus(view, window, cx);
            }))
            .child(displayed_font),
    );
    if state.open {
        let query = state.query.to_lowercase();
        let options = state
            .families
            .iter()
            .filter(|family| query.is_empty() || family.to_lowercase().contains(&query))
            .map(|family| {
                let family_value = family.clone();
                Button::new(format!("font-option-{family}"))
                    .label(family.clone())
                    // Font samples are editable caption data, not application typography.
                    .font_family(family.clone())
                    .on_click(cx.listener(move |view, _event, _window, _cx| {
                        on_font_select(view, &family_value);
                    }))
            })
            .collect::<Vec<_>>();
        picker = picker.child(
            v_flex()
                .id("font-options-scroll")
                .max_h(rems(15.))
                .overflow_y_scroll()
                .on_scroll_wheel(|_event, _window, cx| cx.stop_propagation())
                .p_2()
                .border_1()
                .border_color(cx.theme().border)
                .rounded(cx.theme().radius)
                .bg(cx.theme().popover)
                .children(options),
        );
    }
    picker
}

fn slider_control<V: 'static>(
    spec: SliderSpec,
    style: &NativeStyleSettings,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
) -> impl IntoElement {
    let SliderSpec { id, label, value, min, max, step, set } = spec;
    let current = style.clone();
    let update = Rc::new(move |view: &mut V, next_value: f32| {
        let mut next = current.clone();
        set(&mut next, next_value);
        on_change(view, next);
    });
    range_control(
        RangeSpec {
            id: id.to_string(),
            label,
            value,
            min,
            max,
            step,
            accent: cx.theme().primary.into(),
        },
        cx,
        update,
    )
}

fn range_control<V: 'static>(
    spec: RangeSpec,
    cx: &mut Context<V>,
    update: RangeUpdate<V>,
) -> impl IntoElement {
    let RangeSpec { id, label, value, min, max, step, accent } = spec;
    let fraction = ((value - min) / (max - min)).clamp(0.0, 1.0);
    let entity = cx.entity();
    let down_update = Rc::clone(&update);
    let move_update = update;
    let interaction = canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            window.on_mouse_event({
                let entity = entity.clone();
                move |event: &MouseDownEvent, _, _, app| {
                    if bounds.contains(&event.position) {
                        let next = range_value(bounds, event.position, min, max, step);
                        entity.update(app, |view, _| down_update(view, next));
                    }
                }
            });
            window.on_mouse_event(move |event: &MouseMoveEvent, _, _, app| {
                if event.dragging() && bounds.contains(&event.position) {
                    let next = range_value(bounds, event.position, min, max, step);
                    entity.update(app, |view, _| move_update(view, next));
                }
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();

    v_flex()
        .gap_2()
        .child(
            h_flex().justify_between().child(Label::new(label)).child(
                Label::new(format_slider_value(value, step))
                    .text_sm()
                    .px_2()
                    .rounded(cx.theme().radius)
                    .bg(cx.theme().muted),
            ),
        )
        .child(
            h_flex()
                .id(id)
                .relative()
                .h_6()
                .w_full()
                .cursor_pointer()
                .child(div().absolute().w_full().h_1().rounded_full().bg(cx.theme().input))
                .child(div().w(relative(fraction)).h_1().rounded_full().bg(accent))
                .child(
                    div()
                        .ml_neg_2()
                        .size_4()
                        .rounded_full()
                        .border_2()
                        .border_color(cx.theme().background)
                        .bg(accent),
                )
                .child(interaction),
        )
        .child(
            h_flex()
                .justify_between()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child(SharedString::from(format_slider_value(min, step)))
                .child(SharedString::from(format_slider_value(max, step))),
        )
}

fn range_value(
    bounds: Bounds<Pixels>,
    position: Point<Pixels>,
    min: f32,
    max: f32,
    step: f32,
) -> f32 {
    let fraction = ((position.x - bounds.origin.x) / bounds.size.width).clamp(0.0, 1.0);
    let raw = min + (max - min) * fraction;
    ((raw - min) / step).round().mul_add(step, min).clamp(min, max)
}

fn format_slider_value(value: f32, step: f32) -> String {
    if step >= 1.0 {
        format!("{value:.0}")
    } else if step >= 0.1 {
        format!("{value:.1}")
    } else {
        format!("{value:.2}")
    }
}

fn color_picker_control<V: 'static>(
    spec: ColorPickerSpec<'_>,
    style: &NativeStyleSettings,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
    on_toggle: fn(&mut V, &str),
) -> impl IntoElement {
    let ColorPickerSpec { id, label, value, active, set } = spec;
    let channels = parse_rgb_channels(value);
    let (hue, saturation, brightness) = rgb_to_hsv(channels);
    let square = color_square_control(
        ColorSquareSpec { id: format!("{id}-square"), hue, saturation, brightness, set },
        style,
        cx,
        on_change,
    );
    let hue_bar = hue_bar_control(
        HueBarSpec { id: format!("{id}-hue"), hue, saturation, brightness, set },
        style,
        cx,
        on_change,
    );

    v_flex()
        .gap_2()
        .child(
            Button::new(format!("color-picker-{id}"))
                .selected(active)
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            div()
                                .size_6()
                                .rounded(cx.theme().radius)
                                .border_1()
                                .border_color(cx.theme().border)
                                // This swatch represents user-selected caption data.
                                .bg(parse_rgb(value)),
                        )
                        .child(Label::new(label))
                        .child(muted(value.to_uppercase())),
                )
                .on_click(cx.listener(move |view, _event, _window, _cx| {
                    on_toggle(view, id);
                })),
        )
        .when(active, |this| this.child(h_flex().justify_center().child(square)).child(hue_bar))
}

fn color_square_control<V: 'static>(
    spec: ColorSquareSpec,
    style: &NativeStyleSettings,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
) -> impl IntoElement {
    let ColorSquareSpec { id, hue, saturation, brightness, set } = spec;
    let entity = cx.entity();
    let current = style.clone();
    let update = Rc::new(move |view: &mut V, channels: [u8; 3]| {
        let color = rgb_hex(channels);
        let mut next = current.clone();
        set(&mut next, &color);
        on_change(view, next);
    });
    let down_update = Rc::clone(&update);
    let move_update = update;
    let interaction = canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            window.on_mouse_event({
                let entity = entity.clone();
                move |event: &MouseDownEvent, _, _, app| {
                    if bounds.contains(&event.position) {
                        let channels = square_rgb(bounds, event.position, hue);
                        entity.update(app, |view, _| down_update(view, channels));
                    }
                }
            });
            window.on_mouse_event(move |event: &MouseMoveEvent, _, _, app| {
                if event.dragging() && bounds.contains(&event.position) {
                    let channels = square_rgb(bounds, event.position, hue);
                    entity.update(app, |view, _| move_update(view, channels));
                }
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();

    div()
        .id(id)
        .relative()
        .w(px(240.0))
        .h(px(180.0))
        .rounded_md()
        .cursor_pointer()
        .child(image_view(render_image(color_square_image(hue, saturation, brightness))))
        .child(interaction)
}

fn hue_bar_control<V: 'static>(
    spec: HueBarSpec,
    style: &NativeStyleSettings,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
) -> impl IntoElement {
    let HueBarSpec { id, hue, saturation, brightness, set } = spec;
    let entity = cx.entity();
    let current = style.clone();
    let update = Rc::new(move |view: &mut V, next_hue: f32| {
        let color = rgb_hex(hsv_to_rgb(next_hue, saturation, brightness));
        let mut next = current.clone();
        set(&mut next, &color);
        on_change(view, next);
    });
    let down_update = Rc::clone(&update);
    let move_update = update;
    let interaction = canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            window.on_mouse_event({
                let entity = entity.clone();
                move |event: &MouseDownEvent, _, _, app| {
                    if bounds.contains(&event.position) {
                        let next_hue = hue_from_position(bounds, event.position);
                        entity.update(app, |view, _| down_update(view, next_hue));
                    }
                }
            });
            window.on_mouse_event(move |event: &MouseMoveEvent, _, _, app| {
                if event.dragging() && bounds.contains(&event.position) {
                    let next_hue = hue_from_position(bounds, event.position);
                    entity.update(app, |view, _| move_update(view, next_hue));
                }
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();

    div()
        .id(id)
        .relative()
        .w(px(240.0))
        .h(px(20.0))
        .rounded_md()
        .overflow_hidden()
        .cursor_pointer()
        .child(image_view(render_image(hue_bar_image(hue))))
        .child(interaction)
}

fn toggle_control<V: 'static>(
    spec: ToggleSpec,
    style: &NativeStyleSettings,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
) -> impl IntoElement {
    let ToggleSpec { id, label, value, set } = spec;
    let current = style.clone();
    Switch::new(id).label(label).checked(value).on_click(cx.listener(
        move |view, checked, _window, _cx| {
            let mut next = current.clone();
            set(&mut next, *checked);
            on_change(view, next);
        },
    ))
}

fn color_square_image(
    hue: f32,
    selected_saturation: f32,
    selected_brightness: f32,
) -> caption_bridge_render::RgbaImage {
    const WIDTH: u32 = 480;
    const HEIGHT: u32 = 360;
    let marker_x = selected_saturation * (WIDTH - 1) as f32;
    let marker_y = (1.0 - selected_brightness) * (HEIGHT - 1) as f32;
    let pixels = (0..WIDTH * HEIGHT)
        .flat_map(|index| {
            let x = index % WIDTH;
            let y = index / WIDTH;
            let saturation = x as f32 / (WIDTH - 1) as f32;
            let brightness = 1.0 - y as f32 / (HEIGHT - 1) as f32;
            let marker_distance = (x as f32 - marker_x).hypot(y as f32 - marker_y);
            if (6.0..=10.0).contains(&marker_distance) {
                return [255, 255, 255, 255];
            }
            let [red, green, blue] = hsv_to_rgb(hue, saturation, brightness);
            [red, green, blue, 255]
        })
        .collect();
    caption_bridge_render::RgbaImage { width: WIDTH, height: HEIGHT, stride: WIDTH * 4, pixels }
}

fn hue_bar_image(selected_hue: f32) -> caption_bridge_render::RgbaImage {
    const WIDTH: u32 = 480;
    const HEIGHT: u32 = 40;
    let marker_x = selected_hue.rem_euclid(360.0) / 360.0 * (WIDTH - 1) as f32;
    let pixels = (0..WIDTH * HEIGHT)
        .flat_map(|index| {
            let x = index % WIDTH;
            if (x as f32 - marker_x).abs() <= 3.0 {
                return [255, 255, 255, 255];
            }
            let hue = x as f32 / (WIDTH - 1) as f32 * 360.0;
            let [red, green, blue] = hsv_to_rgb(hue, 1.0, 1.0);
            [red, green, blue, 255]
        })
        .collect();
    caption_bridge_render::RgbaImage { width: WIDTH, height: HEIGHT, stride: WIDTH * 4, pixels }
}

fn square_rgb(bounds: Bounds<Pixels>, position: Point<Pixels>, hue: f32) -> [u8; 3] {
    let saturation = ((position.x - bounds.origin.x) / bounds.size.width).clamp(0.0, 1.0);
    let brightness = (1.0 - (position.y - bounds.origin.y) / bounds.size.height).clamp(0.0, 1.0);
    hsv_to_rgb(hue, saturation, brightness)
}

fn hue_from_position(bounds: Bounds<Pixels>, position: Point<Pixels>) -> f32 {
    ((position.x - bounds.origin.x) / bounds.size.width).clamp(0.0, 1.0) * 360.0
}

fn rgb_to_hsv([red, green, blue]: [u8; 3]) -> (f32, f32, f32) {
    let red = f32::from(red) / 255.0;
    let green = f32::from(green) / 255.0;
    let blue = f32::from(blue) / 255.0;
    let max = red.max(green).max(blue);
    let min = red.min(green).min(blue);
    let delta = max - min;
    let hue = if delta == 0.0 {
        0.0
    } else if max == red {
        60.0 * ((green - blue) / delta).rem_euclid(6.0)
    } else if max == green {
        60.0 * ((blue - red) / delta + 2.0)
    } else {
        60.0 * ((red - green) / delta + 4.0)
    };
    let saturation = if max == 0.0 { 0.0 } else { delta / max };
    (hue, saturation, max)
}

fn hsv_to_rgb(hue: f32, saturation: f32, value: f32) -> [u8; 3] {
    let chroma = value * saturation;
    let section = hue.rem_euclid(360.0) / 60.0;
    let x = chroma * (1.0 - (section.rem_euclid(2.0) - 1.0).abs());
    let (red, green, blue) = match section as u8 {
        0 => (chroma, x, 0.0),
        1 => (x, chroma, 0.0),
        2 => (0.0, chroma, x),
        3 => (0.0, x, chroma),
        4 => (x, 0.0, chroma),
        _ => (chroma, 0.0, x),
    };
    let match_value = value - chroma;
    [
        ((red + match_value) * 255.0).round() as u8,
        ((green + match_value) * 255.0).round() as u8,
        ((blue + match_value) * 255.0).round() as u8,
    ]
}

fn rgb_hex([red, green, blue]: [u8; 3]) -> String {
    format!("#{red:02x}{green:02x}{blue:02x}")
}

fn parse_rgb_channels(color: &str) -> [u8; 3] {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(value) = u32::from_str_radix(hex, 16) {
            return [
                ((value >> 16) & 0xff) as u8,
                ((value >> 8) & 0xff) as u8,
                (value & 0xff) as u8,
            ];
        }
    }
    [255, 255, 255]
}

pub fn parse_rgb(color: &str) -> gpui::Rgba {
    let [red, green, blue] = parse_rgb_channels(color);
    gpui::rgba(u32::from_be_bytes([red, green, blue, 0xff]))
}

#[cfg(test)]
mod tests {
    use gpui::{point, px, size, Bounds};

    use super::{
        color_square_image, hsv_to_rgb, parse_rgb_channels, range_value, rgb_to_hsv,
        PREVIEW_HEIGHT_PX, PREVIEW_WIDTH_PX,
    };

    #[test]
    fn range_value_tracks_and_quantizes_pointer_position() {
        let bounds = Bounds::new(point(px(10.0), px(20.0)), size(px(200.0), px(24.0)));
        assert_eq!(range_value(bounds, point(px(110.0), px(30.0)), 0.0, 100.0, 1.0), 50.0);
        assert_eq!(range_value(bounds, point(px(-5.0), px(30.0)), 0.0, 100.0, 1.0), 0.0);
        assert_eq!(range_value(bounds, point(px(250.0), px(30.0)), 0.0, 100.0, 1.0), 100.0);
    }

    #[test]
    fn color_picker_parses_all_rgb_channels() {
        assert_eq!(parse_rgb_channels("#1a80ff"), [26, 128, 255]);
        assert_eq!(parse_rgb_channels("invalid"), [255, 255, 255]);
    }

    #[test]
    fn color_picker_uses_hsv_primary_colors() {
        assert_eq!(hsv_to_rgb(0.0, 1.0, 1.0), [255, 0, 0]);
        assert_eq!(hsv_to_rgb(120.0, 1.0, 1.0), [0, 255, 0]);
        assert_eq!(hsv_to_rgb(240.0, 1.0, 1.0), [0, 0, 255]);
        assert_eq!(rgb_to_hsv([255, 0, 0]), (0.0, 1.0, 1.0));
    }

    #[test]
    fn preview_keeps_a_compact_widescreen_display_area() {
        assert_eq!(PREVIEW_WIDTH_PX, 560.0);
        assert_eq!(PREVIEW_HEIGHT_PX, 157.5);
    }

    #[test]
    fn color_square_renders_at_hidpi_resolution() {
        let image = color_square_image(0.0, 1.0, 1.0);
        assert_eq!(image.width, 480);
        assert_eq!(image.height, 360);
        assert_eq!(image.pixels.len(), 691_200);
    }
}
