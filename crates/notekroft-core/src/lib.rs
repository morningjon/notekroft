//! NoteKroft core: the notebook model, the on-disk format, and search.
//!
//! This crate has no UI and makes no network calls. A library is a plain
//! directory of JSON files and image assets (see `docs/FORMAT.md`), so notes
//! stay readable, diffable and syncable with whatever tool the owner prefers.

mod error;
pub mod html;
pub mod location;
mod model;
mod search;
mod store;

pub use error::{Error, Result};
pub use model::*;
pub use search::SearchHit;
pub use store::{new_id, now_ms, Library};
