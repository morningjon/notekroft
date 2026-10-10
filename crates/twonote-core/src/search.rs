//! Full-text search across every notebook in a library.
//!
//! This is a straightforward scan: every page is read and matched on each
//! query. That is comfortably fast for thousands of pages and keeps the
//! library free of index files that could drift out of date.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::html;
use crate::model::Block;
use crate::store::Library;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub notebook_id: String,
    pub notebook_title: String,
    pub section_id: String,
    pub section_title: String,
    pub page_id: String,
    pub page_title: String,
    /// A short excerpt around the first match in the page body, if any.
    pub snippet: String,
    /// True when every term appears in the page title.
    pub title_match: bool,
    pub modified: i64,
}

const SNIPPET_BEFORE: usize = 40;
const SNIPPET_LEN: usize = 140;

fn snippet(text: &str, lower: &str, term: &str) -> String {
    let Some(byte) = lower.find(term) else {
        return String::new();
    };
    // Lowercasing can change byte lengths, so translate through char counts.
    let hit = lower[..byte].chars().count();
    let total = text.chars().count();
    let start = hit.saturating_sub(SNIPPET_BEFORE);
    let mut s: String = text.chars().skip(start).take(SNIPPET_LEN).collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if start + SNIPPET_LEN < total {
        s.push('…');
    }
    s
}

impl Library {
    /// Pages containing every whitespace-separated term of `query`,
    /// case-insensitively. Title matches come first, then most recent.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let mut hits = Vec::new();
        if terms.is_empty() {
            return Ok(hits);
        }

        for nb_id in self.notebook_ids()? {
            let Ok(nb) = self.read_notebook_file(&nb_id) else {
                continue;
            };
            for sec_id in &nb.sections {
                let Ok(sec) = self.read_section(&nb_id, sec_id) else {
                    continue;
                };
                for entry in &sec.pages {
                    let Ok(page) = self.read_page_file(&nb_id, sec_id, &entry.id) else {
                        continue;
                    };
                    let body = page
                        .blocks
                        .iter()
                        .filter_map(|b| match b {
                            Block::Text { html, .. } => Some(html::to_text(html)),
                            Block::Image { alt, .. } if !alt.is_empty() => Some(alt.clone()),
                            Block::Image { .. } => None,
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    let title_lower = page.title.to_lowercase();
                    let body_lower = body.to_lowercase();
                    let all_present = terms
                        .iter()
                        .all(|t| title_lower.contains(t) || body_lower.contains(t));
                    if !all_present {
                        continue;
                    }
                    let snip = terms
                        .iter()
                        .map(|t| snippet(&body, &body_lower, t))
                        .find(|s| !s.is_empty())
                        .unwrap_or_else(|| body.chars().take(SNIPPET_LEN).collect());
                    hits.push(SearchHit {
                        notebook_id: nb_id.clone(),
                        notebook_title: nb.title.clone(),
                        section_id: sec_id.clone(),
                        section_title: sec.title.clone(),
                        page_id: entry.id.clone(),
                        page_title: page.title.clone(),
                        snippet: snip,
                        title_match: terms.iter().all(|t| title_lower.contains(t)),
                        modified: page.modified,
                    });
                }
            }
        }

        hits.sort_by(|a, b| {
            b.title_match
                .cmp(&a.title_match)
                .then(b.modified.cmp(&a.modified))
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Block;

    #[test]
    fn finds_pages_by_title_and_body() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let nb = lib.create_notebook("Work").unwrap();
        let sec = lib.create_section(&nb.id, "Clients").unwrap();

        let mut a = lib
            .create_page(&nb.id, &sec.id, "Budget review", None)
            .unwrap();
        a.blocks = vec![Block::Text {
            id: "b".into(),
            x: 0.0,
            y: 0.0,
            w: 300.0,
            html: "<p>Quarterly <b>FORECAST</b> for the café &amp; bar</p>".into(),
        }];
        lib.save_page(&nb.id, &sec.id, a.clone()).unwrap();

        let mut b = lib.create_page(&nb.id, &sec.id, "Forecast", None).unwrap();
        b.blocks = vec![];
        lib.save_page(&nb.id, &sec.id, b.clone()).unwrap();

        let hits = lib.search("forecast", 50).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].page_id, b.id, "title matches rank first");
        assert!(hits[1].snippet.contains("FORECAST for the café & bar"));
        assert_eq!(hits[1].section_title, "Clients");

        // Every term must match, across title and body; tags never match.
        assert_eq!(lib.search("budget CAFÉ", 50).unwrap().len(), 1);
        assert!(lib.search("budget missing", 50).unwrap().is_empty());
        assert!(lib.search("<b>", 50).unwrap().is_empty());
        assert!(lib.search("   ", 50).unwrap().is_empty());
        assert_eq!(lib.search("forecast", 1).unwrap().len(), 1);
    }

    #[test]
    fn long_bodies_get_trimmed_snippets() {
        let text = format!("{} needle {}", "é".repeat(100), "z".repeat(300));
        let s = snippet(&text, &text.to_lowercase(), "needle");
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("needle"));
        assert_eq!(s.chars().count(), SNIPPET_LEN + 2);
    }
}
