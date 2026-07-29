fn main() {
    #[cfg(target_os = "macos")]
    {
        let framework_dir =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("frameworks");
        println!("cargo:rustc-link-search=framework={}", framework_dir.display());
    }
    tauri_build::build();
}
