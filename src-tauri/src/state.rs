use crate::error::AppError;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub root: PathBuf,
}

impl AppState {
    pub fn books_dir(&self) -> PathBuf {
        self.root.join("books")
    }

    pub fn covers_dir(&self) -> PathBuf {
        self.root.join("covers")
    }

    pub fn cover_path(&self, id: &str) -> PathBuf {
        self.covers_dir().join(format!("{id}.jpg"))
    }

    pub fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AppError> {
        self.db
            .lock()
            .map_err(|_| AppError::msg("library database is busy"))
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn title_from_filename(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn format_from_path(path: &Path) -> Result<&'static str, AppError> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("epub") => Ok("epub"),
        Some("pdf") => Err(AppError::msg("PDF support is disabled; import an EPUB instead")),
        _ => Err(AppError::msg("only EPUB files can be imported")),
    }
}
