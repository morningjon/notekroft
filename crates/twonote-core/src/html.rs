//! Rich text handling: sanitising note HTML and extracting plain text.
//!
//! Note containers store a small, fixed subset of HTML. Everything passes
//! through [`clean`] on the way to disk and again on the way back out, so a
//! notebook that arrived from somewhere else (a sync folder, a download)
//! cannot carry script into the app.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Classes a block may carry. `todo`/`done` make a tick box; `quote` and
/// `cite` are paragraph styles; the rest are note tags, each drawn as a
/// small icon in front of the paragraph.
pub const BLOCK_CLASSES: [&str; 20] = [
    "todo",
    "done",
    "quote",
    "cite",
    "tag-important",
    "tag-question",
    "tag-remember",
    "tag-definition",
    "tag-highlight",
    "tag-contact",
    "tag-address",
    "tag-phone",
    "tag-website",
    "tag-idea",
    "tag-password",
    "tag-critical",
    "tag-movie",
    "tag-book",
    "tag-music",
    "tag-source",
];

/// Elements that may carry a `class` and a `style`.
const BLOCK_TAGS: [&str; 9] = ["div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6"];

/// Further elements that may carry a `style`.
const STYLED_ONLY: [&str; 5] = ["span", "td", "th", "pre", "blockquote"];

static CLEANER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let tags: HashSet<&str> = [
        "p",
        "div",
        "br",
        "hr",
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
        "h4",
        "h5",
        "h6",
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
        "img",
    ]
    .into_iter()
    .collect();

    let mut attrs: HashMap<&str, HashSet<&str>> = HashMap::new();
    attrs.insert("a", ["href"].into_iter().collect());
    // Inline pictures never carry a `src`: they name an asset stored in the
    // notebook, and the interface resolves that when the page is shown.
    attrs.insert(
        "img",
        ["data-asset", "width", "height", "alt"]
            .into_iter()
            .collect(),
    );
    for tag in BLOCK_TAGS.iter().chain(STYLED_ONLY.iter()) {
        attrs.entry(tag).or_default().insert("style");
    }
    for tag in ["td", "th"] {
        let entry = attrs.entry(tag).or_default();
        entry.insert("colspan");
        entry.insert("rowspan");
    }

    let block_classes: HashSet<&str> = BLOCK_CLASSES.into_iter().collect();
    let mut classes: HashMap<&str, HashSet<&str>> = HashMap::new();
    for tag in BLOCK_TAGS {
        classes.insert(tag, block_classes.clone());
    }

    let mut b = ammonia::Builder::empty();
    b.tags(tags)
        .tag_attributes(attrs)
        .allowed_classes(classes)
        .url_schemes(["http", "https", "mailto"].into_iter().collect())
        .link_rel(Some("noopener noreferrer"))
        .clean_content_tags(["script", "style"].into_iter().collect())
        .attribute_filter(|element, attribute, value| match (element, attribute) {
            (_, "style") => normalise_style(value).map(Into::into),
            ("img", "data-asset") => crate::model::is_asset_name(value).then(|| value.into()),
            ("img", "width" | "height") => {
                let digits = !value.is_empty()
                    && value.len() <= 5
                    && value.bytes().all(|b| b.is_ascii_digit());
                digits.then(|| value.into())
            }
            _ => Some(value.into()),
        });
    b
});

/// The only CSS a note may carry, in the order it is written out.
const STYLE_PROPERTIES: [&str; 5] = [
    "font-family",
    "font-size",
    "color",
    "background-color",
    "text-align",
];

/// Reduce a `style` attribute to TwoNote's formatting properties, with each
/// value checked and rewritten in one canonical form. Returns `None` when
/// nothing valid is left. Anything that could load a resource or change
/// layout (urls, positioning, sizes of boxes) never survives.
pub fn normalise_style(value: &str) -> Option<String> {
    let mut kept: [Option<String>; 5] = Default::default();
    for declaration in value.split(';') {
        let Some((property, raw)) = declaration.split_once(':') else {
            continue;
        };
        let property = property.trim().to_ascii_lowercase();
        let raw = raw.trim();
        let Some(index) = STYLE_PROPERTIES.iter().position(|p| *p == property) else {
            continue;
        };
        let parsed = match property.as_str() {
            "font-family" => font_family(raw),
            "font-size" => font_size(raw),
            "color" | "background-color" => colour(raw),
            _ => {
                let v = raw.to_ascii_lowercase();
                matches!(v.as_str(), "left" | "center" | "right" | "justify").then_some(v)
            }
        };
        if parsed.is_some() {
            kept[index] = parsed;
        }
    }
    let parts: Vec<String> = STYLE_PROPERTIES
        .iter()
        .zip(kept)
        .filter_map(|(property, value)| value.map(|v| format!("{property}: {v}")))
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// `#rgb`, `#rrggbb`, `rgb(r, g, b)` or an opaque `rgba(...)`, as `#rrggbb`.
fn colour(raw: &str) -> Option<String> {
    let v = raw.to_ascii_lowercase();
    if let Some(hex) = v.strip_prefix('#') {
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        return match hex.len() {
            3 => Some(format!(
                "#{}",
                hex.chars().flat_map(|c| [c, c]).collect::<String>()
            )),
            6 => Some(format!("#{hex}")),
            _ => None,
        };
    }
    let inner = v
        .strip_prefix("rgba(")
        .or_else(|| v.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = inner
        .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 3 || parts.len() > 4 {
        return None;
    }
    if let Some(alpha) = parts.get(3) {
        // Fully transparent means "no colour", which is simply no property.
        if alpha.trim_end_matches('%').parse::<f32>().ok()? <= 0.0 {
            return None;
        }
    }
    let mut rgb = [0u8; 3];
    for (slot, part) in rgb.iter_mut().zip(&parts) {
        *slot = part.parse::<f32>().ok()?.round().clamp(0.0, 255.0) as u8;
    }
    Some(format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]))
}

/// Font names only: letters, digits, spaces, hyphens and commas.
fn font_family(raw: &str) -> Option<String> {
    let names: Vec<String> = raw
        .split(',')
        .map(|name| {
            name.trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|name| !name.is_empty())
        .collect();
    let ok = !names.is_empty()
        && names.iter().all(|name| {
            name.chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        });
    let joined = names.join(", ");
    (ok && joined.chars().count() <= 120).then_some(joined)
}

/// A size in points or pixels within a sane range, rounded to two decimals.
fn font_size(raw: &str) -> Option<String> {
    let v = raw.to_ascii_lowercase();
    let unit = ["pt", "px"].into_iter().find(|u| v.ends_with(u))?;
    let number: f32 = v[..v.len() - 2].trim().parse().ok()?;
    if !(1.0..=400.0).contains(&number) {
        return None;
    }
    let rounded = (number * 100.0).round() / 100.0;
    Some(format!("{rounded}{unit}"))
}

/// Reduce arbitrary HTML to the subset TwoNote stores.
pub fn clean(input: &str) -> String {
    drop_unresolvable_images(CLEANER.clean(input).to_string())
}

/// An `<img>` that names no valid asset can never be shown, so remove it
/// rather than leave an empty element behind. Runs on sanitiser output, where
/// every `<` is a real tag and attribute values are quoted and escaped.
fn drop_unresolvable_images(html: String) -> String {
    if !html.contains("<img") {
        return html;
    }
    let mut out = String::with_capacity(html.len());
    let mut rest = html.as_str();
    while let Some(start) = rest.find("<img") {
        out.push_str(&rest[..start]);
        let end = rest[start..]
            .find('>')
            .map_or(rest.len(), |i| start + i + 1);
        let tag = &rest[start..end];
        if tag.contains(" data-asset=\"") {
            out.push_str(tag);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
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
    fn inline_pictures_keep_only_a_valid_asset_reference() {
        let name = format!("{}.png", "ab".repeat(32));
        let html = format!(
            r#"<img data-asset="{name}" width="320" height="200" alt="chart" src="https://tracker.example/x.gif" onload="x()">"#
        );
        assert_eq!(
            clean(&html),
            format!(r#"<img data-asset="{name}" width="320" height="200" alt="chart">"#)
        );
        assert_eq!(
            clean(
                r#"a<img data-asset="../../secret.png" width="1e9" src="file:///etc/passwd">b<img alt="x">"#
            ),
            "ab"
        );
    }

    #[test]
    fn styles_are_reduced_to_text_formatting() {
        assert_eq!(
            clean(r#"<span style="position:fixed">x</span>"#),
            "<span>x</span>"
        );
        let messy = r#"<span style='TEXT-ALIGN: Center; color: rgb(170, 0, 17); background: url(https://evil.example/x.png); background-color:#FE0; font-family: "Calibri Light", sans-serif; font-size: 13.3333px; position: absolute; width: 9999px; color: red'>x</span>"#;
        assert_eq!(
            clean(messy),
            r#"<span style="font-family: Calibri Light, sans-serif; font-size: 13.33px; color: #aa0011; background-color: #ffee00; text-align: center">x</span>"#
        );
        // Already-clean input is left exactly as it is.
        assert_eq!(clean(&clean(messy)), clean(messy));
    }

    #[test]
    fn style_values_are_validated() {
        for bad in [
            "color: url(x)",
            "color: expression(alert(1))",
            "color: #12345",
            "color: rgba(0, 0, 0, 0)",
            "font-size: 100000px",
            "font-size: 2em",
            "font-family: \\6a avascript",
            "text-align: start; float: left",
            "",
        ] {
            assert_eq!(normalise_style(bad), None, "{bad}");
        }
        // An attempt to break out of the declaration keeps only what is valid.
        assert_eq!(
            normalise_style("font-family: x; } body { display: none").as_deref(),
            Some("font-family: x")
        );
        assert_eq!(
            normalise_style("color:#abc").as_deref(),
            Some("color: #aabbcc")
        );
        assert_eq!(
            normalise_style("font-size: 20PT; color: rgb(1 2 3 / 50%)").as_deref(),
            Some("font-size: 20pt; color: #010203")
        );
    }

    #[test]
    fn tags_headings_and_rules() {
        let html = r#"<h5 class="tag-important nope">T</h5><div class="tag-question quote">q</div><hr><span class="tag-idea">s</span>"#;
        assert_eq!(
            clean(html),
            r#"<h5 class="tag-important">T</h5><div class="tag-question quote">q</div><hr><span>s</span>"#
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
