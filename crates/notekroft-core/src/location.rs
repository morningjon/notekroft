//! Where the notes folder is: remembering the user's choice, working out
//! which folder to open at start-up, and moving a library from one place to
//! another without putting any notes at risk.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::store::write_atomic;

/// Folder name used when notes are put inside a folder that holds other things.
pub const FOLDER_NAME: &str = "NoteKroft";
const TRASH_DIR: &str = ".trash";
/// Files that operating systems scatter about; a folder holding only these
/// is still empty as far as a person is concerned.
const CLUTTER: [&str; 4] = [".DS_Store", "Thumbs.db", "desktop.ini", ".directory"];

fn problem(message: impl Into<String>) -> Error {
    Error::Location(message.into())
}

// ---- the remembered choice ---------------------------------------------------

/// What NoteKroft remembers between runs. Kept in the app's own
/// configuration folder, never inside the notes folder, so the notes folder
/// can move freely.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The notes folder the user chose, if they have chosen one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<PathBuf>,
}

impl Settings {
    /// Read the settings file. A missing or unreadable file is simply no
    /// settings: the app must always be able to start.
    pub fn load(file: &Path) -> Settings {
        fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        write_atomic(file, &bytes)
    }
}

/// Why a particular notes folder is the one in use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Forced by an environment variable; the app cannot change it.
    Environment,
    /// Chosen by the user in the app.
    Chosen,
    /// Nothing chosen, so the standard place.
    Default,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub path: PathBuf,
    pub source: Source,
    /// Something the user should be told about how the folder was picked.
    pub notice: Option<String>,
}

/// Decide which notes folder to open at start-up.
///
/// An environment override wins, then the user's choice, then the default.
/// If the chosen folder is not there (an unplugged drive, a renamed folder)
/// the default is opened instead and the choice is kept, so the notes
/// reappear when the folder does. Nothing is created in the missing place:
/// making an empty library where the real one should be would look like
/// data loss.
pub fn resolve(environment: Option<PathBuf>, settings: &Settings, default: PathBuf) -> Resolved {
    if let Some(path) = environment {
        return Resolved {
            path,
            source: Source::Environment,
            notice: None,
        };
    }
    match &settings.library {
        Some(chosen) if chosen.is_dir() => Resolved {
            path: chosen.clone(),
            source: Source::Chosen,
            notice: None,
        },
        Some(chosen) => Resolved {
            notice: Some(format!(
                "Your notes folder could not be found:\n{}\n\nIf it is on a drive that is not connected, connect it and restart NoteKroft. Until then, the standard folder is being shown:\n{}",
                chosen.display(),
                default.display()
            )),
            path: default,
            source: Source::Default,
        },
        None => Resolved {
            path: default,
            source: Source::Default,
            notice: None,
        },
    }
}

// ---- looking at folders --------------------------------------------------------

fn entries(dir: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        out.push(entry?);
    }
    Ok(out)
}

fn is_clutter(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|n| CLUTTER.contains(&n))
}

/// True if the folder holds nothing a person would count as a file.
fn is_empty(dir: &Path) -> Result<bool> {
    Ok(entries(dir)?.iter().all(|e| is_clutter(&e.file_name())))
}

/// True for a folder holding a notebook (a `notebook.json` inside).
fn is_notebook(dir: &Path) -> bool {
    dir.join("notebook.json").is_file()
}

/// True if the folder already holds at least one notebook.
pub fn looks_like_library(dir: &Path) -> bool {
    entries(dir)
        .map(|list| list.iter().any(|e| is_notebook(&e.path())))
        .unwrap_or(false)
}

/// The parts of a notes folder that belong to NoteKroft: each notebook and
/// the trash. Anything else a person keeps beside them is not ours to move
/// or delete.
fn owned_entries(library: &Path) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = entries(library)?
        .into_iter()
        .map(|e| e.path())
        .filter(|p| is_notebook(p) || (p.is_dir() && p.file_name().is_some_and(|n| n == TRASH_DIR)))
        .collect();
    out.sort();
    Ok(out)
}

/// Turn the folder a person picked into the folder notes will live in.
///
/// An empty folder, or one that already holds notebooks, is used as it is.
/// A folder with other things in it (Documents, a cloud-sync folder) gets a
/// `NoteKroft` folder inside, so notes never mingle with unrelated files.
pub fn target_for(picked: &Path) -> Result<PathBuf> {
    if !picked.exists() {
        return Ok(picked.to_path_buf());
    }
    if !picked.is_dir() {
        return Err(problem("That is a file, not a folder."));
    }
    if is_empty(picked)? || looks_like_library(picked) {
        Ok(picked.to_path_buf())
    } else {
        Ok(picked.join(FOLDER_NAME))
    }
}

// ---- moving a library ----------------------------------------------------------

/// How much was copied when a library moved.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub notebooks: u64,
    pub files: u64,
    pub bytes: u64,
}

fn is_temporary(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|n| n.starts_with(".tmp-"))
}

/// Count the files under a folder, the way [`copy_tree`] would copy them.
fn tally_tree(dir: &Path, tally: &mut Tally) -> Result<()> {
    for entry in entries(dir)? {
        let kind = entry.file_type()?;
        if is_temporary(&entry.file_name()) {
            continue;
        }
        if kind.is_dir() {
            tally_tree(&entry.path(), tally)?;
        } else if kind.is_file() {
            tally.files += 1;
            tally.bytes += entry.metadata()?.len();
        }
    }
    Ok(())
}

/// Copy a folder and everything in it. Half-written temporary files and
/// links are left behind: neither is part of a library.
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in entries(from)? {
        let kind = entry.file_type()?;
        if is_temporary(&entry.file_name()) {
            continue;
        }
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn tally_owned(library: &Path) -> Result<Tally> {
    let mut tally = Tally::default();
    for path in owned_entries(library)? {
        if is_notebook(&path) {
            tally.notebooks += 1;
        }
        tally_tree(&path, &mut tally)?;
    }
    Ok(tally)
}

/// Copy a library's notebooks and trash into an empty folder, and check the
/// copy is complete.
///
/// This is the first half of a move and changes nothing at the source. If
/// anything goes wrong, whatever was copied is removed again and the error
/// is returned, leaving both folders as they were. Only once the caller has
/// switched over to the copy should it call [`remove_moved`].
pub fn copy_library(from: &Path, to: &Path) -> Result<Tally> {
    if !from.is_dir() {
        return Err(problem("The current notes folder could not be found."));
    }
    fs::create_dir_all(to)
        .map_err(|e| problem(format!("That folder could not be created or opened: {e}")))?;
    let source = fs::canonicalize(from)?;
    let dest = fs::canonicalize(to)?;
    if source == dest {
        return Err(problem("Your notes are already in that folder."));
    }
    if dest.starts_with(&source) {
        return Err(problem(
            "That folder is inside your current notes folder. Choose somewhere outside it.",
        ));
    }
    if !is_empty(&dest)? {
        return Err(problem(format!(
            "There are already files in {}. Choose an empty folder to move your notes into.",
            dest.display()
        )));
    }

    let expected = tally_owned(&source)?;
    let mut created: Vec<PathBuf> = Vec::new();
    let copied = (|| -> Result<()> {
        for path in owned_entries(&source)? {
            let target = dest.join(path.file_name().expect("entries have names"));
            created.push(target.clone());
            copy_tree(&path, &target)?;
        }
        let actual = tally_owned(&dest)?;
        if actual != expected {
            return Err(problem(format!(
                "The copy did not match the original ({} of {} files). Nothing was changed.",
                actual.files, expected.files
            )));
        }
        Ok(())
    })();
    if let Err(err) = copied {
        for path in created {
            let _ = fs::remove_dir_all(path);
        }
        return Err(err);
    }
    Ok(expected)
}

/// Remove a library's notebooks and trash from their old home after a
/// successful move, then the folder itself if nothing else is in it.
/// Returns true if nothing of the library was left behind. Files that were
/// never NoteKroft's are not touched.
pub fn remove_moved(old: &Path) -> bool {
    let Ok(owned) = owned_entries(old) else {
        return false;
    };
    let mut clean = true;
    for path in owned {
        clean &= fs::remove_dir_all(&path).is_ok();
    }
    if clean && is_empty(old).unwrap_or(false) {
        for entry in entries(old).unwrap_or_default() {
            let _ = fs::remove_file(entry.path());
        }
        let _ = fs::remove_dir(old);
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Block, Library};

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9];

    /// A library with a notebook, a page, a picture and something in the trash.
    fn sample(root: &Path) -> (Library, String, String, String) {
        let lib = Library::open(root).unwrap();
        let nb = lib.create_notebook("Work").unwrap();
        let sec = lib.create_section(&nb.id, "Notes").unwrap();
        let mut page = lib.create_page(&nb.id, &sec.id, "Plan", None).unwrap();
        let asset = lib.save_asset(&nb.id, PNG).unwrap();
        page.blocks = vec![Block::Image {
            id: "i".into(),
            x: 0.0,
            y: 0.0,
            w: 20.0,
            h: 20.0,
            asset,
            alt: String::new(),
        }];
        lib.save_page(&nb.id, &sec.id, page.clone()).unwrap();
        let gone = lib.create_page(&nb.id, &sec.id, "Old", None).unwrap();
        lib.delete_page(&nb.id, &sec.id, &gone.id).unwrap();
        (lib, nb.id, sec.id, page.id)
    }

    #[test]
    fn settings_round_trip_and_survive_damage() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config").join("settings.json");
        assert_eq!(Settings::load(&file), Settings::default());
        let chosen = Settings {
            library: Some(dir.path().join("Notes ✓")),
        };
        chosen.save(&file).unwrap();
        assert_eq!(Settings::load(&file), chosen);
        fs::write(&file, b"{ not json").unwrap();
        assert_eq!(Settings::load(&file), Settings::default());
    }

    #[test]
    fn start_up_prefers_environment_then_choice_then_default() {
        let dir = tempfile::tempdir().unwrap();
        let default = dir.path().join("default");
        let chosen = dir.path().join("chosen");
        fs::create_dir(&chosen).unwrap();
        let settings = Settings {
            library: Some(chosen.clone()),
        };

        let forced = resolve(Some(dir.path().join("env")), &settings, default.clone());
        assert_eq!((forced.source, forced.notice), (Source::Environment, None));

        let picked = resolve(None, &settings, default.clone());
        assert_eq!(
            (picked.path, picked.source, picked.notice),
            (chosen.clone(), Source::Chosen, None)
        );

        let plain = resolve(None, &Settings::default(), default.clone());
        assert_eq!(
            (plain.path, plain.source, plain.notice),
            (default.clone(), Source::Default, None)
        );

        // The chosen folder has gone (a drive unplugged): fall back, say so,
        // and do not conjure an empty library where the real one should be.
        fs::remove_dir(&chosen).unwrap();
        let missing = resolve(None, &settings, default.clone());
        assert_eq!((missing.path, missing.source), (default, Source::Default));
        assert!(missing.notice.unwrap().contains("could not be found"));
        assert!(!chosen.exists());
    }

    #[test]
    fn picked_folders_are_used_directly_only_when_that_is_safe() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty");
        fs::create_dir(&empty).unwrap();
        fs::write(empty.join(".DS_Store"), b"x").unwrap();
        assert_eq!(target_for(&empty).unwrap(), empty);

        let new = dir.path().join("not-made-yet");
        assert_eq!(target_for(&new).unwrap(), new);

        let documents = dir.path().join("Documents");
        fs::create_dir(&documents).unwrap();
        fs::write(documents.join("tax.pdf"), b"x").unwrap();
        assert_eq!(target_for(&documents).unwrap(), documents.join("NoteKroft"));

        let existing = dir.path().join("existing");
        sample(&existing);
        fs::write(existing.join("readme.txt"), b"x").unwrap();
        assert!(looks_like_library(&existing));
        assert_eq!(target_for(&existing).unwrap(), existing);

        assert!(target_for(&documents.join("tax.pdf")).is_err());
    }

    #[test]
    fn a_move_copies_everything_then_clears_the_old_folder() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("somewhere").join("new");
        let (_lib, nb, sec, page) = sample(&old);
        fs::write(old.join(&nb).join(".tmp-half-written"), b"junk").unwrap();

        let tally = copy_library(&old, &new).unwrap();
        assert_eq!(tally.notebooks, 1);
        // notebook.json, section.json, the page, the picture, the trashed page
        assert_eq!(tally.files, 5);
        assert!(old.join(&nb).is_dir(), "copying leaves the original alone");
        assert!(!new.join(&nb).join(".tmp-half-written").exists());

        let moved = Library::open(&new).unwrap();
        let loaded = moved.get_page(&nb, &sec, &page).unwrap();
        assert_eq!(loaded.title, "Plan");
        let Block::Image { asset, .. } = &loaded.blocks[0] else {
            panic!()
        };
        assert_eq!(moved.read_asset(&nb, asset).unwrap(), PNG);
        assert_eq!(fs::read_dir(new.join(".trash")).unwrap().count(), 1);

        assert!(remove_moved(&old));
        assert!(!old.exists(), "an emptied notes folder is removed");
        assert_eq!(moved.list_notebooks().unwrap().len(), 1);
    }

    #[test]
    fn other_peoples_files_are_neither_moved_nor_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        sample(&old);
        fs::write(old.join("holiday.jpg"), b"mine").unwrap();
        fs::create_dir(old.join("Receipts")).unwrap();

        copy_library(&old, &new).unwrap();
        assert!(!new.join("holiday.jpg").exists() && !new.join("Receipts").exists());
        assert!(remove_moved(&old));
        assert_eq!(fs::read(old.join("holiday.jpg")).unwrap(), b"mine");
        assert!(old.join("Receipts").is_dir());
        assert!(!looks_like_library(&old));
    }

    #[test]
    fn unsafe_moves_are_refused_and_change_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let (_lib, nb, _, _) = sample(&old);
        let before = tally_owned(&old).unwrap();
        let refused = |to: &Path, needle: &str| {
            let message = copy_library(&old, to).unwrap_err().to_string();
            assert!(message.contains(needle), "{message}");
        };

        refused(&old, "already in that folder");
        refused(
            &old.join(&nb).join("deeper"),
            "inside your current notes folder",
        );
        assert!(!old.join(&nb).join("deeper").join(&nb).exists());

        let busy = dir.path().join("busy");
        fs::create_dir(&busy).unwrap();
        fs::write(busy.join("important.txt"), b"keep").unwrap();
        refused(&busy, "already files in");
        assert_eq!(fs::read_dir(&busy).unwrap().count(), 1);

        let other = dir.path().join("other-library");
        sample(&other);
        refused(&other, "already files in");

        assert!(copy_library(&dir.path().join("nowhere"), &dir.path().join("x")).is_err());
        assert_eq!(tally_owned(&old).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_is_rolled_back() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        let (_lib, nb, sec, page) = sample(&old);
        // Make one page unreadable so the copy fails part-way through.
        let locked = old
            .join(&nb)
            .join("sections")
            .join(&sec)
            .join("pages")
            .join(format!("{page}.json"));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&locked).is_ok() {
            // Running as root: permissions do not bite, so this cannot be shown.
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }
        assert!(copy_library(&old, &new).is_err());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            is_empty(&new).unwrap(),
            "nothing is left in the destination"
        );
        assert!(Library::open(&old)
            .unwrap()
            .get_page(&nb, &sec, &page)
            .is_ok());
    }
}
