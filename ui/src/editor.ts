// The freeform page canvas: note containers you can click anywhere to create,
// drag, and resize, plus pictures. Rich text is edited in place with
// contenteditable and stored as a small sanitised subset of HTML.

import type { Block, ImageBlock, TextBlock } from './api';
import { normaliseUrl, sanitizeHtml } from './sanitize';
import { h, type MenuItem } from './widgets';

export interface EditorHost {
  /** Something on the page changed and should be saved. */
  onChange(): void;
  /** The caret moved; toolbar state may need refreshing. */
  onSelection(): void;
  assetUrl(name: string): Promise<string>;
  saveImage(bytes: Uint8Array): Promise<string>;
  openLink(url: string): void;
  showMenu(x: number, y: number, items: MenuItem[]): void;
  notify(message: string): void;
}

export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  insertUnorderedList: boolean;
  insertOrderedList: boolean;
}

export type InlineCommand = keyof FormatState;

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 120;
const MAX_IMAGE_WIDTH = 560;
const HIGHLIGHT = '#ffe866';
const TODO_GUTTER = 24;

const px = (n: number) => `${Math.round(n)}px`;
const num = (s: string) => Number.parseFloat(s) || 0;
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function caretIn(el: Node, atEnd = false) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function emptyCell(): HTMLTableCellElement {
  const td = h('td');
  td.append(h('br'));
  return td;
}

function newRow(columns: number): HTMLTableRowElement {
  const tr = h('tr');
  for (let i = 0; i < columns; i++) tr.append(emptyCell());
  return tr;
}

function measure(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 200, h: img.naturalHeight || 150 });
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = url;
  });
}

export class Editor {
  private selectedImage: HTMLElement | null = null;
  private lastRange: Range | null = null;

  constructor(
    private canvas: HTMLElement,
    private host: EditorHost,
  ) {
    canvas.addEventListener('pointerdown', (e) => this.onCanvasPointerDown(e));
    canvas.addEventListener('input', (e) => this.onInput(e as InputEvent));
    canvas.addEventListener('focusout', (e) => this.onFocusOut(e));
    canvas.addEventListener('keydown', (e) => this.onKeyDown(e));
    canvas.addEventListener('click', (e) => this.onClick(e));
    canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    canvas.addEventListener('drop', (e) => this.onDrop(e));
    document.addEventListener('paste', (e) => this.onPaste(e));
    document.addEventListener('keydown', (e) => this.onDocumentKeyDown(e));
    document.addEventListener('selectionchange', () => {
      const content = this.currentContent();
      const sel = window.getSelection();
      if (content && sel && sel.rangeCount) this.lastRange = sel.getRangeAt(0).cloneRange();
      this.host.onSelection();
    });
  }

  // ---- loading and saving ----------------------------------------------------

  load(blocks: Block[]) {
    this.canvas.replaceChildren();
    this.selectedImage = null;
    this.lastRange = null;
    for (const b of blocks) {
      if (b.kind === 'text') this.addText(b);
      else this.addImage(b);
    }
    this.fit();
  }

  serialize(): Block[] {
    const out: Block[] = [];
    for (const el of Array.from(this.canvas.children) as HTMLElement[]) {
      const base = { id: el.dataset.id!, x: num(el.style.left), y: num(el.style.top), w: num(el.style.width) };
      if (el.classList.contains('text')) {
        const content = el.querySelector<HTMLElement>('.content')!;
        if (this.isEmpty(content)) continue;
        out.push({ kind: 'text', ...base, html: sanitizeHtml(content.innerHTML) });
      } else if (el.classList.contains('image')) {
        out.push({ kind: 'image', ...base, h: num(el.style.height), asset: el.dataset.asset!, alt: '' });
      }
    }
    return out;
  }

  /** Put the caret in the top-most note container, creating one if needed. */
  focusFirst() {
    const contents = Array.from(this.canvas.querySelectorAll<HTMLElement>('.block.text'));
    contents.sort((a, b) => num(a.style.top) - num(b.style.top) || num(a.style.left) - num(b.style.left));
    const el = contents[0] ?? this.addText({ kind: 'text', id: crypto.randomUUID(), x: 0, y: 0, w: DEFAULT_WIDTH, html: '' });
    const content = el.querySelector<HTMLElement>('.content')!;
    content.focus();
    caretIn(content, true);
  }

  // ---- blocks ----------------------------------------------------------------

  private addText(b: TextBlock): HTMLElement {
    const el = h('div', 'block text');
    el.dataset.id = b.id;
    el.style.left = px(b.x);
    el.style.top = px(b.y);
    el.style.width = px(b.w);
    const grip = h('div', 'grip');
    grip.title = 'Drag to move';
    const content = h('div', 'content');
    content.contentEditable = 'true';
    content.spellcheck = true;
    content.innerHTML = sanitizeHtml(b.html);
    const handle = h('div', 'resize-e');
    handle.title = 'Drag to resize';
    el.append(grip, content, handle);
    this.canvas.append(el);

    this.drag(grip, () => {
      const x0 = num(el.style.left);
      const y0 = num(el.style.top);
      el.classList.add('moving');
      return (dx, dy) => {
        el.style.left = px(Math.max(0, x0 + dx));
        el.style.top = px(Math.max(0, y0 + dy));
      };
    }, () => el.classList.remove('moving'));
    this.drag(handle, () => {
      const w0 = num(el.style.width);
      return (dx) => {
        el.style.width = px(Math.max(MIN_WIDTH, w0 + dx));
      };
    });
    return el;
  }

  private addImage(b: ImageBlock): HTMLElement {
    const el = h('div', 'block image');
    el.dataset.id = b.id;
    el.dataset.asset = b.asset;
    el.style.left = px(b.x);
    el.style.top = px(b.y);
    el.style.width = px(b.w);
    el.style.height = px(b.h);
    const img = h('img');
    img.alt = b.alt;
    img.draggable = false;
    this.host.assetUrl(b.asset).then(
      (url) => (img.src = url),
      () => el.classList.add('missing'),
    );
    const handle = h('div', 'resize-se');
    handle.title = 'Drag to resize';
    el.append(img, handle);
    this.canvas.append(el);

    this.drag(el, (e) => {
      if (e.target === handle) return null;
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.select(el);
      const x0 = num(el.style.left);
      const y0 = num(el.style.top);
      return (dx, dy) => {
        el.style.left = px(Math.max(0, x0 + dx));
        el.style.top = px(Math.max(0, y0 + dy));
      };
    });
    this.drag(handle, () => {
      const w0 = num(el.style.width);
      const ratio = w0 / Math.max(1, num(el.style.height));
      return (dx) => {
        const w = Math.max(24, Math.min(4000, w0 + dx));
        el.style.width = px(w);
        el.style.height = px(w / ratio);
      };
    });
    return el;
  }

  /** Wire a pointer drag. `start` returns the move handler, or null to decline. */
  private drag(
    target: HTMLElement,
    start: (e: PointerEvent) => ((dx: number, dy: number) => void) | null,
    end?: () => void,
  ) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const move = start(e);
      if (!move) return;
      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        moved = true;
        move(ev.clientX - sx, ev.clientY - sy);
      };
      const onUp = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        end?.();
        if (moved) {
          this.fit();
          this.host.onChange();
        }
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    });
  }

  private select(el: HTMLElement | null) {
    this.selectedImage?.classList.remove('selected');
    this.selectedImage = el;
    el?.classList.add('selected');
  }

  private isEmpty(content: HTMLElement): boolean {
    return (content.textContent ?? '').trim() === '' && !content.querySelector('table');
  }

  /** Keep the canvas comfortably larger than its contents so there is always
   *  room to click below and to the right. */
  private fit() {
    let right = 0;
    let bottom = 0;
    for (const el of Array.from(this.canvas.children) as HTMLElement[]) {
      right = Math.max(right, el.offsetLeft + el.offsetWidth);
      bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
    }
    this.canvas.style.minWidth = px(right + 240);
    this.canvas.style.minHeight = px(bottom + 360);
  }

  private freeSpot(): { x: number; y: number } {
    const active = this.currentContent()?.parentElement;
    if (active) return { x: num(active.style.left), y: active.offsetTop + active.offsetHeight + 12 };
    let bottom = 0;
    for (const el of Array.from(this.canvas.children) as HTMLElement[]) {
      bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
    }
    return { x: 0, y: bottom ? bottom + 16 : 0 };
  }

  // ---- selection helpers -----------------------------------------------------

  /** The note container holding the caret, if one has focus. */
  private currentContent(): HTMLElement | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains('content') && this.canvas.contains(active)) {
      return active;
    }
    return null;
  }

  private ensureFocus(): HTMLElement {
    const current = this.currentContent();
    if (current) return current;
    const range = this.lastRange;
    if (range && this.canvas.contains(range.startContainer)) {
      const start = range.startContainer;
      const content = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>('.content');
      if (content) {
        content.focus();
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        return content;
      }
    }
    const spot = this.freeSpot();
    const el = this.addText({ kind: 'text', id: crypto.randomUUID(), ...spot, w: DEFAULT_WIDTH, html: '' });
    const content = el.querySelector<HTMLElement>('.content')!;
    content.focus();
    return content;
  }

  /** The top-level line (div, heading, list, table) containing the caret. */
  private lineBlock(content: HTMLElement): HTMLElement | null {
    const find = (): Node | null => {
      let n: Node | null = window.getSelection()?.anchorNode ?? null;
      if (n === content) return null;
      while (n && n.parentNode !== content) n = n.parentNode;
      return n;
    };
    let n = find();
    if (!(n instanceof HTMLElement)) {
      document.execCommand('formatBlock', false, '<div>');
      n = find();
    }
    return n instanceof HTMLElement ? n : null;
  }

  private closestIn<T extends Element>(content: HTMLElement, selector: string): T | null {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement;
    const found = el?.closest<T>(selector) ?? null;
    return found && content.contains(found) && (found as Element) !== content ? found : null;
  }

  private caretAtStart(el: Element): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.rangeCount) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(sel.anchorNode!, sel.anchorOffset);
    return range.toString() === '';
  }

  private changed() {
    this.fit();
    this.host.onChange();
    this.host.onSelection();
  }

  // ---- formatting commands (toolbar and shortcuts) ---------------------------

  formatState(): FormatState | null {
    if (!this.currentContent()) return null;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    return {
      bold: q('bold'),
      italic: q('italic'),
      underline: q('underline'),
      strikeThrough: q('strikeThrough'),
      insertUnorderedList: q('insertUnorderedList'),
      insertOrderedList: q('insertOrderedList'),
    };
  }

  exec(command: InlineCommand | 'removeFormat') {
    this.ensureFocus();
    document.execCommand(command);
    this.changed();
  }

  heading(tag: 'h1' | 'h2' | 'h3' | 'div') {
    this.ensureFocus();
    document.execCommand('formatBlock', false, `<${tag}>`);
    this.changed();
  }

  highlight() {
    const content = this.ensureFocus();
    const mark = this.closestIn<HTMLElement>(content, 'mark');
    if (mark && window.getSelection()?.isCollapsed) {
      mark.replaceWith(...Array.from(mark.childNodes));
    } else {
      if (!document.execCommand('hiliteColor', false, HIGHLIGHT)) {
        document.execCommand('backColor', false, HIGHLIGHT);
      }
      this.tidy(content);
    }
    this.changed();
  }

  /** Browsers express highlight (and sometimes other formatting) as inline
   *  styles. Stored notes carry no styles, so translate what we mean to keep
   *  and drop the rest. */
  private tidy(content: HTMLElement) {
    for (const el of Array.from(content.querySelectorAll<HTMLElement>('[style], font'))) {
      const wrapper = /^(SPAN|FONT)$/.test(el.tagName);
      let inner: HTMLElement | null = null;
      if (el.style.backgroundColor && el.tagName !== 'MARK') {
        inner = h('mark');
        inner.append(...Array.from(el.childNodes));
      }
      if (wrapper) {
        el.replaceWith(...(inner ? [inner] : Array.from(el.childNodes)));
      } else {
        // The browser put the colour on an existing element, such as <b>.
        el.removeAttribute('style');
        if (inner) el.append(inner);
      }
    }
  }

  toggleTodo() {
    const content = this.ensureFocus();
    let target: HTMLElement | null =
      this.closestIn<HTMLElement>(content, 'li') ?? this.lineBlock(content);
    if (target && !/^(DIV|P|LI)$/.test(target.tagName)) {
      if (/^(TABLE|UL|OL)$/.test(target.tagName)) return;
      document.execCommand('formatBlock', false, '<div>');
      target = this.lineBlock(content);
    }
    if (!target) return;
    if (target.classList.contains('todo')) target.classList.remove('todo', 'done');
    else target.classList.add('todo');
    if (!target.getAttribute('class')) target.removeAttribute('class');
    this.changed();
  }

  insertTable(rows = 3, columns = 3) {
    const content = this.ensureFocus();
    if (this.closestIn(content, 'td, th')) return;
    const cell = '<td><br></td>';
    const first = '<td id="tn-first"><br></td>';
    const body = Array.from({ length: rows }, (_, r) =>
      `<tr>${r === 0 ? first + cell.repeat(columns - 1) : cell.repeat(columns)}</tr>`).join('');
    document.execCommand('insertHTML', false, `<table><tbody>${body}</tbody></table><div><br></div>`);
    const target = content.querySelector('#tn-first');
    if (target) {
      target.removeAttribute('id');
      caretIn(target);
    }
    this.changed();
  }

  /** Returns false if the address is not one TwoNote will link to. */
  insertLink(input: string): boolean {
    const url = normaliseUrl(input);
    if (!url) return false;
    this.ensureFocus();
    if (window.getSelection()?.isCollapsed) {
      document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(input.trim())}</a>&nbsp;`);
    } else {
      document.execCommand('createLink', false, url);
    }
    this.changed();
    return true;
  }

  async insertImages(files: Iterable<Blob>, at?: { x: number; y: number }) {
    let spot = at ?? this.freeSpot();
    for (const file of files) {
      try {
        const name = await this.host.saveImage(new Uint8Array(await file.arrayBuffer()));
        const size = await measure(await this.host.assetUrl(name));
        const scale = Math.min(1, MAX_IMAGE_WIDTH / size.w);
        const el = this.addImage({
          kind: 'image',
          id: crypto.randomUUID(),
          x: spot.x,
          y: spot.y,
          w: size.w * scale,
          h: size.h * scale,
          asset: name,
          alt: '',
        });
        this.select(el);
        spot = { x: spot.x, y: spot.y + size.h * scale + 12 };
        this.changed();
      } catch (err) {
        this.host.notify(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ---- events ----------------------------------------------------------------

  private onCanvasPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (!(e.target as Element).closest('.block.image')) this.select(null);
    if (e.target !== this.canvas) return;
    // Clicking empty space starts a new note right there.
    e.preventDefault();
    const el = this.addText({
      kind: 'text',
      id: crypto.randomUUID(),
      x: Math.max(0, e.offsetX - 10),
      y: Math.max(0, e.offsetY - 14),
      w: DEFAULT_WIDTH,
      html: '',
    });
    el.querySelector<HTMLElement>('.content')!.focus();
    this.fit();
  }

  private onFocusOut(e: FocusEvent) {
    const content = e.target as HTMLElement;
    if (!content.classList?.contains('content')) return;
    // Containers left empty disappear, as they do in OneNote.
    setTimeout(() => {
      if (document.activeElement !== content && document.hasFocus() && content.isConnected && this.isEmpty(content)) {
        content.parentElement?.remove();
        this.changed();
      }
    }, 0);
  }

  private onInput(e: InputEvent) {
    const content = this.currentContent();
    if (content && e.inputType === 'insertParagraph') {
      // A new line after a ticked to-do starts unticked.
      this.closestIn<HTMLElement>(content, '.todo.done')?.classList.remove('done');
    }
    this.changed();
  }

  private onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const link = target.closest('a');
    if (link) {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (href && (e.ctrlKey || e.metaKey)) this.host.openLink(href);
      return;
    }
    const todo = target.closest<HTMLElement>('.todo');
    if (todo && e.clientX - todo.getBoundingClientRect().left < TODO_GUTTER) {
      todo.classList.toggle('done');
      this.changed();
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    const content = this.currentContent();
    if (!content) return;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const cell = this.closestIn<HTMLTableCellElement>(content, 'td, th');
      if (cell) this.moveCell(cell, e.shiftKey);
      else if (this.closestIn(content, 'li')) document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      else if (!e.shiftKey) this.lineToTable(content);
      this.changed();
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Enter') && !mod) {
      const todo = this.closestIn<HTMLElement>(content, '.todo');
      const emptyLine = todo && (todo.textContent ?? '').trim() === '';
      if (todo && ((e.key === 'Backspace' && this.caretAtStart(todo)) || (e.key === 'Enter' && emptyLine))) {
        e.preventDefault();
        todo.classList.remove('todo', 'done');
        if (!todo.getAttribute('class')) todo.removeAttribute('class');
        this.changed();
        return;
      }
    }

    if (!mod) return;
    const key = e.key.toLowerCase();
    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.altKey && ['1', '2', '3'].includes(e.key)) run(() => this.heading(`h${e.key}` as 'h1'));
    else if (e.shiftKey && key === 'n') run(() => this.heading('div'));
    else if ((e.altKey || e.shiftKey) && key === 'h') run(() => this.highlight());
    else if (e.key === '.') run(() => this.exec('insertUnorderedList'));
    else if (e.key === '/') run(() => this.exec('insertOrderedList'));
    else if (e.key === '1' && !e.altKey) run(() => this.toggleTodo());
    else if (e.key === '-' && !e.shiftKey) run(() => this.exec('strikeThrough'));
  }

  private onDocumentKeyDown(e: KeyboardEvent) {
    if (!this.selectedImage) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.selectedImage.remove();
      this.selectedImage = null;
      this.changed();
    } else if (e.key === 'Escape') {
      this.select(null);
    }
  }

  private onPaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    const target = e.target as HTMLElement | null;
    if (!data || !this.canvas.isConnected || this.canvas.closest('[hidden]')) return;
    const content = target?.closest?.<HTMLElement>('.content') ?? null;
    const inCanvas = content && this.canvas.contains(content);
    if (!inCanvas && target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

    const images = Array.from(data.files).filter((f) => f.type.startsWith('image/'));
    if (images.length) {
      e.preventDefault();
      void this.insertImages(images);
      return;
    }
    if (!inCanvas) return;
    e.preventDefault();
    const html = data.getData('text/html');
    if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
    else document.execCommand('insertText', false, data.getData('text/plain'));
    this.changed();
  }

  private onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const box = this.canvas.getBoundingClientRect();
    void this.insertImages(files, { x: Math.max(0, e.clientX - box.left), y: Math.max(0, e.clientY - box.top) });
  }

  // ---- tables ----------------------------------------------------------------

  private moveCell(cell: HTMLTableCellElement, back: boolean) {
    const table = cell.closest('table')!;
    const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td, th')).filter(
      (c) => c.closest('table') === table,
    );
    let target = cells[cells.indexOf(cell) + (back ? -1 : 1)];
    if (!target && !back) {
      // Tab in the last cell adds a row.
      const row = cell.parentElement as HTMLTableRowElement;
      const added = newRow(row.cells.length);
      row.after(added);
      target = added.cells[0];
    }
    if (!target) return;
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** OneNote's shortcut: Tab at the end of a line turns it into a table. */
  private lineToTable(content: HTMLElement) {
    const line = this.lineBlock(content);
    if (!line || /^(TABLE|UL|OL)$/.test(line.tagName)) return;
    const first = h('td');
    first.append(...Array.from(line.childNodes));
    if (!first.firstChild) first.append(h('br'));
    const second = emptyCell();
    const row = h('tr');
    row.append(first, second);
    const body = h('tbody');
    body.append(row);
    const table = h('table');
    table.append(body);
    line.replaceWith(table);
    if (!table.nextSibling) {
      const tail = h('div');
      tail.append(h('br'));
      table.after(tail);
    }
    caretIn(second);
  }

  private onContextMenu(e: MouseEvent) {
    const cell = (e.target as Element).closest<HTMLTableCellElement>('td, th');
    if (!cell || !this.canvas.contains(cell)) return;
    e.preventDefault();
    const row = cell.parentElement as HTMLTableRowElement;
    const table = cell.closest('table')!;
    const rows = Array.from(table.rows);
    const index = cell.cellIndex;
    const apply = (fn: () => void) => () => {
      fn();
      this.changed();
    };
    const addColumn = (offset: number) => {
      for (const r of rows) {
        const ref = r.cells[Math.min(index, r.cells.length - 1)];
        if (!ref) r.append(emptyCell());
        else if (offset) ref.after(emptyCell());
        else ref.before(emptyCell());
      }
    };
    this.host.showMenu(e.clientX, e.clientY, [
      { label: 'Insert row above', onSelect: apply(() => row.before(newRow(row.cells.length))) },
      { label: 'Insert row below', onSelect: apply(() => row.after(newRow(row.cells.length))) },
      { label: 'Insert column left', onSelect: apply(() => addColumn(0)) },
      { label: 'Insert column right', onSelect: apply(() => addColumn(1)) },
      'separator',
      {
        label: 'Delete row',
        danger: true,
        onSelect: apply(() => (rows.length > 1 ? row.remove() : table.remove())),
      },
      {
        label: 'Delete column',
        danger: true,
        onSelect: apply(() => {
          if (row.cells.length <= 1) table.remove();
          else for (const r of rows) r.cells[index]?.remove();
        }),
      },
      { label: 'Delete table', danger: true, onSelect: apply(() => table.remove()) },
    ]);
  }
}
