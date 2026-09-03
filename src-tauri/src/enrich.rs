use crate::cover;
use crate::db;
use crate::error::AppError;
use crate::models::Book;
use crate::state::{self, AppState};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const UA: &str = "Bookworm/0.1 (https://github.com/Mhdi-kr/bookworm)";

struct OnlineMeta {
    title: Option<String>,
    authors: Vec<String>,
    isbn: Option<String>,
    description: Option<String>,
    publisher: Option<String>,
    published_date: Option<String>,
    language: Option<String>,
    page_count: Option<i64>,
    cover_url: Option<String>,
    cover_source: &'static str,
}

pub async fn enrich_book(app: &AppHandle, id: &str) -> Result<Option<Book>, AppError> {
    let mut book = {
        let state = app.state::<AppState>();
        let conn = state.conn()?;
        db::get_book(&conn, id)?.ok_or_else(|| AppError::msg("book not found"))?
    };

    let client = reqwest::Client::builder().user_agent(UA).build()?;
    let online = match lookup_open_library(&client, &book).await? {
        Some(meta) => Some(meta),
        None => lookup_google_books(&client, &book).await?,
    };
    let Some(online) = online else {
        return Ok(None);
    };

    let cover_url = online.cover_url.clone();
    let cover_source = online.cover_source;
    merge_metadata(&mut book, &online);
    book.updated_at = state::now_ms();

    if let Some(url) = cover_url {
        if let Some(bytes) = download_image(&client, &url).await? {
            let state = app.state::<AppState>();
            let dest = state.cover_path(&book.id);
            let current_len = cover::cover_len(book.cover_path.as_deref());
            if cover::should_replace_cover(book.cover_source.as_deref(), current_len, bytes.len()) {
                cover::write_cover_jpeg(&dest, &bytes)?;
                book.cover_path = Some(dest.to_string_lossy().into_owned());
                book.cover_source = Some(cover_source.to_string());
                book.updated_at = state::now_ms();
            }
        }
    }

    {
        let state = app.state::<AppState>();
        let conn = state.conn()?;
        db::update_book(&conn, &book)?;
    }
    Ok(Some(book))
}

fn merge_metadata(book: &mut Book, online: &OnlineMeta) {
    if book.title.trim().is_empty() {
        if let Some(title) = &online.title {
            book.title = title.clone();
        }
    }
    if book.authors.is_empty() && !online.authors.is_empty() {
        book.authors = online.authors.clone();
    }
    if book.isbn.is_none() {
        book.isbn = online.isbn.clone();
    }
    if book.description.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        book.description = online.description.clone();
    }
    if book.publisher.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        book.publisher = online.publisher.clone();
    }
    if book.published_date.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        book.published_date = online.published_date.clone();
    }
    if book.language.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        book.language = online.language.clone();
    }
    if book.page_count.is_none() {
        book.page_count = online.page_count;
    }
}

async fn lookup_open_library(
    client: &reqwest::Client,
    book: &Book,
) -> Result<Option<OnlineMeta>, AppError> {
    let url = if let Some(isbn) = &book.isbn {
        format!(
            "https://openlibrary.org/search.json?isbn={}&limit=1",
            url_encode(isbn)
        )
    } else {
        let mut query = format!(
            "https://openlibrary.org/search.json?title={}&limit=1",
            url_encode(&book.title)
        );
        if let Some(author) = book.authors.first() {
            query.push_str("&author=");
            query.push_str(&url_encode(author));
        }
        query
    };

    let response = client.get(&url).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await?;
    let Some(doc) = body
        .get("docs")
        .and_then(|d| d.as_array())
        .and_then(|d| d.first())
        .cloned()
    else {
        return Ok(None);
    };

    let isbn = first_string_in_array(&doc, "isbn").or_else(|| book.isbn.clone());
    let mut description = first_string_in_array(&doc, "first_sentence");
    if description.is_none() {
        if let Some(isbn) = isbn.as_deref() {
            description = open_library_description(client, isbn).await?;
        }
    }

    let cover_url = doc
        .get("cover_i")
        .and_then(|v| v.as_i64())
        .map(|id| format!("https://covers.openlibrary.org/b/id/{id}-L.jpg"))
        .or_else(|| {
            isbn.as_ref()
                .map(|isbn| format!("https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg"))
        });

    Ok(Some(OnlineMeta {
        title: doc.get("title").and_then(|v| v.as_str()).map(str::to_string),
        authors: string_array(&doc, "author_name"),
        isbn,
        description,
        publisher: string_array(&doc, "publisher").into_iter().next(),
        published_date: doc
            .get("first_publish_year")
            .and_then(|v| v.as_i64())
            .map(|y| y.to_string()),
        language: string_array(&doc, "language").into_iter().next(),
        page_count: doc.get("number_of_pages_median").and_then(|v| v.as_i64()),
        cover_url,
        cover_source: "openlibrary",
    }))
}

async fn open_library_description(
    client: &reqwest::Client,
    isbn: &str,
) -> Result<Option<String>, AppError> {
    let url = format!("https://openlibrary.org/isbn/{}.json", url_encode(isbn));
    let Ok(response) = client.get(&url).send().await else {
        return Ok(None);
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    Ok(match body.get("description") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Object(obj)) => obj.get("value").and_then(|v| v.as_str()).map(str::to_string),
        _ => None,
    })
}

async fn lookup_google_books(
    client: &reqwest::Client,
    book: &Book,
) -> Result<Option<OnlineMeta>, AppError> {
    let q = if let Some(isbn) = &book.isbn {
        format!("isbn:{}", url_encode(isbn))
    } else if let Some(author) = book.authors.first() {
        format!(
            "intitle:{}+inauthor:{}",
            url_encode(&book.title),
            url_encode(author)
        )
    } else {
        format!("intitle:{}", url_encode(&book.title))
    };
    let url = format!("https://www.googleapis.com/books/v1/volumes?q={q}&maxResults=1");
    let response = client.get(&url).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await?;
    let Some(info) = body
        .get("items")
        .and_then(|i| i.as_array())
        .and_then(|i| i.first())
        .and_then(|item| item.get("volumeInfo"))
        .cloned()
    else {
        return Ok(None);
    };

    let isbn = info
        .get("industryIdentifiers")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let kind = item.get("type")?.as_str()?;
            let value = item.get("identifier")?.as_str()?;
            kind.contains("ISBN").then_some(value.to_string())
        })
        .max_by_key(|isbn| isbn.len());

    let cover_url = ["extraLarge", "large", "medium", "thumbnail", "smallThumbnail"]
        .into_iter()
        .find_map(|key| {
            info.get("imageLinks")
                .and_then(|links| links.get(key))
                .and_then(|v| v.as_str())
                .map(upgrade_google_cover)
        });

    Ok(Some(OnlineMeta {
        title: info.get("title").and_then(|v| v.as_str()).map(str::to_string),
        authors: string_array(&info, "authors"),
        isbn,
        description: info
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        publisher: info
            .get("publisher")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        published_date: info
            .get("publishedDate")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        language: info.get("language").and_then(|v| v.as_str()).map(str::to_string),
        page_count: info.get("pageCount").and_then(|v| v.as_i64()),
        cover_url,
        cover_source: "google",
    }))
}

fn upgrade_google_cover(url: &str) -> String {
    url.replace("http://", "https://")
        .replace("zoom=1", "zoom=3")
        .replace("&edge=curl", "")
}

async fn download_image(client: &reqwest::Client, url: &str) -> Result<Option<Vec<u8>>, AppError> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await?;
    if bytes.len() < 4000 {
        return Ok(None);
    }
    if !content_type.is_empty()
        && !content_type.starts_with("image/")
        && !url.contains(".jpg")
        && !url.contains(".jpeg")
        && !url.contains(".png")
    {
        return Ok(None);
    }
    Ok(Some(bytes.to_vec()))
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect()
}

fn first_string_in_array(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => items
            .iter()
            .find_map(|item| item.as_str().map(str::to_string)),
        _ => None,
    }
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
