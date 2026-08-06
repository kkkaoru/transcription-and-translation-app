//! Manual, no-OBS sanity check for the macOS Syphon publish path.
//!
//! Starts a `syphon_rs::Server` on a background thread (mirroring how
//! `native_output::start_syphon` runs it), publishes one frame, then calls
//! `syphon_rs::discover_servers` to confirm the running process can see its
//! own announcement over `NSDistributedNotificationCenter`. This does not
//! prove OBS itself can see the server (OBS's Syphon plugin lives in a
//! separate process and is also sensitive to code-signing/Library
//! Validation), but it does catch the most common regressions cheaply:
//! a missing/wrong-arch `Syphon.framework`, a broken `syphon-rs` binding, or
//! a `Server::new` failure that would otherwise only surface as a silent
//! fallback to "transparent-window" deep inside the packaged app.
//!
//! Run with:
//!
//! ```sh
//! cargo run --example syphon_probe
//! ```
//!
//! For a real end-to-end check, run this while OBS (with its Syphon input
//! plugin) is open and confirm "Kotoba Beacon Probe" appears as a source.

fn main() {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        println!("[probe] starting Syphon server...");
        let mut server = match syphon_rs::Server::new("Kotoba Beacon Probe", 64, 64) {
            Ok(server) => server,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("{error:?}")));
                return;
            }
        };
        server.send_frame(&vec![0u8; 64 * 64 * 4]);
        let _ = ready_tx.send(Ok(()));
        // Keep the server (and this thread) alive long enough for an
        // external client (OBS, or a second `discover_servers` call from
        // this same process below) to observe the announcement.
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            server.send_frame(&vec![0u8; 64 * 64 * 4]);
        }
    });

    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => println!("[probe] server started"),
        Ok(Err(error)) => {
            eprintln!("[probe] FAILED to start Syphon server: {error}");
            eprintln!(
                "[probe] check that frameworks/Syphon.framework is present and universal (arm64+x86_64)"
            );
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("[probe] FAILED: server did not report readiness within 3s");
            std::process::exit(1);
        }
    }

    let discovery_timeout = std::time::Duration::from_secs(1);
    let servers = syphon_rs::discover_servers(discovery_timeout);
    println!("[probe] self-discovery found {} server(s):", servers.len());
    for server in &servers {
        println!("[probe]   name={:?} app={:?}", server.name, server.app_name);
    }
    if servers.iter().any(|server| server.name == "Kotoba Beacon Probe") {
        println!("[probe] OK: this process can see its own Syphon announcement.");
    } else {
        eprintln!(
            "[probe] WARNING: self-discovery did not find \"Kotoba Beacon Probe\"; this can be a false negative on the very first discovery poll, but persistent failure points at NSDistributedNotificationCenter delivery."
        );
    }

    println!("[probe] leaving the server running for 15s so an external client (e.g. OBS) can discover it. Press Ctrl+C to stop sooner.");
    std::thread::sleep(std::time::Duration::from_secs(15));
}
