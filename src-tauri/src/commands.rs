use crate::cover;
use crate::db;
use crate::error::AppError;
use crate::extract;
use crate::models::Book;
use crate::state::{self, AppState};
use serde_json::Value;
use std::fs;
use tauri::State;

#[tauri::command]
pub fn import_book(state: State<AppState>, path: String) -> Result<Book, AppError> {
    extract::import_file(&state, &path)
}

#[tauri::command]
pub fn list_books(state: State<AppState>) -> Result<Vec<Book>, AppError> {
    let conn = state.conn()?;
    db::list_books(&conn)
}

#[tauri::command]
pub fn get_book(state: State<AppState>, id: String) -> Result<Book, AppError> {
    let conn = state.conn()?;
    db::get_book(&conn, &id)?.ok_or_else(|| AppError::msg("book not found"))
}

#[tauri::command]
pub fn open_book(state: State<AppState>, id: String) -> Result<Book, AppError> {
    let conn = state.conn()?;
    db::touch_opened(&conn, &id, state::now_ms())?;
    db::get_book(&conn, &id)?.ok_or_else(|| AppError::msg("book not found"))
}

#[tauri::command]
pub fn delete_book(state: State<AppState>, id: String) -> Result<(), AppError> {
    let book = {
        let conn = state.conn()?;
        db::get_book(&conn, &id)?
    };
    if let Some(book) = book {
        if let Some(parent) = std::path::Path::new(&book.library_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
        if let Some(cover) = book.cover_path {
            let _ = fs::remove_file(cover);
        }
    }
    let conn = state.conn()?;
    db::delete_book(&conn, &id)
}

#[tauri::command]
pub fn save_progress(state: State<AppState>, id: String, progress: Value) -> Result<(), AppError> {
    let conn = state.conn()?;
    db::save_progress(&conn, &id, &progress, state::now_ms())
}

#[tauri::command]
pub fn save_cover(
    state: State<AppState>,
    id: String,
    bytes: Vec<u8>,
    source: String,
) -> Result<Book, AppError> {
    let dest = state.cover_path(&id);
    cover::write_cover_jpeg(&dest, &bytes)?;
    let conn = state.conn()?;
    let mut book = db::get_book(&conn, &id)?.ok_or_else(|| AppError::msg("book not found"))?;
    book.cover_path = Some(dest.to_string_lossy().into_owned());
    book.cover_source = Some(source);
    book.updated_at = state::now_ms();
    db::update_book(&conn, &book)?;
    Ok(book)
}
