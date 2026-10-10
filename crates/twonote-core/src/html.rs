//! Rich text handling: sanitising note HTML and extracting plain text.
//!
//! Note containers store a small, fixed subset of HTML. Everything passes
//! through [`clean`] on the way to disk and again on the way back out, so a
//! notebook that arrived from somewhere else (a sync folder, a download)
//! cannot carry script into the app.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static CLEANER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let tags: HashSet<&str> = [
        "p",
        "div",
        "br",
        "b",
        "strong",
        "i",
        "em",
        "u",
        "s",
        "strike",
        "mark",
        "sub",
        "sup",
        "h1",
        "h2",
        "h3",
        "ul",
        "ol",
        "li",
        "blockquote",
        "code",
        "pre",
        "table",
        "tbody",
        "tr",
        "td",
        "th",
        "a",
        "span",
    ]
    .into_iter()
    .collect();

    let mut attrs: HashMap<&str, HashSet<&str>> = HashMap::new();
    attrs.insert("a", ["href"].into_iter().collect());
    attrs.insert("td", ["colspan", "rowspan"].into_iter().collect());
    attrs.insert("th", ["colspan", "rowspan"].into_iter().collect());

    // To-do items are ordinary blocks carrying `class="todo"` (plus `done`
    // once ticked). No other classes survive.
    let todo: HashSet<&str> = ["todo", "done"].into_iter().collect();
    let mut classes: HashMap<&str, HashSet<&str>> = HashMap::new();
    for tag in ["div", "p", "li"] {
        classes.insert(tag, todo.clone());
    }

    let mut b = ammonia::Builder::empty();
    b.tags(tags)
        .tag_attributes(attrs)
        .allowed_classes(classes)
        .url_schemes(["http", "https", "mailto"].into_iter().collect())
        .link_rel(Some("noopener noreferrer"))
        .clean_content_tags(["script", "style"].into_iter().collect());
    b
});

/// Reduce arbitrary HTML to the subset TwoNote stores.
pub fn clean(input: &str) -> String {
    CLEANER.clean(input).to_string()
}

/// Plain text of a piece of note HTML, for search and snippets. Block
/// boundaries become single spaces.
pub fn to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        push_decoded(&mut out, &rest[..lt]);
        match rest[lt..].find('>') {
            Some(gt) => {
                out.push(' ');
                rest = &rest[lt + gt + 1..];
            }
            None => {
                rest = "";
                break;
            }
        }
    }
    push_decoded(&mut out, rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_decoded(out: &mut String, text: &str) {
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let end = tail.find(';').filter(|&i| i <= 10);
        let decoded = end.and_then(|i| decode_entity(&tail[1..i]));
        match (end, decoded) {
            (Some(i), Some(c)) => {
                out.push(c);
                rest = &tail[i + 1..];
            }
            _ => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
}

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let num = name.strip_prefix('#')?;
            let code = match num.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => num.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_script_and_handlers() {
        let dirty =
            r#"<p onclick="x()">hi<script>alert(1)</script><img src=x onerror=alert(1)></p>"#;
        assert_eq!(clean(dirty), "<p>hi</p>");
    }

    #[test]
    fn rejects_dangerous_links_keeps_safe_ones() {
        assert_eq!(
            clean(r#"<a href="javascript:alert(1)">x</a>"#),
            r#"<a rel="noopener noreferrer">x</a>"#
        );
        assert_eq!(
            clean(r#"<a href="https://example.org/">x</a>"#),
            r#"<a href="https://example.org/" rel="noopener noreferrer">x</a>"#
        );
    }

    #[test]
    fn keeps_formatting_tables_and_todos() {
        let html = r#"<h1>T</h1><div class="todo done evil">a</div><table><tbody><tr><td colspan="2">c</td></tr></tbody></table><mark>m</mark>"#;
        let out = clean(html);
        assert!(out.contains(r#"<div class="todo done">a</div>"#), "{out}");
        assert!(out.contains(r#"<td colspan="2">c</td>"#));
        assert!(out.contains("<mark>m</mark>"));
        assert!(!out.contains("evil"));
    }

    #[test]
    fn drops_inline_styles() {
        assert_eq!(
            clean(r#"<span style="position:fixed">x</span>"#),
            "<span>x</span>"
        );
    }

    #[test]
    fn text_extraction() {
        assert_eq!(
            to_text("<p>Tom &amp; Jerry</p><p>caf&#233;&nbsp;&#x41; &bogus; a<b</p>"),
            "Tom & Jerry café A &bogus; a"
        );
    }
}
