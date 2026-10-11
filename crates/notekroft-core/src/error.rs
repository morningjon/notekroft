use std::io;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} not found")]
    NotFound(String),
    #[error("invalid identifier: {0:?}")]
    InvalidId(String),
    #[error("invalid asset: {0}")]
    InvalidAsset(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    /// A problem choosing or moving the notes folder, worded for the user.
    #[error("{0}")]
    Location(String),
    #[error("this notebook uses format version {0}, which is newer than this version of NoteKroft understands")]
    UnsupportedFormat(u32),
    #[error("file error: {0}")]
    Io(#[from] io::Error),
    #[error("corrupt notebook data: {0}")]
    Json(#[from] serde_json::Error),
}
