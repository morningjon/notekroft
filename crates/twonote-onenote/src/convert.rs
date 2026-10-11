//! Turns parsed OneNote pages into TwoNote pages.

use std::io::Read;

use onenote_parser::contents::{
    Content, EmbeddedFile, Image, Outline, OutlineElement, OutlineItem, RichText, Table,
};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::property::common::ColorRef;
use twonote_core::{new_id, Block, Library, NewPage};

use crate::html::{self, Node, Run, Tag};
use crate::Skipped;

/// OneNote measures layout in half inches; TwoNote in CSS pixels (96 per inch).
const PX_PER_HALF_INCH: f64 = 48.0;
const DEFAULT_OUTLINE_WIDTH: f64 = 520.0;
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_IMAGE_WIDTH: f64 = 1200.0;
const MAX_ALT_CHARS: usize = 300;

/// Marks a numbered (as opposed to bulleted) list in a OneNote list format.
const NUMBER_PLACEHOLDER: char = '\u{fffd}';
/// Stands in for an embedded object inside paragraph text.
const OBJECT_PLACEHOLDER: char = '\u{fffc}';
/// Introduces OneNote's hidden hyperlink field text.
const FIELD_MARKER: char = '\u{fddf}';

struct Picture {
    asset: String,
    width: f64,
    height: f64,
    alt: String,
}

pub(crate) struct Converter<'a> {
    pub lib: &'a Library,
    pub notebook: &'a str,
    pub pictures: usize,
    pub skipped: Skipped,
}

fn px(half_inches: f32) -> f64 {
    f64::from(half_inches) * PX_PER_HALF_INCH
}

/// Width and height from a PNG header, when that is what the bytes are.
fn png_size(bytes: &[u8]) -> Option<(f64, f64)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((f64::from(w), f64::from(h)))
}

fn is_highlighted(color: Option<ColorRef>) -> bool {
    match color {
        Some(ColorRef::Manual { r, g, b }) => !(r == 255 && g == 255 && b == 255),
        _ => false,
    }
}

impl Converter<'_> {
    pub fn page(&mut self, page: &Page) -> NewPage {
        struct Placed {
            x: Option<f64>,
            y: Option<f64>,
            block: Block,
        }
        let mut placed: Vec<Placed> = Vec::new();

        for content in page.contents() {
            match content {
                PageContent::Outline(outline) => {
                    let nodes = self.items(outline.items());
                    if html::is_blank(&nodes) {
                        continue;
                    }
                    placed.push(Placed {
                        x: outline.offset_horizontal().map(px),
                        y: outline.offset_vertical().map(px),
                        block: Block::Text {
                            id: new_id(),
                            x: 0.0,
                            y: 0.0,
                            w: outline_width(outline),
                            html: html::render(&nodes),
                        },
                    });
                }
                PageContent::Image(image) => {
                    let x = image.offset_horizontal().map(px);
                    let y = image.offset_vertical().map(px);
                    let block = match self.picture(image) {
                        Some(p) => Block::Image {
                            id: new_id(),
                            x: 0.0,
                            y: 0.0,
                            w: p.width,
                            h: p.height,
                            asset: p.asset,
                            alt: p.alt,
                        },
                        None => {
                            notice_block("Picture not imported: unsupported or missing image data")
                        }
                    };
                    placed.push(Placed { x, y, block });
                }
                PageContent::EmbeddedFile(file) => {
                    placed.push(Placed {
                        x: file.offset_horizontal().map(px),
                        y: file.offset_vertical().map(px),
                        block: notice_block(&self.attachment_notice(file)),
                    });
                }
                PageContent::Ink(_) => self.skipped.ink += 1,
                PageContent::Unknown => self.skipped.other += 1,
            }
        }

        // Keep the page's own arrangement, shifted so it starts at the top
        // left. Anything without a stated position is stacked underneath.
        let min_x = placed
            .iter()
            .filter_map(|p| p.x)
            .fold(f64::INFINITY, f64::min);
        let min_y = placed
            .iter()
            .filter_map(|p| p.y)
            .fold(f64::INFINITY, f64::min);
        let mut next_free = placed
            .iter()
            .filter_map(|p| p.y)
            .fold(0.0_f64, |m, y| m.max(y - min_y + 80.0));
        let blocks = placed
            .into_iter()
            .map(|p| {
                let nx = p.x.map_or(0.0, |x| (x - min_x).max(0.0));
                let ny = match p.y {
                    Some(y) => (y - min_y).max(0.0),
                    None => {
                        let y = next_free;
                        next_free += 80.0;
                        y
                    }
                };
                match p.block {
                    Block::Text { id, w, html, .. } => Block::Text {
                        id,
                        x: nx,
                        y: ny,
                        w,
                        html,
                    },
                    Block::Image {
                        id,
                        w,
                        h,
                        asset,
                        alt,
                        ..
                    } => Block::Image {
                        id,
                        x: nx,
                        y: ny,
                        w,
                        h,
                        asset,
                        alt,
                    },
                }
            })
            .collect();

        NewPage {
            title: page.title_text().unwrap_or_default().to_string(),
            level: (page.level() - 1).clamp(0, 2) as u8,
            created: page.created_time().unix_timestamp() * 1000,
            modified: page.updated_time().unix_timestamp() * 1000,
            blocks,
        }
    }

    fn items(&mut self, items: &[OutlineItem]) -> Vec<Node> {
        let mut out: Vec<Node> = Vec::new();
        for item in items {
            match item {
                OutlineItem::Group(group) => {
                    let children = self.items(group.outlines());
                    push_children(&mut out, children);
                }
                OutlineItem::Element(element) => self.element(element, &mut out),
            }
        }
        out
    }

    fn element(&mut self, element: &OutlineElement, out: &mut Vec<Node>) {
        let mut own: Vec<Node> = Vec::new();
        for content in element.contents() {
            match content {
                Content::RichText(text) => own.push(paragraph(text)),
                Content::Table(table) => own.push(self.table(table)),
                Content::Image(image) => own.push(match self.picture(image) {
                    Some(p) => Node::Image {
                        asset: p.asset,
                        width: p.width.round() as u32,
                        height: p.height.round() as u32,
                        alt: p.alt,
                    },
                    None => Node::Notice(
                        "Picture not imported: unsupported or missing image data".into(),
                    ),
                }),
                Content::EmbeddedFile(file) => own.push(Node::Notice(self.attachment_notice(file))),
                Content::Ink(_) => self.skipped.ink += 1,
                Content::Unknown => self.skipped.other += 1,
            }
        }
        let children = self.items(element.children());

        let lists = element.list_contents();
        if lists.is_empty() {
            out.append(&mut own);
            push_children(out, children);
            return;
        }

        let ordered = lists
            .iter()
            .any(|l| l.list_format().contains(&NUMBER_PLACEHOLDER));
        own.extend(children);
        match out.last_mut() {
            Some(Node::List { ordered: o, items }) if *o == ordered => items.push(own),
            _ => out.push(Node::List {
                ordered,
                items: vec![own],
            }),
        }
    }

    fn table(&mut self, table: &Table) -> Node {
        let rows = table
            .contents()
            .iter()
            .map(|row| {
                row.contents()
                    .iter()
                    .map(|cell| {
                        let mut nodes = Vec::new();
                        for element in cell.contents() {
                            self.element(element, &mut nodes);
                        }
                        nodes
                    })
                    .collect()
            })
            .collect();
        Node::Table(rows)
    }

    /// Store an image in the notebook. `None` means it could not be kept:
    /// no data, too large, or a format TwoNote does not display (OneNote
    /// also stores EMF, BMP and TIFF).
    fn picture(&mut self, image: &Image) -> Option<Picture> {
        let stored = (|| {
            if image.size()? > MAX_IMAGE_BYTES {
                return None;
            }
            let mut bytes = Vec::new();
            image
                .read()?
                .take(MAX_IMAGE_BYTES + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            let asset = self.lib.save_asset(self.notebook, &bytes).ok()?;
            Some((asset, png_size(&bytes)))
        })();
        let Some((asset, intrinsic)) = stored else {
            self.skipped.pictures += 1;
            return None;
        };
        self.pictures += 1;

        let stated = match (image.picture_width(), image.picture_height()) {
            (Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((px(w), px(h))),
            _ => None,
        };
        let (mut width, mut height) = stated.or(intrinsic).unwrap_or((400.0, 300.0));
        if width > MAX_IMAGE_WIDTH {
            height *= MAX_IMAGE_WIDTH / width;
            width = MAX_IMAGE_WIDTH;
        }
        Some(Picture {
            asset,
            width: width.max(16.0),
            height: height.max(16.0),
            alt: image
                .alt_text()
                .unwrap_or_default()
                .chars()
                .take(MAX_ALT_CHARS)
                .collect(),
        })
    }

    fn attachment_notice(&mut self, file: &EmbeddedFile) -> String {
        self.skipped.files += 1;
        let name: String = file.filename().chars().take(120).collect();
        format!("Attached file not imported: {name}")
    }
}

fn notice_block(text: &str) -> Block {
    Block::Text {
        id: new_id(),
        x: 0.0,
        y: 0.0,
        w: 360.0,
        html: html::render(&[Node::Notice(text.to_string())]),
    }
}

fn outline_width(outline: &Outline) -> f64 {
    outline
        .layout_max_width()
        .map(px)
        .filter(|w| *w > 0.0)
        .unwrap_or(DEFAULT_OUTLINE_WIDTH)
        .clamp(200.0, 1400.0)
}

/// Nested content is indented, unless it is purely lists, which already
/// indent themselves.
fn push_children(out: &mut Vec<Node>, children: Vec<Node>) {
    if children.is_empty() {
        return;
    }
    if children.iter().all(|n| matches!(n, Node::List { .. })) {
        out.extend(children);
    } else {
        out.push(Node::Indent(children));
    }
}

fn paragraph(text: &RichText) -> Node {
    let tag = match text.paragraph_style().style_id() {
        Some("h1") => Tag::H1,
        Some("h2") => Tag::H2,
        Some("h3" | "h4" | "h5" | "h6") => Tag::H3,
        Some("code") => Tag::Code,
        _ => Tag::Div,
    };
    let todo = text.note_tags().iter().find_map(|tag| {
        let checkable = tag.definition().is_some_and(|d| d.shape().is_checkable())
            || tag.item_status().task_tag();
        checkable.then(|| tag.item_status().completed())
    });
    Node::Para {
        tag,
        todo,
        runs: runs(text),
    }
}

/// Split paragraph text into formatted runs. Run boundaries and hyperlink
/// ranges are UTF-16 offsets, so the text is handled as UTF-16 here.
fn runs(text: &RichText) -> Vec<Run> {
    let units: Vec<u16> = text.text().encode_utf16().collect();
    let styles = text.text_run_formatting();
    let links = text.hyperlinks();

    let mut bounds: Vec<usize> = text
        .text_run_indices()
        .iter()
        .map(|i| (*i as usize).min(units.len()))
        .collect();
    bounds.push(units.len());

    let mut out = Vec::new();
    let mut start = 0;
    for (index, end) in bounds.into_iter().enumerate() {
        if end <= start {
            continue;
        }
        let style = styles.get(index).unwrap_or_else(|| text.paragraph_style());
        let slice = &units[start..end];
        let run_start = start;
        start = end;
        if style.hidden() {
            continue;
        }
        let visible: String = String::from_utf16_lossy(slice)
            .chars()
            .filter(|c| *c != OBJECT_PLACEHOLDER && *c != FIELD_MARKER)
            .collect();
        if visible.is_empty() {
            continue;
        }
        let link = links
            .iter()
            .find(|l| (l.start() as usize) <= run_start && run_start < l.end() as usize)
            .map(|l| l.target().to_string());
        out.push(Run {
            text: visible,
            bold: style.bold(),
            italic: style.italic(),
            underline: style.underline(),
            strike: style.strikethrough(),
            superscript: style.superscript(),
            subscript: style.subscript(),
            highlight: is_highlighted(style.highlight()),
            link,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_are_read_from_the_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((640.0, 480.0)));
        assert_eq!(png_size(b"\xff\xd8\xff not a png at all....."), None);
        assert_eq!(png_size(&png[..20]), None);
    }

    #[test]
    fn white_highlight_is_not_a_highlight() {
        assert!(is_highlighted(Some(ColorRef::Manual {
            r: 255,
            g: 255,
            b: 0
        })));
        assert!(!is_highlighted(Some(ColorRef::Manual {
            r: 255,
            g: 255,
            b: 255
        })));
        assert!(!is_highlighted(Some(ColorRef::Auto)));
        assert!(!is_highlighted(None));
    }

    #[test]
    fn lists_only_children_are_not_double_indented() {
        let list = Node::List {
            ordered: false,
            items: vec![],
        };
        let para = Node::Para {
            tag: Tag::Div,
            todo: None,
            runs: vec![],
        };
        let mut out = Vec::new();
        push_children(&mut out, vec![list.clone()]);
        assert_eq!(out, vec![list.clone()]);
        push_children(&mut out, vec![para.clone(), list.clone()]);
        assert_eq!(out[1], Node::Indent(vec![para, list]));
        push_children(&mut out, vec![]);
        assert_eq!(out.len(), 2);
    }
}
