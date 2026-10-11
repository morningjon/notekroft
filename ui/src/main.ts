import {
  createBackend,
  SECTION_COLORS,
  type NotebookSummary,
  type NotebookTree,
  type Page,
  type PageEntry,
  type Rules,
  type SearchHit,
  type Section,
} from './api';
import { Editor } from './editor';
import { Ribbon } from './ribbon';
import { buildTabs, type Theme } from './tabs';
import { choiceDialog, closeMenu, confirmDialog, h, infoDialog, promptText, showMenu, tableDialog, toast, type MenuItem } from './widgets';

declare const __APP_VERSION__: string;

const backend = createBackend();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  tabs: $('tabs'),
  ribbon: $('ribbon'),
  search: $<HTMLInputElement>('search'),
  searchBox: $('search-box'),
  results: $('search-results'),
  picker: $<HTMLButtonElement>('nb-picker'),
  nbTitle: $('nb-title'),
  sections: $('sections'),
  pages: $('pages'),
  addSection: $<HTMLButtonElement>('add-section'),
  addPage: $<HTMLButtonElement>('add-page'),
  scroller: $('editor'),
  page: $('page'),
  title: $<HTMLInputElement>('title'),
  stamp: $('stamp'),
  canvas: $('canvas'),
  empty: $('empty'),
  libPath: $<HTMLButtonElement>('lib-path'),
  saveState: $('save-state'),
  imageFile: $<HTMLInputElement>('image-file'),
};

const state = {
  notebooks: [] as NotebookSummary[],
  nb: null as NotebookTree | null,
  sectionId: null as string | null,
  page: null as Page | null,
};

/** Last page viewed in each section, so switching sections returns to it. */
const lastPage = new Map<string, string>();

function report(err: unknown) {
  console.error(err);
  toast(err instanceof Error ? err.message : String(err));
}

/** Run an async action from an event handler, surfacing any failure. */
const act = (fn: () => Promise<unknown> | void) => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(report);
  } catch (err) {
    report(err);
  }
};

const currentSection = (): Section | null =>
  state.nb?.sections.find((s) => s.id === state.sectionId) ?? null;

// ---- remembering where you were ---------------------------------------------

const LAST_KEY = 'notekroft.last';

function remember() {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ nb: state.nb?.id, section: state.sectionId, page: state.page?.id }));
  } catch {
    /* a convenience only */
  }
}

function recall(): { nb?: string; section?: string; page?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

// ---- saving -----------------------------------------------------------------

let dirty = false;
let saveTimer = 0;
let saving: Promise<void> = Promise.resolve();

function markDirty() {
  if (!state.page) return;
  dirty = true;
  el.saveState.textContent = 'Editing…';
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), 500);
}

/** Write the open page if it has changes. Resolves once it is on disk. */
function flush(): Promise<void> {
  clearTimeout(saveTimer);
  if (!dirty || !state.nb || !state.sectionId || !state.page) return saving;
  dirty = false;
  const nb = state.nb;
  const sectionId = state.sectionId;
  const page: Page = { ...state.page, title: el.title.value, blocks: editor.serialize() };
  state.page = page;
  el.saveState.textContent = 'Saving…';
  saving = saving.then(async () => {
    try {
      const entry = await backend.savePage(nb.id, sectionId, page);
      const listed = nb.sections.find((s) => s.id === sectionId)?.pages.find((p) => p.id === entry.id);
      if (listed) Object.assign(listed, { title: entry.title, modified: entry.modified });
      if (!dirty) el.saveState.textContent = 'All changes saved';
    } catch (err) {
      el.saveState.textContent = 'Not saved';
      if (state.page?.id === page.id) dirty = true;
      report(err);
    }
  });
  return saving;
}

// ---- editor -----------------------------------------------------------------

let ribbon: Ribbon | null = null;

const editor = new Editor(el.canvas, {
  onChange: markDirty,
  onSelection: () => ribbon?.refresh(),
  assetUrl: (name) => backend.assetUrl(state.nb!.id, name),
  saveImage: (bytes) => backend.saveAsset(state.nb!.id, bytes),
  openLink: (url) => act(() => backend.openExternal(url)),
  showMenu,
  notify: toast,
});

async function askForLink() {
  const url = await promptText('Insert link', '', 'Insert', 'https://example.org');
  if (url === null || !url.trim()) return;
  if (!editor.insertLink(url)) toast('Only web (http, https) and email links can be added.');
}

el.imageFile.addEventListener('change', () => {
  const files = Array.from(el.imageFile.files ?? []);
  el.imageFile.value = '';
  if (files.length && state.page) act(() => editor.insertImages(files));
});

// ---- how the page looks -------------------------------------------------------

const THEME_KEY = 'notekroft.theme';
let zoom = 1;

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function setTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* a convenience only */
  }
  ribbon?.refresh();
}

function setZoom(next: number) {
  zoom = next;
  el.page.style.transform = next === 1 ? '' : `scale(${next})`;
  editor.setScale(next);
  ribbon?.refresh();
}

/** Show the open page's rule lines and background colour. */
function applyPageLook() {
  const page = state.page;
  el.canvas.classList.toggle('rules-ruled', page?.rules === 'ruled');
  el.canvas.classList.toggle('rules-grid', page?.rules === 'grid');
  // A coloured page is always light, so it keeps dark text in either theme.
  el.scroller.classList.toggle('tinted', !!page?.color);
  el.scroller.style.backgroundColor = page?.color ?? '';
}

function changePage(change: Partial<Pick<Page, 'rules' | 'color'>>) {
  if (!state.page) return;
  state.page = { ...state.page, ...change };
  applyPageLook();
  dirty = true;
  void flush();
  ribbon?.refresh();
}

// ---- ribbon -------------------------------------------------------------------

function notebookActions(): MenuItem[] {
  const items: MenuItem[] = [{ label: 'New notebook…', onSelect: () => act(addNotebook) }];
  if (state.nb) {
    items.push(
      { label: 'Import from OneNote…', onSelect: () => act(importOneNote) },
      'separator',
      { label: 'Rename this notebook…', onSelect: () => act(renameNotebook) },
      { label: 'Delete this notebook…', danger: true, onSelect: () => act(deleteNotebook) },
    );
  }
  return items;
}

const megabytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Show where notes are kept, and offer to move them or use another folder. */
async function notesFolder() {
  const info = await backend.libraryInfo();
  if (info.locked) {
    await infoDialog('Notes folder', [
      'Your notes are kept in:',
      info.path,
      'This folder is set by the NOTEKROFT_LIBRARY environment variable, so it cannot be changed from here. Remove the variable and restart NoteKroft to choose a folder in the app.',
    ]);
    return;
  }
  const choice = await choiceDialog('Notes folder', 'Your notes are kept in:', info.path, [
    {
      key: 'move',
      label: 'Move my notes to another folder…',
      detail: 'Takes every notebook to a folder you pick and uses that folder from now on.',
    },
    {
      key: 'use',
      label: 'Use a different folder…',
      detail: 'Opens the notes in a folder you pick, or starts fresh there. The notes here stay where they are.',
    },
    { key: 'show', label: 'Show this folder', detail: 'Opens it in your file manager.' },
  ]);
  if (choice === 'show') {
    await backend.revealLibrary();
    return;
  }
  if (!choice) return;

  await flush();
  await saving;
  el.saveState.textContent = choice === 'move' ? 'Moving notes…' : 'Opening folder…';
  let change;
  try {
    change = await backend.chooseLibrary(choice);
  } finally {
    el.saveState.textContent = '';
  }
  if (!change) return;

  const lines: string[] = [];
  if (change.moved) {
    lines.push(
      `Moved ${count(change.moved.notebooks, 'notebook')} (${count(change.moved.files, 'file')}, ${megabytes(change.moved.bytes)}) to:`,
      change.path,
      change.oldCleared
        ? 'Every file was copied and checked before the old copy was removed.'
        : `The old copy could not be fully removed. It is still at ${change.oldPath} and is safe to delete yourself.`,
    );
  } else {
    lines.push(
      'Your notes are now kept in:',
      change.path,
      change.hadNotebooks
        ? 'The notebooks already in that folder are now open.'
        : 'That folder had no notebooks, so a new one has been started.',
      `The notes in ${change.oldPath} have not been touched.`,
    );
  }
  await infoDialog(change.moved ? 'Notes moved' : 'Notes folder changed', lines);
  // Everything on screen belongs to the old folder: start again from the new one.
  window.location.reload();
}

const SHORTCUTS: [string, string][] = [
  ['Search all notebooks', 'Ctrl+E'],
  ['New page / new section', 'Ctrl+N / Ctrl+T'],
  ['Previous / next page', 'Ctrl+PageUp / Ctrl+PageDown'],
  ['Make subpage / promote', 'Ctrl+Alt+] / Ctrl+Alt+['],
  ['Undo / redo', 'Ctrl+Z / Ctrl+Y'],
  ['Bold, italic, underline', 'Ctrl+B, Ctrl+I, Ctrl+U'],
  ['Strikethrough', 'Ctrl+-'],
  ['Subscript / superscript', 'Ctrl+= / Ctrl+Shift+='],
  ['Highlight', 'Ctrl+Alt+H'],
  ['Bullet list / numbered list', 'Ctrl+. / Ctrl+/'],
  ['Increase / decrease indent', 'Alt+Shift+Right / Left'],
  ['Align left / right', 'Ctrl+L / Ctrl+R'],
  ['Heading 1 to 6 / normal text', 'Ctrl+Alt+1 to 6 / Ctrl+Shift+N'],
  ['To Do, Important, Question tags', 'Ctrl+1, Ctrl+2, Ctrl+3'],
  ['Remember, Definition tags / remove tag', 'Ctrl+4, Ctrl+5 / Ctrl+0'],
  ['Insert link', 'Ctrl+K'],
  ['Insert date / time / both', 'Alt+Shift+D / T / F'],
  ['Start a table, next cell, new row', 'Tab'],
  ['Open a link', 'Ctrl+click'],
  ['Zoom in / out', 'Ctrl+Alt+= / Ctrl+Alt+-'],
  ['Stop drawing, back to typing', 'Esc'],
];

ribbon = new Ribbon(
  el.tabs,
  el.ribbon,
  buildTabs({
    editor,
    hasPage: () => !!state.page,
    notify: toast,
    pickImages: () => el.imageFile.click(),
    askForLink: () => act(askForLink),
    fileMenu: () => [
      ...notebookActions(),
      ...(backend.desktop
        ? (['separator', { label: 'Notes folder…', onSelect: () => act(notesFolder) }] as MenuItem[])
        : []),
    ],
    helpMenu: () => [
      { label: 'Keyboard shortcuts', onSelect: () => void tableDialog('Keyboard shortcuts', SHORTCUTS) },
      {
        label: 'About NoteKroft',
        onSelect: () => void infoDialog(`NoteKroft ${__APP_VERSION__}`, [
          'A local-first, open source notebook. Your notes are plain files in a folder you control.',
          'Free software under the GNU General Public License, version 3 or later.',
          'github.com/morningjon/notekroft',
        ]),
      },
    ],
    zoom: () => zoom,
    setZoom,
    rules: () => (state.page?.rules as Rules | null | undefined) ?? null,
    setRules: (rules) => changePage({ rules }),
    pageColor: () => state.page?.color ?? null,
    setPageColor: (color) => changePage({ color }),
    theme: storedTheme,
    setTheme,
  }),
  // Leaving the Draw tab puts the pen down.
  (tab) => {
    if (tab !== 'draw' && editor.currentTool.kind !== 'type') editor.setTool({ kind: 'type' });
  },
);
setTheme(storedTheme());

el.title.addEventListener('input', () => {
  const entry = currentSection()?.pages.find((p) => p.id === state.page?.id);
  if (entry) {
    entry.title = el.title.value;
    const label = el.pages.querySelector<HTMLElement>(`li[data-id="${entry.id}"] .label`);
    if (label) setPageLabel(label, entry.title);
  }
  markDirty();
});
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    editor.focusFirst();
  }
});

// ---- navigation: rendering --------------------------------------------------

const DRAG = { section: 'application/x-notekroft-section', page: 'application/x-notekroft-page' } as const;

/** Make a list item draggable within its list. */
function sortable(li: HTMLElement, kind: keyof typeof DRAG, id: string, onMove: (dragged: string, before: boolean) => void) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData(DRAG[kind], id);
    e.dataTransfer!.effectAllowed = 'move';
  });
  li.addEventListener('dragover', (e) => {
    if (!e.dataTransfer!.types.includes(DRAG[kind])) return;
    e.preventDefault();
    const r = li.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    li.classList.toggle('drop-before', before);
    li.classList.toggle('drop-after', !before);
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after', 'drop-into'));
  li.addEventListener('drop', (e) => {
    const dragged = e.dataTransfer!.getData(DRAG[kind]);
    const before = li.classList.contains('drop-before');
    li.classList.remove('drop-before', 'drop-after');
    if (!dragged) return;
    e.preventDefault();
    if (dragged !== id) onMove(dragged, before);
  });
}

function reorder<T extends { id: string }>(items: T[], dragged: string, target: string, before: boolean): T[] {
  const moving = items.find((i) => i.id === dragged);
  if (!moving) return items;
  const rest = items.filter((i) => i.id !== dragged);
  const at = rest.findIndex((i) => i.id === target);
  rest.splice(before ? at : at + 1, 0, moving);
  return rest;
}

function setPageLabel(label: HTMLElement, title: string) {
  label.textContent = title.trim() || 'Untitled page';
  label.classList.toggle('untitled', !title.trim());
}

function renderNotebook() {
  el.nbTitle.textContent = state.nb?.title ?? 'No notebook';
  el.picker.style.setProperty('--c', state.nb?.color ?? 'transparent');
  el.addSection.disabled = !state.nb;
  renderSections();
  renderPages();
}

function renderSections() {
  const nb = state.nb;
  el.sections.replaceChildren(
    ...(nb?.sections ?? []).map((sec) => {
      const li = h('li', 'item section' + (sec.id === state.sectionId ? ' active' : ''));
      li.dataset.id = sec.id;
      li.style.setProperty('--c', sec.color);
      li.tabIndex = 0;
      li.append(h('span', 'label', sec.title));
      li.addEventListener('click', () => act(() => openSection(sec.id)));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') act(() => openSection(sec.id));
      });
      li.addEventListener('dblclick', () => act(() => renameSection(sec)));
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Rename', onSelect: () => act(() => renameSection(sec)) },
          { swatches: SECTION_COLORS, current: sec.color, onPick: (color) => act(() => recolourSection(sec, color)) },
          'separator',
          { label: 'Delete section', danger: true, onSelect: () => act(() => deleteSection(sec)) },
        ]);
      });
      sortable(li, 'section', sec.id, (dragged, before) => act(async () => {
        nb!.sections = reorder(nb!.sections, dragged, sec.id, before);
        renderSections();
        await backend.setSectionOrder(nb!.id, nb!.sections.map((s) => s.id));
      }));
      // Pages can be dropped onto a section to move them there.
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer!.types.includes(DRAG.page) || sec.id === state.sectionId) return;
        e.preventDefault();
        li.classList.add('drop-into');
      });
      li.addEventListener('drop', (e) => {
        const pageId = e.dataTransfer!.getData(DRAG.page);
        li.classList.remove('drop-into');
        if (!pageId || sec.id === state.sectionId) return;
        e.preventDefault();
        act(() => movePageTo(pageId, sec));
      });
      return li;
    }),
  );
}

function renderPages() {
  const sec = currentSection();
  el.addPage.disabled = !sec;
  el.pages.replaceChildren(
    ...(sec?.pages ?? []).map((entry, index) => {
      const li = h('li', `item page level-${entry.level}` + (entry.id === state.page?.id ? ' active' : ''));
      li.dataset.id = entry.id;
      li.tabIndex = 0;
      const label = h('span', 'label');
      setPageLabel(label, entry.title);
      li.append(label);
      li.addEventListener('click', () => act(() => openPage(entry.id)));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') act(() => openPage(entry.id));
      });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const above = sec!.pages[index - 1];
        showMenu(e.clientX, e.clientY, [
          { label: 'New page below', onSelect: () => act(() => addPage(entry.id)) },
          {
            label: 'Make subpage',
            hint: 'Ctrl+Alt+]',
            disabled: !above || entry.level >= 2 || entry.level > above.level,
            onSelect: () => act(() => setLevel(entry.id, entry.level + 1)),
          },
          {
            label: 'Promote subpage',
            hint: 'Ctrl+Alt+[',
            disabled: entry.level === 0,
            onSelect: () => act(() => setLevel(entry.id, entry.level - 1)),
          },
          'separator',
          { label: 'Delete page', danger: true, onSelect: () => act(() => deletePage(entry.id)) },
        ]);
      });
      sortable(li, 'page', entry.id, (dragged, before) => act(async () => {
        const next = reorder(sec!.pages, dragged, entry.id, before);
        await applyPageOrder(sec!, next);
      }));
      return li;
    }),
  );
}

function showEmpty() {
  el.page.hidden = true;
  el.empty.hidden = false;
  const lines = !state.nb
    ? ['No notebook open', 'Use the notebook menu at the top left to create one.']
    : !currentSection()
      ? ['This notebook has no sections yet', 'Add a section to start taking notes.']
      : ['This section is empty', 'Add a page to start taking notes.'];
  el.empty.replaceChildren(h('h2', '', lines[0]), h('p', '', lines[1]));
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

// ---- navigation: opening things ---------------------------------------------

async function loadNotebooks() {
  state.notebooks = await backend.listNotebooks();
}

async function openNotebook(id: string, sectionId?: string, pageId?: string) {
  await flush();
  const nb = await backend.getNotebook(id);
  state.nb = nb;
  state.sectionId = null;
  state.page = null;
  const section = nb.sections.find((s) => s.id === sectionId) ?? nb.sections[0];
  renderNotebook();
  await openSection(section?.id ?? null, pageId);
}

async function openSection(id: string | null, pageId?: string) {
  await flush();
  state.sectionId = id;
  renderSections();
  const sec = currentSection();
  const wanted = pageId ?? (id ? lastPage.get(id) : undefined);
  const entry = sec?.pages.find((p) => p.id === wanted) ?? sec?.pages[0];
  await openPage(entry?.id ?? null);
}

async function openPage(id: string | null, focusTitle = false) {
  await flush();
  if (!id || !state.nb || !state.sectionId) {
    state.page = null;
    editor.load([]);
    applyPageLook();
    renderPages();
    showEmpty();
    remember();
    return;
  }
  const page = await backend.getPage(state.nb.id, state.sectionId, id);
  state.page = page;
  lastPage.set(state.sectionId, id);
  el.title.value = page.title;
  const created = new Date(page.created);
  el.stamp.replaceChildren(h('span', '', dateFmt.format(created)), h('span', '', timeFmt.format(created)));
  el.empty.hidden = true;
  el.page.hidden = false;
  editor.load(page.blocks);
  applyPageLook();
  ribbon?.refresh();
  el.scroller.scrollTo(0, 0);
  el.saveState.textContent = '';
  renderPages();
  remember();
  if (focusTitle) el.title.focus();
  if (page.reflow) {
    // First look at an imported page: settle its layout once and keep it.
    await editor.reflow();
    if (state.page?.id === page.id) {
      state.page = { ...state.page, reflow: false };
      dirty = true;
      await flush();
    }
  }
}

// ---- actions ----------------------------------------------------------------

async function addNotebook() {
  const title = await promptText('New notebook', '', 'Create', 'Notebook name');
  if (title === null) return;
  await flush();
  const nb = await backend.createNotebook(title);
  const section = await backend.createSection(nb.id, 'Quick Notes');
  await backend.createPage(nb.id, section.id, '');
  await loadNotebooks();
  await openNotebook(nb.id);
  el.title.focus();
}

async function renameNotebook() {
  const nb = state.nb;
  if (!nb) return;
  const title = await promptText('Rename notebook', nb.title, 'Rename');
  if (title === null || !title.trim()) return;
  await backend.renameNotebook(nb.id, title);
  nb.title = title.trim();
  await loadNotebooks();
  renderNotebook();
}

async function deleteNotebook() {
  const nb = state.nb;
  if (!nb) return;
  const ok = await confirmDialog(
    `Delete "${nb.title}"?`,
    backend.desktop
      ? 'The notebook and all of its sections and pages move to the .trash folder inside your library, where you can recover them.'
      : 'The notebook and all of its sections and pages will be removed from this browser.',
    'Delete notebook',
  );
  if (!ok) return;
  dirty = false;
  await backend.deleteNotebook(nb.id);
  await loadNotebooks();
  if (state.notebooks[0]) {
    await openNotebook(state.notebooks[0].id);
  } else {
    state.nb = null;
    state.sectionId = null;
    renderNotebook();
    await openPage(null);
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function importOneNote() {
  const nb = state.nb;
  if (!nb) return;
  await flush();
  el.saveState.textContent = 'Importing…';
  let summary;
  try {
    summary = await backend.importOneNote(nb.id);
  } finally {
    el.saveState.textContent = '';
  }
  if (!summary) return;

  state.nb = await backend.getNotebook(nb.id);
  renderNotebook();
  await openSection(summary.sections[0]?.id ?? state.sectionId);

  const lines = [
    `Added ${count(summary.sections.length, 'section')} with ${count(summary.pages, 'page')}, ${count(summary.pictures, 'picture')} and ${count(summary.drawings, 'ink stroke')} to "${nb.title}". Your OneNote files were not changed.`,
  ];
  const s = summary.skipped;
  const left = [
    s.ink && `${count(s.ink, 'piece')} of handwriting written in line with text`,
    s.files && count(s.files, 'attached file'),
    s.pictures && `${count(s.pictures, 'picture')} in a format NoteKroft cannot display`,
    s.other && count(s.other, 'other item'),
  ].filter(Boolean);
  if (left.length) lines.push(`Left out, because NoteKroft cannot show them yet: ${left.join(', ')}.`);
  if (summary.warnings.length) {
    lines.push('Notes from the import:', ...summary.warnings.slice(0, 6));
    if (summary.warnings.length > 6) lines.push(`…and ${summary.warnings.length - 6} more.`);
  }
  await infoDialog('Import finished', lines);
}

async function addSection() {
  const nb = state.nb;
  if (!nb) return;
  const title = await promptText('New section', '', 'Create', 'Section name');
  if (title === null) return;
  await flush();
  const sec = await backend.createSection(nb.id, title);
  nb.sections.push(sec);
  const page = await backend.createPage(nb.id, sec.id, '');
  sec.pages.push({ id: page.id, title: '', level: 0, modified: page.modified });
  await openSection(sec.id, page.id);
  el.title.focus();
}

async function renameSection(sec: Section) {
  const title = await promptText('Rename section', sec.title, 'Rename');
  if (title === null || !title.trim()) return;
  Object.assign(sec, await backend.updateSection(state.nb!.id, sec.id, { title }));
  renderSections();
}

async function recolourSection(sec: Section, color: string) {
  Object.assign(sec, await backend.updateSection(state.nb!.id, sec.id, { color }));
  renderSections();
}

async function deleteSection(sec: Section) {
  const nb = state.nb!;
  const count = sec.pages.length;
  const ok = await confirmDialog(
    `Delete section "${sec.title}"?`,
    `${count === 1 ? 'Its 1 page' : `Its ${count} pages`} will ${backend.desktop ? 'move to the .trash folder inside your library' : 'be removed from this browser'}.`,
    'Delete section',
  );
  if (!ok) return;
  if (sec.id === state.sectionId) dirty = false;
  await backend.deleteSection(nb.id, sec.id);
  nb.sections = nb.sections.filter((s) => s.id !== sec.id);
  if (sec.id === state.sectionId) await openSection(nb.sections[0]?.id ?? null);
  else renderSections();
}

async function addPage(after?: string) {
  const nb = state.nb;
  const sec = currentSection();
  if (!nb || !sec) return;
  await flush();
  const page = await backend.createPage(nb.id, sec.id, '', after);
  state.nb = await backend.getNotebook(nb.id);
  await openPage(page.id, true);
}

async function deletePage(id: string) {
  const nb = state.nb;
  const sec = currentSection();
  if (!nb || !sec) return;
  const index = sec.pages.findIndex((p) => p.id === id);
  const wasOpen = state.page?.id === id;
  if (wasOpen) dirty = false;
  else await flush();
  await backend.deletePage(nb.id, sec.id, id);
  state.nb = await backend.getNotebook(nb.id);
  const pages = currentSection()?.pages ?? [];
  if (wasOpen) await openPage((pages[index] ?? pages[index - 1])?.id ?? null);
  else renderPages();
  if (backend.desktop) toast('Page moved to the .trash folder in your library.');
}

async function applyPageOrder(sec: Section, pages: PageEntry[]) {
  sec.pages = pages;
  renderPages();
  sec.pages = await backend.setPageOrder(state.nb!.id, sec.id, pages.map(({ id, level }) => ({ id, level })));
  renderPages();
}

async function setLevel(id: string, level: number) {
  const sec = currentSection();
  if (!sec) return;
  await applyPageOrder(sec, sec.pages.map((p) => (p.id === id ? { ...p, level: Math.max(0, Math.min(2, level)) } : p)));
}

async function movePageTo(pageId: string, target: Section) {
  const nb = state.nb!;
  const from = state.sectionId!;
  await flush();
  const wasOpen = state.page?.id === pageId;
  await backend.movePage(nb.id, from, pageId, target.id);
  state.nb = await backend.getNotebook(nb.id);
  renderSections();
  if (wasOpen) await openSection(from);
  else renderPages();
  toast(`Page moved to "${target.title}".`);
}

function stepPage(delta: number) {
  const pages = currentSection()?.pages ?? [];
  const next = pages[pages.findIndex((p) => p.id === state.page?.id) + delta];
  if (next) act(() => openPage(next.id));
}

// ---- notebook picker --------------------------------------------------------

el.picker.addEventListener('click', () => {
  const r = el.picker.getBoundingClientRect();
  const items: MenuItem[] = state.notebooks.map((n) => ({
    label: n.title,
    checked: n.id === state.nb?.id,
    onSelect: () => {
      if (n.id !== state.nb?.id) act(() => openNotebook(n.id));
    },
  }));
  if (items.length) items.push('separator');
  showMenu(r.left, r.bottom + 4, [...items, ...notebookActions()]);
});

el.addSection.addEventListener('click', () => act(addSection));
el.addPage.addEventListener('click', () => act(() => addPage()));

// ---- search -----------------------------------------------------------------

let searchSeq = 0;
let searchTimer = 0;
let hits: SearchHit[] = [];
let activeHit = 0;

function hideResults() {
  el.results.hidden = true;
  el.results.replaceChildren();
  hits = [];
}

function renderResults(query: string) {
  activeHit = 0;
  el.results.hidden = false;
  if (!hits.length) {
    el.results.replaceChildren(h('div', 'no-hits', `No pages match "${query}".`));
    return;
  }
  el.results.replaceChildren(
    ...hits.map((hit, i) => {
      const b = h('button', 'hit' + (i === 0 ? ' active' : ''));
      b.type = 'button';
      b.append(
        h('div', 'hit-title', hit.pageTitle.trim() || 'Untitled page'),
        h('div', 'hit-path', `${hit.notebookTitle} › ${hit.sectionTitle}`),
      );
      if (hit.snippet) b.append(h('div', 'hit-snippet', hit.snippet));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => act(() => gotoHit(hit)));
      return b;
    }),
  );
}

async function gotoHit(hit: SearchHit) {
  hideResults();
  el.search.value = '';
  el.search.blur();
  if (state.nb?.id !== hit.notebookId) await openNotebook(hit.notebookId, hit.sectionId, hit.pageId);
  else await openSection(hit.sectionId, hit.pageId);
}

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = el.search.value.trim();
  const seq = ++searchSeq;
  if (!query) {
    hideResults();
    return;
  }
  searchTimer = window.setTimeout(() => act(async () => {
    await flush();
    const found = await backend.search(query);
    if (seq !== searchSeq) return;
    hits = found;
    renderResults(query);
  }), 180);
});

el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.search.value = '';
    searchSeq++;
    hideResults();
    el.search.blur();
  } else if (e.key === 'Enter' && hits[activeHit]) {
    e.preventDefault();
    act(() => gotoHit(hits[activeHit]));
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && hits.length) {
    e.preventDefault();
    activeHit = (activeHit + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
    Array.from(el.results.children).forEach((c, i) => {
      c.classList.toggle('active', i === activeHit);
      if (i === activeHit) c.scrollIntoView({ block: 'nearest' });
    });
  }
});

document.addEventListener('mousedown', (e) => {
  if (!el.searchBox.contains(e.target as Node)) hideResults();
});

// ---- app-wide shortcuts -----------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return;
  const key = e.key.toLowerCase();
  const run = (fn: () => void) => {
    e.preventDefault();
    closeMenu();
    fn();
  };
  const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && state.page && !field) {
    const now = new Date();
    const date = now.toLocaleDateString();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (key === 'd') run(() => editor.insertText(date));
    else if (key === 't') run(() => editor.insertText(time));
    else if (key === 'f') run(() => editor.insertText(`${date} ${time}`));
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  // One undo history for the whole page, in place of the browser's own
  // text-only one. Plain input fields keep theirs.
  if (state.page && !field && !e.altKey && (key === 'z' || key === 'y')) {
    if (key === 'y' || e.shiftKey) run(() => editor.redo());
    else run(() => editor.undo());
    return;
  }
  if (e.altKey && (e.key === '=' || e.key === '+' || e.key === '-')) {
    const steps = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
    const next = e.key === '-' ? [...steps].reverse().find((z) => z < zoom - 0.001) : steps.find((z) => z > zoom + 0.001);
    if (next) run(() => setZoom(next));
    return;
  }
  if (e.altKey && (e.key === ']' || e.key === '[')) {
    const entry = currentSection()?.pages.find((p) => p.id === state.page?.id);
    if (entry) run(() => act(() => setLevel(entry.id, entry.level + (e.key === ']' ? 1 : -1))));
  } else if (e.altKey || e.shiftKey) {
    return;
  } else if (key === 'e') run(() => el.search.focus());
  else if (key === 'n') run(() => act(() => addPage()));
  else if (key === 't') run(() => act(addSection));
  else if (key === 's') run(() => void flush());
  else if (key === 'k' && state.page) run(() => act(askForLink));
  else if (e.key === 'PageDown') run(() => stepPage(1));
  else if (e.key === 'PageUp') run(() => stepPage(-1));
});

// The app is a single page; never navigate away from it.
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flush();
});
window.addEventListener('pagehide', () => void flush());

// ---- start ------------------------------------------------------------------

const WELCOME = [
  '<h2>Click anywhere and start typing</h2>',
  '<div>Every click on empty space starts a new note container. Drag the bar along its top to move it, or its right edge to change the width.</div>',
  '<div><br></div>',
  '<div class="todo done">Type some text, then press Tab to turn the line into a table</div>',
  '<div class="todo">Paste or drop a picture onto the page</div>',
  '<div class="todo">Press Ctrl+1 to tag a line as a to-do</div>',
  '<div class="todo">Open the Draw tab to write or sketch by hand</div>',
  '<div class="todo">Press Ctrl+E to search every notebook</div>',
  '<div><br></div>',
  '<div>Your notes are ordinary files in a folder you control. Nothing leaves this computer.</div>',
].join('');

async function firstRun(): Promise<string> {
  const nb = await backend.createNotebook('My Notebook');
  const sec = await backend.createSection(nb.id, 'Quick Notes');
  const page = await backend.createPage(nb.id, sec.id, 'Welcome to NoteKroft');
  await backend.savePage(nb.id, sec.id, {
    ...page,
    blocks: [{ kind: 'text', id: crypto.randomUUID(), x: 0, y: 0, w: 520, html: WELCOME }],
  });
  return nb.id;
}

async function start() {
  const library = await backend.libraryInfo();
  el.libPath.textContent = library.path;
  if (backend.desktop) {
    el.libPath.title = 'Where your notes are kept. Click to show, move or change the folder.';
    el.libPath.addEventListener('click', () => act(notesFolder));
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    // Finish any pending save before the window goes away.
    void getCurrentWindow().onCloseRequested(async () => {
      await flush();
    });
  } else {
    el.libPath.disabled = true;
  }

  await loadNotebooks();
  if (!state.notebooks.length) {
    await firstRun();
    await loadNotebooks();
  }
  const last = recall();
  const target = state.notebooks.find((n) => n.id === last.nb) ?? state.notebooks[0];
  if (last.section && last.page) lastPage.set(last.section, last.page);
  await openNotebook(target.id, last.section, last.page);
  if (library.notice) await infoDialog('Notes folder not found', library.notice.split('\n').filter(Boolean));
}

showEmpty();
act(start);
