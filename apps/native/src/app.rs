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
    div, point, px, size, transparent_black, App, Bounds, ClipboardItem, Context, Entity,
    FocusHandle, IntoElement, KeyDownEvent, Pixels, Render, RenderImage, Size, Subscription, Task,
    TitlebarOptions, Window, WindowBackgroundAppearance, WindowBounds, WindowOptions,
};
use gpui_component::color_picker::ColorPickerEvent;
use gpui_component::input::{InputEvent, InputState};
use gpui_component::Root;
use rust_lib_kotoba_beacon_companion::api::simple::{ExecutionDevice, PipelineRoute};

use crate::capture::CaptureController;
use crate::companion::{
    companion_pairing_link, companion_pairing_qr_rgba, CompanionConnectionSnapshot,
};
use crate::debug_surfaces::{
    print_debug_status, start_debug_surfaces, start_syphon, stop_syphon, DebugSurfaces,
};
use crate::dictionary::{render_dictionary, DictionaryCallbacks, DictionaryViewState};
use crate::domain::{
    add_dictionary_entry, add_dictionary_profile, add_style_profile, clear_selected_dictionary,
    delete_dictionary_entry, delete_selected_dictionary_profile, delete_selected_style_profile,
    export_dictionary_csv, import_dictionary_file, ingest_fixture_caption, load_app_settings,
    load_dictionary_catalog, load_style_catalog, local_translation_model_installed,
    merge_dictionary_entries, native_config_dir, parse_debug_launch,
    rasterize_live_caption_at_scale, rasterize_style_preview, replace_selected_dictionary_entries,
    save_app_settings, save_dictionary_catalog, save_style_catalog, search_dictionary_entries,
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
use crate::settings::{render_settings, SettingsCallbacks, SettingsRuntimeInfo};
use crate::style::{
    hsla_to_rgb_hex, parse_rgb, render_style, set_style_color, StyleCallbacks, StyleColorPickers,
    StyleTextTarget, StyleViewState,
};
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
    draft_reading: String,
    draft_word: String,
    query_input: Entity<InputState>,
    reading_input: Entity<InputState>,
    word_input: Entity<InputState>,
    fonts: Vec<String>,
    show_settings_details: bool,
    style_color_pickers: StyleColorPickers,
    persist_error: Option<String>,
    active_companion_device_id: Option<String>,
    focus_handle: FocusHandle,
    preview_source_input: Entity<InputState>,
    preview_translation_input: Entity<InputState>,
    surfaces: Rc<RefCell<DebugSurfaces>>,
    preview_source: String,
    preview_translation: String,
    style_preview_image: Option<Arc<RenderImage>>,
    companion_pairing_qr: Option<(String, Arc<RenderImage>)>,
    stale_render_images: Vec<Arc<RenderImage>>,
    last_published_caption: Option<(String, String)>,
    last_browser_caption: Option<(String, String)>,
    last_output_window_check: Instant,
    browser_source: BrowserSourceServer,
    output_window_requested: bool,
    capture_view_compact: bool,
    pre_capture_window_size: Option<Size<Pixels>>,
    _quit_subscription: Subscription,
    _input_subscriptions: Vec<Subscription>,
}

fn adjacent_app_tab(tab: AppTab, reverse: bool) -> AppTab {
    match (tab, reverse) {
        (AppTab::Live, false) => AppTab::Style,
        (AppTab::Style, false) => AppTab::Dictionary,
        (AppTab::Dictionary, false) => AppTab::Settings,
        (AppTab::Settings, false) => AppTab::Live,
        (AppTab::Live, true) => AppTab::Settings,
        (AppTab::Style, true) => AppTab::Live,
        (AppTab::Dictionary, true) => AppTab::Style,
        (AppTab::Settings, true) => AppTab::Dictionary,
    }
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
        div()
            .size_full()
            .bg(parse_rgb(&self.style.capture_background_color))
            .child(image_view(Arc::clone(&self.image)))
    }
}

impl MainView {
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        surfaces: Rc<RefCell<DebugSurfaces>>,
        config_dir: PathBuf,
        style_catalog: NativeStyleCatalog,
        dictionary_catalog: NativeDictionaryCatalog,
        app_settings: NativeAppSettings,
    ) -> Self {
        let style = style_catalog.selected().style.clone();
        let style_color_pickers = StyleColorPickers::new(&style, window, cx);
        // Text must be owned by GPUI's input handler so macOS can deliver IME marked text,
        // candidate selection, and committed replacements. KeyDownEvent::key_char is not an
        // IME text-editing API and must not be used to implement these fields.
        let query_input = cx.new(|cx| InputState::new(window, cx));
        let reading_input = cx.new(|cx| InputState::new(window, cx));
        let word_input = cx.new(|cx| InputState::new(window, cx));
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
        let preview_source_input =
            cx.new(|cx| InputState::new(window, cx).default_value(preview_source.clone()));
        let preview_translation_input =
            cx.new(|cx| InputState::new(window, cx).default_value(preview_translation.clone()));
        let mut input_subscriptions = vec![
            cx.subscribe_in(&query_input, window, Self::on_query_input_event),
            cx.subscribe_in(&reading_input, window, Self::on_reading_input_event),
            cx.subscribe_in(&word_input, window, Self::on_word_input_event),
            cx.subscribe_in(&preview_source_input, window, Self::on_preview_source_input_event),
            cx.subscribe_in(
                &preview_translation_input,
                window,
                Self::on_preview_translation_input_event,
            ),
        ];
        input_subscriptions.extend(style_color_pickers.entries().map(|(id, picker)| {
            cx.subscribe_in(picker, window, move |view, _, event, _window, _cx| {
                view.on_style_color_event(id, event);
            })
        }));
        // The HiDPI preview is only needed on the Style tab. Avoid retaining its
        // multi-megabyte RGBA image throughout normal Live capture.
        let style_preview_image = None;
        let mut capture = CaptureController::new();
        capture
            .set_translation_enabled(app_settings.translation_enabled)
            .expect("idle translation setting must not require a worker command");
        let companion_error = app_settings
            .companion_enabled
            .then(|| capture.configure_companion(desktop_companion_route()).err())
            .flatten();
        let persist_error = companion_error.or(browser_error);
        Self {
            tab: AppTab::Live,
            config_dir,
            style,
            style_catalog,
            app_settings,
            capture,
            dictionary_catalog,
            query: String::new(),
            draft_reading: String::new(),
            draft_word: String::new(),
            query_input,
            reading_input,
            word_input,
            fonts,
            show_settings_details: false,
            style_color_pickers,
            persist_error,
            active_companion_device_id: None,
            focus_handle: cx.focus_handle(),
            preview_source_input,
            preview_translation_input,
            surfaces,
            preview_source,
            preview_translation,
            style_preview_image,
            companion_pairing_qr: None,
            stale_render_images: Vec::new(),
            last_published_caption: None,
            last_browser_caption: None,
            last_output_window_check: Instant::now() - OUTPUT_WINDOW_HEALTH_INTERVAL,
            browser_source,
            output_window_requested: false,
            capture_view_compact: false,
            pre_capture_window_size: None,
            _quit_subscription: quit_subscription,
            _input_subscriptions: input_subscriptions,
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

    fn select_device(&mut self, id: &str) {
        self.capture.select_device(id);
    }

    fn on_style_color_event(&mut self, id: &str, event: &ColorPickerEvent) {
        let ColorPickerEvent::Change(Some(color)) = event else {
            return;
        };
        // Caption colors remain opaque RGB because opacity is controlled by dedicated style
        // fields. This also keeps Native raster and Browser Source serialization identical.
        let mut next = self.style.clone();
        if set_style_color(&mut next, id, &hsla_to_rgb_hex(*color)) {
            self.set_style(next);
        }
    }

    fn on_query_input_event(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            self.query = input.read(cx).value().to_string();
            cx.notify();
        }
    }

    fn on_reading_input_event(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            self.draft_reading = input.read(cx).value().to_string();
        }
    }

    fn on_word_input_event(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            self.draft_word = input.read(cx).value().to_string();
        }
    }

    fn on_preview_source_input_event(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            self.preview_source = input.read(cx).value().to_string();
            self.refresh_style_preview();
        }
    }

    fn on_preview_translation_input_event(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            self.preview_translation = input.read(cx).value().to_string();
            self.refresh_style_preview();
        }
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

    fn set_preview_background_image(&mut self, paths: &[PathBuf]) {
        let Some(source) = paths.iter().find(|path| {
            path.extension().and_then(|value| value.to_str()).is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp")
            })
        }) else {
            return;
        };
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let directory = self.config_dir.join("preview-backgrounds");
        let revision = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let target =
            directory.join(format!("{}-{revision}.{extension}", self.style_catalog.selected_id));
        let result =
            std::fs::create_dir_all(&directory).and_then(|_| std::fs::copy(source, &target));
        match result {
            Ok(_) => {
                if let Some(previous) = self.style.preview_background_image_path.as_deref() {
                    _ = std::fs::remove_file(previous);
                }
                let mut next = self.style.clone();
                next.preview_background_image_path = Some(target.to_string_lossy().into_owned());
                next.preview_background_image_x_percent = 0.0;
                next.preview_background_image_y_percent = 0.0;
                self.set_style(next);
            }
            Err(error) => {
                self.persist_error = Some(format!(
                    "{}: {error}",
                    text(self.app_settings.ui_language, TextKey::PreviewImageError)
                ));
            }
        }
    }

    fn set_preview_background_image_position(&mut self, x: f32, y: f32) {
        self.style.preview_background_image_x_percent = x;
        self.style.preview_background_image_y_percent = y;
        if let Some(profile) = self
            .style_catalog
            .profiles
            .iter_mut()
            .find(|profile| profile.id == self.style_catalog.selected_id)
        {
            profile.style.preview_background_image_x_percent = x;
            profile.style.preview_background_image_y_percent = y;
        }
        if let Err(error) = save_style_catalog(&self.config_dir, &self.style_catalog) {
            self.persist_error = Some(error);
        } else {
            self.persist_error = None;
        }
    }

    fn remove_preview_background_image(&mut self) {
        if let Some(path) = self.style.preview_background_image_path.as_deref() {
            _ = std::fs::remove_file(path);
        }
        let mut next = self.style.clone();
        next.preview_background_image_path = None;
        next.preview_background_image_x_percent = 0.0;
        next.preview_background_image_y_percent = 0.0;
        self.set_style(next);
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

    fn sync_companion_device_settings(&mut self) -> bool {
        let device_id = self.capture.companion_snapshot().and_then(|snapshot| snapshot.device_id);
        if self.active_companion_device_id == device_id {
            return false;
        }
        self.active_companion_device_id = device_id;
        true
    }

    fn toggle_companion(&mut self) {
        if self.capture.snapshot().status != CaptureStatus::Idle {
            self.persist_error = Some(
                text(self.app_settings.ui_language, TextKey::CompanionToggleRequiresIdle)
                    .to_string(),
            );
            return;
        }
        let result = if self.app_settings.companion_enabled {
            self.capture.disable_companion()
        } else {
            self.capture.configure_companion(desktop_companion_route())
        };
        match result {
            Ok(()) => {
                self.app_settings.companion_enabled = !self.app_settings.companion_enabled;
                self.active_companion_device_id = None;
                self.persist_settings();
            }
            Err(error) => self.persist_error = Some(error),
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

    fn toggle_recognition_result(&mut self) {
        self.app_settings.show_recognition_result = !self.app_settings.show_recognition_result;
        self.persist_settings();
    }

    fn toggle_translation_result(&mut self) {
        self.app_settings.show_translation_result = !self.app_settings.show_translation_result;
        self.persist_settings();
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

    fn copy_browser_source_url(&mut self, cx: &mut Context<Self>) {
        if !self.browser_source.is_running() {
            match BrowserSourceServer::start(BrowserSourceConfig::native()) {
                Ok(server) => {
                    server.set_style(browser_style(&self.style));
                    self.browser_source = server;
                    self.app_settings.browser_source_enabled = true;
                    self.persist_settings();
                }
                Err(error) => {
                    self.persist_error = Some(error.to_string());
                    return;
                }
            }
        }
        cx.write_to_clipboard(ClipboardItem::new_string(NATIVE_BROWSER_SOURCE_HINT.to_string()));
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

    fn download_selected_dictionary_csv(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let dictionary = self.dictionary_catalog.selected();
        let safe_name = dictionary.name.replace(['/', ':'], "-");
        let suggested_name = format!("{safe_name}.csv");
        let home =
            std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        let downloads = home.join("Downloads");
        let directory = if downloads.is_dir() { downloads } else { home };
        let contents = export_dictionary_csv(&dictionary.entries);
        let export_error = text(self.app_settings.ui_language, TextKey::DictionaryExportError);
        let receiver = cx.prompt_for_new_path(&directory, Some(&suggested_name));

        cx.spawn_in(window, async move |view, window| {
            let Some(path) = receiver.await.ok().into_iter().flatten().flatten().next() else {
                return;
            };
            let result = window
                .background_executor()
                .spawn(async move {
                    std::fs::write(path, contents)
                        .map_err(|error| format!("{export_error}: {error}"))
                })
                .await;
            _ = view.update_in(window, move |view, _window, cx| {
                view.persist_error = result.err();
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "tab" && event.keystroke.modifiers.control {
            self.select_tab(adjacent_app_tab(self.tab, event.keystroke.modifiers.shift));
            cx.notify();
            cx.stop_propagation();
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

impl MainView {
    fn companion_pairing_qr_image(
        &mut self,
        snapshot: Option<&CompanionConnectionSnapshot>,
    ) -> Option<Arc<RenderImage>> {
        let Some(snapshot) = snapshot else {
            if let Some((_, image)) = self.companion_pairing_qr.take() {
                self.stale_render_images.push(image);
            }
            return None;
        };
        let link = companion_pairing_link(&snapshot.endpoint, &snapshot.pairing_token);
        if let Some((cached_link, image)) = &self.companion_pairing_qr {
            if *cached_link == link {
                return Some(Arc::clone(image));
            }
        }
        let Ok((width, height, pixels)) = companion_pairing_qr_rgba(&link) else {
            return None;
        };
        let image = render_image(caption_bridge_render::RgbaImage {
            width,
            height,
            stride: width.saturating_mul(4),
            pixels,
        });
        if let Some((_, previous)) = self.companion_pairing_qr.replace((link, Arc::clone(&image))) {
            self.stale_render_images.push(previous);
        }
        Some(image)
    }
}

impl Render for MainView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.style_color_pickers.sync(&self.style, window, cx);
        for image in self.stale_render_images.drain(..) {
            let _ = window.drop_image(image);
        }
        let language = self.app_settings.ui_language;
        let persist = self.persist_error.clone();
        let companion_snapshot = self.capture.companion_snapshot();
        let companion_pairing_qr = self.companion_pairing_qr_image(companion_snapshot.as_ref());
        let settings_error = persist.as_deref().or_else(|| {
            companion_snapshot.as_ref().and_then(|snapshot| snapshot.last_error.as_deref())
        });
        let body = match self.tab {
            AppTab::Live => gpui_component::v_flex()
                .gap_3()
                .child(render_live(
                    &self.capture,
                    &self.app_settings,
                    cx,
                    &LiveCallbacks {
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
                        on_toggle_recognition_result: |view| view.toggle_recognition_result(),
                        on_toggle_translation_result: |view| view.toggle_translation_result(),
                    },
                ))
                .child(render_output(
                    &self.app_settings,
                    &self.style,
                    persist.as_deref(),
                    cx,
                    OutputCallbacks {
                        on_open_window: |view| view.output_window_requested = true,
                        on_toggle_window_startup: |view| {
                            view.app_settings.caption_output_open_on_start =
                                !view.app_settings.caption_output_open_on_start;
                            view.persist_settings();
                        },
                        on_copy_url: |view, cx| view.copy_browser_source_url(cx),
                        on_background_color: |view, color| {
                            let mut next = view.style.clone();
                            next.capture_background_color = color.to_string();
                            view.set_style(next);
                        },
                    },
                ))
                .into_any_element(),
            AppTab::Style => render_style(
                &self.style,
                StyleViewState {
                    profiles: &self.style_catalog.profiles,
                    selected_profile_id: &self.style_catalog.selected_id,
                    preview_source_input: &self.preview_source_input,
                    preview_translation_input: &self.preview_translation_input,
                    preview_image: Arc::clone(
                        self.style_preview_image
                            .as_ref()
                            .expect("Style tab must initialize its preview image"),
                    ),
                    fonts: &self.fonts,
                    language,
                    color_pickers: &self.style_color_pickers,
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
                    on_reset: |view| {
                        if let Some(path) = view.style.preview_background_image_path.as_deref() {
                            _ = std::fs::remove_file(path);
                        }
                        view.set_style(NativeStyleSettings::default());
                    },
                    on_copy_text_style: |view, target| {
                        let mut next = view.style.clone();
                        copy_text_style(&mut next, target);
                        view.set_style(next);
                    },
                    on_change: |view, next| view.set_style(next),
                    on_font_select: |view, target, family| {
                        let mut next = view.style.clone();
                        match target {
                            StyleTextTarget::Recognition => {
                                next.source_font_family = family.to_string();
                            }
                            StyleTextTarget::Translation => {
                                next.translation_font_family = family.to_string();
                            }
                        }
                        view.set_style(next);
                    },
                    on_preview_image_paths: |view, paths| {
                        view.set_preview_background_image(paths);
                    },
                    on_preview_image_position: |view, x, y| {
                        view.set_preview_background_image_position(x, y);
                    },
                    on_reset_preview_image_position: |view| {
                        let mut next = view.style.clone();
                        next.preview_background_image_x_percent = 0.0;
                        next.preview_background_image_y_percent = 0.0;
                        view.set_style(next);
                    },
                    on_delete_preview_image: |view| view.remove_preview_background_image(),
                },
            )
            .into_any_element(),
            AppTab::Dictionary => render_dictionary(
                DictionaryViewState {
                    dictionaries: &self.dictionary_catalog.dictionaries,
                    selected_dictionary_id: &self.dictionary_catalog.selected_id,
                    entries: &self.visible_entries(),
                    query_input: &self.query_input,
                    reading_input: &self.reading_input,
                    word_input: &self.word_input,
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
                    on_download_csv: |view, window, cx| {
                        view.download_selected_dictionary_csv(window, cx);
                    },
                    on_save: |view, window, cx| match add_dictionary_entry(
                        &view.dictionary_catalog.selected().entries,
                        &view.draft_reading,
                        &view.draft_word,
                    ) {
                        Ok(next) => {
                            view.draft_reading.clear();
                            view.draft_word.clear();
                            view.reading_input.update(cx, |input, cx| {
                                input.set_value("", window, cx);
                            });
                            view.word_input.update(cx, |input, cx| {
                                input.set_value("", window, cx);
                            });
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
            AppTab::Settings => render_settings(
                &self.app_settings,
                self.show_settings_details,
                &SettingsRuntimeInfo {
                    translation_model_installed: local_translation_model_installed(),
                    syphon_on: self.surfaces.borrow().syphon.is_some(),
                    companion_endpoint: companion_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.endpoint.as_str()),
                    companion_pairing_token: companion_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.pairing_token.as_str()),
                    companion_device: companion_snapshot
                        .as_ref()
                        .and_then(|snapshot| snapshot.device_name.as_deref()),
                    companion_session_id: companion_snapshot
                        .as_ref()
                        .and_then(|snapshot| snapshot.session_id.as_deref()),
                    companion_route: companion_snapshot.as_ref().map(|snapshot| snapshot.route),
                    companion_capabilities: companion_snapshot
                        .as_ref()
                        .and_then(|snapshot| snapshot.capabilities.as_ref()),
                    companion_pairing_qr,
                    persist_error: settings_error,
                },
                cx,
                SettingsCallbacks {
                    on_toggle_details: |view| {
                        view.show_settings_details = !view.show_settings_details;
                    },
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
                    on_toggle_companion: |view| view.toggle_companion(),
                    on_copy_companion_endpoint: |view, cx| {
                        if let Some(snapshot) = view.capture.companion_snapshot() {
                            cx.write_to_clipboard(ClipboardItem::new_string(snapshot.endpoint));
                        }
                    },
                    on_copy_companion_token: |view, cx| {
                        if let Some(snapshot) = view.capture.companion_snapshot() {
                            cx.write_to_clipboard(ClipboardItem::new_string(
                                snapshot.pairing_token,
                            ));
                        }
                    },
                },
            )
            .into_any_element(),
        };

        sky_page(cx)
            .id("main-root")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|view, event, window, cx| view.apply_key(event, window, cx)))
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

fn desktop_companion_route() -> PipelineRoute {
    PipelineRoute {
        asr: ExecutionDevice::Desktop,
        azookey: ExecutionDevice::Desktop,
        translation: ExecutionDevice::Desktop,
    }
}

fn copy_text_style(style: &mut NativeStyleSettings, target: StyleTextTarget) {
    match target {
        StyleTextTarget::Translation => {
            style.translation_font_family = style.source_font_family.clone();
            style.translation_font_weight = style.source_font_weight;
            style.translation_letter_spacing_px = style.source_letter_spacing_px;
            style.translation_line_height = style.source_line_height;
            style.translation_font_size_px = style.source_font_size_px;
            style.translation_color = style.source_color.clone();
            style.translation_opacity = style.source_opacity;
            style.translation_max_chars = style.source_max_chars;
        }
        StyleTextTarget::Recognition => {
            style.source_font_family = style.translation_font_family.clone();
            style.source_font_weight = style.translation_font_weight;
            style.source_letter_spacing_px = style.translation_letter_spacing_px;
            style.source_line_height = style.translation_line_height;
            style.source_font_size_px = style.translation_font_size_px;
            style.source_color = style.translation_color.clone();
            style.source_opacity = style.translation_opacity;
            style.source_max_chars = style.translation_max_chars;
        }
    }
}

fn browser_style(style: &NativeStyleSettings) -> BrowserSourceStyle {
    BrowserSourceStyle {
        font_family: style.source_font_family.clone(),
        font_weight: style.source_font_weight,
        letter_spacing_px: style.source_letter_spacing_px,
        line_height: style.source_line_height,
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
        // GPUI maps plain alpha to the native compositor on macOS, Windows,
        // X11, and Wayland so OBS window capture can preserve transparent pixels.
        window_background: WindowBackgroundAppearance::Transparent,
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
        gpui_component::init(cx);
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
        let output_view_slot: Rc<RefCell<Option<Entity<CaptionOutputView>>>> =
            Rc::new(RefCell::new(None));
        let mut output_window = if app_settings.caption_output_open_on_start {
            let mut options = output_window_options();
            options.window_bounds = Some(WindowBounds::centered(
                size(px(OUTPUT_WINDOW_WIDTH_PX), px(OUTPUT_WINDOW_HEIGHT_PX)),
                cx,
            ));
            let output_view_slot = Rc::clone(&output_view_slot);
            match cx.open_window(options, |window, cx| {
                let style = style.clone();
                let scale_factor = window.scale_factor();
                let view = cx.new(move |_| CaptionOutputView::new(style, scale_factor));
                output_view_slot.borrow_mut().replace(view.clone());
                cx.new(|cx| Root::new(view, window, cx).bordered(false).bg(transparent_black()))
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

        let mut output_view = output_view_slot.borrow_mut().take();
        let main_view_slot: Rc<RefCell<Option<Entity<MainView>>>> = Rc::new(RefCell::new(None));
        let mut options = main_window_options();
        options.window_bounds =
            Some(WindowBounds::centered(size(px(WINDOW_WIDTH_PX), px(WINDOW_HEIGHT_PX)), cx));
        let main_view_slot_for_window = Rc::clone(&main_view_slot);
        let window_handle = match cx.open_window(options, |window, cx| {
            let surfaces = Rc::clone(&surfaces);
            let config_dir = config_dir.clone();
            let style_catalog = style_catalog.clone();
            let dictionary_catalog = dictionary_catalog.clone();
            let app_settings = app_settings.clone();
            let view = cx.new(|cx| {
                MainView::new(
                    window,
                    cx,
                    Rc::clone(&surfaces),
                    config_dir.clone(),
                    style_catalog.clone(),
                    dictionary_catalog.clone(),
                    app_settings.clone(),
                )
            });
            main_view_slot_for_window.borrow_mut().replace(view.clone());
            let focus_handle = view.read(cx).focus_handle.clone();
            window.focus(&focus_handle, cx);
            cx.new(|cx| Root::new(view, window, cx))
        }) {
            Ok(handle) => handle,
            Err(error) => {
                eprintln!("Could not open main window: {error}");
                cx.quit();
                return;
            }
        };
        let Some(main_view) = main_view_slot.borrow_mut().take() else {
            eprintln!("Could not retain the main component view");
            cx.quit();
            return;
        };
        cx.activate(true);
        cx.spawn(async move |cx| loop {
            #[cfg(unix)]
            if termination_requested.load(Ordering::Relaxed) {
                main_view.update(cx, |view, _cx| view.capture.stop());
                cx.update(|cx| cx.quit());
                break;
            }
            let update = window_handle.update(cx, |_root, window, cx| {
                main_view.update(cx, |view, cx| {
                    let capture_changed = view.capture.poll(view.app_settings.caption_timeout_ms);
                    let companion_changed = view.sync_companion_device_settings();
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
                    if (capture_changed && view.tab == AppTab::Live) || companion_changed {
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
                })
            });
            let Ok((output, check_output_window, poll_interval, output_snapshot)) = update else {
                break;
            };
            let output_view_for_update = output_view.clone();
            let output_closed = check_output_window
                && output_window.as_ref().is_some_and(|handle| {
                    handle
                        .update(cx, move |_root, window, cx| {
                            let (Some(view), Some((source, translation, style))) =
                                (output_view_for_update.as_ref(), output)
                            else {
                                return;
                            };
                            view.update(cx, |view, cx| {
                                if view.replace_caption(
                                    source,
                                    translation,
                                    style,
                                    window.scale_factor(),
                                    window,
                                ) {
                                    cx.notify();
                                }
                            });
                        })
                        .is_err()
                });
            if output_closed {
                output_window = None;
                output_view = None;
            }
            if output_window.is_none() {
                if let Some((style, source, translation)) = output_snapshot {
                    let opened = cx.update(|cx| {
                        let mut options = output_window_options();
                        options.window_bounds = Some(WindowBounds::centered(
                            size(px(OUTPUT_WINDOW_WIDTH_PX), px(OUTPUT_WINDOW_HEIGHT_PX)),
                            cx,
                        ));
                        let output_view_slot: Rc<RefCell<Option<Entity<CaptionOutputView>>>> =
                            Rc::new(RefCell::new(None));
                        let slot = Rc::clone(&output_view_slot);
                        cx.open_window(options, |window, cx| {
                            let scale_factor = window.scale_factor();
                            let view = cx.new(move |_| {
                                CaptionOutputView::with_caption(
                                    style,
                                    scale_factor,
                                    source,
                                    translation,
                                )
                            });
                            slot.borrow_mut().replace(view.clone());
                            cx.new(|cx| {
                                Root::new(view, window, cx).bordered(false).bg(transparent_black())
                            })
                        })
                        .map(|handle| (handle, output_view_slot.borrow_mut().take()))
                    });
                    match opened {
                        Ok((handle, view)) => {
                            output_window = Some(handle);
                            output_view = view;
                        }
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

#[cfg(test)]
mod app_tests {
    use super::{adjacent_app_tab, copy_text_style, AppTab, NativeStyleSettings, StyleTextTarget};

    #[test]
    fn control_tab_cycles_all_app_tabs_in_both_directions() {
        assert_eq!(adjacent_app_tab(AppTab::Live, false), AppTab::Style);
        assert_eq!(adjacent_app_tab(AppTab::Settings, false), AppTab::Live);
        assert_eq!(adjacent_app_tab(AppTab::Live, true), AppTab::Settings);
        assert_eq!(adjacent_app_tab(AppTab::Settings, true), AppTab::Dictionary);
    }

    #[test]
    fn text_styles_copy_in_both_directions() {
        let mut style = NativeStyleSettings {
            source_font_family: "Source Font".to_string(),
            source_font_weight: 810,
            source_color: "#123456".to_string(),
            ..NativeStyleSettings::default()
        };
        copy_text_style(&mut style, StyleTextTarget::Translation);
        assert_eq!(style.translation_font_family, "Source Font");
        assert_eq!(style.translation_font_weight, 810);
        assert_eq!(style.translation_color, "#123456");

        style.translation_font_family = "Translation Font".to_string();
        style.translation_line_height = 1.8;
        style.translation_max_chars = 47;
        copy_text_style(&mut style, StyleTextTarget::Recognition);
        assert_eq!(style.source_font_family, "Translation Font");
        assert_eq!(style.source_line_height, 1.8);
        assert_eq!(style.source_max_chars, 47);
    }
}
