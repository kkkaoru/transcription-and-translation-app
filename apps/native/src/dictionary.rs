//! Searchable custom dictionary editor with always-active keyboard fields.

use std::path::PathBuf;

use caption_bridge_dictionary::CustomDictionaryEntry;
use gpui::prelude::*;
use gpui::{Context, ExternalPaths, FocusHandle, IntoElement, Role, SharedString};
use gpui_component::{h_flex, v_flex, ActiveTheme as _};

use crate::domain::{NativeDictionaryProfile, UiLanguage};
use crate::i18n::{text, TextKey};
use crate::ui::{button, card, danger_button, editable_text, error_line, heading, muted};

pub struct DictionaryViewState<'a> {
    pub dictionaries: &'a [NativeDictionaryProfile],
    pub selected_dictionary_id: &'a str,
    pub entries: &'a [CustomDictionaryEntry],
    pub query: &'a str,
    pub draft_reading: &'a str,
    pub draft_word: &'a str,
    pub query_caret: Option<usize>,
    pub reading_caret: Option<usize>,
    pub word_caret: Option<usize>,
    pub query_focus: &'a FocusHandle,
    pub reading_focus: &'a FocusHandle,
    pub word_focus: &'a FocusHandle,
    pub language: UiLanguage,
    pub persist_error: Option<&'a str>,
}

pub struct DictionaryCallbacks<V> {
    pub on_add_dictionary: fn(&mut V),
    pub on_select_dictionary: fn(&mut V, &str),
    pub on_delete_dictionary: fn(&mut V),
    pub on_clear_dictionary: fn(&mut V),
    pub on_import_paths: fn(&mut V, &[PathBuf]),
    pub on_download: fn(&mut V, bool, &mut gpui::Window, &mut Context<V>),
    pub on_focus_query: fn(&mut V, &mut gpui::Window, &mut Context<V>),
    pub on_focus_reading: fn(&mut V, &mut gpui::Window, &mut Context<V>),
    pub on_focus_word: fn(&mut V, &mut gpui::Window, &mut Context<V>),
    pub on_save: fn(&mut V),
    pub on_delete: fn(&mut V, &str),
}

pub fn render_dictionary<V: 'static>(
    state: DictionaryViewState<'_>,
    cx: &mut Context<V>,
    callbacks: DictionaryCallbacks<V>,
) -> impl IntoElement {
    let DictionaryViewState {
        dictionaries,
        selected_dictionary_id,
        entries,
        query,
        draft_reading,
        draft_word,
        query_caret,
        reading_caret,
        word_caret,
        query_focus,
        reading_focus,
        word_focus,
        language,
        persist_error,
    } = state;
    let mut dictionary_buttons = h_flex().flex_wrap().gap_2();
    for dictionary in dictionaries {
        let id = dictionary.id.clone();
        let label = if dictionary.id == selected_dictionary_id {
            format!("✓ {}", dictionary.name)
        } else {
            dictionary.name.clone()
        };
        dictionary_buttons = dictionary_buttons.child(button(
            format!("dictionary-profile-{}", dictionary.id),
            label,
            cx.listener(move |view, _event, _window, _cx| {
                (callbacks.on_select_dictionary)(view, &id)
            }),
        ));
    }

    let mut list = v_flex().gap_2();
    if entries.is_empty() {
        list = list.child(muted(text(language, TextKey::NoEntries), cx));
    } else {
        list = list
            .child(muted(format!("{} {}", entries.len(), text(language, TextKey::EntryCount)), cx));
        for entry in entries {
            let id = entry.id.clone();
            list = list.child(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .px_3()
                    .py_2()
                    .rounded(cx.theme().radius)
                    .bg(cx.theme().muted)
                    .child(SharedString::from(format!("{} → {}", entry.reading, entry.word)))
                    .child(danger_button(
                        format!("dict-delete-{}", entry.id),
                        text(language, TextKey::Delete),
                        cx,
                        cx.listener(move |view, _event, _window, _cx| {
                            (callbacks.on_delete)(view, &id);
                        }),
                    )),
            );
        }
    }

    card(cx)
        .on_drop(cx.listener(move |view, paths: &ExternalPaths, _window, _cx| {
            (callbacks.on_import_paths)(view, paths.paths())
        }))
        .child(heading(text(language, TextKey::Dictionary)))
        .child(dictionary_buttons)
        .child(
            h_flex()
                .flex_wrap()
                .gap_2()
                .child(button(
                    "dictionary-profile-add",
                    text(language, TextKey::AddDictionary),
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_add_dictionary)(view)
                    }),
                ))
                .child(danger_button(
                    "dictionary-profile-delete",
                    text(language, TextKey::DeleteDictionary),
                    cx,
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_delete_dictionary)(view);
                    }),
                ))
                .child(danger_button(
                    "dictionary-clear",
                    text(language, TextKey::ClearDictionary),
                    cx,
                    cx.listener(move |view, _event, _window, _cx| {
                        (callbacks.on_clear_dictionary)(view);
                    }),
                ))
                .child(button(
                    "dictionary-download-csv",
                    text(language, TextKey::DownloadCsv),
                    cx.listener(move |view, _event, window, cx| {
                        (callbacks.on_download)(view, false, window, cx);
                    }),
                ))
                .child(button(
                    "dictionary-download-tsv",
                    text(language, TextKey::DownloadTsv),
                    cx.listener(move |view, _event, window, cx| {
                        (callbacks.on_download)(view, true, window, cx);
                    }),
                )),
        )
        .child(muted(text(language, TextKey::DictionaryImportHint), cx))
        .child(field_editor(
            text(language, TextKey::Search),
            query,
            "dict-query",
            query_caret,
            query_focus,
            cx,
            callbacks.on_focus_query,
        ))
        .child(field_editor(
            text(language, TextKey::Reading),
            draft_reading,
            "dict-reading",
            reading_caret,
            reading_focus,
            cx,
            callbacks.on_focus_reading,
        ))
        .child(field_editor(
            text(language, TextKey::Word),
            draft_word,
            "dict-word",
            word_caret,
            word_focus,
            cx,
            callbacks.on_focus_word,
        ))
        .child(button(
            "dict-save",
            text(language, TextKey::Save),
            cx.listener(move |view, _event, _window, _cx| (callbacks.on_save)(view)),
        ))
        .when_some(persist_error.map(str::to_string), |this, error| this.child(error_line(error)))
        .child(list)
}

fn field_editor<V: 'static>(
    label: &'static str,
    value: &str,
    id: &'static str,
    caret: Option<usize>,
    focus_handle: &FocusHandle,
    cx: &mut Context<V>,
    on_focus: fn(&mut V, &mut gpui::Window, &mut Context<V>),
) -> impl IntoElement {
    let focus_handle = focus_handle.clone();
    h_flex().gap_3().child(gpui_component::label::Label::new(label).w_24()).child(
        h_flex()
            .id(id)
            .track_focus(&focus_handle)
            .tab_index(0)
            .accessibility_id(label)
            .role(Role::TextInput)
            .aria_label(label)
            .aria_value(value)
            .flex_1()
            .min_h_8()
            .px_3()
            .py_2()
            .rounded(cx.theme().radius)
            .border_1()
            .when(caret.is_some(), |this| this.border_2())
            .border_color(if caret.is_some() { cx.theme().foreground } else { cx.theme().input })
            .focus(|style| style.border_2().border_color(cx.theme().foreground))
            .bg(cx.theme().background)
            .cursor_text()
            .on_click(cx.listener(move |view, _event, window, cx| {
                on_focus(view, window, cx);
                window.focus(&focus_handle, cx);
            }))
            .child(editable_text(value, caret, cx)),
    )
}
