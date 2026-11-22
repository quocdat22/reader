//! Backend library for the Reader desktop document viewer.

pub mod backend;
pub mod error;
pub mod worker;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

/// Starts the Reader Tauri desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        eprintln!("failed to run reader application: {err}");
        std::process::exit(1);
    }
}
