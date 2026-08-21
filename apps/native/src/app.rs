//! Operable GPUI shell: clickable tabs and working Live / Style / Dictionary / Settings.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use caption_bridge_dictionary::CustomDictionaryEntry;
use caption_bridge_overlay::DEBUG_OVERLAY_TITLE;
use caption_bridge_syphon::NATIVE_SYPHON_SERVER_NAME;
use gpui::prelude::*;
use gpui::{
    div, point, px, size, App, Bounds, Context, FocusHandle, IntoElement, KeyDownEvent, Render,
    SharedString, Size, TitlebarOptions, Window, WindowBounds, WindowOptions,
};

use crate::capture::CaptureController;
use crate::debug_surfaces::{
    hide_overlay, open_overlay, print_debug_status, start_debug_surfaces, start_syphon,
    stop_syphon, DebugSurfaces,
};
use crate::dictionary::{render_dictionary, DictionaryCallbacks};
use crate::domain::{
    add_dictionary_entry, delete_dictionary_entry, ingest_fixture_caption, load_app_settings,
    load_dictionary_entries, load_style_settings, native_config_dir, parse_debug_launch,
    save_app_settings, save_dictionary_entries, save_style_settings, search_dictionary_entries,
    AppTab, NativeAppSettings, NativeStyleSettings, BUNDLE_ID, DEFAULT_PREVIEW_SOURCE,
    DEFAULT_PREVIEW_TRANSLATION, FLAG_HELP, MIN_WINDOW_HEIGHT_PX, MIN_WINDOW_WIDTH_PX,
    PRODUCT_NAME, WINDOW_HEIGHT_PX, WINDOW_TITLE, WINDOW_WIDTH_PX,
};
use crate::live::{render_live, LiveCallbacks};
use crate::settings::{render_settings, SettingsCallbacks};
use crate::style::render_style;
use crate::ui::{heading, muted, sky_page, tab_bar};

pub struct MainView {
    tab: AppTab,
    config_dir: PathBuf,
    style: NativeStyleSettings,
    app_settings: NativeAppSettings,
    capture: CaptureController,
    entries: Vec<CustomDictionaryEntry>,
    query: String,
    draft_reading: String,
    draft_word: String,
    persist_error: Option<String>,
    focused_field: FocusField,
    focus_handle: FocusHandle,
    surfaces: Rc<RefCell<DebugSurfaces>>,
    preview_source: String,
    preview_translation: String,
    device_select_open: bool,
    last_published_caption: Option<(String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FocusField {
    Query,
    Reading,
    Word,
}

impl MainView {
    pub fn new(cx: &mut Context<Self>, surfaces: Rc<RefCell<DebugSurfaces>>) -> Self {
        let config_dir = native_config_dir();
        let style = load_style_settings(&config_dir).unwrap_or_default();
        let app_settings = load_app_settings(&config_dir).unwrap_or_default();
        let entries = load_dictionary_entries(&config_dir).unwrap_or_default();
        let fixture = ingest_fixture_caption().ok();
        let preview_source = fixture
            .as_ref()
            .map(|caption| caption.source_text.clone())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| DEFAULT_PREVIEW_SOURCE.to_string());
        Self {
            tab: AppTab::Live,
            config_dir,
            style,
            app_settings,
            capture: CaptureController::new(),
            entries,
            query: String::new(),
            draft_reading: String::new(),
            draft_word: String::new(),
            persist_error: None,
            focused_field: FocusField::Reading,
            focus_handle: cx.focus_handle(),
            surfaces,
            preview_source,
            preview_translation: DEFAULT_PREVIEW_TRANSLATION.to_string(),
            device_select_open: false,
            last_published_caption: None,
        }
    }

    fn publish_live_caption(&mut self) {
        let snapshot = self.capture.snapshot();
        let caption = (snapshot.source_text.clone(), snapshot.translation_text.clone());
        match self.surfaces.borrow_mut().publish_caption(
            &self.style,
            &caption.0,
            &caption.1,
            self.last_published_caption.as_ref(),
        ) {
            Ok(Some(_)) => {
                self.last_published_caption = Some(caption);
            }
            Ok(None) => {}
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn select_tab(&mut self, tab: AppTab) {
        self.tab = tab;
    }

    fn toggle_device_select(&mut self) {
        self.device_select_open = !self.device_select_open;
    }

    fn select_device(&mut self, id: &str) {
        self.capture.select_device(id);
        self.device_select_open = false;
    }

    fn persist_style(&mut self) {
        self.last_published_caption = None;
        match save_style_settings(&self.config_dir, &self.style) {
            Ok(()) => self.persist_error = None,
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn persist_settings(&mut self) {
        match save_app_settings(&self.config_dir, &self.app_settings) {
            Ok(()) => self.persist_error = None,
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn toggle_overlay(&mut self, open: bool) {
        let result = {
            let mut surfaces = self.surfaces.borrow_mut();
            if open {
                open_overlay(&mut surfaces)
            } else {
                hide_overlay(&mut surfaces);
                Ok(())
            }
        };
        match result {
            Ok(()) => {
                self.app_settings.overlay_open = open;
                if open {
                    self.last_published_caption = None;
                }
                self.persist_settings();
            }
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn toggle_syphon(&mut self) {
        let result = {
            let mut surfaces = self.surfaces.borrow_mut();
            if surfaces.syphon.is_some() {
                stop_syphon(&mut surfaces);
                Ok(false)
            } else {
                start_syphon(&mut surfaces).map(|()| true)
            }
        };
        match result {
            Ok(enabled) => {
                self.app_settings.syphon_enabled = enabled;
                if enabled {
                    self.last_published_caption = None;
                }
                self.persist_settings();
            }
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn persist_dictionary(&mut self, next: Vec<CustomDictionaryEntry>) {
        match save_dictionary_entries(&self.config_dir, &next) {
            Ok(saved) => {
                self.entries = saved;
                self.persist_error = None;
            }
            Err(error) => self.persist_error = Some(error.to_string()),
        }
    }

    fn apply_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        if self.tab != AppTab::Dictionary {
            return;
        }
        if event.keystroke.key == "backspace" {
            self.pop_focused();
            cx.notify();
            return;
        }
        if event.keystroke.key == "tab" {
            self.focused_field = match self.focused_field {
                FocusField::Query => FocusField::Reading,
                FocusField::Reading => FocusField::Word,
                FocusField::Word => FocusField::Query,
            };
            cx.notify();
            return;
        }
        if let Some(ch) = event.keystroke.key_char.as_deref() {
            if !ch.is_empty() && ch != "\u{8}" && ch != "\r" && ch != "\n" && ch != "\t" {
                self.push_focused(ch);
                cx.notify();
            }
        }
    }

    fn focused_buffer_mut(&mut self) -> &mut String {
        match self.focused_field {
            FocusField::Query => &mut self.query,
            FocusField::Reading => &mut self.draft_reading,
            FocusField::Word => &mut self.draft_word,
        }
    }

    fn push_focused(&mut self, text: &str) {
        self.focused_buffer_mut().push_str(text);
    }

    fn pop_focused(&mut self) {
        self.focused_buffer_mut().pop();
    }

    fn append_sample_to_focused(&mut self) {
        let next = match self.focused_field {
            FocusField::Query => "ぶい",
            FocusField::Reading => "あ",
            FocusField::Word => "A",
        };
        self.push_focused(next);
    }

    fn visible_entries(&self) -> Vec<CustomDictionaryEntry> {
        search_dictionary_entries(&self.entries, &self.query)
    }
}

impl Render for MainView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.capture.poll();
        window.focus(&self.focus_handle, cx);
        let overlay_open = self.surfaces.borrow().overlay.is_some();
        let syphon_on = self.surfaces.borrow().syphon.is_some();
        let persist = self.persist_error.clone();
        let body = match self.tab {
            AppTab::Live => render_live(
                &self.capture,
                self.device_select_open,
                cx,
                &LiveCallbacks {
                    on_refresh: |view| view.capture.refresh_devices(),
                    on_toggle_select: |view| view.toggle_device_select(),
                    on_select_device: |view, id| view.select_device(id),
                    on_start: |view| {
                        if let Err(error) = view.capture.start() {
                            view.persist_error = Some(error);
                        } else {
                            view.persist_error = None;
                        }
                    },
                    on_stop: |view| view.capture.stop(),
                },
            )
            .into_any_element(),
            AppTab::Style => render_style(
                &self.style,
                &self.preview_source,
                &self.preview_translation,
                persist.as_deref(),
                cx,
                |view, next| view.style = next,
                |view| view.persist_style(),
            )
            .into_any_element(),
            AppTab::Dictionary => render_dictionary(
                &self.visible_entries(),
                &self.query,
                &self.draft_reading,
                &self.draft_word,
                persist.as_deref(),
                cx,
                DictionaryCallbacks {
                    on_query_backspace: |view| {
                        view.focused_field = FocusField::Query;
                        view.pop_focused();
                    },
                    on_query_type: |view| {
                        view.focused_field = FocusField::Query;
                        view.append_sample_to_focused();
                    },
                    on_reading_backspace: |view| {
                        view.focused_field = FocusField::Reading;
                        view.pop_focused();
                    },
                    on_reading_type: |view| {
                        view.focused_field = FocusField::Reading;
                        view.append_sample_to_focused();
                    },
                    on_word_backspace: |view| {
                        view.focused_field = FocusField::Word;
                        view.pop_focused();
                    },
                    on_word_type: |view| {
                        view.focused_field = FocusField::Word;
                        view.append_sample_to_focused();
                    },
                    on_add: |view| match add_dictionary_entry(
                        &view.entries,
                        &view.draft_reading,
                        &view.draft_word,
                    ) {
                        Ok(next) => {
                            view.draft_reading.clear();
                            view.draft_word.clear();
                            view.persist_dictionary(next);
                        }
                        Err(error) => view.persist_error = Some(error),
                    },
                    on_delete_first: |view| {
                        if let Some(first) = view.visible_entries().first().cloned() {
                            let next = delete_dictionary_entry(&view.entries, &first.id);
                            view.persist_dictionary(next);
                        }
                    },
                },
            )
            .into_any_element(),
            AppTab::Settings => render_settings(
                &self.app_settings,
                overlay_open,
                syphon_on,
                persist.as_deref(),
                cx,
                SettingsCallbacks {
                    on_open_overlay: |view| view.toggle_overlay(true),
                    on_hide_overlay: |view| view.toggle_overlay(false),
                    on_toggle_syphon: |view| view.toggle_syphon(),
                },
            )
            .into_any_element(),
        };

        sky_page()
            .id("main-root")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|view, event, _window, cx| view.apply_key(event, cx)))
            .child(heading(PRODUCT_NAME))
            .child(muted(format!("bundle id: {BUNDLE_ID}")))
            .child(tab_bar(self.tab, cx, |view, tab| view.select_tab(tab)))
            .child(div().flex_1().child(body))
            .child(muted(format!(
                "overlay title: {DEBUG_OVERLAY_TITLE} / Syphon: {NATIVE_SYPHON_SERVER_NAME}"
            )))
            .child(SharedString::from(format!("active tab: {}", self.tab.label())))
    }
}

pub fn main_window_options() -> WindowOptions {
    WindowOptions {
        titlebar: Some(TitlebarOptions { title: Some(WINDOW_TITLE.into()), ..Default::default() }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(0.), px(0.)),
            size(px(WINDOW_WIDTH_PX), px(WINDOW_HEIGHT_PX)),
        ))),
        is_resizable: true,
        window_min_size: Some(Size {
            width: px(MIN_WINDOW_WIDTH_PX),
            height: px(MIN_WINDOW_HEIGHT_PX),
        }),
        app_id: Some(BUNDLE_ID.to_string()),
        ..Default::default()
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == FLAG_HELP) {
        crate::domain::print_usage();
        return;
    }
    let launch = parse_debug_launch(&args);
    gpui_platform::application().run(move |cx: &mut App| {
        // Debug surfaces (overlay / Syphon / Spout) must start after GPUI has
        // finished configuring NSApplication. Starting them before
        // `application().run` creates a plain NSApplication and makes the
        // gpui_macos platform panic with "Ivar platform not found on class
        // NSApplication".
        let surfaces_result = start_debug_surfaces(launch);
        print_debug_status(launch, &surfaces_result);
        if let Err(error) = &surfaces_result {
            eprintln!("{error}");
        }
        let surfaces =
            Rc::new(RefCell::new(surfaces_result.unwrap_or_else(|_| DebugSurfaces::empty())));
        let poll_surfaces = Rc::clone(&surfaces);

        let mut options = main_window_options();
        options.window_bounds =
            Some(WindowBounds::centered(size(px(WINDOW_WIDTH_PX), px(WINDOW_HEIGHT_PX)), cx));
        let window_handle = match cx
            .open_window(options, |_, cx| cx.new(|cx| MainView::new(cx, Rc::clone(&surfaces))))
        {
            Ok(handle) => handle,
            Err(error) => {
                eprintln!("メインウィンドウを開けません: {error}");
                return;
            }
        };
        cx.activate(true);
        cx.spawn(async move |cx| loop {
            let _ = caption_bridge_overlay::pump_native_events();
            let _ = poll_surfaces.borrow_mut().overlay.as_mut();
            if window_handle
                .update(cx, |view, _window, cx| {
                    view.capture.poll();
                    view.publish_live_caption();
                    cx.notify();
                })
                .is_err()
            {
                break;
            }
            cx.background_executor().timer(Duration::from_millis(32)).await;
        })
        .detach();
    });
}
