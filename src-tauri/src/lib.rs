mod commands;
mod cover;
mod db;
mod enrich;
mod error;
mod extract;
mod models;
mod state;

use state::AppState;
use std::fs;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|err| err.to_string())?
                .join("bookworm");
            fs::create_dir_all(root.join("books")).map_err(|err| err.to_string())?;
            fs::create_dir_all(root.join("covers")).map_err(|err| err.to_string())?;
            let conn = db::init(&root.join("library.db")).map_err(|err| err.to_string())?;
            app.manage(AppState {
                db: Mutex::new(conn),
                root,
            });
            #[cfg(debug_assertions)]
            if let Ok(paths) = std::env::var("BOOKWORM_IMPORT") {
                use tauri::Emitter;
                let handle = app.handle().clone();
                for path in paths.split(':') {
                    let path = path.trim();
                    if path.is_empty() {
                        continue;
                    }
                    let state = handle.state::<AppState>();
                    match extract::import_file(&state, path) {
                        Ok(book) => {
                            let id = book.id.clone();
                            let app_handle = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Ok(Some(updated)) = enrich::enrich_book(&app_handle, &id).await
                                {
                                    let _ = app_handle.emit("book-enriched", updated);
                                }
                            });
                        }
                        Err(err) => eprintln!("BOOKWORM_IMPORT {path}: {err}"),
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_book,
            commands::list_books,
            commands::get_book,
            commands::open_book,
            commands::delete_book,
            commands::save_progress,
            commands::save_highlight,
            commands::list_highlights,
            commands::delete_highlight,
            commands::save_cover,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bookworm");
}
