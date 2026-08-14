#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("syphon_list is macOS-only");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn main() {
    let servers = syphon_rs::discover_servers(std::time::Duration::from_millis(800));
    println!("servers={}", servers.len());
    for d in servers {
        println!("name={:?} app={:?}", d.name, d.app_name);
    }
}
