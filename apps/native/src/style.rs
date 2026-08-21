//! Style tab: source / translation numbers + live text preview.

use gpui::prelude::*;
use gpui::{div, Context, IntoElement, SharedString};

use crate::domain::{
    adjust_font_size, adjust_max_chars, adjust_opacity, adjust_position, cycle_source_color,
    cycle_translation_color, NativeStyleSettings, FONT_SIZE_STEP, MAX_CHARS_STEP, OPACITY_STEP,
    POSITION_STEP,
};
use crate::ui::{button, card, error_line, field_row, heading, muted};

pub fn render_style<V: 'static>(
    style: &NativeStyleSettings,
    preview_source: &str,
    preview_translation: &str,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    on_change: fn(&mut V, NativeStyleSettings),
    on_save: fn(&mut V),
) -> impl IntoElement {
    let current = style.clone();
    card()
        .child(heading("スタイル"))
        .child(muted(
            "数値はネイティブ設定ディレクトリへ保存します（Tauri の desktop 設定には書きません）",
        ))
        .child(field_row(
            "原文サイズ",
            format!("{:.0} px", style.source_font_size_px),
            "style-source-size-minus",
            "style-source-size-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.source_font_size_px =
                        adjust_font_size(next.source_font_size_px, -FONT_SIZE_STEP);
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.source_font_size_px =
                        adjust_font_size(next.source_font_size_px, FONT_SIZE_STEP);
                    on_change(view, next);
                })
            },
        ))
        .child(field_row(
            "原文不透明度",
            format!("{:.1}", style.source_opacity),
            "style-source-opacity-minus",
            "style-source-opacity-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.source_opacity = adjust_opacity(next.source_opacity, -OPACITY_STEP);
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.source_opacity = adjust_opacity(next.source_opacity, OPACITY_STEP);
                    on_change(view, next);
                })
            },
        ))
        .child(field_row(
            "原文最大文字数",
            format!("{}", style.source_max_chars),
            "style-source-chars-minus",
            "style-source-chars-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.source_max_chars =
                        adjust_max_chars(next.source_max_chars, -(MAX_CHARS_STEP as isize));
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.source_max_chars =
                        adjust_max_chars(next.source_max_chars, MAX_CHARS_STEP as isize);
                    on_change(view, next);
                })
            },
        ))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().w(gpui::px(220.)).child(SharedString::from("原文色")))
                .child(
                    div().w(gpui::px(140.)).child(SharedString::from(style.source_color.clone())),
                )
                .child(button("style-source-color", "色を切替", {
                    let current = current.clone();
                    cx.listener(move |view, _event, _window, _cx| {
                        let mut next = current.clone();
                        next.source_color = cycle_source_color(&next.source_color).to_string();
                        on_change(view, next);
                    })
                })),
        )
        .child(field_row(
            "翻訳サイズ",
            format!("{:.0} px", style.translation_font_size_px),
            "style-tr-size-minus",
            "style-tr-size-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.translation_font_size_px =
                        adjust_font_size(next.translation_font_size_px, -FONT_SIZE_STEP);
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.translation_font_size_px =
                        adjust_font_size(next.translation_font_size_px, FONT_SIZE_STEP);
                    on_change(view, next);
                })
            },
        ))
        .child(field_row(
            "翻訳不透明度",
            format!("{:.1}", style.translation_opacity),
            "style-tr-opacity-minus",
            "style-tr-opacity-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.translation_opacity =
                        adjust_opacity(next.translation_opacity, -OPACITY_STEP);
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.translation_opacity =
                        adjust_opacity(next.translation_opacity, OPACITY_STEP);
                    on_change(view, next);
                })
            },
        ))
        .child(field_row(
            "翻訳最大文字数",
            format!("{}", style.translation_max_chars),
            "style-tr-chars-minus",
            "style-tr-chars-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.translation_max_chars =
                        adjust_max_chars(next.translation_max_chars, -(MAX_CHARS_STEP as isize));
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.translation_max_chars =
                        adjust_max_chars(next.translation_max_chars, MAX_CHARS_STEP as isize);
                    on_change(view, next);
                })
            },
        ))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().w(gpui::px(220.)).child(SharedString::from("翻訳色")))
                .child(
                    div()
                        .w(gpui::px(140.))
                        .child(SharedString::from(style.translation_color.clone())),
                )
                .child(button("style-tr-color", "色を切替", {
                    let current = current.clone();
                    cx.listener(move |view, _event, _window, _cx| {
                        let mut next = current.clone();
                        next.translation_color =
                            cycle_translation_color(&next.translation_color).to_string();
                        on_change(view, next);
                    })
                })),
        )
        .child(field_row(
            "キャプション X %",
            format!("{:.0}%", style.caption_x_percent),
            "style-x-minus",
            "style-x-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.caption_x_percent =
                        adjust_position(next.caption_x_percent, -POSITION_STEP);
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.caption_x_percent = adjust_position(next.caption_x_percent, POSITION_STEP);
                    on_change(view, next);
                })
            },
        ))
        .child(field_row(
            "キャプション Y %",
            format!("{:.0}%", style.caption_y_percent),
            "style-y-minus",
            "style-y-plus",
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.caption_y_percent =
                        adjust_position(next.caption_y_percent, -POSITION_STEP);
                    on_change(view, next);
                })
            },
            {
                let current = current.clone();
                cx.listener(move |view, _event, _window, _cx| {
                    let mut next = current.clone();
                    next.caption_y_percent = adjust_position(next.caption_y_percent, POSITION_STEP);
                    on_change(view, next);
                })
            },
        ))
        .child(button(
            "style-save",
            "スタイルを保存",
            cx.listener(move |view, _event, _window, _cx| on_save(view)),
        ))
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
        .child(muted("プレビュー（同じ数値で更新）"))
        .child(
            div()
                .p_3()
                .rounded_md()
                .bg(gpui::rgb(0x061018))
                .child(div().text_color(parse_rgb(&style.source_color)).child(SharedString::from(
                    format!(
                        "{preview_source}  ·  {}px / {}字 / x{:.0}% y{:.0}%",
                        style.source_font_size_px,
                        style.source_max_chars,
                        style.caption_x_percent,
                        style.caption_y_percent
                    ),
                )))
                .child(div().text_color(parse_rgb(&style.translation_color)).child(
                    SharedString::from(format!(
                        "{preview_translation}  ·  {}px / {}字",
                        style.translation_font_size_px, style.translation_max_chars
                    )),
                )),
        )
}

fn parse_rgb(color: &str) -> gpui::Rgba {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(value) = u32::from_str_radix(hex, 16) {
            return gpui::rgb(value);
        }
    }
    gpui::rgb(0xffffff)
}
