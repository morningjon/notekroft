//! The desktop shell: a window plus a thin command layer over `notekroft-core`.
//!
//! Every command takes ids, never paths. The core validates those ids, so the
//! web view cannot read or write outside the notebook library. Where a path
//! is needed (importing a file, choosing the notes folder) the picker opens
//! here on the Rust side and the person at the keyboard chooses it.

// Choosing folders and importing files are desktop features for now, which
// leaves some imports and fields unused in the phone build.
#![cfg_attr(mobile, allow(unused_imports, unused_variables, dead_code))]

use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use notekroft_core::location::{self, Settings, Source, Tally};
use notekroft_core::{
    Library, NotebookSummary, NotebookTree, Page, PageEntry, PageOrder, SearchHit, SectionFile,
};
use notekroft_onenote::ImportSummary;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// One lock for the whole library: commands are read-modify-write on small
/// JSON files, and serialising them keeps two saves from interleaving.
struct AppState {
    lib: Mutex<Library>,
    /// Where the user's choice of notes folder is remembered.
    settings_file: PathBuf,
    /// The standard notes folder, used when nothing else is chosen.
    default_dir: PathBuf,
    /// True when an environment variable fixes the folder for this run.
    locked: bool,
    /// Something to tell the user once about how the folder was chosen.
    notice: Mutex<Option<String>>,
}

type Cmd<T> = Result<T, String>;

fn with<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Library) -> notekroft_core::Result<T>,
) -> Cmd<T> {
    let lib = state
        .lib
        .lock()
        .map_err(|_| "library lock poisoned".to_string())?;
    f(&lib).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryInfo {
    path: String,
    default_path: String,
    /// The folder cannot be changed here: an environment variable fixes it,
    /// or this is a phone, where notes live in the app's own storage.
    locked: bool,
    /// Running on a phone or tablet.
    mobile: bool,
    notice: Option<String>,
}

#[tauri::command]
async fn library_info(state: State<'_, AppState>) -> Cmd<LibraryInfo> {
    let notice = state.notice.lock().ok().and_then(|mut n| n.take());
    with(&state, |l| {
        Ok(LibraryInfo {
            path: l.root().display().to_string(),
            default_path: state.default_dir.display().to_string(),
            locked: state.locked,
            mobile: cfg!(mobile),
            notice,
        })
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryChange {
    path: String,
    old_path: String,
    /// Set when notes were moved: how much went across.
    moved: Option<Tally>,
    /// After a move, whether the old folder was fully cleared.
    old_cleared: bool,
    /// When switching folders, whether the new one already held notebooks.
    had_notebooks: bool,
}

/// Change where notes are kept. `mode` is `"move"` to take the current notes
/// along, or `"use"` to simply open a different folder and leave the current
/// one as it is. Returns `None` if the folder picker is cancelled.
///
/// A move copies everything, checks the copy, switches over, and only then
/// clears the old folder, so there is no moment at which the notes exist in
/// neither place.
#[tauri::command]
async fn choose_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Cmd<Option<LibraryChange>> {
    #[cfg(mobile)]
    {
        Err("On a phone or tablet, notes are kept in the app's own storage and cannot be moved from here.".into())
    }
    #[cfg(desktop)]
    {
        if state.locked {
            return Err(
                "The notes folder is set by the NOTEKROFT_LIBRARY environment variable, so it cannot be changed from here."
                    .into(),
            );
        }
        let moving = match mode.as_str() {
            "move" => true,
            "use" => false,
            _ => return Err("unknown mode".into()),
        };
        let title = if moving {
            "Move notes to this folder"
        } else {
            "Keep notes in this folder"
        };
        let Some(picked) = app
            .dialog()
            .file()
            .set_title(title)
            .blocking_pick_folder()
            .and_then(|folder| folder.into_path().ok())
        else {
            return Ok(None);
        };

        let fail = |e: notekroft_core::Error| e.to_string();
        let target = location::target_for(&picked).map_err(fail)?;
        let mut lib = state
            .lib
            .lock()
            .map_err(|_| "library lock poisoned".to_string())?;
        let old = lib.root().to_path_buf();
        let same = std::fs::canonicalize(&target).ok() == std::fs::canonicalize(&old).ok()
            && target.exists();
        if same {
            return Err("Your notes are already in that folder.".into());
        }

        let had_notebooks = location::looks_like_library(&target);
        let moved = if moving {
            Some(location::copy_library(&old, &target).map_err(fail)?)
        } else {
            None
        };
        let opened = Library::open(&target).map_err(fail).and_then(|new| {
            Settings {
                library: Some(target.clone()),
            }
            .save(&state.settings_file)
            .map_err(fail)
            .map(|()| new)
        });
        let new = match opened {
            Ok(new) => new,
            Err(err) => {
                // Could not switch over: take the copy away again so the old
                // folder remains the one and only home of the notes.
                if moving {
                    location::remove_moved(&target);
                }
                return Err(err);
            }
        };
        *lib = new;
        let old_cleared = moving && location::remove_moved(&old);
        Ok(Some(LibraryChange {
            path: target.display().to_string(),
            old_path: old.display().to_string(),
            moved,
            old_cleared,
            had_notebooks,
        }))
    }
}

#[tauri::command]
async fn list_notebooks(state: State<'_, AppState>) -> Cmd<Vec<NotebookSummary>> {
    with(&state, |l| l.list_notebooks())
}

#[tauri::command]
async fn create_notebook(state: State<'_, AppState>, title: String) -> Cmd<NotebookTree> {
    with(&state, |l| l.create_notebook(&title))
}

#[tauri::command]
async fn get_notebook(state: State<'_, AppState>, notebook: String) -> Cmd<NotebookTree> {
    with(&state, |l| l.get_notebook(&notebook))
}

#[tauri::command]
async fn rename_notebook(state: State<'_, AppState>, notebook: String, title: String) -> Cmd<()> {
    with(&state, |l| l.rename_notebook(&notebook, &title))
}

#[tauri::command]
async fn delete_notebook(state: State<'_, AppState>, notebook: String) -> Cmd<()> {
    with(&state, |l| l.delete_notebook(&notebook))
}

#[tauri::command]
async fn create_section(
    state: State<'_, AppState>,
    notebook: String,
    title: String,
) -> Cmd<SectionFile> {
    with(&state, |l| l.create_section(&notebook, &title))
}

#[tauri::command]
async fn update_section(
    state: State<'_, AppState>,
    notebook: String,
    section: String,
    title: Option<String>,
    color: Option<String>,
) -> Cmd<SectionFile> {
    with(&state, |l| {
        l.update_section(&notebook, &section, title.as_deref(), color.as_deref())
    })
}

#[tauri::command]
async fn delete_section(state: State<'_, AppState>, notebook: String, section: String) -> Cmd<()> {
    with(&state, |l| l.delete_section(&notebook, &section))
}

#[tauri::command]
async fn set_section_order(
    state: State<'_, AppState>,
    notebook: String,
    order: Vec<String>,
) -> Cmd<()> {
    with(&state, |l| l.set_section_order(&notebook, &order))
}

#[tauri::command]
async fn create_page(
    state: State<'_, AppState>,
    notebook: String,
    section: String,
    title: String,
    after: Option<String>,
) -> Cmd<Page> {
    with(&state, |l| {
        l.create_page(&notebook, &section, &title, after.as_deref())
    })
}

#[tauri::command]
async fn get_page(
    state: State<'_, AppState>,
    notebook: String,
    section: String,
    page: String,
) -> Cmd<Page> {
    with(&state, |l| l.get_page(&notebook, &section, &page))
}

#[tauri::command]
async fn save_page(
    state: State<'_, AppState>,
    notebook: String,
    section: String,
    page: Page,
) -> Cmd<PageEntry> {
    with(&state, |l| l.save_page(&notebook, &section, page))
}

#[tauri::command]
async fn delete_page(
    state: State<'_, AppState>,
    notebook: String,
    section: String,
    page: String,
) -> Cmd<()> {
    with(&state, |l| l.delete_page(&notebook, &section, &page))
}

#[tauri::command]
async fn set_page_order(
    state: State<'_, AppState>,
    notebook: String,
    section: String,
    order: Vec<PageOrder>,
) -> Cmd<Vec<PageEntry>> {
    with(&state, |l| l.set_page_order(&notebook, &section, &order))
}

#[tauri::command]
async fn move_page(
    state: State<'_, AppState>,
    notebook: String,
    from: String,
    page: String,
    to: String,
) -> Cmd<()> {
    with(&state, |l| l.move_page(&notebook, &from, &page, &to))
}

/// Images arrive base64-encoded; the core checks they really are images.
#[tauri::command]
async fn save_asset(state: State<'_, AppState>, notebook: String, data: String) -> Cmd<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    with(&state, |l| l.save_asset(&notebook, &bytes))
}

#[tauri::command]
async fn read_asset(
    state: State<'_, AppState>,
    notebook: String,
    name: String,
) -> Cmd<tauri::ipc::Response> {
    with(&state, |l| l.read_asset(&notebook, &name)).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Cmd<Vec<SearchHit>> {
    with(&state, |l| l.search(&query, 100))
}

/// Import OneNote files as new sections of a notebook.
///
/// The file picker is opened here, on the Rust side, so the web view never
/// supplies a path: it can only ask for an import, and the person at the
/// keyboard chooses what is read. Returns `None` if they cancel.
#[tauri::command]
async fn import_onenote(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    notebook: String,
) -> Cmd<Option<ImportSummary>> {
    #[cfg(mobile)]
    {
        Err("Importing OneNote files is not available on phones and tablets yet. Import on a computer instead.".into())
    }
    #[cfg(desktop)]
    {
        let picked = app
            .dialog()
            .file()
            .set_title("Import from OneNote")
            .add_filter("OneNote sections and notebooks", &["one", "onetoc2"])
            .blocking_pick_files();
        let paths: Vec<PathBuf> = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .collect();
        if paths.is_empty() {
            return Ok(None);
        }
        let lib = state
            .lib
            .lock()
            .map_err(|_| "library lock poisoned".to_string())?;
        notekroft_onenote::import_files(&lib, &notebook, &paths)
            .map(Some)
            .map_err(|e| e.to_string())
    }
}

/// The folder forced by an environment variable, if any. The app was briefly
/// called TwoNote, so the old variable name still works.
fn environment_dir() -> Option<PathBuf> {
    ["NOTEKROFT_LIBRARY", "TWONOTE_LIBRARY"]
        .into_iter()
        .find_map(|name| std::env::var_os(name).filter(|d| !d.is_empty()))
        .map(PathBuf::from)
}

/// The standard notes folder: `Documents/NoteKroft`, where notes are easy to
/// find, back up and sync. Anyone who used the app as TwoNote has notes in
/// `Documents/TwoNote`; those keep working where they are rather than
/// appearing to vanish.
///
/// On a phone the notes live in the app's own private storage, the one place
/// an app can always read and write without asking for wider access.
fn default_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(mobile)]
    let base = app.path().app_data_dir()?;
    #[cfg(desktop)]
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())?;
    let current = base.join(location::FOLDER_NAME);
    let former = base.join("TwoNote");
    if !current.exists() && former.is_dir() {
        return Ok(former);
    }
    Ok(current)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings_file = app.path().app_config_dir()?.join("settings.json");
            let default_dir = default_dir(app)?;
            // A phone has one notes folder and no way to choose another.
            let (environment, settings) = if cfg!(mobile) {
                (Some(default_dir.clone()), Settings::default())
            } else {
                (environment_dir(), Settings::load(&settings_file))
            };
            let resolved = location::resolve(environment, &settings, default_dir.clone());
            let lib = Library::open(&resolved.path)?;
            app.manage(AppState {
                lib: Mutex::new(lib),
                settings_file,
                default_dir,
                locked: resolved.source == Source::Environment,
                notice: Mutex::new(resolved.notice),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_info,
            choose_library,
            list_notebooks,
            create_notebook,
            get_notebook,
            rename_notebook,
            delete_notebook,
            create_section,
            update_section,
            delete_section,
            set_section_order,
            create_page,
            get_page,
            save_page,
            delete_page,
            set_page_order,
            move_page,
            save_asset,
            read_asset,
            search,
            import_onenote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NoteKroft");
}
