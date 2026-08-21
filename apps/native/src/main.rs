#[cfg(feature = "gpui")]
fn main() {
    kotoba_beacon_native::run();
}

#[cfg(not(feature = "gpui"))]
fn main() {
    kotoba_beacon_native::run_stub();
}
