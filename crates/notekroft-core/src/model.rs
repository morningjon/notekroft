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
    /// Set on imported pages whose block positions came from another
    /// application. The interface nudges overlapping blocks apart the first
    /// time such a page is opened, then clears the flag.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reflow: bool,
    /// Rule lines drawn behind the page: `"ruled"` or `"grid"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<String>,
    /// Page background colour as `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub blocks: Vec<Block>,
}

/// A page to be added by [`crate::Library::import_section`].
#[derive(Clone, Debug, PartialEq)]
pub struct NewPage {
    pub title: String,
    pub level: u8,
    pub created: i64,
    pub modified: i64,
    pub blocks: Vec<Block>,
}

/// True for names of the form `<sha256 hex>.<ext>` that NoteKroft stores
/// pictures under. Nothing else is ever accepted as an asset reference.
pub fn is_asset_name(name: &str) -> bool {
    name.split_once('.').is_some_and(|(stem, ext)| {
        stem.len() == 64
            && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && matches!(ext, "png" | "jpg" | "gif" | "webp")
    })
}

/// Something placed on the freeform page canvas. Coordinates are CSS pixels
/// from the top-left of the canvas.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    /// A note container holding sanitised rich text (which may include
    /// lists, tables, to-do items, links and inline pictures).
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
    /// Freehand drawing: one or more pen strokes.
    Ink {
        id: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        strokes: Vec<Stroke>,
    },
}

impl Block {
    pub fn id(&self) -> &str {
        match self {
            Block::Text { id, .. } | Block::Image { id, .. } | Block::Ink { id, .. } => id,
        }
    }

    /// Move the block so its top-left corner is at the given point.
    pub fn set_position(&mut self, new_x: f64, new_y: f64) {
        match self {
            Block::Text { x, y, .. } | Block::Image { x, y, .. } | Block::Ink { x, y, .. } => {
                *x = new_x;
                *y = new_y;
            }
        }
    }
}

fn full_opacity() -> f32 {
    1.0
}

fn is_full_opacity(v: &f32) -> bool {
    *v >= 1.0
}

/// One continuous pen line. Points are CSS pixels from the top-left corner
/// of the ink block that holds the stroke.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub points: Vec<[f32; 2]>,
    /// `#rrggbb`
    pub color: String,
    /// Line thickness in CSS pixels.
    pub width: f32,
    /// 1 for a pen; lower for a highlighter.
    #[serde(default = "full_opacity", skip_serializing_if = "is_full_opacity")]
    pub opacity: f32,
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
