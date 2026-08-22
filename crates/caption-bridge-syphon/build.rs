//! Link the desktop-vendored `Syphon.framework` for macOS builds.
//!
//! `syphon-rs` 0.1.1 looks for a system or crate-vendored framework. This
//! workspace vendors a universal Metal build under
//! `apps/desktop/src-tauri/frameworks/`. Without this rpath, `Server::new`
//! fails with `FrameworkUnavailable` even though the same crate works in
//! desktop.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let framework_dir = manifest_dir.join("../../apps/desktop/src-tauri/frameworks");
    let syphon_binary = framework_dir.join("Syphon.framework/Versions/A/Syphon");
    println!("cargo:rerun-if-changed={}", syphon_binary.display());
    println!("cargo:rustc-link-search=framework={}", framework_dir.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_dir.display());
}
