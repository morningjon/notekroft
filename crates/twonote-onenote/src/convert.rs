//! Turns parsed OneNote pages into TwoNote pages.

use std::io::Read;

use onenote_parser::contents::{
    Content, EmbeddedFile, EmbeddedObject, Image, Ink, NoteTag, Outline, OutlineElement,
    OutlineItem, RichText, Table,
};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::property::common::ColorRef;
use onenote_parser::property::rich_text::ParagraphAlignment;
use twonote_core::{new_id, Block, Library, NewPage, Stroke};

use crate::html::{self, Node, Run, Tag};
use crate::Skipped;

/// OneNote measures layout in half inches; TwoNote in CSS pixels (96 per inch).
const PX_PER_HALF_INCH: f64 = 48.0;
const DEFAULT_OUTLINE_WIDTH: f64 = 520.0;
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_IMAGE_WIDTH: f64 = 1200.0;
const MAX_ALT_CHARS: usize = 300;
/// Ink coordinates are in HIMETRIC units, 2540 to the inch.
const HIMETRIC_PER_PX: f32 = 2540.0 / 96.0;
/// OneNote's default body text, which imports as TwoNote's own default
/// rather than as explicit formatting on every paragraph.
const DEFAULT_FONT: &str = "Calibri";
const DEFAULT_SIZE_PT: f32 = 11.0;

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
    pub drawings: usize,
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

fn hex(color: Option<ColorRef>) -> Option<(u8, u8, u8)> {
    match color {
        Some(ColorRef::Manual { r, g, b }) => Some((r, g, b)),
        _ => None,
    }
}

/// A highlight colour, unless it is white (which is no highlight at all).
fn highlight_colour(color: Option<ColorRef>) -> Option<String> {
    hex(color)
        .filter(|rgb| *rgb != (255, 255, 255))
        .map(|(r, g, b)| format!("#{r:02x}{g:02x}{b:02x}"))
}

/// A text colour, unless it is plain black (the default).
fn text_colour(color: Option<ColorRef>) -> Option<String> {
    hex(color)
        .filter(|rgb| *rgb != (0, 0, 0))
        .map(|(r, g, b)| format!("#{r:02x}{g:02x}{b:02x}"))
}

/// Map a OneNote tag onto one of TwoNote's, going by its icon and, for the
/// icon-less highlight tags, its name. Tick-box tags are handled separately.
fn note_tag_class(tag: &NoteTag) -> Option<&'static str> {
    let definition = tag.definition()?;
    let shape = format!("{:?}", definition.shape());
    let label = definition.label().to_lowercase();
    let has = |needle: &str| shape.contains(needle);
    Some(if shape == "NoIcon" {
        if label.contains("definition") {
            "tag-definition"
        } else if label.contains("remember") {
            "tag-remember"
        } else if definition.highlight_color().is_some() {
            "tag-highlight"
        } else {
            return None;
        }
    } else if has("CheckBox") {
        return None;
    } else if has("Star") {
        "tag-important"
    } else if has("Question") {
        "tag-question"
    } else if has("LightBulb") {
        "tag-idea"
    } else if has("Priority") || has("Exclamation") || has("TimeSensitive") || has("Lightning") {
        "tag-critical"
    } else if has("Contact") || has("Person") || has("People") {
        "tag-contact"
    } else if shape == "Home" {
        "tag-address"
    } else if has("Phone") {
        "tag-phone"
    } else if has("Globe") {
        "tag-website"
    } else if has("Key") || has("Padlock") {
        "tag-password"
    } else if has("Movie") {
        "tag-movie"
    } else if has("Book") {
        "tag-book"
    } else if has("Music") {
        "tag-music"
    } else if has("Research") || has("Paper") || has("Quotation") {
        "tag-source"
    } else if has("Pushpin") || has("Bell") {
        "tag-remember"
    } else {
        return None;
    })
}

/// Gather every stroke under an ink object as absolute page pixels. The
/// first point of a stroke is its position; the rest are steps from the
/// point before.
fn collect_strokes(ink: &Ink, out: &mut Vec<Stroke>) {
    for child in ink.child_groups() {
        collect_strokes(child, out);
    }
    let ox = ink.offset_horizontal().unwrap_or(0.0) * PX_PER_HALF_INCH as f32;
    let oy = ink.offset_vertical().unwrap_or(0.0) * PX_PER_HALF_INCH as f32;
    for stroke in ink.ink_strokes() {
        let Some((first, steps)) = stroke.path().split_first() else {
            continue;
        };
        let (mut x, mut y) = (first.x(), first.y());
        let mut points = vec![[x / HIMETRIC_PER_PX + ox, y / HIMETRIC_PER_PX + oy]];
        for step in steps {
            x += step.x();
            y += step.y();
            points.push([x / HIMETRIC_PER_PX + ox, y / HIMETRIC_PER_PX + oy]);
        }
        // Stored blue-green-red, lowest byte red.
        let color = stroke.color().unwrap_or(0);
        let (r, g, b) = (color & 0xff, (color >> 8) & 0xff, (color >> 16) & 0xff);
        out.push(Stroke {
            points,
            color: format!("#{r:02x}{g:02x}{b:02x}"),
            width: (stroke.width().max(stroke.height()) / HIMETRIC_PER_PX).clamp(1.0, 60.0),
            opacity: (f32::from(255 - stroke.transparency().unwrap_or(0)) / 255.0).clamp(0.05, 1.0),
        });
    }
}

/// A drawing as a TwoNote ink block, with its position on the page.
fn ink_block(ink: &Ink) -> Option<(f64, f64, Block)> {
    let mut strokes = Vec::new();
    collect_strokes(ink, &mut strokes);
    let pad = strokes.iter().map(|s| s.width).fold(0.0_f32, f32::max) / 2.0 + 1.0;
    let all = || strokes.iter().flat_map(|s| s.points.iter());
    let min_x = all().map(|p| p[0]).fold(f32::INFINITY, f32::min) - pad;
    let min_y = all().map(|p| p[1]).fold(f32::INFINITY, f32::min) - pad;
    let max_x = all().map(|p| p[0]).fold(f32::NEG_INFINITY, f32::max) + pad;
    let max_y = all().map(|p| p[1]).fold(f32::NEG_INFINITY, f32::max) + pad;
    if !(min_x.is_finite() && min_y.is_finite() && max_x.is_finite() && max_y.is_finite()) {
        return None;
    }
    for stroke in &mut strokes {
        for point in &mut stroke.points {
            point[0] -= min_x;
            point[1] -= min_y;
        }
    }
    let block = Block::Ink {
        id: new_id(),
        x: 0.0,
        y: 0.0,
        w: f64::from(max_x - min_x),
        h: f64::from(max_y - min_y),
        strokes,
    };
    Some((f64::from(min_x), f64::from(min_y), block))
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
                PageContent::Ink(ink) => match ink_block(ink) {
                    Some((x, y, block)) => {
                        self.drawings += 1;
                        placed.push(Placed {
                            x: Some(x),
                            y: Some(y),
                            block,
                        });
                    }
                    None => self.skipped.other += 1,
                },
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
                let mut block = p.block;
                block.set_position(nx, ny);
                block
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
                Content::RichText(text) => {
                    // Handwriting written in line with text is not kept yet.
                    self.skipped.ink += text
                        .embedded_objects()
                        .iter()
                        .filter(|o| matches!(o, EmbeddedObject::Ink(_)))
                        .count();
                    own.push(paragraph(text));
                }
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
        Some("h3") => Tag::H3,
        Some("h4") => Tag::H4,
        Some("h5") => Tag::H5,
        Some("h6") => Tag::H6,
        Some("code") => Tag::Code,
        Some("blockquote") => Tag::Quote,
        Some("cite") => Tag::Cite,
        _ => Tag::Div,
    };
    let todo = text.note_tags().iter().find_map(|tag| {
        let checkable = tag.definition().is_some_and(|d| d.shape().is_checkable())
            || tag.item_status().task_tag();
        checkable.then(|| tag.item_status().completed())
    });
    let align = match text.paragraph_alignment() {
        ParagraphAlignment::Center => Some("center"),
        ParagraphAlignment::Right => Some("right"),
        _ => None,
    };
    Node::Para {
        tag,
        todo,
        note_tag: text.note_tags().iter().find_map(note_tag_class),
        align,
        runs: runs(text, tag.is_heading()),
    }
}

/// Split paragraph text into formatted runs. Run boundaries and hyperlink
/// ranges are UTF-16 offsets, so the text is handled as UTF-16 here.
///
/// Headings take their look from the heading style, so their runs keep only
/// emphasis and highlight, not a font, size or colour.
fn runs(text: &RichText, heading: bool) -> Vec<Run> {
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
        let font = style
            .font()
            .filter(|f| !heading && !f.eq_ignore_ascii_case(DEFAULT_FONT))
            .map(str::to_string);
        // Stored in half points.
        let size = style
            .font_size()
            .map(|half| f32::from(half) / 2.0)
            .filter(|pt| !heading && (*pt - DEFAULT_SIZE_PT).abs() > 0.01);
        out.push(Run {
            text: visible,
            bold: style.bold(),
            italic: style.italic(),
            underline: style.underline(),
            strike: style.strikethrough(),
            superscript: style.superscript(),
            subscript: style.subscript(),
            font,
            size,
            // Link text is coloured by being a link.
            color: text_colour(style.font_color()).filter(|_| !heading && link.is_none()),
            highlight: highlight_colour(style.highlight()),
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
    fn default_colours_are_not_formatting() {
        let manual = |r, g, b| Some(ColorRef::Manual { r, g, b });
        assert_eq!(
            highlight_colour(manual(255, 255, 0)).as_deref(),
            Some("#ffff00")
        );
        assert_eq!(highlight_colour(manual(255, 255, 255)), None);
        assert_eq!(highlight_colour(Some(ColorRef::Auto)), None);
        assert_eq!(text_colour(manual(192, 0, 0)).as_deref(), Some("#c00000"));
        assert_eq!(text_colour(manual(0, 0, 0)), None);
        assert_eq!(text_colour(None), None);
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
            note_tag: None,
            align: None,
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
