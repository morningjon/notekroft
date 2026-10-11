// The freeform page canvas: note containers you can click anywhere to create,
// drag, and resize, plus pictures and ink. Rich text is edited in place with
// contenteditable and stored as a small sanitised subset of HTML.

import type { Block, ImageBlock, InkBlock, Stroke, TextBlock } from './api';
import { absoluteStrokes, blockFromAbsolute, inkSvg, pathData, shapePoints, type Point, type Shape } from './ink';
import { normaliseColour, normaliseStyle, normaliseUrl, NOTE_TAGS, sanitizeHtml, type NoteTag } from './sanitize';
import { h, type MenuItem } from './widgets';

export interface EditorHost {
  /** Something on the page changed and should be saved. */
  onChange(): void;
  /** The caret, formatting or tool changed; the ribbon may need refreshing. */
  onSelection(): void;
  assetUrl(name: string): Promise<string>;
  saveImage(bytes: Uint8Array): Promise<string>;
  openLink(url: string): void;
  showMenu(x: number, y: number, items: MenuItem[]): void;
  notify(message: string): void;
}

export type ParagraphStyle = 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'quote' | 'cite' | 'code';
export type Alignment = 'left' | 'center' | 'right' | 'justify';

export type ToggleCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikeThrough'
  | 'subscript'
  | 'superscript'
  | 'insertUnorderedList'
  | 'insertOrderedList';

export type Command = ToggleCommand | 'removeFormat' | 'indent' | 'outdent';

export type FormatState = Record<ToggleCommand, boolean> & {
  /** Explicit font at the caret, or '' for the default. */
  font: string;
  /** Text size at the caret, in points. */
  size: number;
  align: Alignment;
  style: ParagraphStyle;
  todo: boolean;
  tag: NoteTag | null;
};

export type Tool =
  | { kind: 'type' }
  | { kind: 'pen'; color: string; width: number; opacity: number }
  | { kind: 'eraser' }
  | { kind: 'shape'; shape: Shape; color: string; width: number };

/** Formatting carried by the format painter. */
interface Paint {
  toggles: ToggleCommand[];
  font: string;
  size: number | null;
  color: string | null;
  highlight: string | null;
}

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 120;
const MAX_IMAGE_WIDTH = 560;
const TODO_GUTTER = 24;
/** Points for the legacy 1 to 7 font sizes that browsers still produce. */
const LEGACY_SIZES = [8, 10, 12, 14, 18, 24, 36];
const INLINE_TOGGLES: ToggleCommand[] = ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript'];
const HISTORY_LIMIT = 100;
/** Strokes drawn this soon after one another join the same drawing. */
const INK_GROUP_MS = 1500;

const px = (n: number) => `${Math.round(n)}px`;
const num = (s: string) => Number.parseFloat(s) || 0;
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const firstFont = (family: string) => family.split(',')[0].trim().replace(/^["']|["']$/g, '');

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

function cleanClass(el: Element) {
  if (!el.getAttribute('class')) el.removeAttribute('class');
}

export class Editor {
  /** Colours the highlight and font-colour buttons apply. */
  highlightColor = '#ffff00';
  fontColor = '#c00000';

  private tool: Tool = { kind: 'type' };
  private scale = 1;
  private selected: HTMLElement | null = null;
  private lastRange: Range | null = null;
  private inkData = new WeakMap<HTMLElement, InkBlock>();
  private lastInk: { el: HTMLElement; time: number } | null = null;
  private pendingSize: number | null = null;
  private paint: Paint | null = null;

  private history: string[] = [];
  private cursor = -1;
  private snapshotTimer = 0;
  /** A change has happened that is not yet in the history. */
  private pending = false;

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
    document.addEventListener('mouseup', () => this.applyPaint());
    document.addEventListener('selectionchange', () => {
      const content = this.currentContent();
      const sel = window.getSelection();
      if (content && sel && sel.rangeCount) this.lastRange = sel.getRangeAt(0).cloneRange();
      this.host.onSelection();
    });
  }

  // ---- loading and saving ----------------------------------------------------

  /** Show a page's blocks. This starts a fresh undo history. */
  load(blocks: Block[]) {
    this.render(blocks);
    clearTimeout(this.snapshotTimer);
    this.pending = false;
    this.history = [JSON.stringify(this.serialize())];
    this.cursor = 0;
  }

  private render(blocks: Block[]) {
    this.canvas.replaceChildren();
    this.selected = null;
    this.lastRange = null;
    this.lastInk = null;
    for (const b of blocks) {
      if (b.kind === 'text') this.addText(b);
      else if (b.kind === 'image') this.addImage(b);
      else this.addInk(b);
    }
    this.fit();
  }

  serialize(): Block[] {
    const out: Block[] = [];
    for (const el of Array.from(this.canvas.children) as HTMLElement[]) {
      const x = num(el.style.left);
      const y = num(el.style.top);
      const id = el.dataset.id!;
      if (el.classList.contains('text')) {
        const content = el.querySelector<HTMLElement>('.content')!;
        if (this.isEmpty(content)) continue;
        out.push({ kind: 'text', id, x, y, w: num(el.style.width), html: sanitizeHtml(content.innerHTML) });
      } else if (el.classList.contains('image')) {
        out.push({ kind: 'image', id, x, y, w: num(el.style.width), h: num(el.style.height), asset: el.dataset.asset!, alt: '' });
      } else if (el.classList.contains('ink')) {
        const data = this.inkData.get(el);
        if (data?.strokes.length) out.push({ ...data, x, y });
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

  // ---- undo and redo ---------------------------------------------------------
  // One history for everything on the page: typing, formatting, moving
  // containers, pictures and ink. Each step is a snapshot of the page.

  get canUndo() {
    return this.cursor > 0 || this.pending;
  }

  get canRedo() {
    return this.cursor < this.history.length - 1;
  }

  private snapshot() {
    clearTimeout(this.snapshotTimer);
    this.pending = false;
    const now = JSON.stringify(this.serialize());
    if (now === this.history[this.cursor]) return;
    this.history.length = this.cursor + 1;
    this.history.push(now);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.cursor = this.history.length - 1;
  }

  undo() {
    this.snapshot();
    if (this.cursor > 0) this.restore(this.cursor - 1);
  }

  redo() {
    if (this.canRedo) this.restore(this.cursor + 1);
  }

  private restore(index: number) {
    const focused = this.currentContent()?.parentElement?.dataset.id;
    this.cursor = index;
    this.render(JSON.parse(this.history[index]) as Block[]);
    if (focused) {
      const content = this.canvas.querySelector<HTMLElement>(`.block.text[data-id="${CSS.escape(focused)}"] .content`);
      if (content) {
        content.focus();
        caretIn(content, true);
      }
    }
    this.host.onChange();
    this.host.onSelection();
  }

  /** Record a change. Typing is grouped into steps by short pauses; anything
   *  discrete (a move, a stroke, a format) is its own step. */
  private changed(discrete = false) {
    this.fit();
    this.host.onChange();
    this.host.onSelection();
    clearTimeout(this.snapshotTimer);
    this.pending = true;
    if (discrete) this.snapshot();
    else this.snapshotTimer = window.setTimeout(() => this.snapshot(), 500);
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
    this.hydrate(content);
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
      if (e.target === handle || this.tool.kind !== 'type') return null;
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

  private addInk(b: InkBlock): HTMLElement {
    const el = h('div', 'block ink');
    el.dataset.id = b.id;
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    el.append(inkSvg(b.strokes));
    this.inkData.set(el, b);
    this.canvas.append(el);

    // Only the lines themselves take clicks, so the space between them
    // still starts a note.
    this.drag(el, () => {
      if (this.tool.kind !== 'type') return null;
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.select(el);
      const x0 = num(el.style.left);
      const y0 = num(el.style.top);
      return (dx, dy) => {
        el.style.left = `${Math.max(0, x0 + dx)}px`;
        el.style.top = `${Math.max(0, y0 + dy)}px`;
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
        move((ev.clientX - sx) / this.scale, (ev.clientY - sy) / this.scale);
      };
      const onUp = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        end?.();
        if (moved) this.changed(true);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    });
  }

  private select(el: HTMLElement | null) {
    this.selected?.classList.remove('selected');
    this.selected = el;
    el?.classList.add('selected');
  }

  private isEmpty(content: HTMLElement): boolean {
    return (content.textContent ?? '').trim() === '' && !content.querySelector('table, img, hr');
  }

  /** Give inline pictures something to show. Stored HTML only names the
   *  asset; the address is filled in here and stripped again on save. */
  private hydrate(content: HTMLElement) {
    for (const img of Array.from(content.querySelectorAll<HTMLImageElement>('img[data-asset]'))) {
      if (img.getAttribute('src')) continue;
      img.draggable = false;
      this.host.assetUrl(img.dataset.asset!).then(
        (url) => (img.src = url),
        () => img.classList.add('missing'),
      );
    }
  }

  /** Move apart any text or pictures that overlap, working down the page.
   *  Imported pages keep the positions another application gave them, but
   *  the same text takes up different room here. Ink is left alone: it is
   *  meant to sit on top of things. Resolves to true if anything moved. */
  async reflow(): Promise<boolean> {
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const gap = 12;
    const blocks = (Array.from(this.canvas.querySelectorAll(':scope > .text, :scope > .image')) as HTMLElement[])
      .map((el) => ({ el, left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const settled: typeof blocks = [];
    let moved = false;
    for (const block of blocks) {
      for (let again = true; again; ) {
        again = false;
        for (const other of settled) {
          const sideBySide = block.left >= other.left + other.width || other.left >= block.left + block.width;
          const clear = block.top >= other.top + other.height + gap || other.top >= block.top + block.height;
          if (!sideBySide && !clear) {
            block.top = other.top + other.height + gap;
            again = true;
          }
        }
      }
      if (block.top !== block.el.offsetTop) {
        block.el.style.top = px(block.top);
        moved = true;
      }
      settled.push(block);
    }
    this.fit();
    // Not something to undo back past.
    this.history = [JSON.stringify(this.serialize())];
    this.cursor = 0;
    return moved;
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

  /** Where a pointer event falls on the page, whatever the zoom. */
  private point(e: { clientX: number; clientY: number }): Point {
    const box = this.canvas.getBoundingClientRect();
    return [(e.clientX - box.left) / this.scale, (e.clientY - box.top) / this.scale];
  }

  /** Tell the editor how far the page is zoomed, so pointer movement maps
   *  onto page distances. */
  setScale(scale: number) {
    this.scale = scale;
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

  /** Every paragraph and list item the selection touches. */
  private selectedLines(content: HTMLElement): HTMLElement[] {
    this.lineBlock(content);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const out: HTMLElement[] = [];
    const visit = (parent: HTMLElement) => {
      for (const child of Array.from(parent.children) as HTMLElement[]) {
        if (!range.intersectsNode(child)) continue;
        if (/^(UL|OL|BLOCKQUOTE)$/.test(child.tagName)) visit(child);
        else if (child.tagName === 'LI') {
          out.push(child);
          visit(child);
        } else if (/^(DIV|P|H[1-6])$/.test(child.tagName)) out.push(child);
      }
    };
    visit(content);
    return out;
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

  /** Run a DOM tidy-up that moves nodes about, then put the selection back
   *  where it was. Moving a node otherwise drags the caret out of it. */
  private keepingSelection(fn: (replaced: Map<Node, Node>) => void) {
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount
      ? { an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset }
      : null;
    const replaced = new Map<Node, Node>();
    fn(replaced);
    if (!saved || !saved.an || !saved.fn) return;
    const an = replaced.get(saved.an) ?? saved.an;
    const fnode = replaced.get(saved.fn) ?? saved.fn;
    if (!an.isConnected || !fnode.isConnected) return;
    const clamp = (node: Node, offset: number) =>
      Math.min(offset, node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : node.childNodes.length);
    try {
      sel!.setBaseAndExtent(an, clamp(an, saved.ao), fnode, clamp(fnode, saved.fo));
    } catch {
      /* the selection could not be restored; leave it where it fell */
    }
  }

  /** Browsers express formatting in several ways and leave debris behind
   *  when lines are joined. Bring a container back to the stored form:
   *  no <font>, only TwoNote's style properties, and nothing that merely
   *  restates what the text would look like anyway. */
  private tidy(content: HTMLElement) {
    if (!content.querySelector('font, [style]')) return;
    this.keepingSelection((replaced) => {
      for (const font of Array.from(content.querySelectorAll('font'))) {
        const span = h('span');
        const face = font.getAttribute('face');
        const color = font.getAttribute('color');
        const size = Number(font.getAttribute('size'));
        if (face) span.style.fontFamily = face;
        if (color) span.style.color = color;
        if (size >= 1 && size <= 7) {
          span.style.fontSize = `${size === 7 && this.pendingSize ? this.pendingSize : LEGACY_SIZES[size - 1]}pt`;
        }
        span.append(...Array.from(font.childNodes));
        font.replaceWith(span);
        replaced.set(font, span);
      }
      for (const el of Array.from(content.querySelectorAll<HTMLElement>('[style]'))) {
        const parent = el.parentElement;
        if (parent) {
          // A value equal to the inherited one says nothing.
          const own = getComputedStyle(el);
          const inherited = getComputedStyle(parent);
          if (el.style.fontSize && Math.abs(num(own.fontSize) - num(inherited.fontSize)) < 0.3) el.style.removeProperty('font-size');
          if (el.style.color && own.color === inherited.color) el.style.removeProperty('color');
          if (el.style.fontFamily && own.fontFamily === inherited.fontFamily) el.style.removeProperty('font-family');
          if (el.style.textAlign && /^(left|start)$/.test(own.textAlign)) el.style.removeProperty('text-align');
        }
        const style = normaliseStyle(el.getAttribute('style') ?? '');
        if (style) el.setAttribute('style', style);
        else el.removeAttribute('style');
      }
      for (const span of Array.from(content.querySelectorAll('span'))) {
        if (span.attributes.length) continue;
        const first = span.firstChild;
        span.replaceWith(...Array.from(span.childNodes));
        if (first) replaced.set(span, first);
      }
    });
  }

  /** Remove one style property from everything the selection touches. */
  private clearProperty(content: HTMLElement, property: string) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    this.keepingSelection((replaced) => {
      for (const el of Array.from(content.querySelectorAll<HTMLElement>('[style], mark'))) {
        if (!range.intersectsNode(el)) continue;
        if (el.tagName === 'MARK') {
          if (property !== 'background-color') continue;
          const first = el.firstChild;
          el.replaceWith(...Array.from(el.childNodes));
          if (first) replaced.set(el, first);
        } else {
          el.style.removeProperty(property);
        }
      }
    });
  }

  private withCss<T>(fn: () => T): T {
    document.execCommand('styleWithCSS', false, 'true');
    try {
      return fn();
    } finally {
      document.execCommand('styleWithCSS', false, 'false');
    }
  }

  /** The nearest explicitly set value of a style property at the caret. */
  private explicit(content: HTMLElement, property: 'fontFamily' | 'color' | 'backgroundColor'): string {
    const node = window.getSelection()?.anchorNode ?? null;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    for (; el && el !== content; el = el.parentElement) {
      if (el.style[property]) return el.style[property];
      if (property === 'backgroundColor' && el.tagName === 'MARK') return getComputedStyle(el).backgroundColor;
    }
    return '';
  }

  // ---- formatting commands (ribbon and shortcuts) ----------------------------

  formatState(): FormatState | null {
    const content = this.currentContent();
    if (!content) return null;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    const node = window.getSelection()?.anchorNode ?? null;
    const at = node instanceof Element ? node : (node?.parentElement ?? content);
    const line = at.closest<HTMLElement>('pre, h1, h2, h3, h4, h5, h6, li, div, p') ?? content;
    const classes = line === content ? null : line.classList;
    const computed = getComputedStyle(at);
    let style: ParagraphStyle = 'div';
    if (at.closest('pre')) style = 'code';
    else if (/^H[1-6]$/.test(line.tagName)) style = line.tagName.toLowerCase() as ParagraphStyle;
    else if (classes?.contains('quote')) style = 'quote';
    else if (classes?.contains('cite')) style = 'cite';
    const align = /^(center|right|justify)$/.test(computed.textAlign) ? (computed.textAlign as Alignment) : 'left';
    return {
      bold: q('bold'),
      italic: q('italic'),
      underline: q('underline'),
      strikeThrough: q('strikeThrough'),
      subscript: q('subscript'),
      superscript: q('superscript'),
      insertUnorderedList: q('insertUnorderedList'),
      insertOrderedList: q('insertOrderedList'),
      font: firstFont(this.explicit(content, 'fontFamily')),
      size: Math.round(num(computed.fontSize) * 0.75 * 2) / 2,
      align,
      style,
      todo: !!classes?.contains('todo'),
      tag: NOTE_TAGS.find((t) => classes?.contains(`tag-${t}`)) ?? null,
    };
  }

  exec(command: Command) {
    const content = this.ensureFocus();
    document.execCommand(command);
    this.tidy(content);
    this.changed(true);
  }

  setStyle(style: ParagraphStyle) {
    const content = this.ensureFocus();
    const tag = /^h[1-6]$/.test(style) ? style : style === 'code' ? 'pre' : 'div';
    document.execCommand('formatBlock', false, `<${tag}>`);
    for (const line of this.selectedLines(content)) {
      line.classList.remove('quote', 'cite');
      if (style === 'quote' || style === 'cite') line.classList.add(style);
      cleanClass(line);
    }
    this.tidy(content);
    this.changed(true);
  }

  /** Set the font, or pass null to go back to the default. */
  setFont(name: string | null) {
    const content = this.ensureFocus();
    if (name === null) this.clearProperty(content, 'font-family');
    else this.withCss(() => document.execCommand('fontName', false, name));
    this.tidy(content);
    this.changed(true);
  }

  setFontSize(points: number) {
    const content = this.ensureFocus();
    // The browser only knows sizes 1 to 7. Ask for 7, then rewrite what it
    // produced (now or as typing starts) with the size actually wanted.
    this.pendingSize = points;
    document.execCommand('fontSize', false, '7');
    this.tidy(content);
    this.changed(true);
  }

  /** Colour the text, or pass null for the automatic colour. */
  setColor(color: string | null) {
    const content = this.ensureFocus();
    if (color === null) this.clearProperty(content, 'color');
    else {
      this.fontColor = color;
      this.withCss(() => document.execCommand('foreColor', false, color));
    }
    this.tidy(content);
    this.changed(true);
  }

  /** Highlight the text, or pass null to remove highlighting. */
  setHighlight(color: string | null) {
    const content = this.ensureFocus();
    if (color === null) this.clearProperty(content, 'background-color');
    else {
      this.highlightColor = color;
      this.withCss(() => {
        if (!document.execCommand('hiliteColor', false, color)) document.execCommand('backColor', false, color);
      });
    }
    this.tidy(content);
    this.changed(true);
  }

  /** The highlight button and shortcut: on, or off if the caret is already
   *  inside that highlight. */
  toggleHighlight() {
    const content = this.ensureFocus();
    const here = normaliseColour(this.explicit(content, 'backgroundColor'));
    this.setHighlight(here && window.getSelection()?.isCollapsed ? null : this.highlightColor);
  }

  align(direction: Alignment) {
    const content = this.ensureFocus();
    const command = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' }[direction];
    this.withCss(() => document.execCommand(command));
    this.tidy(content);
    this.changed(true);
  }

  toggleTodo() {
    const content = this.ensureFocus();
    const lines = this.selectedLines(content);
    const on = !lines.every((l) => l.classList.contains('todo'));
    for (const line of lines) {
      line.classList.remove('todo', 'done', ...NOTE_TAGS.map((t) => `tag-${t}`));
      if (on) line.classList.add('todo');
      cleanClass(line);
    }
    this.changed(true);
  }

  /** Tag the selected paragraphs, or pass null to remove their tags. */
  setTag(tag: NoteTag | null) {
    const content = this.ensureFocus();
    const lines = this.selectedLines(content);
    const on = tag !== null && !lines.every((l) => l.classList.contains(`tag-${tag}`));
    for (const line of lines) {
      line.classList.remove('todo', 'done', ...NOTE_TAGS.map((t) => `tag-${t}`));
      if (on) line.classList.add(`tag-${tag}`);
      cleanClass(line);
    }
    this.changed(true);
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
    this.changed(true);
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
    this.changed(true);
    return true;
  }

  insertText(text: string) {
    this.ensureFocus();
    document.execCommand('insertText', false, text);
    this.changed(true);
  }

  insertRule() {
    this.ensureFocus();
    document.execCommand('insertHTML', false, '<hr><div><br></div>');
    this.changed(true);
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
        this.changed(true);
      } catch (err) {
        this.host.notify(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ---- clipboard and format painter ------------------------------------------

  cut() {
    if (this.currentContent() && document.execCommand('cut')) this.changed(true);
  }

  copy() {
    if (this.currentContent()) document.execCommand('copy');
  }

  /** Paste plain text. Reading the clipboard from a button needs permission
   *  the web view may not grant; Ctrl+V always works. */
  async paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.insertText(text);
    } catch {
      this.host.notify('Press Ctrl+V to paste.');
    }
  }

  get painting() {
    return this.paint !== null;
  }

  /** Pick up the formatting at the caret; the next selection made with the
   *  mouse receives it. Calling again cancels. */
  toggleFormatPainter() {
    const content = this.currentContent();
    const state = this.formatState();
    if (this.paint || !content || !state) {
      this.paint = null;
    } else {
      this.paint = {
        toggles: INLINE_TOGGLES.filter((t) => state[t]),
        font: state.font,
        size: state.style === 'div' && Math.abs(state.size - 11) > 0.01 ? state.size : null,
        color: normaliseColour(this.explicit(content, 'color')),
        highlight: normaliseColour(this.explicit(content, 'backgroundColor')),
      };
    }
    this.canvas.classList.toggle('painting', this.paint !== null);
    this.host.onSelection();
  }

  private applyPaint() {
    const paint = this.paint;
    const content = this.currentContent();
    if (!paint || !content || window.getSelection()?.isCollapsed) return;
    this.paint = null;
    this.canvas.classList.remove('painting');
    document.execCommand('removeFormat');
    for (const toggle of paint.toggles) document.execCommand(toggle);
    if (paint.font) this.withCss(() => document.execCommand('fontName', false, paint.font));
    if (paint.size) {
      this.pendingSize = paint.size;
      document.execCommand('fontSize', false, '7');
    }
    if (paint.color) this.withCss(() => document.execCommand('foreColor', false, paint.color!));
    if (paint.highlight) this.withCss(() => document.execCommand('hiliteColor', false, paint.highlight!));
    this.tidy(content);
    this.changed(true);
  }

  // ---- drawing ---------------------------------------------------------------

  get currentTool(): Tool {
    return this.tool;
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.lastInk = null;
    this.canvas.classList.toggle('tool-draw', tool.kind === 'pen' || tool.kind === 'shape');
    this.canvas.classList.toggle('tool-erase', tool.kind === 'eraser');
    if (tool.kind !== 'type') {
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.select(null);
    }
    this.host.onSelection();
  }

  /** Follow the pointer until it lifts, drawing a stroke or shape. */
  private draw(e: PointerEvent, tool: Extract<Tool, { kind: 'pen' | 'shape' }>) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.canvas.setPointerCapture(e.pointerId);
    const start = this.point(e);
    let points: Point[] = [start];
    let end = start;
    const opacity = tool.kind === 'pen' ? tool.opacity : 1;

    const live = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    live.setAttribute('class', 'ink-live');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke', tool.color);
    path.setAttribute('stroke-width', String(tool.width));
    path.setAttribute('stroke-opacity', String(opacity));
    path.setAttribute('d', pathData(points));
    live.append(path);
    this.canvas.append(live);

    const onMove = (ev: PointerEvent) => {
      for (const c of ev.getCoalescedEvents?.() ?? [ev]) {
        const p = this.point(c);
        const last = points[points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.2) points.push(p);
        end = p;
      }
      path.setAttribute('d', pathData(tool.kind === 'shape' ? shapePoints(tool.shape, start, end) : points));
    };
    const onUp = () => {
      this.canvas.removeEventListener('pointermove', onMove);
      this.canvas.removeEventListener('pointerup', onUp);
      this.canvas.removeEventListener('pointercancel', onUp);
      live.remove();
      if (tool.kind === 'shape') {
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 4) return;
        points = shapePoints(tool.shape, start, end);
      }
      const stroke: Stroke = { points, color: tool.color, width: tool.width };
      if (opacity < 1) stroke.opacity = opacity;
      this.commitStroke(stroke, tool.kind === 'pen');
    };
    this.canvas.addEventListener('pointermove', onMove);
    this.canvas.addEventListener('pointerup', onUp);
    this.canvas.addEventListener('pointercancel', onUp);
  }

  /** Add a finished stroke to the page. Pen strokes made in quick succession
   *  join one drawing, so a written word moves and deletes as a unit. */
  private commitStroke(stroke: Stroke, mayJoin: boolean) {
    const now = performance.now();
    const previous = this.lastInk;
    const data = previous && this.inkData.get(previous.el);
    if (mayJoin && previous && data && previous.el.isConnected && now - previous.time < INK_GROUP_MS) {
      const here = { ...data, x: num(previous.el.style.left), y: num(previous.el.style.top) };
      const merged = blockFromAbsolute(data.id, [...absoluteStrokes(here), stroke]);
      previous.el.remove();
      this.lastInk = { el: this.addInk(merged), time: now };
    } else {
      const el = this.addInk(blockFromAbsolute(crypto.randomUUID(), [stroke]));
      this.lastInk = mayJoin ? { el, time: now } : null;
    }
    this.changed(true);
  }

  /** Rub out whole strokes under the pointer until it lifts. */
  private erase(e: PointerEvent) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    let erased = false;
    const at = (ev: PointerEvent) => {
      for (const hit of document.elementsFromPoint(ev.clientX, ev.clientY)) {
        if (!hit.classList.contains('hit') || !this.canvas.contains(hit)) continue;
        const group = hit.parentElement as unknown as SVGGElement;
        const el = hit.closest<HTMLElement>('.block.ink');
        const data = el && this.inkData.get(el);
        if (!el || !data) continue;
        data.strokes.splice(Number(group.dataset.i), 1);
        if (data.strokes.length) el.replaceChildren(inkSvg(data.strokes));
        else el.remove();
        erased = true;
      }
    };
    at(e);
    const onUp = () => {
      this.canvas.removeEventListener('pointermove', at);
      this.canvas.removeEventListener('pointerup', onUp);
      this.canvas.removeEventListener('pointercancel', onUp);
      if (erased) this.changed(true);
    };
    this.canvas.addEventListener('pointermove', at);
    this.canvas.addEventListener('pointerup', onUp);
    this.canvas.addEventListener('pointercancel', onUp);
  }

  // ---- events ----------------------------------------------------------------

  private onCanvasPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const tool = this.tool;
    if (tool.kind === 'pen' || tool.kind === 'shape') return this.draw(e, tool);
    if (tool.kind === 'eraser') return this.erase(e);
    if (!(e.target as Element).closest('.block.image, .block.ink')) this.select(null);
    if (e.target !== this.canvas) return;
    // Clicking empty space starts a new note right there.
    e.preventDefault();
    const [x, y] = this.point(e);
    const el = this.addText({
      kind: 'text',
      id: crypto.randomUUID(),
      x: Math.max(0, x - 10),
      y: Math.max(0, y - 14),
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
    if (content) {
      if (e.inputType === 'insertParagraph') {
        // A new line after a ticked to-do starts unticked, and a tag stays
        // with the paragraph it was put on.
        this.closestIn<HTMLElement>(content, '.todo.done')?.classList.remove('done');
        const tagged = this.closestIn<HTMLElement>(content, '[class*="tag-"]');
        if (tagged) {
          tagged.classList.remove(...NOTE_TAGS.map((t) => `tag-${t}`));
          cleanClass(tagged);
        }
      }
      this.tidy(content);
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
    if (todo && (e.clientX - todo.getBoundingClientRect().left) / this.scale < TODO_GUTTER) {
      todo.classList.toggle('done');
      this.changed(true);
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
      this.changed(true);
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Enter') && !mod) {
      const todo = this.closestIn<HTMLElement>(content, '.todo');
      const emptyLine = todo && (todo.textContent ?? '').trim() === '';
      if (todo && ((e.key === 'Backspace' && this.caretAtStart(todo)) || (e.key === 'Enter' && emptyLine))) {
        e.preventDefault();
        todo.classList.remove('todo', 'done');
        cleanClass(todo);
        this.changed(true);
        return;
      }
    }

    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.altKey && e.shiftKey && !mod) {
      if (e.key === 'ArrowRight') run(() => this.exec('indent'));
      else if (e.key === 'ArrowLeft') run(() => this.exec('outdent'));
      return;
    }
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (e.altKey && /^[1-6]$/.test(e.key)) run(() => this.setStyle(`h${e.key}` as ParagraphStyle));
    else if (e.shiftKey && key === 'n') run(() => this.setStyle('div'));
    else if ((e.altKey || e.shiftKey) && key === 'h') run(() => this.toggleHighlight());
    else if (e.key === '.') run(() => this.exec('insertUnorderedList'));
    else if (e.key === '/') run(() => this.exec('insertOrderedList'));
    else if (e.key === '1' && !e.altKey) run(() => this.toggleTodo());
    else if (e.key === '2' && !e.altKey) run(() => this.setTag('important'));
    else if (e.key === '3' && !e.altKey) run(() => this.setTag('question'));
    else if (e.key === '4' && !e.altKey) run(() => this.setTag('remember'));
    else if (e.key === '5' && !e.altKey) run(() => this.setTag('definition'));
    else if (e.key === '0' && !e.altKey) run(() => this.setTag(null));
    else if (e.key === '-' && !e.shiftKey) run(() => this.exec('strikeThrough'));
    else if (e.key === '=' && !e.shiftKey) run(() => this.exec('subscript'));
    else if ((e.key === '+' || e.key === '=') && e.shiftKey) run(() => this.exec('superscript'));
    else if (key === 'l' && !e.shiftKey && !e.altKey) run(() => this.align('left'));
    else if (key === 'r' && !e.shiftKey && !e.altKey) run(() => this.align('right'));
  }

  private onDocumentKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (this.paint) this.toggleFormatPainter();
      if (this.tool.kind !== 'type') this.setTool({ kind: 'type' });
    }
    if (!this.selected) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.selected.remove();
      this.selected = null;
      this.changed(true);
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
    if (content) this.hydrate(content);
    this.changed(true);
  }

  private onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const [x, y] = this.point(e);
    void this.insertImages(files, { x: Math.max(0, x), y: Math.max(0, y) });
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
    if (!line || /^(TABLE|UL|OL|HR)$/.test(line.tagName)) return;
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
      this.changed(true);
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
