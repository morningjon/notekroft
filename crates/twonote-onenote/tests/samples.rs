//! Runs the importer over real OneNote files.
//!
//! TwoNote does not ship any `.one` files, so this test looks for them in the
//! directory named by `TWONOTE_ONE_SAMPLES` and is skipped when that is not
//! set. The parser project keeps a good collection:
//!
//! ```sh
//! git clone https://github.com/msiemens/onenote.rs /tmp/onenote.rs
//! TWONOTE_ONE_SAMPLES=/tmp/onenote.rs/crates/parser/tests/samples \
//!     cargo test -p twonote-onenote --test samples -- --nocapture
//! ```

use std::path::{Path, PathBuf};

use twonote_core::{html, Block, Library};
use twonote_onenote::import_files;

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("one"))
        {
            out.push(path);
        }
    }
}

#[test]
fn every_sample_imports_into_valid_pages() {
    let Some(dir) = std::env::var_os("TWONOTE_ONE_SAMPLES") else {
        eprintln!("TWONOTE_ONE_SAMPLES is not set; skipping the sample import test");
        return;
    };
    let mut files = Vec::new();
    collect(Path::new(&dir), &mut files);
    files.sort();
    assert!(!files.is_empty(), "no .one files found under {dir:?}");

    let tmp = tempfile::tempdir().unwrap();
    let lib = Library::open(tmp.path()).unwrap();
    let nb = lib.create_notebook("Samples").unwrap();

    let (mut imported, mut failed, mut pages, mut blocks, mut pictures) = (0, 0, 0, 0, 0);
    for file in &files {
        let name = file
            .strip_prefix(Path::new(&dir))
            .unwrap()
            .display()
            .to_string();
        // Git LFS pointers and other stubs are not OneNote files.
        if std::fs::metadata(file)
            .map(|m| m.len() < 1024)
            .unwrap_or(true)
        {
            eprintln!("skip  {name} (placeholder)");
            continue;
        }
        let summary = match import_files(&lib, &nb.id, &[file]) {
            Ok(summary) => summary,
            Err(err) => {
                failed += 1;
                eprintln!("FAIL  {name}: {err}");
                continue;
            }
        };
        imported += 1;
        pages += summary.pages;
        pictures += summary.pictures;
        eprintln!(
            "ok    {name}: {} pages, {} pictures, skipped {:?}, {} warnings",
            summary.pages,
            summary.pictures,
            summary.skipped,
            summary.warnings.len()
        );

        for section in &summary.sections {
            let tree = lib.get_notebook(&nb.id).unwrap();
            let stored = tree.sections.iter().find(|s| s.id == section.id).unwrap();
            assert_eq!(stored.pages.len(), section.pages, "{name}");
            for entry in &stored.pages {
                let page = lib.get_page(&nb.id, &section.id, &entry.id).unwrap();
                assert!(page.reflow, "{name}: imported pages ask for a reflow");
                assert!(page.created > 0 && page.modified >= 0, "{name}");
                for block in &page.blocks {
                    blocks += 1;
                    match block {
                        Block::Text {
                            html: text,
                            x,
                            y,
                            w,
                            ..
                        } => {
                            assert!(!text.is_empty(), "{name}: empty text block");
                            assert!(*x >= 0.0 && *y >= 0.0 && *w >= 60.0, "{name}: bad geometry");
                            // The importer must emit TwoNote's stored form
                            // directly: sanitising again is a no-op.
                            assert_eq!(&html::clean(text), text, "{name}: page {:?}", page.title);
                            assert!(
                                !text.contains('\u{fddf}') && !text.contains("HYPERLINK \""),
                                "{name}: field code leaked into page {:?}",
                                page.title
                            );
                        }
                        Block::Image { asset, w, h, .. } => {
                            assert!(*w >= 16.0 && *h >= 16.0, "{name}");
                            assert!(!lib.read_asset(&nb.id, asset).unwrap().is_empty(), "{name}");
                        }
                    }
                }
            }
        }
    }

    eprintln!("\n{imported} files imported, {failed} failed, {pages} pages, {blocks} blocks, {pictures} pictures");
    assert!(imported > 0, "nothing imported");
    assert_eq!(failed, 0, "some sample files failed to import");
    assert!(pages > 0 && blocks > 0);

    // Imported text is searchable like any other page.
    assert!(lib.search("the", 5).is_ok());
}
