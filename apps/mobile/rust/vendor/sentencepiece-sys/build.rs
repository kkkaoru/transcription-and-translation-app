use std::env;

use cc::Build;
use cmake::Config;

macro_rules! feature(($name:expr) => (env::var(concat!("CARGO_FEATURE_", $name)).is_ok()));

fn build_sentencepiece(builder: &mut Build) {
    let mut config = Config::new("source");
    config
        .define("CMAKE_POLICY_VERSION_MINIMUM", "3.10")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let abi = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "arm64-v8a",
            Ok("arm") => "armeabi-v7a",
            Ok("x86_64") => "x86_64",
            _ => panic!("unsupported Android architecture"),
        };
        config.define("ANDROID_ABI", abi).define("ANDROID_PLATFORM", "android-31");
    }
    if builder.get_compiler().is_like_msvc() {
        config.profile("Release");
        if env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default().contains("crt-static") {
            config.define("SPM_ENABLE_MSVC_MT_BUILD", "ON");
            config.define("MSVC_RUNTIME_LIBRARY", "MultiThreaded");
            config.define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreaded");
            config.static_crt(true);
        }
    }
    let dst = config.build();
    println!("cargo:rustc-link-search=native={}", dst.join("build").join("src").display());
    println!("cargo:rustc-link-search=native={}", dst.join("lib").display());
    println!("cargo:rustc-link-lib=static=sentencepiece");

    builder.include("source/src");
}

fn find_sentencepiece(builder: &mut Build) -> bool {
    let lib = match pkg_config::Config::new().probe("sentencepiece") {
        Ok(lib) => lib,
        Err(_) => return false,
    };

    // Add include paths
    for i in &lib.include_paths {
        builder.include(i);
    }

    true
}

fn main() {
    let mut builder = Build::new();

    if feature!("SYSTEM") {
        find_sentencepiece(&mut builder);
    } else if feature!("STATIC") || !find_sentencepiece(&mut builder) {
        build_sentencepiece(&mut builder);
    }

    builder.file("src/ffi/sentencepiece.cpp").cpp(true);

    if builder.get_compiler().is_like_msvc() {
        builder.flag("/std:c++17");
        // same as https://github.com/google/sentencepiece/blob/master/CMakeLists.txt#L82C21-L82C28
        builder.flag("/wd4267");
        builder.flag("/wd4244");
        builder.flag("/wd4305");
        builder.flag("/Zc:strictStrings");
        builder.flag("/utf-8");
    } else {
        builder.flag("-std=c++17");
    }

    builder.compile("sentencepiece_wrap");

    println!("cargo:rerun-if-changed=src/ffi/sentencepiece.cpp");
}
