//! Syphon receive/inspect harness for Kotoba Beacon.
//!
//! Builds a local verification environment that does **not** depend on OBS:
//!
//! 1. `--self-test` publishes a known opaque pattern on a temporary Syphon
//!    server, receives it, and asserts opaque pixels are present.
//! 2. Default mode discovers the live `Kotoba Beacon` server, samples frames,
//!    writes a checkerboard-composited PPM preview, and exits non-zero when
//!    the plate is empty (the blank-client failure mode).
//!
//! ```sh
//! cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example syphon_inspect -- --self-test
//! cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example syphon_inspect -- \
//!   --out tmp/syphon-inspect-latest.ppm --seconds 5
//! ```

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("syphon_inspect is macOS-only");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn main() {
    mac::main();
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use objc2_metal::{MTLOrigin, MTLRegion, MTLSize, MTLTexture};

    const SERVER_NAME: &str = "Kotoba Beacon";
    const SELF_TEST_NAME: &str = "Kotoba Beacon Inspect Self-Test";

    #[allow(clippy::excessive_nesting)]
    pub(crate) fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.iter().any(|arg| arg == "--help" || arg == "-h") {
            print_usage();
            return;
        }
        if args.iter().any(|arg| arg == "--self-test") {
            if let Err(error) = run_self_test() {
                eprintln!("self-test FAILED: {error}");
                std::process::exit(1);
            }
            println!("self-test OK");
            return;
        }

        let seconds = parse_flag_u64(&args, "--seconds").unwrap_or(5);
        let out = parse_flag_path(&args, "--out")
            .unwrap_or_else(|| PathBuf::from("tmp/syphon-inspect-latest.ppm"));
        let min_opaque = parse_flag_u64(&args, "--min-opaque").unwrap_or(64);

        match inspect_live(Duration::from_secs(seconds), &out, min_opaque as usize) {
            Ok(stats) => {
                println!(
                    "OK frames={} size={}x{} opaque={} max_alpha={} out={}",
                    stats.frames,
                    stats.width,
                    stats.height,
                    stats.opaque_pixels,
                    stats.max_alpha,
                    out.display()
                );
            }
            Err(error) => {
                eprintln!("inspect FAILED: {error}");
                std::process::exit(1);
            }
        }
    }

    fn print_usage() {
        eprintln!(
            "Usage:\n  syphon_inspect --self-test\n  syphon_inspect [--seconds N] [--out path.ppm] [--min-opaque N]"
        );
    }

    fn parse_flag_u64(args: &[String], flag: &str) -> Option<u64> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1).and_then(|value| value.parse::<u64>().ok()))
    }

    fn parse_flag_path(args: &[String], flag: &str) -> Option<PathBuf> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1).map(PathBuf::from))
    }

    #[derive(Debug, Clone)]
    struct FrameStats {
        frames: u64,
        width: u32,
        height: u32,
        opaque_pixels: usize,
        max_alpha: u8,
        rgba: Vec<u8>,
    }

    #[allow(clippy::excessive_nesting)]
    fn run_self_test() -> Result<(), String> {
        let width = 64u32;
        let height = 36u32;
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for y in 8..28 {
            for x in 16..48 {
                let index = ((y * width + x) * 4) as usize;
                pixels[index] = 255;
                pixels[index + 1] = 255;
                pixels[index + 2] = 255;
                pixels[index + 3] = 255;
            }
        }

        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_worker = Arc::clone(&stop);
        let publish_pixels = pixels.clone();
        std::thread::spawn(move || {
            let mut server = match syphon_rs::Server::new(SELF_TEST_NAME, width, height) {
                Ok(server) => server,
                Err(error) => {
                    let _ = ready_tx.send(Err(format!("server start failed: {error:?}")));
                    return;
                }
            };
            server.send_frame(&publish_pixels);
            let _ = ready_tx.send(Ok(()));
            while !stop_worker.load(Ordering::Acquire) {
                server.send_frame(&publish_pixels);
                std::thread::sleep(Duration::from_millis(33));
            }
        });

        ready_rx
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "server readiness timed out".to_string())??;

        let out = PathBuf::from("tmp/syphon-inspect-self-test.ppm");
        let stats = inspect_named(SELF_TEST_NAME, Duration::from_secs(2), &out, 64)?;
        stop.store(true, Ordering::Release);
        if stats.opaque_pixels < 64 {
            return Err(format!(
                "self-test received empty plate opaque={} (wrote {})",
                stats.opaque_pixels,
                out.display()
            ));
        }
        Ok(())
    }

    fn inspect_live(
        timeout: Duration,
        out: &Path,
        min_opaque: usize,
    ) -> Result<FrameStats, String> {
        inspect_named(SERVER_NAME, timeout, out, min_opaque)
    }

    #[allow(clippy::excessive_nesting)]
    fn inspect_named(
        name: &str,
        timeout: Duration,
        out: &Path,
        min_opaque: usize,
    ) -> Result<FrameStats, String> {
        let deadline = Instant::now() + timeout;
        let mut last_error = format!("server {name:?} not found");
        while Instant::now() < deadline {
            let servers = syphon_rs::discover_servers(Duration::from_millis(400));
            let Some(desc) = servers.into_iter().find(|server| server.name == name) else {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            };
            println!("found name={:?} app={:?} uuid={}", desc.name, desc.app_name, desc.uuid);
            match sample_server(&desc, deadline, out) {
                Ok(stats) => {
                    if stats.opaque_pixels < min_opaque {
                        return Err(format!(
                            "blank Syphon plate: opaque_pixels={} < min_opaque={} (size {}x{}, wrote {})",
                            stats.opaque_pixels,
                            min_opaque,
                            stats.width,
                            stats.height,
                            out.display()
                        ));
                    }
                    return Ok(stats);
                }
                Err(error) => {
                    last_error = error;
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
        Err(last_error)
    }

    #[allow(clippy::excessive_nesting)]
    fn sample_server(
        desc: &syphon_rs::ServerDescription,
        deadline: Instant,
        out: &Path,
    ) -> Result<FrameStats, String> {
        // syphon-rs rebuilds a minimal description dictionary and that path has
        // returned ClientCreationFailed against live servers. Use the raw
        // SyphonServerDirectory entry instead (what OBS / Simple Client use).
        ensure_ns_application();
        let client = open_metal_client_for_uuid(&desc.uuid)
            .or_else(|_| open_metal_client_for_name(&desc.name))?;

        let mut best: Option<FrameStats> = None;
        while Instant::now() < deadline {
            pump_run_loop(Duration::from_millis(50));
            if let Some((width, height, rgba)) = client_new_frame_rgba(&client)? {
                let (opaque_pixels, max_alpha) = alpha_stats(&rgba);
                let frames = best.as_ref().map(|stats| stats.frames + 1).unwrap_or(1);
                let candidate =
                    FrameStats { frames, width, height, opaque_pixels, max_alpha, rgba };
                let replace = best
                    .as_ref()
                    .map(|stats| candidate.opaque_pixels >= stats.opaque_pixels)
                    .unwrap_or(true);
                if replace {
                    best = Some(candidate);
                } else if let Some(stats) = best.as_mut() {
                    stats.frames = frames;
                }
            }
        }

        let Some(stats) = best else {
            return Err("no Syphon frames received".to_string());
        };
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
        write_checkerboard_ppm(out, stats.width, stats.height, &stats.rgba)?;
        Ok(stats)
    }

    fn ensure_ns_application() {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject};
        let Some(app_cls) = AnyClass::get(c"NSApplication") else {
            return;
        };
        let _: Retained<AnyObject> = unsafe { msg_send![app_cls, sharedApplication] };
    }

    fn open_metal_client_for_uuid(
        uuid: &str,
    ) -> Result<objc2::rc::Retained<objc2::runtime::AnyObject>, String> {
        open_metal_client_matching(|dict| {
            dict_string(dict, "SyphonServerDescriptionUUIDKey") == uuid
        })
    }

    fn open_metal_client_for_name(
        name: &str,
    ) -> Result<objc2::rc::Retained<objc2::runtime::AnyObject>, String> {
        open_metal_client_matching(|dict| {
            dict_string(dict, "SyphonServerDescriptionNameKey") == name
        })
    }

    #[allow(clippy::excessive_nesting)]
    fn open_metal_client_matching<F>(
        matches: F,
    ) -> Result<objc2::rc::Retained<objc2::runtime::AnyObject>, String>
    where
        F: Fn(&objc2::runtime::AnyObject) -> bool,
    {
        use objc2::msg_send;
        use objc2::rc::{Allocated, Retained};
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2_metal::MTLCreateSystemDefaultDevice;

        let dir_cls = AnyClass::get(c"SyphonServerDirectory")
            .ok_or_else(|| "SyphonServerDirectory missing".to_string())?;
        let client_cls = AnyClass::get(c"SyphonMetalClient")
            .ok_or_else(|| "SyphonMetalClient missing".to_string())?;
        let directory: Retained<AnyObject> = unsafe { msg_send![dir_cls, sharedDirectory] };
        let servers: Retained<AnyObject> = unsafe { msg_send![&*directory, servers] };
        let count: usize = unsafe { msg_send![&*servers, count] };
        let device =
            MTLCreateSystemDefaultDevice().ok_or_else(|| "Metal device unavailable".to_string())?;

        for index in 0..count {
            let entry: Retained<AnyObject> = unsafe { msg_send![&*servers, objectAtIndex: index] };
            if !matches(&entry) {
                continue;
            }
            let client: Option<Retained<AnyObject>> = unsafe {
                let alloc: Allocated<AnyObject> = msg_send![client_cls, alloc];
                msg_send![
                    alloc,
                    initWithServerDescription: &*entry,
                    device: &*device,
                    options: std::ptr::null::<AnyObject>(),
                    newFrameHandler: std::ptr::null::<AnyObject>(),
                ]
            };
            if let Some(client) = client {
                return Ok(client);
            }
        }
        Err("SyphonMetalClient init returned nil for matching server".to_string())
    }

    fn dict_string(dict: &objc2::runtime::AnyObject, key: &str) -> String {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        use std::ffi::{c_char, CStr};

        let ns_key = NSString::from_str(key);
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: &*ns_key] };
        let Some(value) = value else {
            return String::new();
        };
        let ptr: *const c_char = unsafe { msg_send![&*value, UTF8String] };
        if ptr.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }

    fn client_new_frame_rgba(
        client: &objc2::runtime::AnyObject,
    ) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::ProtocolObject;

        let texture: Option<Retained<ProtocolObject<dyn MTLTexture>>> =
            unsafe { msg_send![client, newFrameImage] };
        let Some(texture) = texture else {
            return Ok(None);
        };
        let width = texture.width() as u32;
        let height = texture.height() as u32;
        let rgba = read_texture_rgba(&texture, width, height)?;
        Ok(Some((width, height, rgba)))
    }

    fn pump_run_loop(duration: Duration) {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject};

        let Some(rl_cls) = AnyClass::get(c"NSRunLoop") else {
            std::thread::sleep(duration);
            return;
        };
        let Some(date_cls) = AnyClass::get(c"NSDate") else {
            std::thread::sleep(duration);
            return;
        };
        let run_loop: Retained<AnyObject> = unsafe { msg_send![rl_cls, currentRunLoop] };
        let until: Retained<AnyObject> =
            unsafe { msg_send![date_cls, dateWithTimeIntervalSinceNow: duration.as_secs_f64()] };
        let _: () = unsafe { msg_send![&*run_loop, runUntilDate: &*until] };
    }

    fn read_texture_rgba(
        texture: &objc2::runtime::ProtocolObject<dyn MTLTexture>,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        let bytes_per_row =
            (width as usize).checked_mul(4).ok_or_else(|| "texture row overflow".to_string())?;
        let len = bytes_per_row
            .checked_mul(height as usize)
            .ok_or_else(|| "texture buffer overflow".to_string())?;
        let mut rgba = vec![0u8; len];
        let region = MTLRegion {
            origin: MTLOrigin { x: 0, y: 0, z: 0 },
            size: MTLSize { width: width as usize, height: height as usize, depth: 1 },
        };
        let ptr = NonNull::new(rgba.as_mut_ptr().cast::<c_void>())
            .ok_or_else(|| "null texture readback pointer".to_string())?;
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(ptr, bytes_per_row, region, 0);
        }
        Ok(rgba)
    }

    #[allow(clippy::excessive_nesting)]
    fn alpha_stats(rgba: &[u8]) -> (usize, u8) {
        let mut opaque = 0usize;
        let mut max_alpha = 0u8;
        for pixel in rgba.chunks_exact(4) {
            let alpha = pixel[3];
            max_alpha = max_alpha.max(alpha);
            if alpha > 8 {
                opaque += 1;
            }
        }
        (opaque, max_alpha)
    }

    #[allow(clippy::excessive_nesting)]
    fn write_checkerboard_ppm(
        path: &Path,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), String> {
        let mut rgb = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                let index = ((y * width + x) * 4) as usize;
                let r = rgba[index] as u32;
                let g = rgba[index + 1] as u32;
                let b = rgba[index + 2] as u32;
                let a = rgba[index + 3] as u32;
                let checker = if ((x / 8) + (y / 8)) % 2 == 0 { 48u32 } else { 96u32 };
                let blend = |channel: u32| -> u8 {
                    let value = channel + (checker * (255 - a)) / 255;
                    value.min(255) as u8
                };
                rgb.push(blend(r));
                rgb.push(blend(g));
                rgb.push(blend(b));
            }
        }
        let header = format!("P6\n{width} {height}\n255\n");
        let mut body = header.into_bytes();
        body.extend_from_slice(&rgb);
        std::fs::write(path, body).map_err(|error| format!("write {}: {error}", path.display()))
    }
}
