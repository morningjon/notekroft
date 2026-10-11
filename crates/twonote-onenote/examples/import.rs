//! Import OneNote files from the command line.
//!
//! ```sh
//! cargo run -p twonote-onenote --example import -- <library dir> <notebook title> <file.one | file.onetoc2>...
//! ```
//!
//! Creates the notebook in the library and imports every given file into it.
//! Point `TWONOTE_LIBRARY` at the same directory to look at the result in the
//! app.

use std::path::PathBuf;
use std::process::ExitCode;

use twonote_core::Library;
use twonote_onenote::import_files;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [library, title, files @ ..] = args.as_slice() else {
        eprintln!("usage: import <library dir> <notebook title> <file.one | file.onetoc2>...");
        return ExitCode::FAILURE;
    };
    if files.is_empty() {
        eprintln!("no files given");
        return ExitCode::FAILURE;
    }
    let run = || -> Result<(), Box<dyn std::error::Error>> {
        let lib = Library::open(library)?;
        let notebook = lib.create_notebook(title)?;
        let paths: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
        let summary = import_files(&lib, &notebook.id, &paths)?;
        for section in &summary.sections {
            println!("section  {} ({} pages)", section.title, section.pages);
        }
        println!(
            "imported {} sections, {} pages, {} pictures",
            summary.sections.len(),
            summary.pages,
            summary.pictures
        );
        let s = summary.skipped;
        println!(
            "skipped  {} ink drawings, {} attached files, {} pictures, {} other items",
            s.ink, s.files, s.pictures, s.other
        );
        for warning in &summary.warnings {
            println!("warning  {warning}");
        }
        Ok(())
    };
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("import failed: {err}");
            ExitCode::FAILURE
        }
    }
}
