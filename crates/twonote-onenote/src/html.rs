//! A small intermediate form for imported note content, and its rendering to
//! the HTML subset TwoNote stores.
//!
//! Keeping this separate from the OneNote parser means the rules for what an
//! imported note looks like can be tested without any `.one` files.

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
    pub highlight: bool,
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
    Code,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    /// One paragraph. `todo` is `Some(done)` for a to-do item.
    Para {
        tag: Tag,
        todo: Option<bool>,
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
                // Written the way TwoNote's sanitiser stores links.
                out.push_str("\" rel=\"noopener noreferrer\">");
            }
            open_link = link;
        }
        // Links are already underlined; do not double up.
        let tags: [(&str, bool); 7] = [
            ("mark", run.highlight),
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
    }
    if open_link.is_some() {
        out.push_str("</a>");
    }
}

fn todo_class(todo: Option<bool>) -> &'static str {
    match todo {
        Some(true) => " class=\"todo done\"",
        Some(false) => " class=\"todo\"",
        None => "",
    }
}

fn render_para(tag: Tag, todo: Option<bool>, runs: &[Run], out: &mut String) {
    let (open, close) = match tag {
        Tag::Div | Tag::Code => ("div", "div"),
        Tag::H1 => ("h1", "h1"),
        Tag::H2 => ("h2", "h2"),
        Tag::H3 => ("h3", "h3"),
    };
    out.push('<');
    out.push_str(open);
    // Only plain blocks may carry the to-do class in TwoNote's format.
    if open == "div" {
        out.push_str(todo_class(todo));
    }
    out.push('>');
    if tag == Tag::Code {
        out.push_str("<code>");
        render_runs(runs, out);
        out.push_str("</code>");
    } else {
        render_runs(runs, out);
    }
    out.push_str("</");
    out.push_str(close);
    out.push('>');
}

/// Render nodes that sit inside a list item or table cell, where a leading
/// plain paragraph flows inline instead of opening its own block.
fn render_inline_first(nodes: &[Node], out: &mut String) {
    let mut rest = nodes;
    if let Some((
        Node::Para {
            tag: Tag::Div,
            runs,
            ..
        },
        tail,
    )) = nodes.split_first()
    {
        render_runs(runs, out);
        rest = tail;
    } else if nodes.is_empty() {
        out.push_str("<br>");
    }
    render_into(rest, out);
}

fn render_into(nodes: &[Node], out: &mut String) {
    for node in nodes {
        match node {
            Node::Para { tag, todo, runs } => render_para(*tag, *todo, runs, out),
            Node::List { ordered, items } => {
                let tag = if *ordered { "ol" } else { "ul" };
                out.push('<');
                out.push_str(tag);
                out.push('>');
                for item in items {
                    let todo = match item.first() {
                        Some(Node::Para {
                            tag: Tag::Div,
                            todo,
                            ..
                        }) => *todo,
                        _ => None,
                    };
                    out.push_str("<li");
                    out.push_str(todo_class(todo));
                    out.push('>');
                    render_inline_first(item, out);
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
                        render_inline_first(cell, out);
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
    use twonote_core::html::clean;

    fn para(text: &str) -> Node {
        Node::Para {
            tag: Tag::Div,
            todo: None,
            runs: vec![Run::plain(text)],
        }
    }

    /// Whatever the importer produces must already be in TwoNote's stored
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
                highlight: true,
                strike: true,
                ..Run::default()
            },
        ];
        let html = stable(&[Node::Para {
            tag: Tag::Div,
            todo: None,
            runs,
        }]);
        assert_eq!(
            html,
            "<div>a &lt; b &amp; <b><i>bold</i></b><mark><s>x<br>y</s></mark></div>"
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
        let html = stable(&[Node::Para {
            tag: Tag::Div,
            todo: None,
            runs: vec![
                link("Tw", "https://example.org/?a=1&b=2", false),
                link("oNote", "https://example.org/?a=1&b=2", true),
                Run::plain(" and "),
                link("a page", "onenote:#Page&section-id={1}", false),
                link("x", "javascript:alert(1)", false),
            ],
        }]);
        assert_eq!(
            html,
            "<div><a href=\"https://example.org/?a=1&amp;b=2\" rel=\"noopener noreferrer\">Tw<b>oNote</b></a> and <u>a page</u><u>x</u></div>"
        );
    }

    #[test]
    fn headings_code_and_empty_paragraphs() {
        let p = |tag| Node::Para {
            tag,
            todo: None,
            runs: vec![Run::plain("T")],
        };
        let empty = Node::Para {
            tag: Tag::Div,
            todo: None,
            runs: vec![],
        };
        assert_eq!(
            stable(&[p(Tag::H1), p(Tag::H2), p(Tag::H3), p(Tag::Code), empty]),
            "<h1>T</h1><h2>T</h2><h3>T</h3><div><code>T</code></div><div><br></div>"
        );
    }

    #[test]
    fn lists_nest_and_carry_todos() {
        let todo = |text: &str, done| Node::Para {
            tag: Tag::Div,
            todo: Some(done),
            runs: vec![Run::plain(text)],
        };
        let nested = Node::List {
            ordered: true,
            items: vec![vec![para("one")], vec![para("two")]],
        };
        let html = stable(&[
            Node::List {
                ordered: false,
                items: vec![vec![para("top"), nested], vec![todo("ticked", true)]],
            },
            todo("loose", false),
        ]);
        assert_eq!(
            html,
            "<ul><li>top<ol><li>one</li><li>two</li></ol></li><li class=\"todo done\">ticked</li></ul><div class=\"todo\">loose</div>"
        );
    }

    #[test]
    fn tables_images_indents_and_notices() {
        let asset = format!("{}.png", "0f".repeat(32));
        let html = stable(&[
            Node::Table(vec![
                vec![vec![para("a")], vec![]],
                vec![vec![para("b"), para("c")], vec![]],
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
                "<table><tbody><tr><td>a</td><td><br></td></tr><tr><td>b<div>c</div></td><td><br></td></tr></tbody></table>\
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
