//! The on-disk notebook library. Layout is documented in `docs/FORMAT.md`.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::html;
use crate::model::*;

const MAX_TITLE_CHARS: usize = 200;
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;
const TRASH_DIR: &str = ".trash";
const MAX_STROKES: usize = 5_000;
const MAX_STROKE_POINTS: usize = 20_000;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Ids become path components, so they are restricted to a safe alphabet.
fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidId(id.to_string()))
    }
}

/// Asset names are `<sha256 hex>.<ext>` and nothing else.
fn check_asset(name: &str) -> Result<()> {
    if is_asset_name(name) {
        Ok(())
    } else {
        Err(Error::InvalidAsset(name.to_string()))
    }
}

fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn clean_title(title: &str) -> String {
    let t: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(MAX_TITLE_CHARS).collect()
}

fn title_or(title: &str, fallback: &str) -> String {
    let t = clean_title(title);
    if t.is_empty() {
        fallback.to_string()
    } else {
        t
    }
}

fn check_color(color: &str) -> Result<()> {
    let ok = color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("colour {color:?}")))
    }
}

/// A page can sit at most one level deeper than the page above it, and the
/// first page is always top level.
fn normalise_levels(pages: &mut [PageEntry]) {
    let mut prev: Option<u8> = None;
    for p in pages.iter_mut() {
        let max = prev.map_or(0, |l| (l + 1).min(MAX_PAGE_LEVEL));
        p.level = p.level.min(max);
        prev = Some(p.level);
    }
}

fn is_permutation(current: &[&str], requested: &[&str]) -> bool {
    let mut a = current.to_vec();
    let mut b = requested.to_vec();
    a.sort_unstable();
    b.sort_unstable();
    a == b && a.windows(2).all(|w| w[0] != w[1])
}

fn read_json<T: DeserializeOwned>(path: &Path, what: &str) -> Result<T> {
    let bytes = fs::read(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => Error::NotFound(what.to_string()),
        _ => Error::Io(e),
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Write via a temporary file and rename, so a crash never leaves a
/// half-written page behind.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::Invalid("path has no parent".into()))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".tmp-{}", new_id()));
    let res = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(res?)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

/// A directory of notebooks.
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
}

impl Library {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---- paths ---------------------------------------------------------------

    fn nb_dir(&self, nb: &str) -> Result<PathBuf> {
        check_id(nb)?;
        Ok(self.root.join(nb))
    }

    fn nb_file(&self, nb: &str) -> Result<PathBuf> {
        Ok(self.nb_dir(nb)?.join("notebook.json"))
    }

    fn sec_dir(&self, nb: &str, sec: &str) -> Result<PathBuf> {
        check_id(sec)?;
        Ok(self.nb_dir(nb)?.join("sections").join(sec))
    }

    fn sec_file(&self, nb: &str, sec: &str) -> Result<PathBuf> {
        Ok(self.sec_dir(nb, sec)?.join("section.json"))
    }

    fn page_file(&self, nb: &str, sec: &str, page: &str) -> Result<PathBuf> {
        check_id(page)?;
        Ok(self
            .sec_dir(nb, sec)?
            .join("pages")
            .join(format!("{page}.json")))
    }

    // ---- raw file access -----------------------------------------------------

    pub(crate) fn read_notebook_file(&self, nb: &str) -> Result<NotebookFile> {
        let file: NotebookFile = read_json(&self.nb_file(nb)?, "notebook")?;
        if file.format > FORMAT_VERSION {
            return Err(Error::UnsupportedFormat(file.format));
        }
        Ok(file)
    }

    pub(crate) fn read_section(&self, nb: &str, sec: &str) -> Result<SectionFile> {
        read_json(&self.sec_file(nb, sec)?, "section")
    }

    pub(crate) fn read_page_file(&self, nb: &str, sec: &str, page: &str) -> Result<Page> {
        read_json(&self.page_file(nb, sec, page)?, "page")
    }

    fn write_notebook_file(&self, file: &NotebookFile) -> Result<()> {
        write_json(&self.nb_file(&file.id)?, file)
    }

    fn write_section(&self, nb: &str, sec: &SectionFile) -> Result<()> {
        write_json(&self.sec_file(nb, &sec.id)?, sec)
    }

    fn touch(&self, nb: &str) -> Result<()> {
        let mut file = self.read_notebook_file(nb)?;
        file.modified = now_ms();
        self.write_notebook_file(&file)
    }

    /// Deleting never destroys data: things move to `<library>/.trash/`.
    fn trash(&self, src: &Path, label: &str) -> Result<()> {
        let dir = self.root.join(TRASH_DIR);
        fs::create_dir_all(&dir)?;
        let dest = dir.join(format!("{}-{}-{}", now_ms(), label, &new_id()[..8]));
        fs::rename(src, dest)?;
        Ok(())
    }

    pub(crate) fn notebook_ids(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if check_id(name).is_ok() && entry.path().join("notebook.json").is_file() {
                ids.push(name.to_string());
            }
        }
        Ok(ids)
    }

    // ---- notebooks -----------------------------------------------------------

    /// Notebooks that fail to load (corrupt, or from a newer version) are
    /// left out rather than failing the whole listing.
    pub fn list_notebooks(&self) -> Result<Vec<NotebookSummary>> {
        let mut out: Vec<NotebookSummary> = self
            .notebook_ids()?
            .iter()
            .filter_map(|id| self.read_notebook_file(id).ok())
            .map(|f| NotebookSummary {
                id: f.id,
                title: f.title,
                color: f.color,
                modified: f.modified,
            })
            .collect();
        out.sort_by_key(|n| n.title.to_lowercase());
        Ok(out)
    }

    pub fn create_notebook(&self, title: &str) -> Result<NotebookTree> {
        let count = self.notebook_ids()?.len();
        let now = now_ms();
        let file = NotebookFile {
            format: FORMAT_VERSION,
            id: new_id(),
            title: title_or(title, "Untitled notebook"),
            color: SECTION_COLORS[count % SECTION_COLORS.len()].to_string(),
            created: now,
            modified: now,
            sections: Vec::new(),
        };
        let dir = self.nb_dir(&file.id)?;
        fs::create_dir_all(dir.join("sections"))?;
        fs::create_dir_all(dir.join("assets"))?;
        self.write_notebook_file(&file)?;
        self.get_notebook(&file.id)
    }

    pub fn get_notebook(&self, nb: &str) -> Result<NotebookTree> {
        let file = self.read_notebook_file(nb)?;
        let sections = file
            .sections
            .iter()
            .filter_map(|sec| self.read_section(nb, sec).ok())
            .collect();
        Ok(NotebookTree {
            id: file.id,
            title: file.title,
            color: file.color,
            sections,
        })
    }

    pub fn rename_notebook(&self, nb: &str, title: &str) -> Result<()> {
        let mut file = self.read_notebook_file(nb)?;
        file.title = title_or(title, "Untitled notebook");
        file.modified = now_ms();
        self.write_notebook_file(&file)
    }

    pub fn delete_notebook(&self, nb: &str) -> Result<()> {
        self.read_notebook_file(nb)?;
        self.trash(&self.nb_dir(nb)?, &format!("notebook-{nb}"))
    }

    // ---- sections ------------------------------------------------------------

    pub fn create_section(&self, nb: &str, title: &str) -> Result<SectionFile> {
        let mut file = self.read_notebook_file(nb)?;
        let sec = SectionFile {
            id: new_id(),
            title: title_or(title, "New section"),
            color: SECTION_COLORS[file.sections.len() % SECTION_COLORS.len()].to_string(),
            pages: Vec::new(),
        };
        fs::create_dir_all(self.sec_dir(nb, &sec.id)?.join("pages"))?;
        self.write_section(nb, &sec)?;
        file.sections.push(sec.id.clone());
        file.modified = now_ms();
        self.write_notebook_file(&file)?;
        Ok(sec)
    }

    /// Add a whole section in one go, keeping each page's original
    /// timestamps. Used by importers. Pages are written first and the
    /// section is only linked into the notebook once everything is on disk,
    /// so a failure part-way leaves the notebook exactly as it was.
    pub fn import_section(
        &self,
        nb: &str,
        title: &str,
        color: Option<&str>,
        pages: Vec<NewPage>,
    ) -> Result<SectionFile> {
        let mut file = self.read_notebook_file(nb)?;
        let color = match color {
            Some(c) if check_color(c).is_ok() => c.to_lowercase(),
            _ => SECTION_COLORS[file.sections.len() % SECTION_COLORS.len()].to_string(),
        };
        let mut sec = SectionFile {
            id: new_id(),
            title: title_or(title, "Imported section"),
            color,
            pages: Vec::with_capacity(pages.len()),
        };
        fs::create_dir_all(self.sec_dir(nb, &sec.id)?.join("pages"))?;
        for new in pages {
            let mut page = Page {
                id: new_id(),
                title: clean_title(&new.title),
                created: new.created,
                modified: new.modified,
                reflow: true,
                rules: None,
                color: None,
                blocks: new.blocks,
            };
            for b in &page.blocks {
                check_id(b.id())?;
            }
            sanitise_blocks(&mut page.blocks);
            write_json(&self.page_file(nb, &sec.id, &page.id)?, &page)?;
            sec.pages.push(PageEntry {
                id: page.id,
                title: page.title,
                level: new.level.min(MAX_PAGE_LEVEL),
                modified: page.modified,
            });
        }
        normalise_levels(&mut sec.pages);
        self.write_section(nb, &sec)?;
        file.sections.push(sec.id.clone());
        file.modified = now_ms();
        self.write_notebook_file(&file)?;
        Ok(sec)
    }

    pub fn update_section(
        &self,
        nb: &str,
        sec: &str,
        title: Option<&str>,
        color: Option<&str>,
    ) -> Result<SectionFile> {
        let mut section = self.read_section(nb, sec)?;
        if let Some(t) = title {
            section.title = title_or(t, "New section");
        }
        if let Some(c) = color {
            check_color(c)?;
            section.color = c.to_lowercase();
        }
        self.write_section(nb, &section)?;
        self.touch(nb)?;
        Ok(section)
    }

    pub fn delete_section(&self, nb: &str, sec: &str) -> Result<()> {
        let mut file = self.read_notebook_file(nb)?;
        let dir = self.sec_dir(nb, sec)?;
        if !file.sections.iter().any(|s| s == sec) {
            return Err(Error::NotFound("section".into()));
        }
        file.sections.retain(|s| s != sec);
        file.modified = now_ms();
        self.write_notebook_file(&file)?;
        if dir.exists() {
            self.trash(&dir, &format!("section-{sec}"))?;
        }
        Ok(())
    }

    pub fn set_section_order(&self, nb: &str, order: &[String]) -> Result<()> {
        let mut file = self.read_notebook_file(nb)?;
        let current: Vec<&str> = file.sections.iter().map(String::as_str).collect();
        let requested: Vec<&str> = order.iter().map(String::as_str).collect();
        if !is_permutation(&current, &requested) {
            return Err(Error::Invalid(
                "section order does not match the notebook".into(),
            ));
        }
        file.sections = order.to_vec();
        file.modified = now_ms();
        self.write_notebook_file(&file)
    }

    // ---- pages ---------------------------------------------------------------

    /// Create an empty page. With `after`, it is placed directly below that
    /// page at the same indent; otherwise at the end of the section.
    pub fn create_page(
        &self,
        nb: &str,
        sec: &str,
        title: &str,
        after: Option<&str>,
    ) -> Result<Page> {
        let mut section = self.read_section(nb, sec)?;
        let now = now_ms();
        let page = Page {
            id: new_id(),
            title: clean_title(title),
            created: now,
            modified: now,
            reflow: false,
            rules: None,
            color: None,
            blocks: Vec::new(),
        };
        write_json(&self.page_file(nb, sec, &page.id)?, &page)?;
        let anchor = after.and_then(|a| section.pages.iter().position(|p| p.id == a));
        let (index, level) = match anchor {
            Some(i) => (i + 1, section.pages[i].level),
            None => (section.pages.len(), 0),
        };
        section.pages.insert(
            index,
            PageEntry {
                id: page.id.clone(),
                title: page.title.clone(),
                level,
                modified: now,
            },
        );
        normalise_levels(&mut section.pages);
        self.write_section(nb, &section)?;
        self.touch(nb)?;
        Ok(page)
    }

    /// Load a page. Its HTML is sanitised again on the way out, so the UI can
    /// trust what it receives even if the files were edited or synced in.
    pub fn get_page(&self, nb: &str, sec: &str, page: &str) -> Result<Page> {
        let mut p = self.read_page_file(nb, sec, page)?;
        p.id = page.to_string();
        sanitise_page(&mut p);
        Ok(p)
    }

    pub fn save_page(&self, nb: &str, sec: &str, mut page: Page) -> Result<PageEntry> {
        let mut section = self.read_section(nb, sec)?;
        let path = self.page_file(nb, sec, &page.id)?;
        let index = section
            .pages
            .iter()
            .position(|p| p.id == page.id)
            .ok_or_else(|| Error::NotFound("page".into()))?;

        for b in &page.blocks {
            check_id(b.id())?;
        }
        sanitise_page(&mut page);
        page.title = clean_title(&page.title);
        let now = now_ms();
        page.modified = now;
        if let Ok(existing) = self.read_page_file(nb, sec, &page.id) {
            page.created = existing.created;
        }
        write_json(&path, &page)?;

        let entry = &mut section.pages[index];
        entry.title = page.title.clone();
        entry.modified = now;
        let entry = entry.clone();
        self.write_section(nb, &section)?;
        self.touch(nb)?;
        Ok(entry)
    }

    pub fn delete_page(&self, nb: &str, sec: &str, page: &str) -> Result<()> {
        let mut section = self.read_section(nb, sec)?;
        let path = self.page_file(nb, sec, page)?;
        if !section.pages.iter().any(|p| p.id == page) {
            return Err(Error::NotFound("page".into()));
        }
        section.pages.retain(|p| p.id != page);
        normalise_levels(&mut section.pages);
        self.write_section(nb, &section)?;
        if path.exists() {
            self.trash(&path, &format!("page-{page}.json"))?;
        }
        self.touch(nb)
    }

    pub fn set_page_order(
        &self,
        nb: &str,
        sec: &str,
        order: &[PageOrder],
    ) -> Result<Vec<PageEntry>> {
        let mut section = self.read_section(nb, sec)?;
        let current: Vec<&str> = section.pages.iter().map(|p| p.id.as_str()).collect();
        let requested: Vec<&str> = order.iter().map(|p| p.id.as_str()).collect();
        if !is_permutation(&current, &requested) {
            return Err(Error::Invalid(
                "page order does not match the section".into(),
            ));
        }
        let mut pages: Vec<PageEntry> = order
            .iter()
            .map(|o| {
                let mut e = section
                    .pages
                    .iter()
                    .find(|p| p.id == o.id)
                    .cloned()
                    .expect("checked by is_permutation");
                e.level = o.level.min(MAX_PAGE_LEVEL);
                e
            })
            .collect();
        normalise_levels(&mut pages);
        section.pages = pages;
        self.write_section(nb, &section)?;
        self.touch(nb)?;
        Ok(section.pages)
    }

    /// Move a page to the end of another section in the same notebook.
    pub fn move_page(&self, nb: &str, from: &str, page: &str, to: &str) -> Result<()> {
        if from == to {
            return Ok(());
        }
        let mut src = self.read_section(nb, from)?;
        let mut dst = self.read_section(nb, to)?;
        let index = src
            .pages
            .iter()
            .position(|p| p.id == page)
            .ok_or_else(|| Error::NotFound("page".into()))?;
        let from_path = self.page_file(nb, from, page)?;
        let to_path = self.page_file(nb, to, page)?;
        fs::create_dir_all(to_path.parent().expect("page path has a parent"))?;
        fs::rename(&from_path, &to_path)?;

        let mut entry = src.pages.remove(index);
        entry.level = 0;
        dst.pages.push(entry);
        normalise_levels(&mut src.pages);
        // Destination first: if the second write fails the page is listed
        // twice rather than not at all.
        self.write_section(nb, &dst)?;
        self.write_section(nb, &src)?;
        self.touch(nb)
    }

    // ---- assets --------------------------------------------------------------

    /// Store an image in the notebook and return its asset name. The type is
    /// detected from the bytes; identical images are stored once.
    pub fn save_asset(&self, nb: &str, bytes: &[u8]) -> Result<String> {
        self.read_notebook_file(nb)?;
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(Error::InvalidAsset("image is larger than 25 MB".into()));
        }
        let ext = sniff_image(bytes)
            .ok_or_else(|| Error::InvalidAsset("not a PNG, JPEG, GIF or WebP image".into()))?;
        let hash: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let name = format!("{hash}.{ext}");
        let path = self.nb_dir(nb)?.join("assets").join(&name);
        if !path.exists() {
            write_atomic(&path, bytes)?;
        }
        Ok(name)
    }

    pub fn read_asset(&self, nb: &str, name: &str) -> Result<Vec<u8>> {
        check_asset(name)?;
        let path = self.nb_dir(nb)?.join("assets").join(name);
        fs::read(path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => Error::NotFound("image".into()),
            _ => Error::Io(e),
        })
    }
}

fn finite(v: f64, min: f64, max: f64) -> f64 {
    if v.is_finite() {
        v.clamp(min, max)
    } else {
        min
    }
}

/// Clean note HTML, bound geometry, and drop blocks that could not be valid.
fn sanitise_blocks(blocks: &mut Vec<Block>) {
    const EDGE: f64 = 100_000.0;
    blocks.retain_mut(|b| match b {
        Block::Text { x, y, w, html, .. } => {
            *x = finite(*x, 0.0, EDGE);
            *y = finite(*y, 0.0, EDGE);
            *w = finite(*w, 60.0, 4000.0);
            *html = html::clean(html);
            true
        }
        Block::Image {
            x, y, w, h, asset, ..
        } => {
            *x = finite(*x, 0.0, EDGE);
            *y = finite(*y, 0.0, EDGE);
            *w = finite(*w, 16.0, 8000.0);
            *h = finite(*h, 16.0, 8000.0);
            check_asset(asset).is_ok()
        }
        Block::Ink {
            x,
            y,
            w,
            h,
            strokes,
            ..
        } => {
            *x = finite(*x, 0.0, EDGE);
            *y = finite(*y, 0.0, EDGE);
            *w = finite(*w, 1.0, 20_000.0);
            *h = finite(*h, 1.0, 20_000.0);
            strokes.truncate(MAX_STROKES);
            strokes.retain_mut(|s| {
                s.points.truncate(MAX_STROKE_POINTS);
                for p in &mut s.points {
                    for v in p.iter_mut() {
                        // One decimal place is finer than any screen shows.
                        let bounded = if v.is_finite() {
                            v.clamp(-20_000.0, 40_000.0)
                        } else {
                            0.0
                        };
                        *v = (bounded * 10.0).round() / 10.0;
                    }
                }
                s.width = if s.width.is_finite() {
                    s.width.clamp(0.5, 80.0)
                } else {
                    2.0
                };
                s.opacity = if s.opacity.is_finite() {
                    s.opacity.clamp(0.05, 1.0)
                } else {
                    1.0
                };
                s.color = s.color.to_lowercase();
                !s.points.is_empty() && check_color(&s.color).is_ok()
            });
            !strokes.is_empty()
        }
    });
}

/// Everything a page carries besides its title and dates.
fn sanitise_page(page: &mut Page) {
    sanitise_blocks(&mut page.blocks);
    page.rules = page
        .rules
        .take()
        .filter(|r| matches!(r.as_str(), "ruled" | "grid"));
    page.color = page
        .color
        .take()
        .map(|c| c.to_lowercase())
        .filter(|c| check_color(c).is_ok());
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

    fn lib() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path().join("library")).unwrap();
        (dir, lib)
    }

    fn text(id: &str, html: &str) -> Block {
        Block::Text {
            id: id.into(),
            x: 10.0,
            y: 20.0,
            w: 300.0,
            html: html.into(),
        }
    }

    #[test]
    fn notebook_section_page_round_trip() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("  Work\nnotes ").unwrap();
        assert_eq!(nb.title, "Work notes");
        let sec = lib.create_section(&nb.id, "Meetings").unwrap();
        let mut page = lib.create_page(&nb.id, &sec.id, "", None).unwrap();
        page.title = "Kickoff".into();
        page.blocks = vec![text("b1", "<p>Agenda<script>bad()</script></p>")];
        let entry = lib.save_page(&nb.id, &sec.id, page.clone()).unwrap();
        assert_eq!(entry.title, "Kickoff");

        let loaded = lib.get_page(&nb.id, &sec.id, &page.id).unwrap();
        assert_eq!(loaded.created, page.created);
        assert_eq!(loaded.blocks, vec![text("b1", "<p>Agenda</p>")]);

        let tree = lib.get_notebook(&nb.id).unwrap();
        assert_eq!(tree.sections.len(), 1);
        assert_eq!(tree.sections[0].pages[0].title, "Kickoff");
        assert_eq!(lib.list_notebooks().unwrap().len(), 1);
    }

    #[test]
    fn reopening_the_library_sees_the_same_data() {
        let (d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let sec = lib.create_section(&nb.id, "S").unwrap();
        lib.create_page(&nb.id, &sec.id, "P", None).unwrap();
        let again = Library::open(d.path().join("library")).unwrap();
        let tree = again.get_notebook(&nb.id).unwrap();
        assert_eq!(tree.sections[0].pages[0].title, "P");
    }

    #[test]
    fn ids_cannot_escape_the_library() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        for bad in ["..", "../x", "a/b", "", "a.b", "a\\b"] {
            assert!(
                matches!(lib.get_notebook(bad), Err(Error::InvalidId(_))),
                "{bad}"
            );
            assert!(
                matches!(lib.get_page(&nb.id, bad, "p"), Err(Error::InvalidId(_))),
                "{bad}"
            );
        }
        assert!(matches!(
            lib.read_asset(&nb.id, "../notebook.json"),
            Err(Error::InvalidAsset(_))
        ));
    }

    #[test]
    fn saving_requires_a_known_page() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let sec = lib.create_section(&nb.id, "S").unwrap();
        let ghost = Page {
            id: "ghost".into(),
            title: "x".into(),
            created: 0,
            modified: 0,
            reflow: false,
            rules: None,
            color: None,
            blocks: vec![],
        };
        assert!(matches!(
            lib.save_page(&nb.id, &sec.id, ghost),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn page_order_levels_and_insert_after() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let sec = lib.create_section(&nb.id, "S").unwrap();
        let a = lib.create_page(&nb.id, &sec.id, "a", None).unwrap();
        let b = lib.create_page(&nb.id, &sec.id, "b", None).unwrap();
        let c = lib.create_page(&nb.id, &sec.id, "c", Some(&a.id)).unwrap();
        let ids = |lib: &Library| -> Vec<(String, u8)> {
            lib.get_notebook(&nb.id).unwrap().sections[0]
                .pages
                .iter()
                .map(|p| (p.title.clone(), p.level))
                .collect()
        };
        assert_eq!(
            ids(&lib),
            [("a".into(), 0), ("c".into(), 0), ("b".into(), 0)]
        );

        // Levels are clamped: the first page cannot be a subpage and nothing
        // can skip a level.
        let order = vec![
            PageOrder {
                id: b.id.clone(),
                level: 2,
            },
            PageOrder {
                id: a.id.clone(),
                level: 2,
            },
            PageOrder {
                id: c.id.clone(),
                level: 9,
            },
        ];
        lib.set_page_order(&nb.id, &sec.id, &order).unwrap();
        assert_eq!(
            ids(&lib),
            [("b".into(), 0), ("a".into(), 1), ("c".into(), 2)]
        );

        let short = vec![PageOrder {
            id: a.id.clone(),
            level: 0,
        }];
        assert!(lib.set_page_order(&nb.id, &sec.id, &short).is_err());

        lib.delete_page(&nb.id, &sec.id, &b.id).unwrap();
        assert_eq!(ids(&lib), [("a".into(), 0), ("c".into(), 1)]);
    }

    #[test]
    fn deleting_moves_to_trash() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let sec = lib.create_section(&nb.id, "S").unwrap();
        let page = lib.create_page(&nb.id, &sec.id, "P", None).unwrap();
        lib.delete_page(&nb.id, &sec.id, &page.id).unwrap();
        lib.delete_section(&nb.id, &sec.id).unwrap();
        lib.delete_notebook(&nb.id).unwrap();
        assert!(lib.list_notebooks().unwrap().is_empty());
        let trashed = fs::read_dir(lib.root().join(TRASH_DIR)).unwrap().count();
        assert_eq!(trashed, 3);
    }

    #[test]
    fn sections_reorder_and_recolour() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let s1 = lib.create_section(&nb.id, "one").unwrap();
        let s2 = lib.create_section(&nb.id, "two").unwrap();
        assert_ne!(s1.color, s2.color);
        lib.set_section_order(&nb.id, &[s2.id.clone(), s1.id.clone()])
            .unwrap();
        assert!(lib
            .set_section_order(&nb.id, &[s2.id.clone(), s2.id.clone()])
            .is_err());
        lib.update_section(&nb.id, &s1.id, Some("uno"), Some("#ABCDEF"))
            .unwrap();
        assert!(lib
            .update_section(&nb.id, &s1.id, None, Some("red"))
            .is_err());
        let tree = lib.get_notebook(&nb.id).unwrap();
        let titles: Vec<_> = tree.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["two", "uno"]);
        assert_eq!(tree.sections[1].color, "#abcdef");
    }

    #[test]
    fn pages_move_between_sections() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let s1 = lib.create_section(&nb.id, "one").unwrap();
        let s2 = lib.create_section(&nb.id, "two").unwrap();
        let page = lib.create_page(&nb.id, &s1.id, "P", None).unwrap();
        lib.move_page(&nb.id, &s1.id, &page.id, &s2.id).unwrap();
        let tree = lib.get_notebook(&nb.id).unwrap();
        assert!(tree.sections[0].pages.is_empty());
        assert_eq!(tree.sections[1].pages[0].id, page.id);
        assert!(lib.get_page(&nb.id, &s2.id, &page.id).is_ok());
        assert!(lib.get_page(&nb.id, &s1.id, &page.id).is_err());
    }

    #[test]
    fn assets_are_content_addressed_and_type_checked() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let name = lib.save_asset(&nb.id, PNG).unwrap();
        assert!(name.ends_with(".png"));
        assert_eq!(lib.save_asset(&nb.id, PNG).unwrap(), name);
        assert_eq!(lib.read_asset(&nb.id, &name).unwrap(), PNG);
        assert!(lib.save_asset(&nb.id, b"<svg onload=alert(1)>").is_err());
    }

    #[test]
    fn bad_blocks_are_repaired_or_dropped() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let sec = lib.create_section(&nb.id, "S").unwrap();
        let mut page = lib.create_page(&nb.id, &sec.id, "P", None).unwrap();
        page.blocks = vec![
            Block::Text {
                id: "t".into(),
                x: f64::NAN,
                y: -5.0,
                w: 1.0,
                html: "x".into(),
            },
            Block::Image {
                id: "i".into(),
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
                asset: "../../etc/passwd".into(),
                alt: String::new(),
            },
        ];
        lib.save_page(&nb.id, &sec.id, page.clone()).unwrap();
        let loaded = lib.get_page(&nb.id, &sec.id, &page.id).unwrap();
        assert_eq!(
            loaded.blocks,
            vec![Block::Text {
                id: "t".into(),
                x: 0.0,
                y: 0.0,
                w: 60.0,
                html: "x".into()
            }]
        );
    }

    #[test]
    fn import_section_keeps_timestamps_and_flags_reflow() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let asset = lib.save_asset(&nb.id, PNG).unwrap();
        let html = format!(
            r#"<div>see <img data-asset="{asset}" width="10" height="5" src="http://x/y.png" onerror="x()"></div>"#
        );
        let pages = vec![
            NewPage {
                title: "First".into(),
                level: 3,
                created: 1000,
                modified: 2000,
                blocks: vec![text("b1", &html)],
            },
            NewPage {
                title: "Child".into(),
                level: 9,
                created: 3000,
                modified: 4000,
                blocks: vec![],
            },
        ];
        let sec = lib
            .import_section(&nb.id, " Old notes ", Some("#AA00FF"), pages)
            .unwrap();
        assert_eq!(
            (sec.title.as_str(), sec.color.as_str()),
            ("Old notes", "#aa00ff")
        );
        assert_eq!(
            sec.pages.iter().map(|p| p.level).collect::<Vec<_>>(),
            [0, 1]
        );
        assert_eq!(lib.get_notebook(&nb.id).unwrap().sections[0].id, sec.id);

        let page = lib.get_page(&nb.id, &sec.id, &sec.pages[0].id).unwrap();
        assert_eq!(
            (page.created, page.modified, page.reflow),
            (1000, 2000, true)
        );
        let Block::Text { html, .. } = &page.blocks[0] else {
            panic!()
        };
        assert_eq!(
            html,
            &format!(r#"<div>see <img data-asset="{asset}" width="10" height="5"></div>"#)
        );

        // Saving from the interface clears the flag for good.
        let mut edited = page.clone();
        edited.reflow = false;
        lib.save_page(&nb.id, &sec.id, edited).unwrap();
        let raw = fs::read_to_string(
            lib.root()
                .join(&nb.id)
                .join("sections")
                .join(&sec.id)
                .join("pages")
                .join(format!("{}.json", page.id)),
        )
        .unwrap();
        assert!(!raw.contains("reflow"));
        assert!(lib.search("see", 10).unwrap().len() == 1);
    }

    #[test]
    fn ink_page_colour_and_rule_lines_round_trip() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let sec = lib.create_section(&nb.id, "S").unwrap();
        let mut page = lib.create_page(&nb.id, &sec.id, "P", None).unwrap();
        let stroke = |points: Vec<[f32; 2]>, color: &str, width: f32, opacity: f32| Stroke {
            points,
            color: color.into(),
            width,
            opacity,
        };
        page.rules = Some("grid".into());
        page.color = Some("#FFF2CC".into());
        page.blocks = vec![
            Block::Ink {
                id: "ink1".into(),
                x: 10.0,
                y: 20.0,
                w: 100.0,
                h: 50.0,
                strokes: vec![
                    stroke(vec![[0.0, 0.0], [12.3456, f32::NAN]], "#FF0000", 2.5, 1.0),
                    stroke(vec![[1.0, 1.0]], "#ffee00", 500.0, 0.4),
                    stroke(vec![], "#000000", 2.0, 1.0),
                    stroke(vec![[1.0, 1.0]], "javascript:alert(1)", 2.0, 1.0),
                ],
            },
            Block::Ink {
                id: "empty".into(),
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
                strokes: vec![],
            },
        ];
        lib.save_page(&nb.id, &sec.id, page.clone()).unwrap();
        let loaded = lib.get_page(&nb.id, &sec.id, &page.id).unwrap();
        assert_eq!(loaded.rules.as_deref(), Some("grid"));
        assert_eq!(loaded.color.as_deref(), Some("#fff2cc"));
        assert_eq!(
            loaded.blocks,
            vec![Block::Ink {
                id: "ink1".into(),
                x: 10.0,
                y: 20.0,
                w: 100.0,
                h: 50.0,
                strokes: vec![
                    stroke(vec![[0.0, 0.0], [12.3, 0.0]], "#ff0000", 2.5, 1.0),
                    stroke(vec![[1.0, 1.0]], "#ffee00", 80.0, 0.4),
                ],
            }]
        );
        // Opacity is only written when it is not the default.
        let raw = fs::read_to_string(lib.page_file(&nb.id, &sec.id, &page.id).unwrap()).unwrap();
        assert_eq!(raw.matches("\"opacity\"").count(), 1);

        let mut odd = loaded.clone();
        odd.rules = Some("../../etc".into());
        odd.color = Some("url(x)".into());
        lib.save_page(&nb.id, &sec.id, odd).unwrap();
        let loaded = lib.get_page(&nb.id, &sec.id, &page.id).unwrap();
        assert_eq!((loaded.rules, loaded.color), (None, None));
    }

    #[test]
    fn newer_formats_are_refused_not_mangled() {
        let (_d, lib) = lib();
        let nb = lib.create_notebook("A").unwrap();
        let path = lib.root().join(&nb.id).join("notebook.json");
        let raw = fs::read_to_string(&path)
            .unwrap()
            .replace("\"format\": 1", "\"format\": 99");
        fs::write(&path, raw).unwrap();
        assert!(matches!(
            lib.get_notebook(&nb.id),
            Err(Error::UnsupportedFormat(99))
        ));
        assert!(lib.list_notebooks().unwrap().is_empty());
    }
}
