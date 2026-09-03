use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub format: String,
    pub title: String,
    pub authors: Vec<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub language: Option<String>,
    pub library_path: String,
    pub cover_path: Option<String>,
    pub cover_source: Option<String>,
    pub page_count: Option<i64>,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub updated_at: i64,
    pub progress: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub locator: Value,
    pub quote: String,
    pub created_at: i64,
}
