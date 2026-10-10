//! The desktop shell: a window plus a thin command layer over `twonote-core`.
//!
//! Every command takes ids, never paths. The core validates those ids, so the
//! web view cannot read or write outside the notebook library.

use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use tauri::{Manager, State};
use twonote_core::{
    Library, NotebookSummary, NotebookTree, Page, PageEntry, PageOrder, SearchHit, SectionFile,
};

/// One lock for the whole library: commands are read-modify-write on small
/// JSON files, and serialising them keeps two saves from interleaving.
struct AppState {
    lib: Mutex<Library>,
}

type Cmd<T> = Result<T, String>;

fn with<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Library) -> twonote_core::Result<T>,
) -> Cmd<T> {
    let lib = state
        .lib
        .lock()
        .map_err(|_| "library lock poisoned".to_string())?;
    f(&lib).map_err(|e| e.to_string())
}

#[tauri::command]
async fn library_path(state: State<'_, AppState>) -> Cmd<String> {
    with(&state, |l| Ok(l.root().display().to_string()))
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

/// `TWONOTE_LIBRARY` wins; otherwise notebooks live in `Documents/TwoNote`
/// where they are easy to find, back up and sync.
fn library_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("TWONOTE_LIBRARY").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())?;
    Ok(base.join("TwoNote"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let lib = Library::open(library_dir(app)?)?;
            app.manage(AppState {
                lib: Mutex::new(lib),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_path,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running TwoNote");
}
