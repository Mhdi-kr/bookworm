use crate::error::AppError;
use crate::models::{Book, Highlight};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::path::Path;

pub fn init(path: &Path) -> Result<Connection, AppError> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            format TEXT NOT NULL,
            title TEXT NOT NULL,
            authors TEXT NOT NULL DEFAULT '[]',
            isbn TEXT,
            description TEXT,
            publisher TEXT,
            published_date TEXT,
            language TEXT,
            library_path TEXT NOT NULL,
            cover_path TEXT,
            cover_source TEXT,
            page_count INTEGER,
            added_at INTEGER NOT NULL,
            last_opened_at INTEGER,
            updated_at INTEGER NOT NULL,
            progress TEXT
        );
        CREATE TABLE IF NOT EXISTS highlights (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL,
            locator TEXT NOT NULL,
            quote TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        "#,
    )?;
    Ok(conn)
}

fn book_from_row(row: &Row<'_>) -> rusqlite::Result<Book> {
    let authors: String = row.get("authors")?;
    let progress: Option<String> = row.get("progress")?;
    Ok(Book {
        id: row.get("id")?,
        format: row.get("format")?,
        title: row.get("title")?,
        authors: serde_json::from_str(&authors).unwrap_or_default(),
        isbn: row.get("isbn")?,
        description: row.get("description")?,
        publisher: row.get("publisher")?,
        published_date: row.get("published_date")?,
        language: row.get("language")?,
        library_path: row.get("library_path")?,
        cover_path: row.get("cover_path")?,
        cover_source: row.get("cover_source")?,
        page_count: row.get("page_count")?,
        added_at: row.get("added_at")?,
        last_opened_at: row.get("last_opened_at")?,
        updated_at: row.get("updated_at")?,
        progress: progress.and_then(|raw| serde_json::from_str(&raw).ok()),
    })
}

pub fn insert_book(conn: &Connection, book: &Book) -> Result<(), AppError> {
    conn.execute(
        r#"
        INSERT INTO books (
            id, format, title, authors, isbn, description, publisher, published_date,
            language, library_path, cover_path, cover_source, page_count, added_at,
            last_opened_at, updated_at, progress
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        "#,
        params![
            book.id,
            book.format,
            book.title,
            serde_json::to_string(&book.authors)?,
            book.isbn,
            book.description,
            book.publisher,
            book.published_date,
            book.language,
            book.library_path,
            book.cover_path,
            book.cover_source,
            book.page_count,
            book.added_at,
            book.last_opened_at,
            book.updated_at,
            book.progress.as_ref().map(|v| v.to_string()),
        ],
    )?;
    Ok(())
}

pub fn update_book(conn: &Connection, book: &Book) -> Result<(), AppError> {
    conn.execute(
        r#"
        UPDATE books SET
            title = ?2,
            authors = ?3,
            isbn = ?4,
            description = ?5,
            publisher = ?6,
            published_date = ?7,
            language = ?8,
            cover_path = ?9,
            cover_source = ?10,
            page_count = ?11,
            last_opened_at = ?12,
            updated_at = ?13,
            progress = ?14
        WHERE id = ?1
        "#,
        params![
            book.id,
            book.title,
            serde_json::to_string(&book.authors)?,
            book.isbn,
            book.description,
            book.publisher,
            book.published_date,
            book.language,
            book.cover_path,
            book.cover_source,
            book.page_count,
            book.last_opened_at,
            book.updated_at,
            book.progress.as_ref().map(|v| v.to_string()),
        ],
    )?;
    Ok(())
}

pub fn get_book(conn: &Connection, id: &str) -> Result<Option<Book>, AppError> {
    let book = conn
        .query_row("SELECT * FROM books WHERE id = ?1", [id], book_from_row)
        .optional()?;
    Ok(book)
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM books ORDER BY COALESCE(last_opened_at, added_at) DESC, added_at DESC",
    )?;
    let books = stmt
        .query_map([], book_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(books)
}

pub fn delete_book(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM highlights WHERE book_id = ?1", [id])?;
    conn.execute("DELETE FROM books WHERE id = ?1", [id])?;
    Ok(())
}

pub fn save_progress(conn: &Connection, id: &str, progress: &Value, updated_at: i64) -> Result<(), AppError> {
    conn.execute(
        "UPDATE books SET progress = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, progress.to_string(), updated_at],
    )?;
    Ok(())
}

pub fn touch_opened(conn: &Connection, id: &str, opened_at: i64) -> Result<(), AppError> {
    conn.execute(
        "UPDATE books SET last_opened_at = ?2 WHERE id = ?1",
        params![id, opened_at],
    )?;
    Ok(())
}

pub fn insert_highlight(conn: &Connection, highlight: &Highlight) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO highlights (id, book_id, locator, quote, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            highlight.id,
            highlight.book_id,
            highlight.locator.to_string(),
            highlight.quote,
            highlight.created_at,
        ],
    )?;
    Ok(())
}

fn highlight_from_row(row: &Row<'_>) -> rusqlite::Result<Highlight> {
    let locator: String = row.get("locator")?;
    Ok(Highlight {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        locator: serde_json::from_str(&locator).unwrap_or(Value::Null),
        quote: row.get("quote")?,
        created_at: row.get("created_at")?,
    })
}

pub fn list_highlights(conn: &Connection, book_id: &str) -> Result<Vec<Highlight>, AppError> {
    let mut stmt =
        conn.prepare("SELECT * FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC")?;
    let highlights = stmt
        .query_map([book_id], highlight_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(highlights)
}

pub fn delete_highlight(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM highlights WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Book;
    use crate::state;
    use serde_json::json;

    fn sample_book(id: &str) -> Book {
        Book {
            id: id.into(),
            format: "epub".into(),
            title: "Test".into(),
            authors: vec!["Ada".into()],
            isbn: None,
            description: None,
            publisher: None,
            published_date: None,
            language: Some("en".into()),
            library_path: "/tmp/book.epub".into(),
            cover_path: None,
            cover_source: None,
            page_count: Some(3),
            added_at: 1,
            last_opened_at: None,
            updated_at: 1,
            progress: None,
        }
    }

    #[test]
    fn stores_progress_and_highlights() {
        let path = std::env::temp_dir().join(format!("bookworm-db-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = init(&path).unwrap();
        insert_book(&conn, &sample_book("b1")).unwrap();
        save_progress(&conn, "b1", &json!({"cfi": "epubcfi(/6/2)", "percent": 0.4}), 2).unwrap();
        let book = get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(book.progress.unwrap()["percent"], 0.4);

        let highlight = crate::models::Highlight {
            id: "h1".into(),
            book_id: "b1".into(),
            locator: json!({"kind": "epub", "cfi": "epubcfi(/6/2)"}),
            quote: "Speak this".into(),
            created_at: state::now_ms(),
        };
        insert_highlight(&conn, &highlight).unwrap();
        let listed = list_highlights(&conn, "b1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].quote, "Speak this");
        delete_highlight(&conn, "h1").unwrap();
        assert!(list_highlights(&conn, "b1").unwrap().is_empty());
    }
}

