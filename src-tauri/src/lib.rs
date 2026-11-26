//! Backend library for the Reader desktop document viewer.

pub mod backend;
pub mod commands;
pub mod covers;
pub mod error;
pub mod state;
pub mod worker;

use tauri::Manager;

/// Starts the Reader Tauri desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(resource_dir) = app.path().resource_dir() {
                backend::pdf::configure_resource_dir(resource_dir);
            }
            let state_path = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("state.json"))?;
            let initial_file = state::parse_initial_file_arg(std::env::args_os());
            let app_state = state::AppState::new(state_path, initial_file)?;
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_initial_file,
            commands::get_persisted_state,
            commands::open_document,
            commands::close_document,
            commands::render_page,
            commands::get_outline,
            commands::get_page_text,
            commands::search_document,
            commands::save_reading_state,
            commands::remove_recent_file,
            commands::get_recent_cover,
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        eprintln!("failed to run reader application: {err}");
        std::process::exit(1);
    }
}
