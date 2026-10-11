//! A small intermediate form for imported note content, and its rendering to
//! the HTML subset NoteKroft stores.
//!
//! Keeping this separate from the OneNote parser means the rules for what an
//! imported note looks like can be tested without any `.one` files.

use notekroft_core::html::normalise_style;

/// A stretch of text with one set of character formatting.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub superscript: bool,
    pub subscript: bool,
    /// Font family, when it differs from the default.
    pub font: Option<String>,
    /// Size in points, when it differs from the default.
    pub size: Option<f32>,
    /// Text colour as `#rrggbb`.
    pub color: Option<String>,
    /// Highlight colour as `#rrggbb`.
    pub highlight: Option<String>,
    pub link: Option<String>,
}

impl Run {
    #[cfg(test)]
    pub fn plain(text: &str) -> Self {
        Run {
            text: text.to_string(),
            ..Run::default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tag {
    Div,
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    Code,
    Quote,
    Cite,
}

impl Tag {
    pub fn is_heading(self) -> bool {
        matches!(
            self,
            Tag::H1 | Tag::H2 | Tag::H3 | Tag::H4 | Tag::H5 | Tag::H6
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    /// One paragraph. `todo` is `Some(done)` for a to-do item; `note_tag` is
    /// one of NoteKroft's `tag-*` classes; `align` is a `text-align` value.
    Para {
        tag: Tag,
        todo: Option<bool>,
        note_tag: Option<&'static str>,
        align: Option<&'static str>,
        runs: Vec<Run>,
    },
    List {
        ordered: bool,
        items: Vec<Vec<Node>>,
    },
    /// Content indented under the paragraph before it.
    Indent(Vec<Node>),
    /// Rows of cells; each cell holds its own nodes.
    Table(Vec<Vec<Vec<Node>>>),
    Image {
        asset: String,
        width: u32,
        height: u32,
        alt: String,
    },
    /// A visible note standing in for something that could not be imported.
    Notice(String),
}

/// Only web and email links survive; internal `onenote:` links and anything
/// else are dropped, leaving their text in place.
fn safe_link(target: &str) -> Option<&str> {
    let t = target.trim();
    let lower = t.to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
        .then_some(t)
}

fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // OneNote marks a line break inside a paragraph with a vertical tab.
            '\u{b}' | '\n' => out.push_str("<br>"),
            '\t' => out.push('\t'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
}

fn escape_attr(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
}

fn run_is_blank(run: &Run) -> bool {
    run.text
        .chars()
        .all(|c| c.is_control() && c != '\u{b}' && c != '\n')
}

fn render_runs(runs: &[Run], out: &mut String) {
    let runs: Vec<&Run> = runs.iter().filter(|r| !run_is_blank(r)).collect();
    if runs.is_empty() {
        out.push_str("<br>");
        return;
    }
    let mut open_link: Option<&str> = None;
    for run in runs {
        let link = run.link.as_deref().and_then(safe_link);
        if link != open_link {
            if open_link.is_some() {
                out.push_str("</a>");
            }
            if let Some(href) = link {
                out.push_str("<a href=\"");
                escape_attr(href, out);
                // Written the way NoteKroft's sanitiser stores links.
                out.push_str("\" rel=\"noopener noreferrer\">");
            }
            open_link = link;
        }
        let style = run_style(run);
        if let Some(style) = &style {
            out.push_str("<span style=\"");
            escape_attr(style, out);
            out.push_str("\">");
        }
        // Links are already underlined; do not double up.
        let tags: [(&str, bool); 6] = [
            ("b", run.bold),
            ("i", run.italic),
            ("u", run.underline && link.is_none()),
            ("s", run.strike),
            ("sup", run.superscript),
            ("sub", run.subscript && !run.superscript),
        ];
        for (tag, on) in tags {
            if on {
                out.push('<');
                out.push_str(tag);
                out.push('>');
            }
        }
        escape(&run.text, out);
        for (tag, on) in tags.iter().rev() {
            if *on {
                out.push_str("</");
                out.push_str(tag);
                out.push('>');
            }
        }
        if style.is_some() {
            out.push_str("</span>");
        }
    }
    if open_link.is_some() {
        out.push_str("</a>");
    }
}

/// The run's character formatting as a canonical `style` value, exactly as
/// NoteKroft's sanitiser would write it.
fn run_style(run: &Run) -> Option<String> {
    let mut raw = String::new();
    // A font name is data from the file: anything that is not plainly a name
    // is left out rather than passed along.
    let plain_name = |f: &&String| {
        f.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
    };
    if let Some(font) = run.font.as_ref().filter(plain_name) {
        raw.push_str(&format!("font-family: {font};"));
    }
    if let Some(size) = run.size {
        raw.push_str(&format!("font-size: {size}pt;"));
    }
    if let Some(color) = &run.color {
        raw.push_str(&format!("color: {color};"));
    }
    if let Some(highlight) = &run.highlight {
        raw.push_str(&format!("background-color: {highlight};"));
    }
    normalise_style(&raw)
}

/// ` class="…"` and ` style="…"` for a block, in the order the sanitiser
/// writes them.
fn block_attrs(
    todo: Option<bool>,
    extra: Option<&str>,
    note_tag: Option<&str>,
    align: Option<&str>,
    out: &mut String,
) {
    let mut classes: Vec<&str> = Vec::new();
    match todo {
        Some(true) => classes.extend(["todo", "done"]),
        Some(false) => classes.push("todo"),
        None => {}
    }
    classes.extend(extra);
    classes.extend(note_tag);
    if !classes.is_empty() {
        out.push_str(" class=\"");
        out.push_str(&classes.join(" "));
        out.push('"');
    }
    if let Some(align) = align {
        out.push_str(" style=\"text-align: ");
        out.push_str(align);
        out.push('"');
    }
}

fn render_para(node: &Node, out: &mut String) {
    let Node::Para {
        tag,
        todo,
        note_tag,
        align,
        runs,
    } = node
    else {
        return;
    };
    let (name, class) = match tag {
        Tag::Div | Tag::Code => ("div", None),
        Tag::Quote => ("div", Some("quote")),
        Tag::Cite => ("div", Some("cite")),
        Tag::H1 => ("h1", None),
        Tag::H2 => ("h2", None),
        Tag::H3 => ("h3", None),
        Tag::H4 => ("h4", None),
        Tag::H5 => ("h5", None),
        Tag::H6 => ("h6", None),
    };
    out.push('<');
    out.push_str(name);
    block_attrs(*todo, class, *note_tag, *align, out);
    out.push('>');
    if *tag == Tag::Code {
        out.push_str("<code>");
        render_runs(runs, out);
        out.push_str("</code>");
    } else {
        render_runs(runs, out);
    }
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

/// A paragraph with nothing a list item or table cell could not carry
/// itself, so its text can flow straight into that container.
fn plain_para(node: &Node) -> Option<(&[Run], Option<bool>, Option<&'static str>)> {
    match node {
        Node::Para {
            tag: Tag::Div,
            todo,
            note_tag,
            align: None,
            runs,
        } => Some((runs, *todo, *note_tag)),
        _ => None,
    }
}

/// Render nodes that sit inside a list item or table cell, where a leading
/// plain paragraph flows inline instead of opening its own block. In a table
/// cell (`bare`) that only applies when the paragraph has no tick box or tag,
/// since a cell cannot carry one.
fn render_inline_first(nodes: &[Node], bare: bool, out: &mut String) {
    let mut rest = nodes;
    if let Some((first, tail)) = nodes.split_first() {
        match plain_para(first) {
            Some((runs, todo, tag)) if !bare || (todo.is_none() && tag.is_none()) => {
                render_runs(runs, out);
                rest = tail;
            }
            _ => {}
        }
    } else {
        out.push_str("<br>");
    }
    render_into(rest, out);
}

fn render_into(nodes: &[Node], out: &mut String) {
    for node in nodes {
        match node {
            Node::Para { .. } => render_para(node, out),
            Node::List { ordered, items } => {
                let tag = if *ordered { "ol" } else { "ul" };
                out.push('<');
                out.push_str(tag);
                out.push('>');
                for item in items {
                    let (todo, note_tag) = item
                        .first()
                        .and_then(plain_para)
                        .map_or((None, None), |(_, todo, tag)| (todo, tag));
                    out.push_str("<li");
                    block_attrs(todo, None, note_tag, None, out);
                    out.push('>');
                    render_inline_first(item, false, out);
                    out.push_str("</li>");
                }
                out.push_str("</");
                out.push_str(tag);
                out.push('>');
            }
            Node::Indent(children) => {
                if !children.is_empty() {
                    out.push_str("<blockquote>");
                    render_into(children, out);
                    out.push_str("</blockquote>");
                }
            }
            Node::Table(rows) => {
                out.push_str("<table><tbody>");
                for row in rows {
                    out.push_str("<tr>");
                    for cell in row {
                        out.push_str("<td>");
                        render_inline_first(cell, true, out);
                        out.push_str("</td>");
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>");
            }
            Node::Image {
                asset,
                width,
                height,
                alt,
            } => {
                out.push_str("<div><img data-asset=\"");
                escape_attr(asset, out);
                out.push_str(&format!("\" width=\"{width}\" height=\"{height}\""));
                if !alt.is_empty() {
                    out.push_str(" alt=\"");
                    escape_attr(alt, out);
                    out.push('"');
                }
                out.push_str("></div>");
            }
            Node::Notice(text) => {
                out.push_str("<div><i>[");
                escape(text, out);
                out.push_str("]</i></div>");
            }
        }
    }
}

pub fn render(nodes: &[Node]) -> String {
    let mut out = String::new();
    render_into(nodes, &mut out);
    out
}

/// True when the nodes would show nothing at all.
pub fn is_blank(nodes: &[Node]) -> bool {
    nodes.iter().all(|n| match n {
        Node::Para { runs, .. } => runs.iter().all(|r| r.text.trim().is_empty()),
        Node::List { items, .. } => items.iter().all(|i| is_blank(i)),
        Node::Indent(children) => is_blank(children),
        Node::Table(_) | Node::Image { .. } | Node::Notice(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notekroft_core::html::clean;

    fn p(tag: Tag, runs: Vec<Run>) -> Node {
        Node::Para {
            tag,
            todo: None,
            note_tag: None,
            align: None,
            runs,
        }
    }

    fn para(text: &str) -> Node {
        p(Tag::Div, vec![Run::plain(text)])
    }

    fn todo(text: &str, done: bool) -> Node {
        Node::Para {
            tag: Tag::Div,
            todo: Some(done),
            note_tag: None,
            align: None,
            runs: vec![Run::plain(text)],
        }
    }

    /// Whatever the importer produces must already be in NoteKroft's stored
    /// form: sanitising it again changes nothing.
    fn stable(nodes: &[Node]) -> String {
        let html = render(nodes);
        assert_eq!(clean(&html), html, "importer output is not in stored form");
        html
    }

    #[test]
    fn character_formatting_and_escaping() {
        let runs = vec![
            Run::plain("a < b & "),
            Run {
                text: "bold".into(),
                bold: true,
                italic: true,
                ..Run::default()
            },
            Run {
                text: "x\u{b}y\u{1}".into(),
                highlight: Some("#ffff00".into()),
                strike: true,
                ..Run::default()
            },
        ];
        assert_eq!(
            stable(&[p(Tag::Div, runs)]),
            "<div>a &lt; b &amp; <b><i>bold</i></b><span style=\"background-color: #ffff00\"><s>x<br>y</s></span></div>"
        );
    }

    #[test]
    fn fonts_sizes_and_colours_become_canonical_styles() {
        let run = Run {
            text: "Title".into(),
            font: Some("Calibri Light".into()),
            size: Some(20.0),
            color: Some("#C00000".into()),
            highlight: Some("#00ff00".into()),
            underline: true,
            ..Run::default()
        };
        let half = Run {
            text: "x".into(),
            size: Some(10.5),
            font: Some("bad;font{}".into()),
            ..Run::default()
        };
        assert_eq!(
            stable(&[p(Tag::Div, vec![run, half])]),
            "<div><span style=\"font-family: Calibri Light; font-size: 20pt; color: #c00000; background-color: #00ff00\"><u>Title</u></span><span style=\"font-size: 10.5pt\">x</span></div>"
        );
    }

    #[test]
    fn links_merge_across_runs_and_unsafe_ones_are_dropped() {
        let link = |text: &str, target: &str, bold: bool| Run {
            text: text.into(),
            bold,
            underline: true,
            link: Some(target.into()),
            ..Run::default()
        };
        let html = stable(&[p(
            Tag::Div,
            vec![
                link("Tw", "https://example.org/?a=1&b=2", false),
                link("oNote", "https://example.org/?a=1&b=2", true),
                Run::plain(" and "),
                link("a page", "onenote:#Page&section-id={1}", false),
                link("x", "javascript:alert(1)", false),
            ],
        )]);
        assert_eq!(
            html,
            "<div><a href=\"https://example.org/?a=1&amp;b=2\" rel=\"noopener noreferrer\">Tw<b>oNote</b></a> and <u>a page</u><u>x</u></div>"
        );
    }

    #[test]
    fn paragraph_styles_alignment_and_tags() {
        let t = |tag| p(tag, vec![Run::plain("T")]);
        assert_eq!(
            stable(&[
                t(Tag::H1),
                t(Tag::H4),
                t(Tag::H6),
                t(Tag::Code),
                t(Tag::Quote),
                t(Tag::Cite),
                p(Tag::Div, vec![]),
            ]),
            "<h1>T</h1><h4>T</h4><h6>T</h6><div><code>T</code></div><div class=\"quote\">T</div><div class=\"cite\">T</div><div><br></div>"
        );
        let fancy = Node::Para {
            tag: Tag::H2,
            todo: Some(true),
            note_tag: Some("tag-important"),
            align: Some("center"),
            runs: vec![Run::plain("T")],
        };
        assert_eq!(
            stable(&[fancy]),
            "<h2 class=\"todo done tag-important\" style=\"text-align: center\">T</h2>"
        );
    }

    #[test]
    fn lists_nest_and_carry_todos_and_tags() {
        let nested = Node::List {
            ordered: true,
            items: vec![vec![para("one")], vec![para("two")]],
        };
        let tagged = Node::Para {
            tag: Tag::Div,
            todo: None,
            note_tag: Some("tag-question"),
            align: None,
            runs: vec![Run::plain("why")],
        };
        let html = stable(&[
            Node::List {
                ordered: false,
                items: vec![
                    vec![para("top"), nested],
                    vec![todo("ticked", true)],
                    vec![tagged],
                ],
            },
            todo("loose", false),
        ]);
        assert_eq!(
            html,
            "<ul><li>top<ol><li>one</li><li>two</li></ol></li><li class=\"todo done\">ticked</li><li class=\"tag-question\">why</li></ul><div class=\"todo\">loose</div>"
        );
    }

    #[test]
    fn tables_images_indents_and_notices() {
        let asset = format!("{}.png", "0f".repeat(32));
        let html = stable(&[
            Node::Table(vec![
                vec![vec![para("a")], vec![]],
                vec![vec![para("b"), para("c")], vec![todo("in a cell", false)]],
            ]),
            Node::Indent(vec![para("child")]),
            Node::Indent(vec![]),
            Node::Image {
                asset: asset.clone(),
                width: 320,
                height: 200,
                alt: "a \"chart\"\nline".into(),
            },
            Node::Notice("Attached file not imported: <report>.pdf".into()),
        ]);
        assert_eq!(
            html,
            format!(
                "<table><tbody><tr><td>a</td><td><br></td></tr><tr><td>b<div>c</div></td><td><div class=\"todo\">in a cell</div></td></tr></tbody></table>\
                 <blockquote><div>child</div></blockquote>\
                 <div><img data-asset=\"{asset}\" width=\"320\" height=\"200\" alt=\"a &quot;chart&quot; line\"></div>\
                 <div><i>[Attached file not imported: &lt;report&gt;.pdf]</i></div>"
            )
        );
    }

    #[test]
    fn blank_detection() {
        assert!(is_blank(&[para("  "), Node::Indent(vec![para("")])]));
        assert!(!is_blank(&[para("x")]));
        assert!(!is_blank(&[Node::Notice("n".into())]));
    }
}
