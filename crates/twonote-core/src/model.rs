use serde::{Deserialize, Serialize};

/// Version of the on-disk format written by this crate.
pub const FORMAT_VERSION: u32 = 1;

/// Deepest subpage indent (0 = page, 1 = subpage, 2 = sub-subpage).
pub const MAX_PAGE_LEVEL: u8 = 2;

/// Section tab colours, cycled as sections are added.
pub const SECTION_COLORS: [&str; 8] = [
    "#2f7dd1", "#d1492f", "#3a9d5d", "#c98a12", "#8a56c2", "#1f9a9a", "#c2478b", "#6b7785",
];

/// `notebook.json`
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookFile {
    pub format: u32,
    pub id: String,
    pub title: String,
    pub color: String,
    /// Milliseconds since the Unix epoch, UTC.
    pub created: i64,
    pub modified: i64,
    /// Section ids, in display order.
    pub sections: Vec<String>,
}

/// `sections/<id>/section.json`
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionFile {
    pub id: String,
    pub title: String,
    pub color: String,
    /// Page index, in display order. Titles are duplicated here so the
    /// navigation can be drawn without opening every page.
    pub pages: Vec<PageEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageEntry {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub level: u8,
    pub modified: i64,
}

/// `sections/<id>/pages/<id>.json`
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub title: String,
    pub created: i64,
    pub modified: i64,
    #[serde(default)]
    pub blocks: Vec<Block>,
}

/// Something placed on the freeform page canvas. Coordinates are CSS pixels
/// from the top-left of the canvas.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    /// A note container holding sanitised rich text (which may include
    /// lists, tables, to-do items and links).
    Text {
        id: String,
        x: f64,
        y: f64,
        w: f64,
        html: String,
    },
    /// A picture stored in the notebook's `assets/` folder.
    Image {
        id: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        asset: String,
        #[serde(default)]
        alt: String,
    },
}

// ---- views handed to the UI -------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSummary {
    pub id: String,
    pub title: String,
    pub color: String,
    pub modified: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTree {
    pub id: String,
    pub title: String,
    pub color: String,
    pub sections: Vec<SectionFile>,
}

/// One entry of a requested page order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageOrder {
    pub id: String,
    #[serde(default)]
    pub level: u8,
}
