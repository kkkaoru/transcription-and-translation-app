//! GPUI shell for capture, style, dictionary, output, and runtime settings.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use caption_bridge_browser_source::{BrowserSourceConfig, BrowserSourceServer, BrowserSourceStyle};
use caption_bridge_dictionary::CustomDictionaryEntry;
use gpui::prelude::*;
use gpui::{
    div, point, px, rgb, size, App, Bounds, ClipboardItem, Context, FocusHandle, IntoElement,
    KeyDownEvent, Pixels, Render, RenderImage, Size, Subscription, Task, TitlebarOptions, Window,
    WindowBounds, WindowOptions,
};

use crate::capture::CaptureController;
use crate::debug_surfaces::{
    print_debug_status, start_debug_surfaces, start_syphon, stop_syphon, DebugSurfaces,
};
use crate::dictionary::{render_dictionary, DictionaryCallbacks, DictionaryViewState};
use crate::domain::{
    add_dictionary_entry, add_dictionary_profile, add_style_profile, clear_selected_dictionary,
    delete_dictionary_entry, delete_selected_dictionary_profile, delete_selected_style_profile,
    import_dictionary_file, ingest_fixture_caption, load_app_settings, load_dictionary_catalog,
    load_style_catalog, local_translation_model_installed, merge_dictionary_entries,
    native_config_dir, parse_debug_launch, rasterize_live_caption_at_scale,
    rasterize_style_preview, replace_selected_dictionary_entries, save_app_settings,
    save_dictionary_catalog, save_style_catalog, search_dictionary_entries,
    select_dictionary_profile, select_style_profile, AppTab, CaptureStatus, NativeAppSettings,
    NativeDictionaryCatalog, NativeStyleCatalog, NativeStyleSettings, BUNDLE_ID,
    DEFAULT_PREVIEW_SOURCE, DEFAULT_PREVIEW_TRANSLATION, FLAG_HELP, MIN_WINDOW_HEIGHT_PX,
    MIN_WINDOW_WIDTH_PX, NATIVE_BROWSER_SOURCE_HINT, WINDOW_HEIGHT_PX, WINDOW_TITLE,
    WINDOW_WIDTH_PX,
};
use crate::hot_path::{caption_changed, should_check_output_window, OUTPUT_WINDOW_HEALTH_INTERVAL};
use crate::i18n::{text, TextKey};
use crate::live::{render_live, LiveCallbacks};
use crate::output::{render_output, OutputCallbacks};
use crate::settings::{render_settings, SettingsCallbacks};
use crate::style::{render_style, FontPickerState, StyleCallbacks, StyleViewState};
use crate::ui::{image_view, render_image, sky_page, tab_bar};

const OUTPUT_WINDOW_TITLE: &str = "Kotoba Beacon Caption Output";
const OUTPUT_WINDOW_WIDTH_PX: f32 = 1280.0;
const OUTPUT_WINDOW_HEIGHT_PX: f32 = 720.0;
const CAPTURE_WINDOW_WIDTH_PX: f32 = MIN_WINDOW_WIDTH_PX;
const CAPTURE_WINDOW_HEIGHT_PX: f32 = MIN_WINDOW_HEIGHT_PX;
const ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(32);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(250);

struct CaptionOutputView {
    image: Arc<RenderImage>,
    caption: (String, String),
    style: NativeStyleSettings,
    scale_factor: f32,
}

pub struct MainView {
    tab: AppTab,
    config_dir: PathBuf,
    style: NativeStyleSettings,
    style_catalog: NativeStyleCatalog,
    app_settings: NativeAppSettings,
    capture: CaptureController,
    dictionary_catalog: NativeDictionaryCatalog,
    query: String,
    query_caret: usize,
    draft_reading: String,
    reading_caret: usize,
    draft_word: String,
    word_caret: usize,
    font_query: String,
    font_caret: usize,
    fonts: Vec<String>,
    font_select_open: bool,
    active_color_picker: Option<String>,
    persist_error: Option<String>,
    focused_field: FocusField,
    focus_handle: FocusHandle,
    surfaces: Rc<RefCell<DebugSurfaces>>,
    preview_source: String,
    preview_translation: String,
    style_preview_image: Option<Arc<RenderImage>>,
    stale_render_images: Vec<Arc<RenderImage>>,
    preview_source_caret: usize,
    preview_translation_caret: usize,
    device_select_open: bool,
    last_published_caption: Option<(String, String)>,
    last_browser_caption: Option<(String, String)>,
    last_output_window_check: Instant,
    browser_source: BrowserSourceServer,
    output_window_requested: bool,
    capture_view_compact: bool,
    pre_capture_window_size: Option<Size<Pixels>>,
    _quit_subscription: Subscription,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FocusField {
    Query,
    Reading,
    Word,
    Font,
    PreviewSource,
    PreviewTranslation,
}

impl CaptionOutputView {
    fn new(style: NativeStyleSettings, scale_factor: f32) -> Self {
        let image = render_image(rasterize_live_caption_at_scale(&style, "", "", scale_factor));
        Self { image, caption: (String::new(), String::new()), style, scale_factor }
    }

    fn with_caption(
        style: NativeStyleSettings,
        scale_factor: f32,
        source: String,
        translation: String,
    ) -> Self {
        let image = render_image(rasterize_live_caption_at_scale(
            &style,
            &source,
            &translation,
            scale_factor,
        ));
        Self { image, caption: (source, translation), style, scale_factor }
    }

    fn replace_caption(
        &mut self,
        source: String,
        translation: String,
        style: NativeStyleSettings,
        scale_factor: f32,
        window: &mut Window,
    ) -> bool {
        let caption = (source, translation);
        if self.caption == caption && self.style == style && self.scale_factor == scale_factor {
            return false;
        }
        let next_image = render_image(rasterize_live_caption_at_scale(
            &style,
            &caption.0,
            &caption.1,
            scale_factor,
        ));
        let previous_image = std::mem::replace(&mut self.image, next_image);
        let _ = window.drop_image(previous_image);
        self.caption = caption;
        self.style = style;
        self.scale_factor = scale_factor;
        true
    }
}

impl Render for CaptionOutputView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(rgb(0x00ff00)).child(image_view(Arc::clone(&self.image)))
    }
}

impl MainView {
    pub fn new(
        cx: &mut Context<Self>,
        surfaces: Rc<RefCell<DebugSurfaces>>,
        config_dir: PathBuf,
        style_catalog: NativeStyleCatalog,
        dictionary_catalog: NativeDictionaryCatalog,
        app_settings: NativeAppSettings,
    ) -> Self {
        let style = style_catalog.selected().style.clone();
        let fixture = ingest_fixture_caption().ok();
        let preview_source = fixture
            .as_ref()
            .map(|caption| caption.source_text.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_PREVIEW_SOURCE.to_string());
        let quit_subscription = cx.on_app_quit(|view, _cx| {
            view.capture.stop();
            view.browser_source.stop();
            Task::ready(())
        });
        let (browser_source, browser_error) =
            start_browser_source(app_settings.browser_source_enabled);
        browser_source.set_style(browser_style(&style));
        let fonts = Vec::new();
        let preview_translation = DEFAULT_PREVIEW_TRANSLATION.to_string();
        // The HiDPI preview is only needed on the Style tab. Avoid retaining its
        // multi-megabyte RGBA image throughout normal Live capture.
        let style_preview_image = None;
        let preview_source_caret = preview_source.len();
        let preview_translation_caret = preview_translation.len();
        let mut capture = CaptureController::new();
        capture
            .set_translation_enabled(app_settings.translation_enabled)
            .expect("idle translation setting must not require a worker command");
        Self {
            tab: AppTab::Live,
            config_dir,
            style,
            style_catalog,
            app_settings,
            capture,
            dictionary_catalog,
            query: String::new(),
            query_caret: 0,
            draft_reading: String::new(),
            reading_caret: 0,
            draft_word: String::new(),
            word_caret: 0,
            font_query: String::new(),
            font_caret: 0,
            fonts,
            font_select_open: false,
            active_color_picker: None,
            persist_error: browser_error,
            focused_field: FocusField::Reading,
            focus_handle: cx.focus_handle(),
            surfaces,
            preview_source,
            preview_translation,
            style_preview_image,
            stale_render_images: Vec::new(),
            preview_source_caret,
            preview_translation_caret,
            device_select_open: false,
            last_published_caption: None,
            last_browser_caption: None,
            last_output_window_check: Instant::now() - OUTPUT_WINDOW_HEALTH_INTERVAL,
            browser_source,
            output_window_requested: false,
            capture_view_compact: false,
            pre_capture_window_size: None,
            _quit_subscription: quit_subscription,
        }
    }

    fn publish_live_caption(&mut self) -> bool {
        let snapshot = self.capture.snapshot();
        let source = snapshot.source_text.as_str();
        let translation = snapshot.translation_text.as_str();
        let browser_changed =
            caption_changed(self.last_browser_caption.as_ref(), source, translation);
        if browser_changed {
            self.browser_source.feed(source, translation);
            self.last_browser_caption = Some((source.to_string(), translation.to_string()));
        }
        let surface_changed = match self.surfaces.borrow_mut().publish_caption(
            &self.style,
            source,
            translation,
            self.last_published_caption.as_ref(),
        ) {
            Ok(Some(_)) => {
                self.last_published_caption = Some((source.to_string(), translation.to_string()));
                true
            }
            Ok(None) => false,
            Err(error) => {
                self.persist_error = Some(error);
                false
            }
        };
        browser_changed || surface_changed
    }

    fn select_tab(&mut self, tab: AppTab) {
        self.tab = tab;
        if tab == AppTab::Style {
            if self.fonts.is_empty() {
                self.fonts = caption_bridge_render::font_families();
            }
            if self.style_preview_image.is_none() {
                self.refresh_style_preview();
            }
        } else {
            self.fonts.clear();
            self.fonts.shrink_to_fit();
            if let Some(previous_image) = self.style_preview_image.take() {
                self.stale_render_images.push(previous_image);
            }
        }
    }

    fn update_capture_display(&mut self, status: CaptureStatus, window: &mut Window) {
        let capture_active = capture_display_active(status);
        if capture_active == self.capture_view_compact {
            return;
        }
        self.capture_view_compact = capture_active;
        if capture_active {
            self.select_tab(AppTab::Live);
            self.font_select_open = false;
            self.active_color_picker = None;
            self.fonts.clear();
            self.fonts.shrink_to_fit();
            self.pre_capture_window_size = Some(window.viewport_size());
            window.resize(size(px(CAPTURE_WINDOW_WIDTH_PX), px(CAPTURE_WINDOW_HEIGHT_PX)));
        } else {
            if let Some(previous_size) = self.pre_capture_window_size.take() {
                window.resize(previous_size);
            }
        }
    }

    fn toggle_device_select(&mut self) {
        if !self.device_select_open {
            self.capture.refresh_devices();
        }
        self.device_select_open = !self.device_select_open;
    }

    fn select_device(&mut self, id: &str) {
        self.capture.select_device(id);
        self.device_select_open = false;
    }

    fn set_style(&mut self, next: NativeStyleSettings) {
        self.style = next.clone();
        if let Some(profile) = self
            .style_catalog
            .profiles
            .iter_mut()
            .find(|profile| profile.id == self.style_catalog.selected_id)
        {
            profile.style = next;
        }
        self.refresh_style_preview();
        self.last_published_caption = None;
        self.last_browser_caption = None;
        self.browser_source.set_style(browser_style(&self.style));
        if let Err(error) = save_style_catalog(&self.config_dir, &self.style_catalog) {
            self.persist_error = Some(error);
        } else {
            self.persist_error = None;
        }
    }

    fn set_style_catalog(&mut self, catalog: NativeStyleCatalog) {
        self.style = catalog.selected().style.clone();
        self.style_catalog = catalog;
        self.refresh_style_preview();
        self.last_published_caption = None;
        self.last_browser_caption = None;
        self.browser_source.set_style(browser_style(&self.style));
        if let Err(error) = save_style_catalog(&self.config_dir, &self.style_catalog) {
            self.persist_error = Some(error);
        } else {
            self.persist_error = None;
        }
    }

    fn persist_settings(&mut self) {
        if let Err(error) = save_app_settings(&self.config_dir, &self.app_settings) {
            self.persist_error = Some(error);
        } else {
            self.persist_error = None;
        }
    }

    fn toggle_translation(&mut self) {
        let enabled = !self.app_settings.translation_enabled;
        match self.capture.set_translation_enabled(enabled) {
            Ok(()) => {
                self.app_settings.translation_enabled = enabled;
                self.last_published_caption = None;
                self.last_browser_caption = None;
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
                self.last_published_caption = None;
                self.persist_settings();
            }
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn toggle_browser_source(&mut self) {
        if self.browser_source.is_running() {
            self.browser_source.stop();
            self.app_settings.browser_source_enabled = false;
            self.persist_settings();
            return;
        }
        match BrowserSourceServer::start(BrowserSourceConfig::native()) {
            Ok(server) => {
                server.set_style(browser_style(&self.style));
                self.browser_source = server;
                self.app_settings.browser_source_enabled = true;
                self.persist_settings();
            }
            Err(error) => self.persist_error = Some(error.to_string()),
        }
    }

    fn persist_dictionary(&mut self, next: Vec<CustomDictionaryEntry>) {
        let catalog = replace_selected_dictionary_entries(&self.dictionary_catalog, next);
        match save_dictionary_catalog(&self.config_dir, &catalog) {
            Ok(()) => {
                self.dictionary_catalog = catalog;
                self.persist_error = None;
            }
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn set_dictionary_catalog(&mut self, catalog: NativeDictionaryCatalog) {
        match save_dictionary_catalog(&self.config_dir, &catalog) {
            Ok(()) => {
                self.dictionary_catalog = catalog;
                self.query.clear();
                self.query_caret = 0;
                self.persist_error = None;
            }
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn import_dictionary_paths(&mut self, paths: &[PathBuf]) {
        let mut entries = self.dictionary_catalog.selected().entries.clone();
        for path in paths {
            match import_dictionary_file(path) {
                Ok(imported) => entries = merge_dictionary_entries(&entries, imported),
                Err(error) => {
                    self.persist_error = Some(error);
                    return;
                }
            }
        }
        self.persist_dictionary(entries);
    }

    fn apply_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let accepts_input = match self.tab {
            AppTab::Dictionary => matches!(
                self.focused_field,
                FocusField::Query | FocusField::Reading | FocusField::Word
            ),
            AppTab::Style => matches!(
                self.focused_field,
                FocusField::Font | FocusField::PreviewSource | FocusField::PreviewTranslation
            ),
            _ => false,
        };
        if !accepts_input {
            return;
        }
        if event.keystroke.key == "tab" {
            self.focused_field = match self.focused_field {
                FocusField::Query => FocusField::Reading,
                FocusField::Reading => FocusField::Word,
                FocusField::Word => FocusField::Query,
                FocusField::Font => FocusField::PreviewSource,
                FocusField::PreviewSource => FocusField::PreviewTranslation,
                FocusField::PreviewTranslation => FocusField::Font,
            };
            cx.notify();
            return;
        }
        self.apply_focused_text_key(event);
        cx.notify();
    }

    fn apply_focused_text_key(&mut self, event: &KeyDownEvent) {
        let preview_text_field = matches!(
            self.focused_field,
            FocusField::PreviewSource | FocusField::PreviewTranslation
        );
        let (buffer, caret) = match self.focused_field {
            FocusField::Query => (&mut self.query, &mut self.query_caret),
            FocusField::Reading => (&mut self.draft_reading, &mut self.reading_caret),
            FocusField::Word => (&mut self.draft_word, &mut self.word_caret),
            FocusField::Font => (&mut self.font_query, &mut self.font_caret),
            FocusField::PreviewSource => (&mut self.preview_source, &mut self.preview_source_caret),
            FocusField::PreviewTranslation => {
                (&mut self.preview_translation, &mut self.preview_translation_caret)
            }
        };
        let previous_text = preview_text_field.then(|| buffer.clone());
        match event.keystroke.key.as_str() {
            "backspace" => erase_editable_text(buffer, caret),
            "delete" => delete_editable_text(buffer, caret),
            "left" => *caret = previous_caret(buffer, *caret),
            "right" => *caret = next_caret(buffer, *caret),
            "home" => *caret = 0,
            "end" => *caret = buffer.len(),
            _ => {
                if let Some(value) = event.keystroke.key_char.as_deref() {
                    if !value.is_empty() && !matches!(value, "\u{8}" | "\r" | "\n" | "\t") {
                        insert_editable_text(buffer, caret, value);
                    }
                }
            }
        }
        if previous_text.as_ref().is_some_and(|text| text != buffer) {
            self.refresh_style_preview();
        }
    }

    fn refresh_style_preview(&mut self) {
        let next_image = render_image(rasterize_style_preview(
            &self.style,
            &self.preview_source,
            &self.preview_translation,
        ));
        if let Some(previous_image) = self.style_preview_image.replace(next_image) {
            self.stale_render_images.push(previous_image);
        }
    }

    fn visible_entries(&self) -> Vec<CustomDictionaryEntry> {
        search_dictionary_entries(&self.dictionary_catalog.selected().entries, &self.query)
    }
}

pub(crate) fn erase_editable_text(buffer: &mut String, caret: &mut usize) {
    let previous = previous_caret(buffer, *caret);
    if previous < *caret {
        buffer.replace_range(previous..*caret, "");
        *caret = previous;
    }
}

pub(crate) fn delete_editable_text(buffer: &mut String, caret: &mut usize) {
    let next = next_caret(buffer, *caret);
    if *caret < next {
        buffer.replace_range(*caret..next, "");
    }
}

pub(crate) fn insert_editable_text(buffer: &mut String, caret: &mut usize, value: &str) {
    buffer.insert_str(*caret, value);
    *caret += value.len();
}

pub(crate) fn previous_caret(buffer: &str, caret: usize) -> usize {
    buffer[..caret].char_indices().next_back().map_or(0, |(index, _)| index)
}

pub(crate) fn next_caret(buffer: &str, caret: usize) -> usize {
    buffer[caret..].chars().next().map_or(buffer.len(), |character| caret + character.len_utf8())
}

impl Render for MainView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for image in self.stale_render_images.drain(..) {
            let _ = window.drop_image(image);
        }
        window.focus(&self.focus_handle, cx);
        let language = self.app_settings.ui_language;
        let persist = self.persist_error.clone();
        let body = match self.tab {
            AppTab::Live => render_live(
                &self.capture,
                self.device_select_open,
                language,
                cx,
                &LiveCallbacks {
                    on_toggle_select: MainView::toggle_device_select,
                    on_refresh_devices: |view| {
                        view.capture.refresh_devices();
                    },
                    on_select_device: |view, id| view.select_device(id),
                    on_start: |view| {
                        if let Err(error) =
                            view.capture.start(view.app_settings.translation_enabled)
                        {
                            view.persist_error = Some(error);
                        }
                    },
                    on_stop: |view| view.capture.stop(),
                    on_toggle_translation: |view| view.toggle_translation(),
                },
            )
            .into_any_element(),
            AppTab::Style => render_style(
                &self.style,
                StyleViewState {
                    profiles: &self.style_catalog.profiles,
                    selected_profile_id: &self.style_catalog.selected_id,
                    preview_source: &self.preview_source,
                    preview_translation: &self.preview_translation,
                    preview_image: Arc::clone(
                        self.style_preview_image
                            .as_ref()
                            .expect("Style tab must initialize its preview image"),
                    ),
                    fonts: FontPickerState {
                        query: &self.font_query,
                        families: &self.fonts,
                        open: self.font_select_open,
                        caret: (self.focused_field == FocusField::Font).then_some(self.font_caret),
                    },
                    language,
                    active_color_picker: self.active_color_picker.as_deref(),
                    preview_source_caret: (self.focused_field == FocusField::PreviewSource)
                        .then_some(self.preview_source_caret),
                    preview_translation_caret: (self.focused_field
                        == FocusField::PreviewTranslation)
                        .then_some(self.preview_translation_caret),
                    persist_error: persist.as_deref(),
                },
                cx,
                StyleCallbacks {
                    on_add_profile: |view| {
                        let catalog = add_style_profile(&view.style_catalog);
                        view.set_style_catalog(catalog);
                    },
                    on_select_profile: |view, id| {
                        let catalog = select_style_profile(&view.style_catalog, id);
                        view.set_style_catalog(catalog);
                    },
                    on_delete_profile: |view| {
                        let catalog = delete_selected_style_profile(&view.style_catalog);
                        view.set_style_catalog(catalog);
                    },
                    on_change: |view, next| view.set_style(next),
                    on_font_focus: |view, window, cx| {
                        view.focused_field = FocusField::Font;
                        view.font_caret = view.font_query.len();
                        view.font_select_open = true;
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_font_select: |view, family| {
                        let mut next = view.style.clone();
                        next.font_family = family.to_string();
                        view.font_query.clear();
                        view.font_caret = 0;
                        view.font_select_open = false;
                        view.set_style(next);
                    },
                    on_preview_source_focus: |view, window, cx| {
                        view.focused_field = FocusField::PreviewSource;
                        view.preview_source_caret = view.preview_source.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_preview_translation_focus: |view, window, cx| {
                        view.focused_field = FocusField::PreviewTranslation;
                        view.preview_translation_caret = view.preview_translation.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_color_toggle: |view, id| {
                        if view.active_color_picker.as_deref() == Some(id) {
                            view.active_color_picker = None;
                        } else {
                            view.active_color_picker = Some(id.to_string());
                        }
                    },
                },
            )
            .into_any_element(),
            AppTab::Dictionary => render_dictionary(
                DictionaryViewState {
                    dictionaries: &self.dictionary_catalog.dictionaries,
                    selected_dictionary_id: &self.dictionary_catalog.selected_id,
                    entries: &self.visible_entries(),
                    query: &self.query,
                    draft_reading: &self.draft_reading,
                    draft_word: &self.draft_word,
                    query_caret: (self.focused_field == FocusField::Query)
                        .then_some(self.query_caret),
                    reading_caret: (self.focused_field == FocusField::Reading)
                        .then_some(self.reading_caret),
                    word_caret: (self.focused_field == FocusField::Word).then_some(self.word_caret),
                    language,
                    persist_error: persist.as_deref(),
                },
                cx,
                DictionaryCallbacks {
                    on_add_dictionary: |view| {
                        let catalog = add_dictionary_profile(&view.dictionary_catalog);
                        view.set_dictionary_catalog(catalog);
                    },
                    on_select_dictionary: |view, id| {
                        let catalog = select_dictionary_profile(&view.dictionary_catalog, id);
                        view.set_dictionary_catalog(catalog);
                    },
                    on_delete_dictionary: |view| {
                        let catalog = delete_selected_dictionary_profile(&view.dictionary_catalog);
                        view.set_dictionary_catalog(catalog);
                    },
                    on_clear_dictionary: |view| {
                        let catalog = clear_selected_dictionary(&view.dictionary_catalog);
                        view.set_dictionary_catalog(catalog);
                    },
                    on_import_paths: |view, paths| view.import_dictionary_paths(paths),
                    on_focus_query: |view, window, cx| {
                        view.focused_field = FocusField::Query;
                        view.query_caret = view.query.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_focus_reading: |view, window, cx| {
                        view.focused_field = FocusField::Reading;
                        view.reading_caret = view.draft_reading.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_focus_word: |view, window, cx| {
                        view.focused_field = FocusField::Word;
                        view.word_caret = view.draft_word.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_save: |view| match add_dictionary_entry(
                        &view.dictionary_catalog.selected().entries,
                        &view.draft_reading,
                        &view.draft_word,
                    ) {
                        Ok(next) => {
                            view.draft_reading.clear();
                            view.reading_caret = 0;
                            view.draft_word.clear();
                            view.word_caret = 0;
                            view.persist_dictionary(next);
                        }
                        Err(_) => {
                            view.persist_error = Some(
                                text(view.app_settings.ui_language, TextKey::DictionaryRequired)
                                    .to_string(),
                            );
                        }
                    },
                    on_delete: |view, id| {
                        let next = delete_dictionary_entry(
                            &view.dictionary_catalog.selected().entries,
                            id,
                        );
                        view.persist_dictionary(next);
                    },
                },
            )
            .into_any_element(),
            AppTab::Output => render_output(
                &self.app_settings,
                self.browser_source.is_running(),
                persist.as_deref(),
                cx,
                OutputCallbacks {
                    on_open_window: |view| view.output_window_requested = true,
                    on_toggle_window_startup: |view| {
                        view.app_settings.caption_output_open_on_start =
                            !view.app_settings.caption_output_open_on_start;
                        view.persist_settings();
                    },
                    on_toggle_browser: |view| view.toggle_browser_source(),
                    on_copy_url: |_view, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(
                            NATIVE_BROWSER_SOURCE_HINT.to_string(),
                        ));
                    },
                },
            )
            .into_any_element(),
            AppTab::Settings => render_settings(
                &self.app_settings,
                local_translation_model_installed(),
                self.surfaces.borrow().syphon.is_some(),
                persist.as_deref(),
                cx,
                SettingsCallbacks {
                    on_language: |view, language| {
                        view.app_settings.ui_language = language;
                        view.persist_settings();
                    },
                    on_toggle_translation: |view| view.toggle_translation(),
                    on_timeout: |view, timeout| {
                        view.app_settings.caption_timeout_ms = timeout;
                        view.persist_settings();
                    },
                    on_toggle_syphon: |view| view.toggle_syphon(),
                },
            )
            .into_any_element(),
        };

        sky_page()
            .id("main-root")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|view, event, _window, cx| view.apply_key(event, cx)))
            .children(
                (!self.capture_view_compact)
                    .then(|| tab_bar(self.tab, language, cx, |view, tab| view.select_tab(tab))),
            )
            .child(div().flex_1().min_h_0().child(body))
    }
}

pub(crate) fn capture_display_active(status: CaptureStatus) -> bool {
    matches!(status, CaptureStatus::Capturing | CaptureStatus::Stopping)
}

fn start_browser_source(enabled: bool) -> (BrowserSourceServer, Option<String>) {
    match BrowserSourceServer::start(BrowserSourceConfig {
        port: BrowserSourceConfig::native().port,
        enabled,
    }) {
        Ok(server) => (server, None),
        Err(error) => (BrowserSourceServer::default(), Some(error.to_string())),
    }
}

fn browser_style(style: &NativeStyleSettings) -> BrowserSourceStyle {
    BrowserSourceStyle {
        font_family: style.font_family.clone(),
        font_weight: style.font_weight,
        letter_spacing_px: style.letter_spacing_px,
        line_height: style.line_height,
        source_size_px: style.source_font_size_px,
        source_color: style.source_color.clone(),
        source_opacity: style.source_opacity,
        translation_size_px: style.translation_font_size_px,
        translation_color: style.translation_color.clone(),
        translation_opacity: style.translation_opacity,
        x_percent: style.caption_x_percent,
        y_percent: style.caption_y_percent,
        background_enabled: style.background_enabled,
        background_color: style.background_color.clone(),
        background_opacity: style.background_opacity,
        shadow_enabled: style.shadow_enabled,
        shadow_color: style.shadow_color.clone(),
        shadow_blur_px: style.shadow_blur_px,
        shadow_offset_x: style.shadow_offset_x,
        shadow_offset_y: style.shadow_offset_y,
        outline_enabled: style.outline_enabled,
        outline_color: style.outline_color.clone(),
        outline_width_px: style.outline_width_px,
    }
}

pub(crate) fn output_window_options() -> WindowOptions {
    WindowOptions {
        titlebar: Some(TitlebarOptions {
            title: Some(OUTPUT_WINDOW_TITLE.into()),
            ..Default::default()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(0.), px(0.)),
            size(px(OUTPUT_WINDOW_WIDTH_PX), px(OUTPUT_WINDOW_HEIGHT_PX)),
        ))),
        focus: false,
        is_resizable: true,
        app_id: Some(BUNDLE_ID.to_string()),
        ..Default::default()
    }
}

pub fn main_window_options() -> WindowOptions {
    WindowOptions {
        titlebar: Some(TitlebarOptions { title: Some(WINDOW_TITLE.into()), ..Default::default() }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(0.), px(0.)),
            size(px(WINDOW_WIDTH_PX), px(WINDOW_HEIGHT_PX)),
        ))),
        focus: true,
        is_resizable: true,
        window_min_size: Some(Size {
            width: px(MIN_WINDOW_WIDTH_PX),
            height: px(MIN_WINDOW_HEIGHT_PX),
        }),
        app_id: Some(BUNDLE_ID.to_string()),
        ..Default::default()
    }
}

#[cfg(unix)]
fn register_termination_flag() -> Result<Arc<AtomicBool>, String> {
    let termination_requested = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&termination_requested))
        .map_err(|error| format!("could not register SIGTERM handler: {error}"))?;
    Ok(termination_requested)
}

pub fn run() {
    let instance_guard = match crate::instance::acquire_native_instance() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    #[cfg(unix)]
    let termination_requested = match register_termination_flag() {
        Ok(flag) => flag,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == FLAG_HELP) {
        crate::domain::print_usage();
        return;
    }
    let launch = parse_debug_launch(&args);

    // Construct the OS UI platform first on the main thread. On macOS, ONNX Runtime
    // may initialize Objective-C classes that dispatch to the AppKit main queue; doing
    // that from a worker before NSApplication exists deadlocks. Recognition still
    // starts later, so initializing ORT here remains race-free on every supported OS.
    let application = gpui_platform::application();
    if let Err(error) = parapper_engine::initialize_onnx_runtime() {
        eprintln!("Could not initialize ONNX Runtime before starting the native UI: {error:#}");
        return;
    }
    application.run(move |cx: &mut App| {
        let surfaces_result = start_debug_surfaces(launch);
        print_debug_status(launch, &surfaces_result);
        if let Err(error) = &surfaces_result {
            eprintln!("{error}");
        }
        let surfaces =
            Rc::new(RefCell::new(surfaces_result.unwrap_or_else(|_| DebugSurfaces::empty())));
        let config_dir = native_config_dir();
        let style_catalog = load_style_catalog(&config_dir).unwrap_or_default();
        let dictionary_catalog = load_dictionary_catalog(&config_dir).unwrap_or_default();
        let style = style_catalog.selected().style.clone();
        let app_settings = load_app_settings(&config_dir).unwrap_or_default();

        // Create Caption Output first so the subsequently created control window is above it
        // without activating the application or stealing focus from the developer's current app.
        let mut output_window = if app_settings.caption_output_open_on_start {
            let mut options = output_window_options();
            options.window_bounds = Some(WindowBounds::centered(
                size(px(OUTPUT_WINDOW_WIDTH_PX), px(OUTPUT_WINDOW_HEIGHT_PX)),
                cx,
            ));
            match cx.open_window(options, |window, cx| {
                let style = style.clone();
                let scale_factor = window.scale_factor();
                cx.new(move |_| CaptionOutputView::new(style, scale_factor))
            }) {
                Ok(handle) => Some(handle),
                Err(error) => {
                    eprintln!("Could not open caption output: {error}");
                    None
                }
            }
        } else {
            None
        };

        let mut options = main_window_options();
        options.window_bounds =
            Some(WindowBounds::centered(size(px(WINDOW_WIDTH_PX), px(WINDOW_HEIGHT_PX)), cx));
        let window_handle = match cx.open_window(options, |_, cx| {
            let surfaces = Rc::clone(&surfaces);
            let config_dir = config_dir.clone();
            let style_catalog = style_catalog.clone();
            let dictionary_catalog = dictionary_catalog.clone();
            let app_settings = app_settings.clone();
            cx.new(move |cx| {
                MainView::new(
                    cx,
                    surfaces,
                    config_dir,
                    style_catalog,
                    dictionary_catalog,
                    app_settings,
                )
            })
        }) {
            Ok(handle) => handle,
            Err(error) => {
                eprintln!("Could not open main window: {error}");
                cx.quit();
                return;
            }
        };
        cx.activate(true);
        cx.spawn(async move |cx| loop {
            #[cfg(unix)]
            if termination_requested.load(Ordering::Relaxed) {
                let _ = window_handle.update(cx, |view, _window, _cx| view.capture.stop());
                cx.update(|cx| cx.quit());
                break;
            }
            let update = window_handle.update(cx, |view, window, cx| {
                let capture_changed = view.capture.poll(view.app_settings.caption_timeout_ms);
                let output_changed = view.publish_live_caption();
                let check_output_window = should_check_output_window(
                    output_changed,
                    view.last_output_window_check.elapsed(),
                );
                if check_output_window {
                    view.last_output_window_check = Instant::now();
                }
                let status = view.capture.snapshot().status;
                view.update_capture_display(status, window);
                let snapshot = view.capture.snapshot();
                let output = output_changed.then(|| {
                    (
                        snapshot.source_text.clone(),
                        snapshot.translation_text.clone(),
                        view.style.clone(),
                    )
                });
                if capture_changed && view.tab == AppTab::Live {
                    cx.notify();
                }
                let poll_interval = if matches!(
                    snapshot.status,
                    CaptureStatus::Capturing | CaptureStatus::Stopping
                ) {
                    ACTIVE_POLL_INTERVAL
                } else {
                    IDLE_POLL_INTERVAL
                };
                let open_output = std::mem::take(&mut view.output_window_requested);
                let output_snapshot = open_output.then(|| {
                    (
                        view.style.clone(),
                        snapshot.source_text.clone(),
                        snapshot.translation_text.clone(),
                    )
                });
                (output, check_output_window, poll_interval, output_snapshot)
            });
            let Ok((output, check_output_window, poll_interval, output_snapshot)) = update else {
                break;
            };
            let output_closed = check_output_window
                && output_window.as_ref().is_some_and(|handle| {
                    handle
                        .update(cx, move |view, window, cx| {
                            let Some((source, translation, style)) = output else {
                                return;
                            };
                            if view.replace_caption(
                                source,
                                translation,
                                style,
                                window.scale_factor(),
                                window,
                            ) {
                                cx.notify();
                            }
                        })
                        .is_err()
                });
            if output_closed {
                output_window = None;
            }
            if output_window.is_none() {
                if let Some((style, source, translation)) = output_snapshot {
                    let opened = cx.update(|cx| {
                        let mut options = output_window_options();
                        options.window_bounds = Some(WindowBounds::centered(
                            size(px(OUTPUT_WINDOW_WIDTH_PX), px(OUTPUT_WINDOW_HEIGHT_PX)),
                            cx,
                        ));
                        cx.open_window(options, |window, cx| {
                            let scale_factor = window.scale_factor();
                            cx.new(move |_| {
                                CaptionOutputView::with_caption(
                                    style,
                                    scale_factor,
                                    source,
                                    translation,
                                )
                            })
                        })
                    });
                    match opened {
                        Ok(handle) => output_window = Some(handle),
                        Err(error) => eprintln!("Could not open caption output: {error}"),
                    }
                }
            }
            cx.background_executor().timer(poll_interval).await;
        })
        .detach();
    });
    drop(instance_guard);
}
