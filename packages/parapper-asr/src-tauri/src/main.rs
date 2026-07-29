#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().is_some_and(|argument| argument == "--headless") {
        if let Err(error) = app_lib::run_headless(&arguments) {
            eprintln!("Parapper headless startup error: {error}");
            std::process::exit(2);
        }
    } else {
        app_lib::run();
    }
}
