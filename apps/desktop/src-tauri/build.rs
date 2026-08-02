fn main() {
    let rustc_version = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=RUSTC_VERSION={rustc_version}");

    // Only Intel builds link against the vendored legacy Syphon framework.
    // Apple-silicon builds intentionally use the transparent-window/browser-source
    // fallback and must not search an x86_64 framework directory.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
    {
        let framework_dir =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("frameworks");
        println!("cargo:rustc-link-search=framework={}", framework_dir.display());
    }
    tauri_build::build();
}
