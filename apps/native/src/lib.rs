#[cfg(any(feature = "gpui", test))]
mod capture;
mod debug_surfaces;
mod domain;

#[cfg(feature = "gpui")]
mod app;
#[cfg(feature = "gpui")]
mod dictionary;
#[cfg(feature = "gpui")]
mod live;
#[cfg(feature = "gpui")]
mod settings;
#[cfg(feature = "gpui")]
mod style;
#[cfg(feature = "gpui")]
mod ui;

pub use debug_surfaces::{start_debug_surfaces, DebugSurfaces};
pub use domain::{
    ingest_fixture_caption, parse_debug_launch, print_usage, run_stub_lines, DebugLaunch,
    FixtureCaption, BINARY_NAME, BUNDLE_ID, PRODUCT_NAME, TABS,
};

#[cfg(feature = "gpui")]
pub use app::{main_window_options, run, MainView};

pub use caption_bridge_spout::NATIVE_SPOUT_SHARE_NAME;
pub use caption_bridge_syphon::{NATIVE_SYPHON_SERVER_NAME, WINDOWS_SYPHON_UNSUPPORTED};

/// Print identity, fixture caption, and optional debug surfaces without GPUI.
pub fn run_stub() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == domain::FLAG_HELP) {
        print_usage();
        return;
    }
    let launch = parse_debug_launch(&args);
    for line in run_stub_lines() {
        println!("{line}");
    }
    let surfaces = start_debug_surfaces(launch);
    debug_surfaces::print_debug_status(launch, &surfaces);
    if debug_surfaces::wants_event_pump(launch) && surfaces.is_ok() {
        debug_surfaces::pump_debug_loop();
    }
}

#[cfg(test)]
mod tests;
