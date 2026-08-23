//! Forward the shared Syphon.framework rpath to the Native binary.
//!
//! `caption-bridge-syphon` links the framework, but dyld resolves `@rpath`
//! against the final executable. Without this, `cargo test` and `cargo run`
//! abort with `Library not loaded: @rpath/Syphon.framework`.

fn main() {
    let build_id = std::process::Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=KOTOBA_BUILD_ID={build_id}");
    println!("cargo:rerun-if-changed=../../.git/HEAD");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let framework_dir = manifest_dir.join("../../crates/caption-bridge-syphon/frameworks");
    let syphon_binary = framework_dir.join("Syphon.framework/Versions/A/Syphon");
    println!("cargo:rerun-if-changed={}", syphon_binary.display());
    println!("cargo:rustc-link-search=framework={}", framework_dir.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_dir.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
}
