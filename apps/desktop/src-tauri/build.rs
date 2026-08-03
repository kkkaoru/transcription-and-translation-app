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

    // The vendored Syphon.framework is a universal (arm64 + x86_64) build that
    // includes the Metal server classes, so every macOS target links it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let framework_dir =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("frameworks");
        println!("cargo:rustc-link-search=framework={}", framework_dir.display());
        // Let test binaries and raw `cargo run` find the framework at runtime;
        // the Tauri bundle carries its own copy under Contents/Frameworks.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_dir.display());
    }
    tauri_build::build();
}
