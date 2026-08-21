//! Dictionary tab: list / search / add / delete.

use caption_bridge_dictionary::CustomDictionaryEntry;
use gpui::prelude::*;
use gpui::{div, Context, IntoElement, SharedString};

use crate::ui::{button, card, error_line, heading, muted};

pub struct DictionaryCallbacks<V> {
    pub on_query_backspace: fn(&mut V),
    pub on_query_type: fn(&mut V),
    pub on_reading_backspace: fn(&mut V),
    pub on_reading_type: fn(&mut V),
    pub on_word_backspace: fn(&mut V),
    pub on_word_type: fn(&mut V),
    pub on_add: fn(&mut V),
    pub on_delete_first: fn(&mut V),
}

pub fn render_dictionary<V: 'static>(
    entries: &[CustomDictionaryEntry],
    query: &str,
    draft_reading: &str,
    draft_word: &str,
    persist_error: Option<&str>,
    cx: &mut Context<V>,
    callbacks: DictionaryCallbacks<V>,
) -> impl IntoElement {
    let mut list = div().flex().flex_col().gap_1();
    if entries.is_empty() {
        list = list.child(muted("該当するエントリはありません"));
    } else {
        list = list.child(muted(format!("{} 件", entries.len())));
        if let Some(first) = entries.first() {
            list = list.child(SharedString::from(format!("{} → {}", first.reading, first.word)));
        }
        if let Some(second) = entries.get(1) {
            list = list.child(SharedString::from(format!("{} → {}", second.reading, second.word)));
        }
        if let Some(third) = entries.get(2) {
            list = list.child(SharedString::from(format!("{} → {}", third.reading, third.word)));
        }
        if entries.len() > 3 {
            list = list.child(muted(format!("ほか {} 件", entries.len() - 3)));
        }
    }

    card()
        .child(heading("カスタム辞書"))
        .child(muted("保存先は Native の config_dir/dictionary（初回空なら VRC サンプルをシード）"))
        .child(field_editor(
            "検索",
            query,
            "dict-query-bs",
            "dict-query-type",
            cx,
            callbacks.on_query_backspace,
            callbacks.on_query_type,
        ))
        .child(field_editor(
            "読み",
            draft_reading,
            "dict-reading-bs",
            "dict-reading-type",
            cx,
            callbacks.on_reading_backspace,
            callbacks.on_reading_type,
        ))
        .child(field_editor(
            "単語",
            draft_word,
            "dict-word-bs",
            "dict-word-type",
            cx,
            callbacks.on_word_backspace,
            callbacks.on_word_type,
        ))
        .child(
            div()
                .flex()
                .gap_2()
                .child(button(
                    "dict-add",
                    "追加して保存",
                    cx.listener(move |view, _event, _window, _cx| (callbacks.on_add)(view)),
                ))
                .child(button(
                    "dict-delete",
                    "先頭を削除",
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_delete_first)(view)
                    }),
                )),
        )
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
        .child(list)
}

fn field_editor<V: 'static>(
    label: &'static str,
    value: &str,
    backspace_id: &'static str,
    type_id: &'static str,
    cx: &mut Context<V>,
    on_backspace: fn(&mut V),
    on_type: fn(&mut V),
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_2()
        .child(div().w(gpui::px(80.)).child(SharedString::from(label)))
        .child(
            div().flex_1().px_2().py_1().rounded_md().bg(gpui::rgb(0xe8f4fc)).child(
                SharedString::from(if value.is_empty() { "（空）" } else { value }.to_string()),
            ),
        )
        .child(button(
            backspace_id,
            "⌫",
            cx.listener(move |view, _event, _window, _cx| on_backspace(view)),
        ))
        .child(button(
            type_id,
            "入力+",
            cx.listener(move |view, _event, _window, _cx| on_type(view)),
        ))
}
