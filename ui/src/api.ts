// Types shared with twonote-core, and the two backends behind them:
// the desktop app (Rust, real files) and a browser-only demo store.

export interface PageEntry {
  id: string;
  title: string;
  level: number;
  modified: number;
}

export interface Section {
  id: string;
  title: string;
  color: string;
  pages: PageEntry[];
}

export interface NotebookSummary {
  id: string;
  title: string;
  color: string;
  modified: number;
}

export interface NotebookTree {
  id: string;
  title: string;
  color: string;
  sections: Section[];
}

export interface TextBlock {
  kind: 'text';
  id: string;
  x: number;
  y: number;
  w: number;
  html: string;
}

export interface ImageBlock {
  kind: 'image';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  asset: string;
  alt: string;
}

/** One continuous pen line. Points are pixels from the ink block's corner. */
export interface Stroke {
  points: [number, number][];
  color: string;
  width: number;
  /** 1 for a pen (and then left out); lower for a highlighter. */
  opacity?: number;
}

export interface InkBlock {
  kind: 'ink';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  strokes: Stroke[];
}

export type Block = TextBlock | ImageBlock | InkBlock;

export type Rules = 'ruled' | 'grid';

export interface Page {
  id: string;
  title: string;
  created: number;
  modified: number;
  /** Imported page whose blocks still need nudging apart; see Editor.reflow. */
  reflow?: boolean;
  /** Rule lines behind the page. */
  rules?: Rules | null;
  /** Page background colour, `#rrggbb`. */
  color?: string | null;
  blocks: Block[];
}

export interface ImportSummary {
  sections: { id: string; title: string; pages: number }[];
  pages: number;
  pictures: number;
  drawings: number;
  skipped: { ink: number; files: number; pictures: number; other: number };
  warnings: string[];
}

export interface SearchHit {
  notebookId: string;
  notebookTitle: string;
  sectionId: string;
  sectionTitle: string;
  pageId: string;
  pageTitle: string;
  snippet: string;
  titleMatch: boolean;
  modified: number;
}

export interface PageOrder {
  id: string;
  level: number;
}

export interface Backend {
  /** True for the desktop app, false for the in-browser demo. */
  readonly desktop: boolean;
  libraryPath(): Promise<string>;
  listNotebooks(): Promise<NotebookSummary[]>;
  createNotebook(title: string): Promise<NotebookTree>;
  getNotebook(notebook: string): Promise<NotebookTree>;
  renameNotebook(notebook: string, title: string): Promise<void>;
  deleteNotebook(notebook: string): Promise<void>;
  createSection(notebook: string, title: string): Promise<Section>;
  updateSection(notebook: string, section: string, change: { title?: string; color?: string }): Promise<Section>;
  deleteSection(notebook: string, section: string): Promise<void>;
  setSectionOrder(notebook: string, order: string[]): Promise<void>;
  createPage(notebook: string, section: string, title: string, after?: string): Promise<Page>;
  getPage(notebook: string, section: string, page: string): Promise<Page>;
  savePage(notebook: string, section: string, page: Page): Promise<PageEntry>;
  deletePage(notebook: string, section: string, page: string): Promise<void>;
  setPageOrder(notebook: string, section: string, order: PageOrder[]): Promise<PageEntry[]>;
  movePage(notebook: string, from: string, page: string, to: string): Promise<void>;
  saveAsset(notebook: string, bytes: Uint8Array): Promise<string>;
  /** A URL an <img> can show for a stored asset. */
  assetUrl(notebook: string, name: string): Promise<string>;
  search(query: string): Promise<SearchHit[]>;
  /** Let the user pick OneNote files and import them as new sections.
   *  Resolves to null if they cancel. Desktop only. */
  importOneNote(notebook: string): Promise<ImportSummary | null>;
  openExternal(url: string): Promise<void>;
  revealLibrary(): Promise<void>;
}

export const SECTION_COLORS = [
  '#2f7dd1', '#d1492f', '#3a9d5d', '#c98a12', '#8a56c2', '#1f9a9a', '#c2478b', '#6b7785',
];

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// ---- desktop ----------------------------------------------------------------

class DesktopBackend implements Backend {
  readonly desktop = true;
  private urls = new Map<string, string>();
  private core = import('@tauri-apps/api/core');
  private opener = import('@tauri-apps/plugin-opener');

  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await this.core;
    try {
      return await invoke<T>(cmd, args);
    } catch (err) {
      throw new Error(typeof err === 'string' ? err : String(err));
    }
  }

  libraryPath() { return this.call<string>('library_path'); }
  listNotebooks() { return this.call<NotebookSummary[]>('list_notebooks'); }
  createNotebook(title: string) { return this.call<NotebookTree>('create_notebook', { title }); }
  getNotebook(notebook: string) { return this.call<NotebookTree>('get_notebook', { notebook }); }
  renameNotebook(notebook: string, title: string) { return this.call<void>('rename_notebook', { notebook, title }); }
  deleteNotebook(notebook: string) { return this.call<void>('delete_notebook', { notebook }); }
  createSection(notebook: string, title: string) { return this.call<Section>('create_section', { notebook, title }); }
  updateSection(notebook: string, section: string, change: { title?: string; color?: string }) {
    return this.call<Section>('update_section', { notebook, section, title: change.title ?? null, color: change.color ?? null });
  }
  deleteSection(notebook: string, section: string) { return this.call<void>('delete_section', { notebook, section }); }
  setSectionOrder(notebook: string, order: string[]) { return this.call<void>('set_section_order', { notebook, order }); }
  createPage(notebook: string, section: string, title: string, after?: string) {
    return this.call<Page>('create_page', { notebook, section, title, after: after ?? null });
  }
  getPage(notebook: string, section: string, page: string) { return this.call<Page>('get_page', { notebook, section, page }); }
  savePage(notebook: string, section: string, page: Page) { return this.call<PageEntry>('save_page', { notebook, section, page }); }
  deletePage(notebook: string, section: string, page: string) { return this.call<void>('delete_page', { notebook, section, page }); }
  setPageOrder(notebook: string, section: string, order: PageOrder[]) {
    return this.call<PageEntry[]>('set_page_order', { notebook, section, order });
  }
  movePage(notebook: string, from: string, page: string, to: string) {
    return this.call<void>('move_page', { notebook, from, page, to });
  }
  saveAsset(notebook: string, bytes: Uint8Array) {
    return this.call<string>('save_asset', { notebook, data: toBase64(bytes) });
  }
  async assetUrl(notebook: string, name: string) {
    const key = `${notebook}/${name}`;
    let url = this.urls.get(key);
    if (!url) {
      const buf = await this.call<ArrayBuffer>('read_asset', { notebook, name });
      const type = MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
      url = URL.createObjectURL(new Blob([buf], { type }));
      this.urls.set(key, url);
    }
    return url;
  }
  search(query: string) { return this.call<SearchHit[]>('search', { query }); }
  importOneNote(notebook: string) { return this.call<ImportSummary | null>('import_onenote', { notebook }); }
  async openExternal(url: string) { await (await this.opener).openUrl(url); }
  async revealLibrary() { await (await this.opener).revealItemInDir(await this.libraryPath()); }
}

// ---- browser demo -----------------------------------------------------------
// Mirrors the core's behaviour closely enough to try the interface without
// installing anything. Data stays in this browser's localStorage.

interface DemoNotebook {
  id: string;
  title: string;
  color: string;
  modified: number;
  sections: Section[];
  pages: Record<string, Page>;
}

interface DemoData {
  notebooks: Record<string, DemoNotebook>;
  assets: Record<string, string>;
}

const DEMO_KEY = 'twonote.demo.v1';
const uid = () => crypto.randomUUID();
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function normaliseLevels(pages: PageEntry[]) {
  let prev = -1;
  for (const p of pages) {
    p.level = Math.max(0, Math.min(p.level, prev + 1, 2));
    prev = p.level;
  }
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<(\/?)(p|div|br|li|td|th|tr|h[1-3])\b/gi, ' <$1$2'), 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

class DemoBackend implements Backend {
  readonly desktop = false;
  private data: DemoData = { notebooks: {}, assets: {} };

  constructor() {
    try {
      const raw = localStorage.getItem(DEMO_KEY);
      if (raw) this.data = JSON.parse(raw);
    } catch {
      /* start empty */
    }
  }

  private persist() {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(this.data));
    } catch {
      throw new Error('Browser demo storage is full. The desktop app has no such limit.');
    }
  }

  private nb(id: string): DemoNotebook {
    const nb = this.data.notebooks[id];
    if (!nb) throw new Error('notebook not found');
    return nb;
  }

  private sec(nbId: string, id: string): Section {
    const sec = this.nb(nbId).sections.find((s) => s.id === id);
    if (!sec) throw new Error('section not found');
    return sec;
  }

  private tree(nb: DemoNotebook): NotebookTree {
    return copy({ id: nb.id, title: nb.title, color: nb.color, sections: nb.sections });
  }

  async libraryPath() { return 'Browser demo: notes are kept in this browser only'; }

  async listNotebooks() {
    return Object.values(this.data.notebooks)
      .map(({ id, title, color, modified }) => ({ id, title, color, modified }))
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  }

  async createNotebook(title: string) {
    const count = Object.keys(this.data.notebooks).length;
    const nb: DemoNotebook = {
      id: uid(),
      title: title.trim() || 'Untitled notebook',
      color: SECTION_COLORS[count % SECTION_COLORS.length],
      modified: Date.now(),
      sections: [],
      pages: {},
    };
    this.data.notebooks[nb.id] = nb;
    this.persist();
    return this.tree(nb);
  }

  async getNotebook(id: string) { return this.tree(this.nb(id)); }

  async renameNotebook(id: string, title: string) {
    this.nb(id).title = title.trim() || 'Untitled notebook';
    this.persist();
  }

  async deleteNotebook(id: string) {
    this.nb(id);
    delete this.data.notebooks[id];
    this.persist();
  }

  async createSection(nbId: string, title: string) {
    const nb = this.nb(nbId);
    const sec: Section = {
      id: uid(),
      title: title.trim() || 'New section',
      color: SECTION_COLORS[nb.sections.length % SECTION_COLORS.length],
      pages: [],
    };
    nb.sections.push(sec);
    this.persist();
    return copy(sec);
  }

  async updateSection(nbId: string, id: string, change: { title?: string; color?: string }) {
    const sec = this.sec(nbId, id);
    if (change.title !== undefined) sec.title = change.title.trim() || 'New section';
    if (change.color !== undefined) sec.color = change.color;
    this.persist();
    return copy(sec);
  }

  async deleteSection(nbId: string, id: string) {
    const nb = this.nb(nbId);
    const sec = this.sec(nbId, id);
    for (const p of sec.pages) delete nb.pages[p.id];
    nb.sections = nb.sections.filter((s) => s.id !== id);
    this.persist();
  }

  async setSectionOrder(nbId: string, order: string[]) {
    const nb = this.nb(nbId);
    nb.sections = order.map((id) => this.sec(nbId, id));
    this.persist();
  }

  async createPage(nbId: string, secId: string, title: string, after?: string) {
    const nb = this.nb(nbId);
    const sec = this.sec(nbId, secId);
    const now = Date.now();
    const page: Page = { id: uid(), title: title.trim(), created: now, modified: now, blocks: [] };
    nb.pages[page.id] = page;
    const anchor = after ? sec.pages.findIndex((p) => p.id === after) : -1;
    const entry: PageEntry = { id: page.id, title: page.title, level: anchor >= 0 ? sec.pages[anchor].level : 0, modified: now };
    sec.pages.splice(anchor >= 0 ? anchor + 1 : sec.pages.length, 0, entry);
    normaliseLevels(sec.pages);
    this.persist();
    return copy(page);
  }

  async getPage(nbId: string, _secId: string, id: string) {
    const page = this.nb(nbId).pages[id];
    if (!page) throw new Error('page not found');
    return copy(page);
  }

  async savePage(nbId: string, secId: string, page: Page) {
    const nb = this.nb(nbId);
    const entry = this.sec(nbId, secId).pages.find((p) => p.id === page.id);
    if (!entry) throw new Error('page not found');
    const now = Date.now();
    nb.pages[page.id] = { ...copy(page), title: page.title.trim(), created: nb.pages[page.id]?.created ?? page.created, modified: now };
    entry.title = page.title.trim();
    entry.modified = now;
    nb.modified = now;
    this.persist();
    return copy(entry);
  }

  async deletePage(nbId: string, secId: string, id: string) {
    const nb = this.nb(nbId);
    const sec = this.sec(nbId, secId);
    sec.pages = sec.pages.filter((p) => p.id !== id);
    normaliseLevels(sec.pages);
    delete nb.pages[id];
    this.persist();
  }

  async setPageOrder(nbId: string, secId: string, order: PageOrder[]) {
    const sec = this.sec(nbId, secId);
    sec.pages = order.map((o) => {
      const entry = sec.pages.find((p) => p.id === o.id);
      if (!entry) throw new Error('page order does not match the section');
      return { ...entry, level: o.level };
    });
    normaliseLevels(sec.pages);
    this.persist();
    return copy(sec.pages);
  }

  async movePage(nbId: string, from: string, id: string, to: string) {
    if (from === to) return;
    const src = this.sec(nbId, from);
    const dst = this.sec(nbId, to);
    const entry = src.pages.find((p) => p.id === id);
    if (!entry) throw new Error('page not found');
    src.pages = src.pages.filter((p) => p.id !== id);
    normaliseLevels(src.pages);
    dst.pages.push({ ...entry, level: 0 });
    this.persist();
  }

  async saveAsset(_nbId: string, bytes: Uint8Array) {
    const sig = Array.from(bytes.subarray(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const ext = sig === '89504e47' ? 'png' : sig.startsWith('ffd8ff') ? 'jpg' : sig === '47494638' ? 'gif' : sig === '52494646' ? 'webp' : null;
    if (!ext) throw new Error('invalid asset: not a PNG, JPEG, GIF or WebP image');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    const name = `${Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')}.${ext}`;
    this.data.assets[name] = `data:${MIME[ext]};base64,${toBase64(bytes)}`;
    this.persist();
    return name;
  }

  async assetUrl(_nbId: string, name: string) {
    const url = this.data.assets[name];
    if (!url) throw new Error('image not found');
    return url;
  }

  async search(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];
    if (!terms.length) return hits;
    for (const nb of Object.values(this.data.notebooks)) {
      for (const sec of nb.sections) {
        for (const entry of sec.pages) {
          const page = nb.pages[entry.id];
          if (!page) continue;
          const body = page.blocks.map((b) => (b.kind === 'text' ? htmlToText(b.html) : b.kind === 'image' ? b.alt : '')).join(' ');
          const title = page.title.toLowerCase();
          const lower = body.toLowerCase();
          if (!terms.every((t) => title.includes(t) || lower.includes(t))) continue;
          const at = Math.max(0, ...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).slice(0, 1));
          const start = Math.max(0, at - 40);
          hits.push({
            notebookId: nb.id,
            notebookTitle: nb.title,
            sectionId: sec.id,
            sectionTitle: sec.title,
            pageId: page.id,
            pageTitle: page.title,
            snippet: (start > 0 ? '…' : '') + body.slice(start, start + 140) + (start + 140 < body.length ? '…' : ''),
            titleMatch: terms.every((t) => title.includes(t)),
            modified: page.modified,
          });
        }
      }
    }
    return hits.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.modified - a.modified).slice(0, 100);
  }

  async importOneNote(): Promise<ImportSummary | null> {
    throw new Error('Importing OneNote files needs the desktop app, which can read files from your computer.');
  }

  async openExternal(url: string) { window.open(url, '_blank', 'noopener,noreferrer'); }
  async revealLibrary() { /* nothing to reveal in a browser */ }
}

export function createBackend(): Backend {
  return '__TAURI_INTERNALS__' in window ? new DesktopBackend() : new DemoBackend();
}
