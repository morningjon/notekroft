//! Imports Microsoft OneNote files into a TwoNote library.
//!
//! Reading the `.one` and `.onetoc2` formats is done by the
//! [`onenote_parser`] crate, an independent implementation of Microsoft's
//! published MS-ONE and MS-ONESTORE specifications. This crate maps what it
//! reads onto TwoNote's own pages.
//!
//! The import is read-only with respect to the OneNote files and additive
//! with respect to the library: each OneNote section becomes a new TwoNote
//! section, and nothing already in the notebook is touched.

mod convert;
mod html;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use onenote_parser::section::{Section, SectionEntry};
use onenote_parser::Parser;
use serde::Serialize;
use twonote_core::Library;
use typed_path::{PathType, TypedPath};

use convert::Converter;

const MAX_WARNINGS: usize = 25;

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("{0}")]
    Library(#[from] twonote_core::Error),
    /// Nothing could be imported; the message says why for each file.
    #[error("{0}")]
    NothingImported(String),
}

/// Things OneNote pages can hold that TwoNote cannot show yet.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    /// Handwriting written in line with text.
    pub ink: usize,
    /// Attached files, including audio and video recordings.
    pub files: usize,
    /// Pictures with no data or in a format TwoNote does not display.
    pub pictures: usize,
    /// Content of a kind the parser did not recognise.
    pub other: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSection {
    pub id: String,
    pub title: String,
    pub pages: usize,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub sections: Vec<ImportedSection>,
    pub pages: usize,
    pub pictures: usize,
    /// Handwriting and drawings brought across.
    pub drawings: usize,
    pub skipped: Skipped,
    /// Human-readable notes about anything that did not go smoothly.
    pub warnings: Vec<String>,
}

impl ImportSummary {
    fn warn(&mut self, message: String) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(message);
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// OneDrive downloads name the notebook index just `.onetoc2`, which has no
/// extension as far as `Path` is concerned, so match on the whole name.
fn is_notebook_index(path: &Path) -> bool {
    file_name(path).to_ascii_lowercase().ends_with(".onetoc2")
}

fn section_color(section: &Section) -> Option<String> {
    let c = section.color()?;
    Some(format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b()))
}

fn native_paths() -> PathType {
    if cfg!(windows) {
        PathType::Windows
    } else {
        PathType::Unix
    }
}

struct Importer<'a> {
    converter: Converter<'a>,
    summary: ImportSummary,
}

impl Importer<'_> {
    fn section(&mut self, section: &Section, group: &[&str]) -> Result<(), twonote_core::Error> {
        let pages: Vec<_> = section
            .page_series()
            .iter()
            .flat_map(|series| series.pages())
            .map(|page| self.converter.page(page))
            .collect();
        for warning in section.report().warnings() {
            let message = match warning.page() {
                Some((_, title)) if !title.is_empty() => {
                    format!(
                        "{} (page \"{}\"): {}",
                        section.display_name(),
                        title,
                        warning.message()
                    )
                }
                _ => format!("{}: {}", section.display_name(), warning.message()),
            };
            self.summary.warn(message);
        }

        let mut title = group.join(" / ");
        if !title.is_empty() {
            title.push_str(" / ");
        }
        title.push_str(section.display_name());

        let count = pages.len();
        let stored = self.converter.lib.import_section(
            self.converter.notebook,
            &title,
            section_color(section).as_deref(),
            pages,
        )?;
        self.summary.pages += count;
        self.summary.sections.push(ImportedSection {
            id: stored.id,
            title: stored.title,
            pages: count,
        });
        Ok(())
    }

    fn entries<'e>(
        &mut self,
        entries: &'e [SectionEntry],
        group: &mut Vec<&'e str>,
    ) -> Result<(), twonote_core::Error> {
        for entry in entries {
            match entry {
                SectionEntry::Section(section) => self.section(section, group)?,
                SectionEntry::SectionGroup(g) => {
                    // OneNote keeps deleted pages in a hidden group.
                    if g.display_name().eq_ignore_ascii_case("OneNote_RecycleBin") {
                        continue;
                    }
                    group.push(g.display_name());
                    self.entries(g.entries(), group)?;
                    group.pop();
                }
            }
        }
        Ok(())
    }

    /// Import every section file in a notebook folder, treating subfolders
    /// as section groups. Used when a notebook index cannot say what it holds.
    fn folder(&mut self, dir: &Path, group: &mut Vec<String>, depth: usize) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = read.flatten().map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let name = file_name(&path);
            if path.is_dir() {
                if depth < 8 && !name.eq_ignore_ascii_case("OneNote_RecycleBin") {
                    group.push(name);
                    self.folder(&path, group, depth + 1);
                    group.pop();
                }
            } else if name.to_ascii_lowercase().ends_with(".one") {
                let parsed = path
                    .to_str()
                    .ok_or_else(|| "the file path is not valid text".to_string())
                    .and_then(|text| {
                        Parser::new()
                            .parse_section(TypedPath::new(text, native_paths()))
                            .map_err(|e| e.to_string())
                    });
                let refs: Vec<&str> = group.iter().map(String::as_str).collect();
                let result =
                    parsed.and_then(|s| self.section(&s, &refs).map_err(|e| e.to_string()));
                if let Err(reason) = result {
                    self.summary.warn(format!("Not imported: {name}: {reason}"));
                }
            }
        }
    }

    fn file(&mut self, path: &Path) -> Result<(), String> {
        let text = path
            .to_str()
            .ok_or_else(|| "the file path is not valid text".to_string())?;
        let typed = TypedPath::new(text, native_paths());
        let parser = Parser::new();

        if is_notebook_index(path) {
            let notebook = parser.parse_notebook(typed).map_err(|e| e.to_string())?;
            for warning in notebook.report().warnings() {
                self.summary.warn(warning.message().to_string());
            }
            let before = self.summary.sections.len();
            self.entries(notebook.entries(), &mut Vec::new())
                .map_err(|e| e.to_string())?;
            if self.summary.sections.len() == before {
                // Some indexes, notably from OneDrive downloads, list no
                // sections even though the files sit right beside them.
                if let Some(dir) = path.parent() {
                    self.folder(dir, &mut Vec::new(), 0);
                }
            }
            Ok(())
        } else {
            let section = parser.parse_section(typed).map_err(|e| e.to_string())?;
            self.section(&section, &[]).map_err(|e| e.to_string())
        }
    }
}

/// Import OneNote files into an existing notebook.
///
/// Each path may be a `.one` section file or a `.onetoc2` notebook index (in
/// which case every section beside it is imported). A file that cannot be
/// read is reported in the summary's warnings and the rest carry on; the call
/// fails only if nothing at all could be imported.
pub fn import_files(
    lib: &Library,
    notebook: &str,
    paths: &[impl AsRef<Path>],
) -> Result<ImportSummary, ImportError> {
    lib.get_notebook(notebook)?;
    let mut importer = Importer {
        converter: Converter {
            lib,
            notebook,
            pictures: 0,
            drawings: 0,
            skipped: Skipped::default(),
        },
        summary: ImportSummary::default(),
    };

    let mut failures = Vec::new();
    for path in paths {
        let path = path.as_ref();
        // The parser is defensive, but these are untrusted binary files:
        // contain any panic to the one file that caused it.
        let outcome = catch_unwind(AssertUnwindSafe(|| importer.file(path)))
            .unwrap_or_else(|_| Err("the file could not be understood".to_string()));
        if let Err(reason) = outcome {
            failures.push(format!("{}: {}", file_name(path), reason));
        }
    }

    let Importer {
        converter,
        mut summary,
    } = importer;
    if summary.sections.is_empty() {
        let detail = if failures.is_empty() {
            "No sections were found to import.".to_string()
        } else {
            failures.join("\n")
        };
        return Err(ImportError::NothingImported(detail));
    }
    for failure in failures {
        summary.warn(format!("Not imported: {failure}"));
    }
    summary.pictures = converter.pictures;
    summary.drawings = converter.drawings;
    summary.skipped = converter.skipped;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notebook_index_files_are_recognised_by_name() {
        for name in ["Open Notebook.onetoc2", ".onetoc2", "dir/.ONETOC2"] {
            assert!(is_notebook_index(Path::new(name)), "{name}");
        }
        for name in ["Notes.one", "onetoc2", "x.onetoc2.bak"] {
            assert!(!is_notebook_index(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn unreadable_files_fail_cleanly_and_change_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path().join("lib")).unwrap();
        let nb = lib.create_notebook("N").unwrap();
        let junk = dir.path().join("junk.one");
        std::fs::write(&junk, b"this is not a OneNote file").unwrap();
        let missing = dir.path().join("missing.one");

        let err = import_files(&lib, &nb.id, &[&junk, &missing]).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("junk.one") && message.contains("missing.one"),
            "{message}"
        );
        assert!(lib.get_notebook(&nb.id).unwrap().sections.is_empty());
        assert!(import_files(&lib, "no-such-notebook", &[&junk]).is_err());
    }
}
