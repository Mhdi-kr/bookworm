use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(value: reqwest::Error) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<image::ImageError> for AppError {
    fn from(value: image::ImageError) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<lopdf::Error> for AppError {
    fn from(value: lopdf::Error) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<regex::Error> for AppError {
    fn from(value: regex::Error) -> Self {
        Self::Message(value.to_string())
    }
}
