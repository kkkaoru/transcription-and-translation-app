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
        let syphon_binary = framework_dir.join("Syphon.framework/Versions/A/Syphon");
        verify_syphon_framework_architectures(&syphon_binary);
        println!("cargo:rustc-link-search=framework={}", framework_dir.display());
        // Let test binaries and raw `cargo run` find the framework at runtime;
        // the Tauri bundle carries its own copy under Contents/Frameworks.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_dir.display());
        println!("cargo:rerun-if-changed={}", syphon_binary.display());
    }
    tauri_build::build();
}

/// Fail the build when the vendored Syphon binary is missing an architecture.
///
/// An x86_64-only framework previously shipped inside an arm64 `.app`, so the
/// process could not load `SyphonMetalServer` and silently fell back to the
/// transparent-window lane — OBS then never listed a Syphon server.
#[cfg(target_os = "macos")]
fn verify_syphon_framework_architectures(syphon_binary: &std::path::Path) {
    if !syphon_binary.is_file() {
        panic!("vendored Syphon.framework binary missing at {}", syphon_binary.display());
    }
    let output = std::process::Command::new("lipo")
        .args(["-archs"])
        .arg(syphon_binary)
        .output()
        .unwrap_or_else(|error| panic!("could not inspect Syphon.framework with lipo: {error}"));
    if !output.status.success() {
        panic!(
            "lipo failed for {}: {}",
            syphon_binary.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let archs = String::from_utf8_lossy(&output.stdout);
    let has_arm64 = archs.split_whitespace().any(|arch| arch == "arm64");
    let has_x86_64 = archs.split_whitespace().any(|arch| arch == "x86_64");
    if !has_arm64 || !has_x86_64 {
        panic!(
            "Syphon.framework must be a universal binary (arm64 + x86_64); found: {}",
            archs.trim()
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn verify_syphon_framework_architectures(_syphon_binary: &std::path::Path) {}
