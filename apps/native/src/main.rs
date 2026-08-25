#![cfg_attr(all(feature = "gpui", target_os = "windows"), windows_subsystem = "windows")]

#[cfg(feature = "gpui")]
fn main() {
    kotoba_beacon_native::memory::configure_process_memory();
    kotoba_beacon_native::run();
}

#[cfg(not(feature = "gpui"))]
fn main() {
    kotoba_beacon_native::memory::configure_process_memory();
    kotoba_beacon_native::run_stub();
}
