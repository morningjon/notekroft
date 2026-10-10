import {
  createBackend,
  SECTION_COLORS,
  type NotebookSummary,
  type NotebookTree,
  type Page,
  type PageEntry,
  type SearchHit,
  type Section,
} from './api';
import { Editor, type InlineCommand } from './editor';
import { closeMenu, confirmDialog, h, promptText, showMenu, toast, type MenuItem } from './widgets';

const backend = createBackend();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  toolbar: $('toolbar'),
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

const LAST_KEY = 'twonote.last';

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

const editor = new Editor(el.canvas, {
  onChange: markDirty,
  onSelection: refreshToolbar,
  assetUrl: (name) => backend.assetUrl(state.nb!.id, name),
  saveImage: (bytes) => backend.saveAsset(state.nb!.id, bytes),
  openLink: (url) => act(() => backend.openExternal(url)),
  showMenu,
  notify: toast,
});

function refreshToolbar() {
  const fmt = editor.formatState();
  for (const b of el.toolbar.querySelectorAll<HTMLButtonElement>('[data-cmd]')) {
    const cmd = b.dataset.cmd as InlineCommand;
    b.setAttribute('aria-pressed', String(!!fmt && cmd in fmt && fmt[cmd]));
  }
}

async function askForLink() {
  const url = await promptText('Insert link', '', 'Insert', 'https://example.org');
  if (url === null || !url.trim()) return;
  if (!editor.insertLink(url)) toast('Only web (http, https) and email links can be added.');
}

// Toolbar buttons must not take focus, or the selection they act on is lost.
el.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
el.toolbar.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button');
  if (!b) return;
  if (!state.page) {
    toast('Open or add a page first.');
    return;
  }
  if (b.dataset.cmd) {
    editor.exec(b.dataset.cmd as InlineCommand);
    return;
  }
  switch (b.dataset.act) {
    case 'styles': {
      const r = b.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'Heading 1', hint: 'Ctrl+Alt+1', onSelect: () => editor.heading('h1') },
        { label: 'Heading 2', hint: 'Ctrl+Alt+2', onSelect: () => editor.heading('h2') },
        { label: 'Heading 3', hint: 'Ctrl+Alt+3', onSelect: () => editor.heading('h3') },
        { label: 'Normal', hint: 'Ctrl+Shift+N', onSelect: () => editor.heading('div') },
      ]);
      break;
    }
    case 'highlight': editor.highlight(); break;
    case 'todo': editor.toggleTodo(); break;
    case 'table': editor.insertTable(); break;
    case 'image': el.imageFile.click(); break;
    case 'link': act(askForLink); break;
  }
});

el.imageFile.addEventListener('change', () => {
  const files = Array.from(el.imageFile.files ?? []);
  el.imageFile.value = '';
  if (files.length && state.page) act(() => editor.insertImages(files));
});

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

const DRAG = { section: 'application/x-twonote-section', page: 'application/x-twonote-page' } as const;

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
  el.scroller.scrollTo(0, 0);
  el.saveState.textContent = '';
  renderPages();
  remember();
  if (focusTitle) el.title.focus();
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
  items.push({ label: 'New notebook…', onSelect: () => act(addNotebook) });
  if (state.nb) {
    items.push(
      { label: 'Rename this notebook…', onSelect: () => act(renameNotebook) },
      { label: 'Delete this notebook…', danger: true, onSelect: () => act(deleteNotebook) },
    );
  }
  showMenu(r.left, r.bottom + 4, items);
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
  if (!(e.ctrlKey || e.metaKey) || document.querySelector('.overlay')) return;
  const key = e.key.toLowerCase();
  const run = (fn: () => void) => {
    e.preventDefault();
    closeMenu();
    fn();
  };
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
  '<div class="todo">Press Ctrl+E to search every notebook</div>',
  '<div><br></div>',
  '<div>Your notes are ordinary files in a folder you control. Nothing leaves this computer.</div>',
].join('');

async function firstRun(): Promise<string> {
  const nb = await backend.createNotebook('My Notebook');
  const sec = await backend.createSection(nb.id, 'Quick Notes');
  const page = await backend.createPage(nb.id, sec.id, 'Welcome to TwoNote');
  await backend.savePage(nb.id, sec.id, {
    ...page,
    blocks: [{ kind: 'text', id: crypto.randomUUID(), x: 0, y: 0, w: 520, html: WELCOME }],
  });
  return nb.id;
}

async function start() {
  const path = await backend.libraryPath();
  el.libPath.textContent = path;
  if (backend.desktop) {
    el.libPath.title = 'Show the notebook library folder';
    el.libPath.addEventListener('click', () => act(() => backend.revealLibrary()));
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
}

showEmpty();
act(start);
