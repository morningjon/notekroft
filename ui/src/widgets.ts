// Small UI pieces: element helper, context menus, dialogs, toasts.
// Native prompt()/confirm() are avoided because web views handle them
// inconsistently.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

export type MenuItem =
  | 'separator'
  | { heading: string }
  | {
      label: string;
      onSelect: () => void;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
      /** Show the label in this font, for font pickers. */
      font?: string;
      /** A class for the label, for style previews. */
      preview?: string;
    }
  | { swatches: string[]; current?: string | null; onPick: (color: string) => void };

let openMenu: HTMLElement | null = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** Show a menu at viewport coordinates. Items never take focus, so the text
 *  selection in the page survives choosing one. */
export function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const menu = h('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', 'menu-sep'));
    } else if ('heading' in item) {
      menu.append(h('div', 'menu-heading', item.heading));
    } else if ('swatches' in item) {
      const row = h('div', 'menu-swatches');
      for (const color of item.swatches) {
        const b = h('button', 'swatch' + (color === item.current ? ' current' : ''));
        b.type = 'button';
        b.style.setProperty('--c', color);
        b.title = color;
        b.addEventListener('click', () => {
          closeMenu();
          item.onPick(color);
        });
        row.append(b);
      }
      menu.append(row);
    } else {
      const b = h('button', 'menu-item' + (item.danger ? ' danger' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.disabled = !!item.disabled;
      const label = h('span', 'menu-label' + (item.preview ? ` ${item.preview}` : ''), item.label);
      if (item.font) label.style.fontFamily = item.font;
      b.append(h('span', 'menu-check', item.checked ? '✓' : ''), label);
      if (item.hint) b.append(h('span', 'menu-hint', item.hint));
      b.addEventListener('click', () => {
        closeMenu();
        item.onSelect();
      });
      menu.append(b);
    }
  }
  place(menu, x, y);
}

/** Show any element as a floating panel, with the same behaviour as a menu:
 *  it never takes focus and closes on an outside click or Escape. */
export function showPanel(x: number, y: number, content: HTMLElement) {
  closeMenu();
  const panel = h('div', 'menu panel');
  panel.append(content);
  place(panel, x, y);
}

function place(menu: HTMLElement, x: number, y: number) {
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenu = menu;
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

function dialog<T>(build: (box: HTMLElement, done: (value: T) => void) => HTMLElement | null, cancelValue: T): Promise<T> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = h('div', 'overlay');
    const box = h('div', 'dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    overlay.append(box);
    const done = (value: T) => {
      overlay.remove();
      previous?.focus?.();
      resolve(value);
    };
    const focus = build(box, done);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(cancelValue);
    });
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(cancelValue);
    });
    document.body.append(overlay);
    focus?.focus();
  });
}

function buttons(box: HTMLElement, okLabel: string, danger: boolean, onOk: () => void, onCancel: () => void) {
  const row = h('div', 'dialog-buttons');
  const cancel = h('button', 'btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const ok = h('button', 'btn primary' + (danger ? ' danger' : ''), okLabel);
  ok.type = 'submit';
  ok.addEventListener('click', (e) => {
    e.preventDefault();
    onOk();
  });
  row.append(cancel, ok);
  box.append(row);
  return ok;
}

export function promptText(title: string, initial = '', okLabel = 'OK', placeholder = ''): Promise<string | null> {
  return dialog<string | null>((box, done) => {
    box.append(h('h2', 'dialog-title', title));
    const input = h('input', 'dialog-input');
    input.type = 'text';
    input.value = initial;
    input.placeholder = placeholder;
    input.maxLength = 200;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value);
      }
    });
    box.append(input);
    buttons(box, okLabel, false, () => done(input.value), () => done(null));
    queueMicrotask(() => input.select());
    return input;
  }, null);
}

export function confirmDialog(title: string, detail: string, okLabel: string): Promise<boolean> {
  return dialog<boolean>((box, done) => {
    box.append(h('h2', 'dialog-title', title), h('p', 'dialog-detail', detail));
    return buttons(box, okLabel, true, () => done(true), () => done(false));
  }, false);
}

/** A message with a single button. `lines` are shown as separate paragraphs. */
export function infoDialog(title: string, lines: string[]): Promise<void> {
  return dialog<void>((box, done) => {
    box.append(h('h2', 'dialog-title', title));
    for (const line of lines) box.append(h('p', 'dialog-detail', line));
    const row = h('div', 'dialog-buttons');
    const ok = h('button', 'btn primary', 'OK');
    ok.type = 'button';
    ok.addEventListener('click', () => done());
    row.append(ok);
    box.append(row);
    return ok;
  }, undefined);
}

export interface Choice<K extends string> {
  key: K;
  label: string;
  /** A line under the label saying what the choice does. */
  detail?: string;
}

/** A dialog offering several named actions. Resolves to the chosen key, or
 *  null if it is closed without choosing. `path` is shown as selectable text. */
export function choiceDialog<K extends string>(
  title: string,
  intro: string,
  path: string,
  choices: Choice<K>[],
): Promise<K | null> {
  return dialog<K | null>((box, done) => {
    box.classList.add('wide');
    box.append(h('h2', 'dialog-title', title), h('p', 'dialog-detail', intro), h('div', 'dialog-path', path));
    const list = h('div', 'dialog-choices');
    for (const choice of choices) {
      const b = h('button', 'choice');
      b.type = 'button';
      b.append(h('span', 'choice-label', choice.label));
      if (choice.detail) b.append(h('span', 'choice-detail', choice.detail));
      b.addEventListener('click', () => done(choice.key));
      list.append(b);
    }
    const row = h('div', 'dialog-buttons');
    const close = h('button', 'btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => done(null));
    row.append(close);
    box.append(list, row);
    return close;
  }, null);
}

/** A two-column reference table with a single button. */
export function tableDialog(title: string, rows: [string, string][]): Promise<void> {
  return dialog<void>((box, done) => {
    box.classList.add('wide');
    box.append(h('h2', 'dialog-title', title));
    const table = h('table', 'dialog-table');
    for (const [what, how] of rows) {
      const tr = h('tr');
      tr.append(h('td', '', what), h('td', 'keys', how));
      table.append(tr);
    }
    const scroll = h('div', 'dialog-scroll');
    scroll.append(table);
    const row = h('div', 'dialog-buttons');
    const ok = h('button', 'btn primary', 'OK');
    ok.type = 'button';
    ok.addEventListener('click', () => done());
    row.append(ok);
    box.append(scroll, row);
    return ok;
  }, undefined);
}

let toastTimer = 0;

export function toast(message: string) {
  document.querySelector('.toast')?.remove();
  const el = h('div', 'toast', message);
  el.setAttribute('role', 'status');
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 5000);
}
