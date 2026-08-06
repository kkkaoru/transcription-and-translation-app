fn main() {
    let servers = syphon_rs::discover_servers(std::time::Duration::from_millis(800));
    println!("servers={}", servers.len());
    for d in servers {
        println!("name={:?} app={:?}", d.name, d.app_name);
    }
}
