// The ribbon: a row of tabs, each showing one strip of controls. Controls
// never take focus, so they act on the text selection without disturbing it.

import { icon } from './icons';
import { closeMenu, h, showMenu, showPanel, type MenuItem } from './widgets';

interface Common {
  title: string;
  disabled?: () => boolean;
}

export type Control =
  | 'separator'
  | (Common & {
      kind: 'button';
      icon?: string;
      /** Text shown in the button, or a function for text that changes. */
      label?: string | (() => string);
      /** Extra class for the label, e.g. to style a B as bold. */
      labelClass?: string;
      pressed?: () => boolean;
      onClick: () => void;
    })
  | (Common & {
      kind: 'menu';
      icon?: string;
      label?: string | (() => string);
      /** Fixed width in pixels, for combo boxes whose text changes. */
      width?: number;
      items: () => MenuItem[];
    })
  | (Common & {
      kind: 'panel';
      icon?: string;
      label?: string;
      /** Build the panel's content; call `close` when a choice is made. */
      build: (close: () => void) => HTMLElement;
    })
  | (Common & {
      /** A button with a colour bar, plus an arrow that opens a palette. */
      kind: 'colour';
      glyph: string;
      glyphClass?: string;
      color: () => string;
      onClick: () => void;
      items: () => MenuItem[];
    })
  | (Common & {
      /** A pen: a toggle button drawn in the pen's own colour. */
      kind: 'pen';
      icon: string;
      color: () => string;
      pressed: () => boolean;
      onClick: () => void;
    });

export interface Tab {
  id: string;
  label: string;
  /** A tab with controls shows a strip; one with `menu` just opens a menu. */
  controls?: Control[];
  menu?: () => MenuItem[];
}

const text = (v: string | (() => string) | undefined) => (typeof v === 'function' ? v() : (v ?? ''));

function below(el: HTMLElement): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left, r.bottom + 4];
}

export class Ribbon {
  private refreshers: (() => void)[] = [];
  private active: string;
  private queued = false;

  constructor(
    private tabsEl: HTMLElement,
    private stripEl: HTMLElement,
    private tabs: Tab[],
    private onTab: (id: string) => void,
  ) {
    this.active = tabs.find((t) => t.controls)?.id ?? '';
    // Keep the caret where it is while the ribbon is being used.
    for (const el of [tabsEl, stripEl]) el.addEventListener('mousedown', (e) => e.preventDefault());
    this.renderTabs();
    this.renderStrip();
  }

  get tab() {
    return this.active;
  }

  select(id: string) {
    if (id === this.active || !this.tabs.find((t) => t.id === id)?.controls) return;
    this.active = id;
    this.renderTabs();
    this.renderStrip();
    this.onTab(id);
  }

  /** Bring pressed states, labels and colours up to date. Safe to call
   *  often: the work happens at most once per frame. */
  refresh() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      for (const fn of this.refreshers) fn();
    });
  }

  private renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.tabs.map((tab) => {
        const b = h('button', 'tab' + (tab.id === this.active ? ' active' : ''), tab.label);
        b.type = 'button';
        b.dataset.tab = tab.id;
        if (tab.controls) b.setAttribute('aria-pressed', String(tab.id === this.active));
        b.addEventListener('click', () => {
          if (tab.menu) showMenu(...below(b), tab.menu());
          else this.select(tab.id);
        });
        return b;
      }),
    );
  }

  private renderStrip() {
    closeMenu();
    this.refreshers = [];
    const tab = this.tabs.find((t) => t.id === this.active);
    this.stripEl.replaceChildren(...(tab?.controls ?? []).map((c) => this.build(c)));
    for (const fn of this.refreshers) fn();
  }

  private build(c: Control): HTMLElement {
    if (c === 'separator') return h('span', 'tool-sep');

    const button = (className: string) => {
      const b = h('button', className);
      b.type = 'button';
      b.title = c.title;
      if (c.disabled) this.refreshers.push(() => (b.disabled = c.disabled!()));
      return b;
    };
    const content = (b: HTMLElement, iconName?: string, label?: string | (() => string), labelClass = '') => {
      if (iconName) b.append(icon(iconName));
      if (label !== undefined) {
        const span = h('span', `tool-label ${labelClass}`.trim(), text(label));
        b.append(span);
        if (typeof label === 'function') this.refreshers.push(() => (span.textContent = label()));
      }
    };
    const caret = () => h('span', 'caret', '▾');

    switch (c.kind) {
      case 'button': {
        const b = button('tool');
        content(b, c.icon, c.label, c.labelClass);
        if (c.pressed) this.refreshers.push(() => b.setAttribute('aria-pressed', String(c.pressed!())));
        b.addEventListener('click', c.onClick);
        return b;
      }
      case 'menu': {
        const b = button('tool' + (c.width ? ' combo' : ''));
        if (c.width) b.style.width = `${c.width}px`;
        content(b, c.icon, c.label);
        b.append(caret());
        b.addEventListener('click', () => showMenu(...below(b), c.items()));
        return b;
      }
      case 'panel': {
        const b = button('tool');
        content(b, c.icon, c.label);
        b.append(caret());
        b.addEventListener('click', () => showPanel(...below(b), c.build(closeMenu)));
        return b;
      }
      case 'colour': {
        const wrap = h('span', 'split');
        const main = button('tool');
        const glyph = h('span', `glyph ${c.glyphClass ?? ''}`.trim(), c.glyph);
        const bar = h('span', 'colour-bar');
        main.append(glyph, bar);
        this.refreshers.push(() => bar.style.setProperty('--c', c.color()));
        main.addEventListener('click', c.onClick);
        const more = button('tool arrow');
        more.title = `${c.title}: choose a colour`;
        more.append(caret());
        more.addEventListener('click', () => showMenu(...below(wrap), c.items()));
        wrap.append(main, more);
        return wrap;
      }
      case 'pen': {
        const b = button('tool pen');
        b.append(icon(c.icon));
        this.refreshers.push(() => {
          b.style.setProperty('--c', c.color());
          b.setAttribute('aria-pressed', String(c.pressed()));
        });
        b.addEventListener('click', c.onClick);
        return b;
      }
    }
  }
}

/** A grid for choosing a table size by pointing at it. */
export function tableGrid(onPick: (rows: number, columns: number) => void): HTMLElement {
  const ROWS = 8;
  const COLS = 10;
  const box = h('div', 'table-grid');
  const label = h('div', 'grid-label', 'Insert table');
  const grid = h('div', 'grid-cells');
  const cells: HTMLElement[] = [];
  const paint = (rows: number, cols: number) => {
    cells.forEach((cell, i) => cell.classList.toggle('on', Math.floor(i / COLS) < rows && i % COLS < cols));
    label.textContent = rows ? `${cols} × ${rows} table` : 'Insert table';
  };
  for (let i = 0; i < ROWS * COLS; i++) {
    const cell = h('button', 'grid-cell');
    cell.type = 'button';
    const rows = Math.floor(i / COLS) + 1;
    const cols = (i % COLS) + 1;
    cell.setAttribute('aria-label', `${cols} by ${rows} table`);
    cell.addEventListener('mouseenter', () => paint(rows, cols));
    cell.addEventListener('click', () => onPick(rows, cols));
    cells.push(cell);
    grid.append(cell);
  }
  grid.addEventListener('mouseleave', () => paint(0, 0));
  box.append(label, grid);
  return box;
}

/** A grid of characters to insert. */
export function symbolGrid(symbols: string[], onPick: (symbol: string) => void): HTMLElement {
  const grid = h('div', 'symbol-grid');
  for (const symbol of symbols) {
    const b = h('button', 'symbol', symbol);
    b.type = 'button';
    b.addEventListener('click', () => onPick(symbol));
    grid.append(b);
  }
  return grid;
}
