//! Scrollable Native caption style editor with continuous range and color controls.

use std::{rc::Rc, sync::Arc};

use gpui::prelude::*;
use gpui::{
    canvas, div, img, px, relative, Bounds, Context, DragMoveEvent, Empty, Entity, ExternalPaths,
    IntoElement, MouseDownEvent, ObjectFit, Pixels, Point, RenderImage, SharedString, Window,
};
use gpui_component::button::Button;
use gpui_component::color_picker::{ColorPicker, ColorPickerState};
use gpui_component::input::{Input, InputState};
use gpui_component::label::Label;
use gpui_component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_component::switch::Switch;
use gpui_component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, StyledExt as _};

use crate::domain::{NativeStyleProfile, NativeStyleSettings, UiLanguage};
use crate::i18n::{text, TextKey};
use crate::ui::{
    button, card, danger_button, error_line, heading, image_view, muted, selectable_text,
};

const PREVIEW_WIDTH_PX: f32 = 560.0;
const PREVIEW_HEIGHT_PX: f32 = 157.5;

#[derive(Clone)]
struct StylePointerDrag {
    owner_id: String,
}

impl StylePointerDrag {
    fn new(owner_id: impl Into<String>) -> Self {
        Self { owner_id: owner_id.into() }
    }

    fn is_owned_by(&self, control_id: &str) -> bool {
        self.owner_id == control_id
    }
}

impl gpui::Render for StylePointerDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

macro_rules! slider {
    ($id:expr, $label:expr, $language:expr, $value:expr, $min:expr, $max:expr, $step:expr, $style:expr, $cx:expr, $on_change:expr, $set:expr $(,)?) => {
        slider_control(
            SliderSpec {
                id: $id,
                label: $label,
                language: $language,
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
    ($id:expr, $label:expr, $color_pickers:expr $(,)?) => {
        color_picker_control($id, $label, $color_pickers)
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StyleTextTarget {
    Recognition,
    Translation,
}

pub struct StyleCallbacks<V> {
    pub on_add_profile: fn(&mut V),
    pub on_select_profile: fn(&mut V, &str),
    pub on_delete_profile: fn(&mut V),
    pub on_reset: fn(&mut V),
    pub on_copy_text_style: fn(&mut V, StyleTextTarget),
    pub on_change: fn(&mut V, NativeStyleSettings),
    pub on_font_select: fn(&mut V, StyleTextTarget, &str),
    pub on_preview_image_paths: fn(&mut V, &[std::path::PathBuf]),
    pub on_preview_image_position: fn(&mut V, f32, f32),
    pub on_reset_preview_image_position: fn(&mut V),
    pub on_delete_preview_image: fn(&mut V),
}

pub struct StyleViewState<'a> {
    pub profiles: &'a [NativeStyleProfile],
    pub selected_profile_id: &'a str,
    pub preview_source_input: &'a Entity<InputState>,
    pub preview_translation_input: &'a Entity<InputState>,
    pub preview_image: Arc<RenderImage>,
    pub fonts: &'a [String],
    pub language: UiLanguage,
    pub color_pickers: &'a StyleColorPickers,
    pub persist_error: Option<&'a str>,
}

pub struct StyleColorPickers {
    source: Entity<ColorPickerState>,
    translation: Entity<ColorPickerState>,
    background: Entity<ColorPickerState>,
    outline: Entity<ColorPickerState>,
    shadow: Entity<ColorPickerState>,
}

impl StyleColorPickers {
    pub fn new<V: 'static>(
        style: &NativeStyleSettings,
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Self {
        let mut picker = |value: &str| {
            cx.new(|cx| ColorPickerState::new(window, cx).default_value(parse_rgb(value)))
        };
        Self {
            source: picker(&style.source_color),
            translation: picker(&style.translation_color),
            background: picker(&style.background_color),
            outline: picker(&style.outline_color),
            shadow: picker(&style.shadow_color),
        }
    }

    pub fn entries(&self) -> [(&'static str, &Entity<ColorPickerState>); 5] {
        [
            ("source-color", &self.source),
            ("translation-color", &self.translation),
            ("background-color", &self.background),
            ("outline-color", &self.outline),
            ("shadow-color", &self.shadow),
        ]
    }

    fn state(&self, id: &str) -> &Entity<ColorPickerState> {
        self.entries()
            .into_iter()
            .find_map(|(entry_id, state)| (entry_id == id).then_some(state))
            .expect("style color picker ID must be registered")
    }

    pub fn sync<V: 'static>(
        &self,
        style: &NativeStyleSettings,
        window: &mut Window,
        cx: &mut Context<V>,
    ) {
        for (id, state) in self.entries() {
            let value = style_color_value(style, id).expect("registered color must exist");
            let in_sync = state
                .read(cx)
                .value()
                .is_some_and(|color| hsla_to_rgb_hex(color).eq_ignore_ascii_case(value));
            if !in_sync {
                state.update(cx, |state, cx| state.set_value(parse_rgb(value), window, cx));
            }
        }
    }
}

struct SliderSpec {
    id: &'static str,
    label: &'static str,
    language: UiLanguage,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    set: fn(&mut NativeStyleSettings, f32),
}

struct RangeSpec {
    id: String,
    label: &'static str,
    language: UiLanguage,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    accent: gpui::Rgba,
}

struct ToggleSpec {
    id: &'static str,
    label: &'static str,
    value: bool,
    set: fn(&mut NativeStyleSettings, bool),
}

type RangeUpdate<V> = Rc<dyn Fn(&mut V, f32)>;

fn localized_style_profile_name(profile: &NativeStyleProfile, language: UiLanguage) -> String {
    match (profile.id.as_str(), profile.name.as_str()) {
        ("style-1", "Horizontal") => text(language, TextKey::HorizontalStyle).to_string(),
        ("style-2", "Vertical") => text(language, TextKey::VerticalStyle).to_string(),
        (_, name) => {
            name.strip_prefix("Style ").and_then(|number| number.parse::<usize>().ok()).map_or_else(
                || name.to_string(),
                |number| format!("{} {number}", text(language, TextKey::Style)),
            )
        }
    }
}

pub fn render_style<V: 'static>(
    style: &NativeStyleSettings,
    state: StyleViewState<'_>,
    cx: &mut Context<V>,
    callbacks: StyleCallbacks<V>,
) -> impl IntoElement {
    let StyleViewState {
        profiles,
        selected_profile_id,
        preview_source_input,
        preview_translation_input,
        preview_image,
        fonts,
        language,
        color_pickers,
        persist_error,
    } = state;

    let selected_profile_name = profiles
        .iter()
        .find(|profile| profile.id == selected_profile_id)
        .map(|profile| localized_style_profile_name(profile, language))
        .unwrap_or_default();
    let profile_options = profiles
        .iter()
        .map(|profile| {
            (
                profile.id.clone(),
                localized_style_profile_name(profile, language),
                profile.id == selected_profile_id,
            )
        })
        .collect::<Vec<_>>();
    let view = cx.entity();
    let on_select_profile = callbacks.on_select_profile;
    let profile_select = Button::new("style-profile-select")
        .w_56()
        .label(selected_profile_name)
        .dropdown_caret(true)
        .dropdown_menu(move |menu, _window, _cx| {
            profile_options.iter().fold(menu, |menu, (id, name, selected)| {
                let id = id.clone();
                let view = view.clone();
                menu.item(PopupMenuItem::new(name.clone()).checked(*selected).on_click(
                    move |_event, _window, cx| {
                        view.update(cx, |view, cx| {
                            on_select_profile(view, &id);
                            cx.notify();
                        });
                    },
                ))
            })
        });
    let profiles = card(cx).p_2().flex_shrink_0().child(
        h_flex()
            .items_center()
            .gap_2()
            .child(heading(text(language, TextKey::StyleProfiles)))
            .child(profile_select)
            .child(button(
                "style-profile-add",
                text(language, TextKey::AddStyle),
                cx.listener(move |view, _event, _window, _cx| (callbacks.on_add_profile)(view)),
            ))
            .child(danger_button(
                "style-profile-delete",
                text(language, TextKey::DeleteStyle),
                cx,
                cx.listener(move |view, _event, _window, _cx| {
                    (callbacks.on_delete_profile)(view);
                }),
            ))
            .child(button(
                "style-reset-all",
                text(language, TextKey::ResetStyle),
                cx.listener(move |view, _event, _window, _cx| {
                    (callbacks.on_reset)(view);
                }),
            )),
    );

    let preview_has_background_image = style.preview_background_image_path.is_some();
    let preview_drag = preview_has_background_image.then(|| {
        const CONTROL_ID: &str = "style-preview-position-drag";
        let entity = cx.entity();
        let on_position = callbacks.on_preview_image_position;
        div()
            .id(CONTROL_ID)
            .absolute()
            .inset_0()
            .cursor_move()
            .on_drag(StylePointerDrag::new(CONTROL_ID), |drag, _, _, cx| {
                cx.stop_propagation();
                cx.new(|_| drag.clone())
            })
            .on_drag_move(move |event: &DragMoveEvent<StylePointerDrag>, _, app| {
                let is_owner = event.drag(app).is_owned_by(CONTROL_ID);
                if !is_owner {
                    return;
                }
                let bounds = event.bounds;
                let center_x = bounds.origin.x + bounds.size.width / 2.0;
                let center_y = bounds.origin.y + bounds.size.height / 2.0;
                let x = ((event.event.position.x - center_x) / bounds.size.width * 200.0)
                    .clamp(-100.0, 100.0);
                let y = ((event.event.position.y - center_y) / bounds.size.height * 200.0)
                    .clamp(-100.0, 100.0);
                entity.update(app, |view, cx| {
                    on_position(view, x, y);
                    cx.notify();
                });
                app.stop_propagation();
            })
    });
    let mut preview_surface = div()
        .id("style-preview-surface")
        .relative()
        .w(px(PREVIEW_WIDTH_PX))
        .h(px(PREVIEW_HEIGHT_PX))
        .flex_shrink_0()
        .rounded_md()
        .overflow_hidden()
        .when(preview_has_background_image, |this| this.cursor_move())
        .when(!preview_has_background_image, |this| {
            this.bg(parse_rgb(&style.capture_background_color))
        })
        .on_drop(cx.listener(move |view, paths: &ExternalPaths, _window, _cx| {
            (callbacks.on_preview_image_paths)(view, paths.paths());
        }));
    if let Some(path) = style.preview_background_image_path.as_ref() {
        preview_surface = preview_surface.child(
            img(std::path::PathBuf::from(path))
                .absolute()
                .left(px(style.preview_background_image_x_percent * PREVIEW_WIDTH_PX / 100.0))
                .top(px(style.preview_background_image_y_percent * PREVIEW_HEIGHT_PX / 100.0))
                .size_full()
                .object_fit(ObjectFit::Cover),
        );
    }
    let preview_surface = preview_surface
        .child(image_view(preview_image))
        .when_some(preview_drag, |this, drag| this.child(drag));
    let preview_controls = v_flex()
        .flex_1()
        .min_w_0()
        .gap_2()
        .child(preview_input(
            "preview-source-input",
            text(language, TextKey::PreviewRecognition),
            preview_source_input,
        ))
        .child(preview_input(
            "preview-translation-input",
            text(language, TextKey::PreviewTranslation),
            preview_translation_input,
        ))
        .child(muted(text(language, TextKey::PreviewImageHint), cx))
        .when(preview_has_background_image, |this| {
            this.child(
                h_flex()
                    .gap_2()
                    .child(button(
                        "preview-image-position-reset",
                        text(language, TextKey::ResetPreviewImagePosition),
                        cx.listener(move |view, _event, _window, _cx| {
                            (callbacks.on_reset_preview_image_position)(view);
                        }),
                    ))
                    .child(danger_button(
                        "preview-image-delete",
                        text(language, TextKey::DeletePreviewImage),
                        cx,
                        cx.listener(move |view, _event, _window, _cx| {
                            (callbacks.on_delete_preview_image)(view);
                        }),
                    )),
            )
        });
    let preview = card(cx)
        .flex_shrink_0()
        .child(heading(text(language, TextKey::Preview)))
        .child(h_flex().items_start().gap_3().child(preview_surface).child(preview_controls));

    let source = setting_section(
        text(language, TextKey::RecognitionText),
        div()
            .child(button(
                "copy-recognition-to-translation",
                text(language, TextKey::CopyToTranslation),
                cx.listener(move |view, _event, _window, _cx| {
                    (callbacks.on_copy_text_style)(view, StyleTextTarget::Translation);
                }),
            ))
            .child(font_family_picker(
                "source-font-family",
                &style.source_font_family,
                fonts,
                language,
                StyleTextTarget::Recognition,
                cx,
                callbacks.on_font_select,
            ))
            .child(slider!(
                "source-font-weight",
                text(language, TextKey::FontWeight),
                language,
                f32::from(style.source_font_weight),
                100.0,
                900.0,
                10.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.source_font_weight = value.round() as u16,
            ))
            .child(slider!(
                "source-letter-spacing",
                text(language, TextKey::LetterSpacing),
                language,
                style.source_letter_spacing_px,
                0.0,
                8.0,
                0.1,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.source_letter_spacing_px = value,
            ))
            .child(slider!(
                "source-line-height",
                text(language, TextKey::LineHeight),
                language,
                style.source_line_height,
                0.8,
                2.0,
                0.05,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.source_line_height = value,
            ))
            .child(slider!(
                "source-size",
                text(language, TextKey::SourceSize),
                language,
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
                color_pickers,
            ))
            .child(slider!(
                "source-opacity",
                text(language, TextKey::SourceOpacity),
                language,
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
                language,
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
            .child(button(
                "copy-translation-to-recognition",
                text(language, TextKey::CopyToRecognition),
                cx.listener(move |view, _event, _window, _cx| {
                    (callbacks.on_copy_text_style)(view, StyleTextTarget::Recognition);
                }),
            ))
            .child(font_family_picker(
                "translation-font-family",
                &style.translation_font_family,
                fonts,
                language,
                StyleTextTarget::Translation,
                cx,
                callbacks.on_font_select,
            ))
            .child(slider!(
                "translation-font-weight",
                text(language, TextKey::FontWeight),
                language,
                f32::from(style.translation_font_weight),
                100.0,
                900.0,
                10.0,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.translation_font_weight = value.round() as u16,
            ))
            .child(slider!(
                "translation-letter-spacing",
                text(language, TextKey::LetterSpacing),
                language,
                style.translation_letter_spacing_px,
                0.0,
                8.0,
                0.1,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.translation_letter_spacing_px = value,
            ))
            .child(slider!(
                "translation-line-height",
                text(language, TextKey::LineHeight),
                language,
                style.translation_line_height,
                0.8,
                2.0,
                0.05,
                style,
                cx,
                callbacks.on_change,
                |next, value| next.translation_line_height = value,
            ))
            .child(slider!(
                "translation-size",
                text(language, TextKey::TranslationSize),
                language,
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
                color_pickers,
            ))
            .child(slider!(
                "translation-opacity",
                text(language, TextKey::TranslationOpacity),
                language,
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
                language,
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
                language,
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
                language,
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
                color_pickers,
            ))
            .child(slider!(
                "background-opacity",
                text(language, TextKey::BackgroundOpacity),
                language,
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
                color_pickers,
            ))
            .child(slider!(
                "shadow-blur",
                text(language, TextKey::ShadowBlur),
                language,
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
                language,
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
                language,
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
                language,
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
                color_pickers,
            ))
            .child(slider!(
                "outline-width",
                text(language, TextKey::OutlineWidth),
                language,
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
                .child(h_flex().items_start().gap_3().child(source).child(translation))
                .child(placement)
                .child(h_flex().items_start().gap_3().child(outline).child(shadow))
                .child(background),
        )
}

fn setting_section(title: &'static str, content: gpui::Div, cx: &gpui::App) -> gpui::Div {
    card(cx)
        .flex_1()
        .gap_3()
        .child(selectable_text(title).font_semibold())
        .child(content.flex().flex_col().gap_3())
}

fn preview_input(
    id: &'static str,
    label: &'static str,
    input: &Entity<InputState>,
) -> impl IntoElement {
    v_flex()
        .flex_1()
        .gap_2()
        .child(Label::new(label))
        .child(Input::new(input).accessibility_id(id).aria_label(label).w_full())
}

fn font_family_picker<V: 'static>(
    id: &'static str,
    selected_family: &str,
    families: &[String],
    language: UiLanguage,
    target: StyleTextTarget,
    cx: &mut Context<V>,
    on_select: fn(&mut V, StyleTextTarget, &str),
) -> impl IntoElement {
    let options = families.to_vec();
    let view = cx.entity();
    v_flex().gap_2().child(muted(text(language, TextKey::FontFamily), cx)).child(
        Button::new(id)
            .w_full()
            .label(selected_family.to_string())
            .dropdown_caret(true)
            .dropdown_menu(move |menu, _window, _cx| {
                options.iter().fold(menu, |menu, family| {
                    let family_value = family.clone();
                    let view = view.clone();
                    menu.item(PopupMenuItem::new(family.clone()).on_click(
                        move |_event, _window, cx| {
                            view.update(cx, |view, cx| {
                                on_select(view, target, &family_value);
                                cx.notify();
                            });
                        },
                    ))
                })
            }),
    )
}

fn slider_control<V: 'static>(
    spec: SliderSpec,
    style: &NativeStyleSettings,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
) -> impl IntoElement {
    let SliderSpec { id, label, language, value, min, max, step, set } = spec;
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
            language,
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
    let RangeSpec { id, label, language, value, min, max, step, accent } = spec;
    let fraction = ((value - min) / (max - min)).clamp(0.0, 1.0);
    let entity = cx.entity();
    let decrease_entity = entity.clone();
    let decrease_update = Rc::clone(&update);
    let decrease = Button::new(format!("{id}-decrease"))
        .label("−")
        .accessibility_id(format!("{}: {label}", text(language, TextKey::Decrease)))
        .tooltip(format!("{}: {label}", text(language, TextKey::Decrease)))
        .disabled(value <= min)
        .on_click(move |_event, _window, app| {
            decrease_entity.update(app, |view, _| {
                decrease_update(view, quantize_range_value(value - step, min, max, step));
            });
        });
    let increase_entity = entity.clone();
    let increase_update = Rc::clone(&update);
    let increase = Button::new(format!("{id}-increase"))
        .label("+")
        .accessibility_id(format!("{}: {label}", text(language, TextKey::Increase)))
        .tooltip(format!("{}: {label}", text(language, TextKey::Increase)))
        .disabled(value >= max)
        .on_click(move |_event, _window, app| {
            increase_entity.update(app, |view, _| {
                increase_update(view, quantize_range_value(value + step, min, max, step));
            });
        });
    let down_update = Rc::clone(&update);
    let down_entity = entity.clone();
    let click_interaction = canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            window.on_mouse_event(move |event: &MouseDownEvent, _, _, app| {
                if bounds.contains(&event.position) {
                    let next = range_value(bounds, event.position, min, max, step);
                    down_entity.update(app, |view, cx| {
                        down_update(view, next);
                        cx.notify();
                    });
                }
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let drag_owner_id = id.clone();
    let drag_payload = StylePointerDrag::new(id.clone());
    let drag_entity = entity;
    let drag_update = update;

    v_flex()
        .gap_2()
        .child(
            h_flex().justify_between().gap_2().child(Label::new(label)).child(
                h_flex()
                    .gap_2()
                    .child(decrease)
                    .child(
                        Label::new(format_slider_value(value, step))
                            .min_w_12()
                            .text_center()
                            .text_sm()
                            .px_2()
                            .rounded(cx.theme().radius)
                            .bg(cx.theme().muted),
                    )
                    .child(increase),
            ),
        )
        .child(
            h_flex()
                .id(id)
                .relative()
                .h_6()
                .w_full()
                .cursor_pointer()
                .on_drag(drag_payload, |drag, _, _, cx| {
                    cx.stop_propagation();
                    cx.new(|_| drag.clone())
                })
                .on_drag_move(move |event: &DragMoveEvent<StylePointerDrag>, _, app| {
                    let is_owner = event.drag(app).is_owned_by(&drag_owner_id);
                    if !is_owner {
                        return;
                    }
                    let next = range_value(event.bounds, event.event.position, min, max, step);
                    drag_entity.update(app, |view, cx| {
                        drag_update(view, next);
                        cx.notify();
                    });
                    app.stop_propagation();
                })
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
                .child(click_interaction),
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
    quantize_range_value(min + (max - min) * fraction, min, max, step)
}

fn quantize_range_value(value: f32, min: f32, max: f32, step: f32) -> f32 {
    ((value - min) / step).round().mul_add(step, min).clamp(min, max)
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

fn color_picker_control(
    id: &'static str,
    label: &'static str,
    color_pickers: &StyleColorPickers,
) -> impl IntoElement {
    ColorPicker::new(color_pickers.state(id)).label(label)
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

pub(crate) fn hsla_to_rgb_hex(color: gpui::Hsla) -> String {
    let color = gpui::Rgba::from(color);
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(color.r), channel(color.g), channel(color.b))
}

pub(crate) fn style_color_value<'a>(style: &'a NativeStyleSettings, id: &str) -> Option<&'a str> {
    match id {
        "source-color" => Some(&style.source_color),
        "translation-color" => Some(&style.translation_color),
        "background-color" => Some(&style.background_color),
        "outline-color" => Some(&style.outline_color),
        "shadow-color" => Some(&style.shadow_color),
        _ => None,
    }
}

pub(crate) fn set_style_color(style: &mut NativeStyleSettings, id: &str, color: &str) -> bool {
    let target = match id {
        "source-color" => &mut style.source_color,
        "translation-color" => &mut style.translation_color,
        "background-color" => &mut style.background_color,
        "outline-color" => &mut style.outline_color,
        "shadow-color" => &mut style.shadow_color,
        _ => return false,
    };
    if target == color {
        return false;
    }
    *target = color.to_string();
    true
}

pub fn parse_rgb(color: &str) -> gpui::Rgba {
    if color.eq_ignore_ascii_case("transparent") {
        return gpui::rgba(0x00000000);
    }
    let [red, green, blue] = parse_rgb_channels(color);
    gpui::rgba(u32::from_be_bytes([red, green, blue, 0xff]))
}

#[cfg(test)]
mod tests {
    use gpui::{point, px, size, Bounds};

    use super::{
        hsla_to_rgb_hex, localized_style_profile_name, parse_rgb, parse_rgb_channels,
        quantize_range_value, range_value, set_style_color, style_color_value, StylePointerDrag,
        PREVIEW_HEIGHT_PX, PREVIEW_WIDTH_PX,
    };
    use crate::domain::{NativeStyleProfile, NativeStyleSettings, UiLanguage};

    #[test]
    fn default_style_profile_names_are_localized() {
        let horizontal = NativeStyleProfile {
            id: "style-1".to_string(),
            name: "Horizontal".to_string(),
            style: NativeStyleSettings::default(),
        };
        let vertical = NativeStyleProfile {
            id: "style-2".to_string(),
            name: "Vertical".to_string(),
            style: NativeStyleSettings::default(),
        };
        let generated = NativeStyleProfile {
            id: "style-3".to_string(),
            name: "Style 3".to_string(),
            style: NativeStyleSettings::default(),
        };
        assert_eq!(localized_style_profile_name(&horizontal, UiLanguage::Japanese), "横型");
        assert_eq!(localized_style_profile_name(&vertical, UiLanguage::Japanese), "縦型");
        assert_eq!(localized_style_profile_name(&generated, UiLanguage::Japanese), "スタイル 3");
        assert_eq!(localized_style_profile_name(&horizontal, UiLanguage::English), "Horizontal");
    }

    #[test]
    fn drag_payload_updates_only_its_owner_control() {
        let source_font_size = StylePointerDrag::new("source-font-size");

        assert!(source_font_size.is_owned_by("source-font-size"));
        assert!(!source_font_size.is_owned_by("translation-font-size"));
        assert!(!source_font_size.is_owned_by("source-color-square"));
    }

    #[test]
    fn range_value_tracks_and_quantizes_pointer_position() {
        let bounds = Bounds::new(point(px(10.0), px(20.0)), size(px(200.0), px(24.0)));
        assert_eq!(range_value(bounds, point(px(110.0), px(30.0)), 0.0, 100.0, 1.0), 50.0);
        assert_eq!(range_value(bounds, point(px(-5.0), px(30.0)), 0.0, 100.0, 1.0), 0.0);
        assert_eq!(range_value(bounds, point(px(250.0), px(30.0)), 0.0, 100.0, 1.0), 100.0);
        assert_eq!(
            [60.0, 110.0, 160.0]
                .map(|x| { range_value(bounds, point(px(x), px(30.0)), 0.0, 100.0, 1.0) }),
            [25.0, 50.0, 75.0],
            "each drag move must produce a new value before pointer release"
        );
    }

    #[test]
    fn keyboard_step_controls_quantize_and_clamp_slider_values() {
        assert!((quantize_range_value(1.26, 0.0, 2.0, 0.1) - 1.3).abs() < f32::EPSILON * 2.0);
        assert_eq!(quantize_range_value(-1.0, 0.0, 2.0, 0.1), 0.0);
        assert_eq!(quantize_range_value(3.0, 0.0, 2.0, 0.1), 2.0);
    }

    #[test]
    fn color_picker_parses_all_rgb_channels() {
        assert_eq!(parse_rgb_channels("#1a80ff"), [26, 128, 255]);
        assert_eq!(parse_rgb_channels("invalid"), [255, 255, 255]);
        assert_eq!(parse_rgb("transparent").a, 0.0);
    }

    #[test]
    fn color_codes_update_every_editable_style_color() {
        let mut style = NativeStyleSettings::default();
        assert!(set_style_color(&mut style, "source-color", "#102030"));
        assert!(set_style_color(&mut style, "translation-color", "#203040"));
        assert!(set_style_color(&mut style, "background-color", "#304050"));
        assert!(set_style_color(&mut style, "outline-color", "#405060"));
        assert!(set_style_color(&mut style, "shadow-color", "#506070"));
        assert_eq!(style_color_value(&style, "source-color"), Some("#102030"));
        assert_eq!(style_color_value(&style, "translation-color"), Some("#203040"));
        assert_eq!(style_color_value(&style, "background-color"), Some("#304050"));
        assert_eq!(style_color_value(&style, "outline-color"), Some("#405060"));
        assert_eq!(style_color_value(&style, "shadow-color"), Some("#506070"));
    }

    #[test]
    fn component_color_picker_is_normalized_to_opaque_rgb() {
        assert_eq!(hsla_to_rgb_hex(gpui::hsla(0.0, 1.0, 0.5, 0.25)), "#ff0000");
    }

    #[test]
    fn preview_keeps_a_compact_widescreen_display_area() {
        assert_eq!(PREVIEW_WIDTH_PX, 560.0);
        assert_eq!(PREVIEW_HEIGHT_PX, 157.5);
    }
}
