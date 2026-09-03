use crate::cover;
use crate::db;
use crate::error::AppError;
use crate::models::Book;
use crate::state::{self, AppState};
use epub::doc::EpubDoc;
use lopdf::{Document, Object};
use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use uuid::Uuid;

pub fn import_file(state: &AppState, source: &str) -> Result<Book, AppError> {
    let source_path = Path::new(source);
    if !source_path.is_file() {
        return Err(AppError::msg("file not found"));
    }
    let format = state::format_from_path(source_path)?;
    let id = Uuid::new_v4().to_string();
    let dest_dir = state.books_dir().join(&id);
    fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(format!("book.{format}"));
    fs::copy(source_path, &dest)?;

    let mut book = Book {
        id: id.clone(),
        format: format.to_string(),
        title: state::title_from_filename(source_path),
        authors: Vec::new(),
        isbn: find_isbn(&source_path.to_string_lossy()),
        description: None,
        publisher: None,
        published_date: None,
        language: None,
        library_path: dest.to_string_lossy().into_owned(),
        cover_path: None,
        cover_source: None,
        page_count: None,
        added_at: state::now_ms(),
        last_opened_at: None,
        updated_at: state::now_ms(),
        progress: None,
    };

    match format {
        "epub" => fill_epub(&dest, &mut book, state)?,
        "pdf" => fill_pdf(&dest, &mut book)?,
        _ => {}
    }

    let conn = state.conn()?;
    db::insert_book(&conn, &book)?;
    Ok(book)
}

fn fill_epub(path: &Path, book: &mut Book, state: &AppState) -> Result<(), AppError> {
    let mut doc = EpubDoc::new(path).map_err(|e| AppError::msg(e.to_string()))?;
    if let Some(title) = first_meta(&doc, &["title", "dc:title"]) {
        if !title.trim().is_empty() {
            book.title = title;
        }
    }
    let authors = all_meta(&doc, &["creator", "dc:creator"]);
    if !authors.is_empty() {
        book.authors = authors;
    }
    if let Some(language) = first_meta(&doc, &["language", "dc:language"]) {
        book.language = Some(language);
    }
    if let Some(publisher) = first_meta(&doc, &["publisher", "dc:publisher"]) {
        book.publisher = Some(publisher);
    }
    if let Some(description) = first_meta(&doc, &["description", "dc:description"]) {
        book.description = Some(description);
    }
    if let Some(date) = first_meta(&doc, &["date", "dc:date"]) {
        book.published_date = Some(date);
    }
    if book.isbn.is_none() {
        for value in all_meta(
            &doc,
            &["identifier", "dc:identifier", "source", "dc:source"],
        ) {
            if let Some(isbn) = find_isbn(&value) {
                book.isbn = Some(isbn);
                break;
            }
        }
    }
    if book.isbn.is_none() {
        if let Some(unique) = doc.unique_identifier.clone() {
            book.isbn = find_isbn(&unique);
        }
    }
    book.page_count = Some(doc.get_num_chapters() as i64);

    if let Some((bytes, _mime)) = doc.get_cover() {
        if bytes.len() > 1024 {
            let dest = state.cover_path(&book.id);
            cover::write_cover_jpeg(&dest, &bytes)?;
            book.cover_path = Some(dest.to_string_lossy().into_owned());
            book.cover_source = Some("file".into());
        }
    }
    Ok(())
}

fn first_meta(doc: &EpubDoc<std::io::BufReader<std::fs::File>>, keys: &[&str]) -> Option<String> {
    all_meta(doc, keys).into_iter().next()
}

fn all_meta(doc: &EpubDoc<std::io::BufReader<std::fs::File>>, keys: &[&str]) -> Vec<String> {
    doc.metadata
        .iter()
        .filter(|item| {
            keys.iter().any(|key| {
                item.property.eq_ignore_ascii_case(key)
                    || item
                        .property
                        .eq_ignore_ascii_case(&format!("dc:{key}"))
            })
        })
        .map(|item| item.value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn fill_pdf(path: &Path, book: &mut Book) -> Result<(), AppError> {
    let doc = Document::load(path)?;
    book.page_count = Some(doc.get_pages().len() as i64);
    if let Ok(info) = doc.trailer.get(b"Info") {
        if let Some(dict) = resolve_dict(&doc, info) {
            if let Some(title) = dict_string(&doc, &dict, b"Title") {
                if !title.trim().is_empty() {
                    book.title = title;
                }
            }
            if let Some(author) = dict_string(&doc, &dict, b"Author") {
                book.authors = author
                    .split([';', ','])
                    .map(|part| part.trim().to_string())
                    .filter(|part| !part.is_empty())
                    .collect();
            }
            if let Some(subject) = dict_string(&doc, &dict, b"Subject") {
                book.description = Some(subject);
            }
            if book.isbn.is_none() {
                for key in [b"Keywords".as_slice(), b"Subject".as_slice(), b"Title".as_slice()] {
                    if let Some(value) = dict_string(&doc, &dict, key) {
                        if let Some(isbn) = find_isbn(&value) {
                            book.isbn = Some(isbn);
                            break;
                        }
                    }
                }
            }
        }
    }
    if book.isbn.is_none() {
        book.isbn = isbn_from_pdf_objects(&doc);
    }
    Ok(())
}

fn resolve_dict(doc: &Document, object: &Object) -> Option<lopdf::Dictionary> {
    match object {
        Object::Dictionary(dict) => Some(dict.clone()),
        Object::Reference(id) => doc.get_dictionary(*id).ok().cloned(),
        _ => None,
    }
}

fn dict_string(doc: &Document, dict: &lopdf::Dictionary, key: &[u8]) -> Option<String> {
    let object = dict.get(key).ok()?;
    object_string(doc, object)
}

fn object_string(doc: &Document, object: &Object) -> Option<String> {
    match object {
        Object::String(bytes, _) => Some(decode_pdf_string(bytes)),
        Object::Name(name) => Some(String::from_utf8_lossy(name).into_owned()),
        Object::Reference(id) => doc.get_object(*id).ok().and_then(|obj| object_string(doc, obj)),
        _ => None,
    }
}

fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units = bytes[2..]
            .chunks(2)
            .filter_map(|chunk| {
                (chunk.len() == 2).then_some(u16::from_be_bytes([chunk[0], chunk[1]]))
            })
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn isbn_from_pdf_objects(doc: &Document) -> Option<String> {
    for object in doc.objects.values() {
        if let Object::String(bytes, _) = object {
            if let Some(isbn) = find_isbn(&decode_pdf_string(bytes)) {
                return Some(isbn);
            }
        }
    }
    None
}

fn isbn_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx])")
            .expect("isbn regex")
    })
}

pub fn find_isbn(text: &str) -> Option<String> {
    for caps in isbn_regex().captures_iter(text) {
        let compact = caps
            .get(1)?
            .as_str()
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x')
            .collect::<String>()
            .to_uppercase();
        if compact.len() == 13 && compact.chars().all(|c| c.is_ascii_digit()) {
            return Some(compact);
        }
        if compact.len() == 10 {
            return Some(compact);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Mutex;

    fn temp_state() -> AppState {
        let root = std::env::temp_dir().join(format!("bookworm-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("books")).unwrap();
        std::fs::create_dir_all(root.join("covers")).unwrap();
        let conn = db::init(&root.join("library.db")).unwrap();
        AppState {
            db: Mutex::new(conn),
            root,
        }
    }

    #[test]
    fn imports_sample_epub() {
        let state = temp_state();
        let book = import_file(&state, "/tmp/bookworm-samples/little-test-book.epub").unwrap();
        assert_eq!(book.title, "The Little Test Book");
        assert_eq!(book.authors, vec!["Ada Lovelace".to_string()]);
        assert_eq!(book.isbn.as_deref(), Some("9780141439518"));
        assert!(book.cover_path.is_some());
        assert_eq!(book.cover_source.as_deref(), Some("file"));
        assert_eq!(book.format, "epub");
    }

    #[test]
    fn imports_sample_pdf() {
        let state = temp_state();
        let book = import_file(&state, "/tmp/bookworm-samples/little-test-book.pdf").unwrap();
        assert_eq!(book.title, "The Little Test Book");
        assert!(book.authors.iter().any(|author| author.contains("Ada")));
        assert_eq!(book.isbn.as_deref(), Some("9780141439518"));
        assert_eq!(book.format, "pdf");
        assert_eq!(book.page_count, Some(1));
    }
}

