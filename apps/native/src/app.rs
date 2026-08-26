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
    div, point, px, rgb, size, App, Bounds, ClipboardItem, Context, Entity, FocusHandle,
    IntoElement, KeyDownEvent, Pixels, Render, RenderImage, Size, Subscription, Task,
    TitlebarOptions, Window, WindowBounds, WindowOptions,
};
use gpui_component::Root;
use rust_lib_kotoba_beacon_companion::api::simple::{
    ExecutionDevice, PipelineRoute, ProcessingStage,
};

use crate::capture::CaptureController;
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
    select_dictionary_profile, select_style_profile, AppTab, CaptureStatus,
    CompanionDeviceSettings, NativeAppSettings, NativeDictionaryCatalog, NativeStyleCatalog,
    NativeStyleSettings, BUNDLE_ID, DEFAULT_PREVIEW_SOURCE, DEFAULT_PREVIEW_TRANSLATION, FLAG_HELP,
    MIN_WINDOW_HEIGHT_PX, MIN_WINDOW_WIDTH_PX, NATIVE_BROWSER_SOURCE_HINT, WINDOW_HEIGHT_PX,
    WINDOW_TITLE, WINDOW_WIDTH_PX,
};
use crate::hot_path::{caption_changed, should_check_output_window, OUTPUT_WINDOW_HEALTH_INTERVAL};
use crate::i18n::{text, TextKey};
use crate::live::{render_live, LiveCallbacks};
use crate::output::{render_output, OutputCallbacks};
use crate::settings::{render_settings, SettingsCallbacks, SettingsRuntimeInfo};
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
    show_settings_details: bool,
    active_color_picker: Option<String>,
    persist_error: Option<String>,
    active_companion_device_id: Option<String>,
    focused_field: Option<FocusField>,
    focus_handle: FocusHandle,
    query_focus_handle: FocusHandle,
    reading_focus_handle: FocusHandle,
    word_focus_handle: FocusHandle,
    font_focus_handle: FocusHandle,
    preview_source_focus_handle: FocusHandle,
    preview_translation_focus_handle: FocusHandle,
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

fn dismissible_keyboard_context(
    focused_field: Option<FocusField>,
    device_select_open: bool,
    font_select_open: bool,
) -> bool {
    focused_field.is_some() || device_select_open || font_select_open
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

fn adjacent_text_field(field: FocusField, reverse: bool) -> Option<FocusField> {
    match (field, reverse) {
        (FocusField::Query | FocusField::Font, true)
        | (FocusField::Word | FocusField::PreviewTranslation, false) => None,
        (FocusField::Query, false) => Some(FocusField::Reading),
        (FocusField::Reading, false) => Some(FocusField::Word),
        (FocusField::Reading, true) => Some(FocusField::Query),
        (FocusField::Word, true) => Some(FocusField::Reading),
        (FocusField::Font, false) => Some(FocusField::PreviewSource),
        (FocusField::PreviewSource, false) => Some(FocusField::PreviewTranslation),
        (FocusField::PreviewSource, true) => Some(FocusField::Font),
        (FocusField::PreviewTranslation, true) => Some(FocusField::PreviewSource),
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
        let companion_error = capture.configure_companion(companion_route(&app_settings)).err();
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
            query_caret: 0,
            draft_reading: String::new(),
            reading_caret: 0,
            draft_word: String::new(),
            word_caret: 0,
            font_query: String::new(),
            font_caret: 0,
            fonts,
            font_select_open: false,
            show_settings_details: false,
            active_color_picker: None,
            persist_error,
            active_companion_device_id: None,
            focused_field: None,
            focus_handle: cx.focus_handle(),
            query_focus_handle: cx.focus_handle(),
            reading_focus_handle: cx.focus_handle(),
            word_focus_handle: cx.focus_handle(),
            font_focus_handle: cx.focus_handle(),
            preview_source_focus_handle: cx.focus_handle(),
            preview_translation_focus_handle: cx.focus_handle(),
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
        self.focused_field = None;
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

    fn sync_companion_device_settings(&mut self) -> bool {
        let Some(snapshot) = self.capture.companion_snapshot() else {
            self.active_companion_device_id = None;
            return false;
        };
        let (Some(device_id), Some(device_name), Some(capabilities)) =
            (snapshot.device_id, snapshot.device_name, snapshot.capabilities)
        else {
            self.active_companion_device_id = None;
            return false;
        };
        let is_new_connection = self.active_companion_device_id.as_deref() != Some(&device_id);
        self.active_companion_device_id = Some(device_id.clone());
        let saved = self
            .app_settings
            .companion_devices
            .iter()
            .find(|device| device.device_id == device_id)
            .cloned();
        if is_new_connection {
            if let Some(saved) = saved {
                let route = capabilities.constrain(companion_device_route(&saved));
                apply_companion_route_settings(&mut self.app_settings, route);
                if let Err(error) = self.capture.configure_companion(route) {
                    self.persist_error = Some(error);
                }
                return true;
            }
        }
        let route = snapshot.route;
        apply_companion_route_settings(&mut self.app_settings, route);
        let profile = CompanionDeviceSettings {
            device_id: device_id.clone(),
            device_name,
            asr_on_mobile: route.asr == ExecutionDevice::Mobile,
            azookey_on_mobile: route.azookey == ExecutionDevice::Mobile,
            translation_on_mobile: route.translation == ExecutionDevice::Mobile,
        };
        if let Some(saved) = self
            .app_settings
            .companion_devices
            .iter_mut()
            .find(|device| device.device_id == device_id)
        {
            if *saved == profile {
                return false;
            }
            *saved = profile;
        } else {
            self.app_settings.companion_devices.push(profile);
        }
        self.persist_settings();
        true
    }

    fn toggle_companion_stage(&mut self, stage: ProcessingStage) {
        if self.capture.snapshot().status != CaptureStatus::Idle {
            self.persist_error =
                Some("Stop capture before changing companion processing locations".to_string());
            return;
        }
        let Some(snapshot) = self.capture.companion_snapshot() else {
            self.persist_error =
                Some("Connect a mobile companion before changing routes".to_string());
            return;
        };
        let Some(capabilities) = snapshot.capabilities else {
            self.persist_error = Some("Wait for mobile capability detection to finish".to_string());
            return;
        };
        if !stage_runs_on_mobile(&self.app_settings, stage) && !capabilities.supports(stage) {
            self.persist_error =
                Some("The connected device does not support this mobile stage".to_string());
            return;
        }
        match stage {
            ProcessingStage::Asr => {
                self.app_settings.companion_asr_on_mobile =
                    !self.app_settings.companion_asr_on_mobile;
            }
            ProcessingStage::Azookey => {
                self.app_settings.companion_azookey_on_mobile =
                    !self.app_settings.companion_azookey_on_mobile;
            }
            ProcessingStage::Translation => {
                self.app_settings.companion_translation_on_mobile =
                    !self.app_settings.companion_translation_on_mobile;
            }
        }
        let route = companion_route(&self.app_settings);
        match self.capture.configure_companion(route) {
            Ok(()) => {
                self.update_active_companion_profile(route);
                self.persist_settings();
            }
            Err(error) => self.persist_error = Some(error),
        }
    }

    fn update_active_companion_profile(&mut self, route: PipelineRoute) {
        let Some(device_id) = self.active_companion_device_id.as_deref() else {
            return;
        };
        let Some(profile) = self
            .app_settings
            .companion_devices
            .iter_mut()
            .find(|device| device.device_id == device_id)
        else {
            return;
        };
        profile.asr_on_mobile = route.asr == ExecutionDevice::Mobile;
        profile.azookey_on_mobile = route.azookey == ExecutionDevice::Mobile;
        profile.translation_on_mobile = route.translation == ExecutionDevice::Mobile;
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

    fn focused_text_field(&self, window: &Window) -> Option<FocusField> {
        [
            (FocusField::Query, &self.query_focus_handle),
            (FocusField::Reading, &self.reading_focus_handle),
            (FocusField::Word, &self.word_focus_handle),
            (FocusField::Font, &self.font_focus_handle),
            (FocusField::PreviewSource, &self.preview_source_focus_handle),
            (FocusField::PreviewTranslation, &self.preview_translation_focus_handle),
        ]
        .into_iter()
        .find_map(|(field, handle)| handle.is_focused(window).then_some(field))
    }

    fn text_field_focus_handle(&self, field: FocusField) -> &FocusHandle {
        match field {
            FocusField::Query => &self.query_focus_handle,
            FocusField::Reading => &self.reading_focus_handle,
            FocusField::Word => &self.word_focus_handle,
            FocusField::Font => &self.font_focus_handle,
            FocusField::PreviewSource => &self.preview_source_focus_handle,
            FocusField::PreviewTranslation => &self.preview_translation_focus_handle,
        }
    }

    fn activate_text_field(&mut self, field: FocusField) {
        self.focused_field = Some(field);
        match field {
            FocusField::Query => self.query_caret = self.query.len(),
            FocusField::Reading => self.reading_caret = self.draft_reading.len(),
            FocusField::Word => self.word_caret = self.draft_word.len(),
            FocusField::Font => {
                self.font_caret = self.font_query.len();
                self.font_select_open = true;
            }
            FocusField::PreviewSource => self.preview_source_caret = self.preview_source.len(),
            FocusField::PreviewTranslation => {
                self.preview_translation_caret = self.preview_translation.len();
            }
        }
    }

    fn apply_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(field) = self.focused_text_field(window) {
            if self.focused_field != Some(field) {
                self.activate_text_field(field);
            }
        }

        if event.keystroke.key == "escape"
            && dismissible_keyboard_context(
                self.focused_field,
                self.device_select_open,
                self.font_select_open,
            )
        {
            self.focused_field = None;
            self.device_select_open = false;
            self.font_select_open = false;
            window.focus(&self.focus_handle, cx);
            cx.notify();
            cx.stop_propagation();
            return;
        }

        if event.keystroke.key == "tab" && event.keystroke.modifiers.control {
            self.select_tab(adjacent_app_tab(self.tab, event.keystroke.modifiers.shift));
            cx.notify();
            cx.stop_propagation();
            return;
        }

        let accepts_input = match self.tab {
            AppTab::Dictionary => matches!(
                self.focused_field,
                Some(FocusField::Query | FocusField::Reading | FocusField::Word)
            ),
            AppTab::Style => matches!(
                self.focused_field,
                Some(FocusField::Font | FocusField::PreviewSource | FocusField::PreviewTranslation)
            ),
            _ => false,
        };
        if !accepts_input {
            return;
        }
        if event.keystroke.key == "tab" {
            let reverse = event.keystroke.modifiers.shift;
            let field = self.focused_field.expect("accepts_input requires a focused text field");
            if let Some(next) = adjacent_text_field(field, reverse) {
                self.activate_text_field(next);
                window.focus(self.text_field_focus_handle(next), cx);
                cx.notify();
            } else if reverse {
                window.focus_prev(cx);
            } else {
                window.focus_next(cx);
            }
            cx.stop_propagation();
            return;
        }
        self.apply_focused_text_key(event);
        cx.notify();
    }

    fn apply_focused_text_key(&mut self, event: &KeyDownEvent) {
        let Some(focused_field) = self.focused_field else {
            return;
        };
        let preview_text_field =
            matches!(focused_field, FocusField::PreviewSource | FocusField::PreviewTranslation);
        let (buffer, caret) = match focused_field {
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
        let language = self.app_settings.ui_language;
        let persist = self.persist_error.clone();
        let companion_snapshot = self.capture.companion_snapshot();
        let settings_error = persist.as_deref().or_else(|| {
            companion_snapshot.as_ref().and_then(|snapshot| snapshot.last_error.as_deref())
        });
        let body = match self.tab {
            AppTab::Live => gpui_component::v_flex()
                .gap_3()
                .child(render_live(
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
                ))
                .child(render_output(
                    &self.app_settings,
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
                    },
                ))
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
                        focus_handle: &self.font_focus_handle,
                        open: self.font_select_open,
                        caret: (self.focused_field == Some(FocusField::Font))
                            .then_some(self.font_caret),
                    },
                    language,
                    active_color_picker: self.active_color_picker.as_deref(),
                    preview_source_caret: (self.focused_field == Some(FocusField::PreviewSource))
                        .then_some(self.preview_source_caret),
                    preview_translation_caret: (self.focused_field
                        == Some(FocusField::PreviewTranslation))
                    .then_some(self.preview_translation_caret),
                    preview_source_focus: &self.preview_source_focus_handle,
                    preview_translation_focus: &self.preview_translation_focus_handle,
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
                        view.focused_field = Some(FocusField::Font);
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
                        view.focused_field = Some(FocusField::PreviewSource);
                        view.preview_source_caret = view.preview_source.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_preview_translation_focus: |view, window, cx| {
                        view.focused_field = Some(FocusField::PreviewTranslation);
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
                    query_caret: (self.focused_field == Some(FocusField::Query))
                        .then_some(self.query_caret),
                    reading_caret: (self.focused_field == Some(FocusField::Reading))
                        .then_some(self.reading_caret),
                    word_caret: (self.focused_field == Some(FocusField::Word))
                        .then_some(self.word_caret),
                    query_focus: &self.query_focus_handle,
                    reading_focus: &self.reading_focus_handle,
                    word_focus: &self.word_focus_handle,
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
                    on_focus_query: |view, window, cx| {
                        view.focused_field = Some(FocusField::Query);
                        view.query_caret = view.query.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_focus_reading: |view, window, cx| {
                        view.focused_field = Some(FocusField::Reading);
                        view.reading_caret = view.draft_reading.len();
                        window.focus(&view.focus_handle, cx);
                        cx.notify();
                    },
                    on_focus_word: |view, window, cx| {
                        view.focused_field = Some(FocusField::Word);
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
                    companion_saved_devices: self.app_settings.companion_devices.len(),
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
                    on_toggle_companion_asr: |view| {
                        view.toggle_companion_stage(ProcessingStage::Asr)
                    },
                    on_toggle_companion_azookey: |view| {
                        view.toggle_companion_stage(ProcessingStage::Azookey)
                    },
                    on_toggle_companion_translation: |view| {
                        view.toggle_companion_stage(ProcessingStage::Translation)
                    },
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

pub(crate) fn companion_route(settings: &NativeAppSettings) -> PipelineRoute {
    PipelineRoute {
        asr: if settings.companion_asr_on_mobile {
            ExecutionDevice::Mobile
        } else {
            ExecutionDevice::Desktop
        },
        azookey: if settings.companion_azookey_on_mobile {
            ExecutionDevice::Mobile
        } else {
            ExecutionDevice::Desktop
        },
        translation: if settings.companion_translation_on_mobile {
            ExecutionDevice::Mobile
        } else {
            ExecutionDevice::Desktop
        },
    }
}

fn stage_runs_on_mobile(settings: &NativeAppSettings, stage: ProcessingStage) -> bool {
    match stage {
        ProcessingStage::Asr => settings.companion_asr_on_mobile,
        ProcessingStage::Azookey => settings.companion_azookey_on_mobile,
        ProcessingStage::Translation => settings.companion_translation_on_mobile,
    }
}

fn companion_device_route(settings: &CompanionDeviceSettings) -> PipelineRoute {
    PipelineRoute {
        asr: if settings.asr_on_mobile {
            ExecutionDevice::Mobile
        } else {
            ExecutionDevice::Desktop
        },
        azookey: if settings.azookey_on_mobile {
            ExecutionDevice::Mobile
        } else {
            ExecutionDevice::Desktop
        },
        translation: if settings.translation_on_mobile {
            ExecutionDevice::Mobile
        } else {
            ExecutionDevice::Desktop
        },
    }
}

fn apply_companion_route_settings(settings: &mut NativeAppSettings, route: PipelineRoute) {
    settings.companion_asr_on_mobile = route.asr == ExecutionDevice::Mobile;
    settings.companion_azookey_on_mobile = route.azookey == ExecutionDevice::Mobile;
    settings.companion_translation_on_mobile = route.translation == ExecutionDevice::Mobile;
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
                cx.new(|cx| Root::new(view, window, cx).bordered(false))
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
            let view = cx.new(move |cx| {
                MainView::new(
                    cx,
                    surfaces,
                    config_dir,
                    style_catalog,
                    dictionary_catalog,
                    app_settings,
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
                            cx.new(|cx| Root::new(view, window, cx).bordered(false))
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
mod focus_tests {
    use super::{
        adjacent_app_tab, adjacent_text_field, dismissible_keyboard_context, AppTab, FocusField,
    };

    #[test]
    fn escape_context_covers_text_fields_and_open_selection_menus() {
        assert!(dismissible_keyboard_context(Some(FocusField::Query), false, false));
        assert!(dismissible_keyboard_context(None, true, false));
        assert!(dismissible_keyboard_context(None, false, true));
        assert!(!dismissible_keyboard_context(None, false, false));
    }

    #[test]
    fn control_tab_cycles_all_app_tabs_in_both_directions() {
        assert_eq!(adjacent_app_tab(AppTab::Live, false), AppTab::Style);
        assert_eq!(adjacent_app_tab(AppTab::Settings, false), AppTab::Live);
        assert_eq!(adjacent_app_tab(AppTab::Live, true), AppTab::Settings);
        assert_eq!(adjacent_app_tab(AppTab::Settings, true), AppTab::Dictionary);
    }

    #[test]
    fn tab_navigation_leaves_custom_text_groups_at_each_edge() {
        assert_eq!(adjacent_text_field(FocusField::Query, true), None);
        assert_eq!(adjacent_text_field(FocusField::Word, false), None);
        assert_eq!(adjacent_text_field(FocusField::Font, true), None);
        assert_eq!(adjacent_text_field(FocusField::PreviewTranslation, false), None);
    }

    #[test]
    fn tab_navigation_moves_forward_and_backward_between_custom_fields() {
        assert_eq!(adjacent_text_field(FocusField::Query, false), Some(FocusField::Reading));
        assert_eq!(adjacent_text_field(FocusField::Reading, true), Some(FocusField::Query));
        assert_eq!(
            adjacent_text_field(FocusField::PreviewSource, false),
            Some(FocusField::PreviewTranslation)
        );
        assert_eq!(
            adjacent_text_field(FocusField::PreviewTranslation, true),
            Some(FocusField::PreviewSource)
        );
    }
}
