// Reduce arbitrary HTML (pasted content, loaded pages) to the subset NoteKroft
// stores. The Rust core applies the same rules again before anything touches
// disk and when pages are read back; this copy keeps the live DOM clean and
// makes pasting behave predictably. The two must stay in step.

const TAGS = new Set([
  'p', 'div', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
  'table', 'tbody', 'tr', 'td', 'th', 'a', 'span', 'img',
]);

/** Removed together with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math',
  'head', 'title', 'meta', 'link', 'base', 'form', 'input', 'button', 'select', 'textarea',
  'picture', 'video', 'audio', 'canvas',
]);

/** Unknown block-level tags become plain divs so line structure survives. */
const BLOCKY = new Set([
  'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption',
  'address', 'dl', 'dt', 'dd', 'center', 'details', 'summary', 'fieldset', 'caption',
]);

const RENAME: Record<string, string> = { thead: 'tbody', tfoot: 'tbody' };

const ATTRS: Record<string, string[]> = {
  a: ['href'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  // No `src`: an inline picture names an asset stored in the notebook, and
  // the editor resolves it. Pictures pasted from the web are never fetched.
  img: ['data-asset', 'width', 'height', 'alt'],
};

const ASSET_NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;
const DIMENSION = /^[0-9]{1,5}$/;
const SAFE_URL = /^(https?:|mailto:)/i;

/** Note tags, each drawn as a small icon in front of its paragraph. */
export const NOTE_TAGS = [
  'important', 'question', 'remember', 'definition', 'highlight', 'contact', 'address', 'phone',
  'website', 'idea', 'password', 'critical', 'movie', 'book', 'music', 'source',
] as const;
export type NoteTag = (typeof NOTE_TAGS)[number];

/** Elements that may carry a class and a style. */
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_CLASSES = new Set(['todo', 'done', 'quote', 'cite', ...NOTE_TAGS.map((t) => `tag-${t}`)]);
/** Further elements that may carry a style. */
const STYLED_ONLY = new Set(['span', 'td', 'th', 'pre', 'blockquote']);

// ---- styles -------------------------------------------------------------------

const STYLE_PROPERTIES = ['font-family', 'font-size', 'color', 'background-color', 'text-align'] as const;

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** `#rgb`, `#rrggbb`, `rgb(r, g, b)` or an opaque `rgba(...)`, as `#rrggbb`. */
export function normaliseColour(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3) return `#${[...hex].map((c) => c + c).join('')}`;
    return hex.length === 6 ? v : null;
  }
  const m = /^rgba?\((.*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  if (parts[3] !== undefined) {
    const alpha = Number.parseFloat(parts[3]);
    if (!(alpha > 0)) return null;
  }
  const rgb = parts.slice(0, 3).map((p) => Number(p));
  if (rgb.some((n) => !Number.isFinite(n))) return null;
  return `#${rgb.map(hex2).join('')}`;
}

function fontFamily(raw: string): string | null {
  const names = raw
    .split(',')
    .map((n) => n.trim().replace(/^["']+|["']+$/g, '').split(/\s+/).filter(Boolean).join(' '))
    .filter(Boolean);
  if (!names.length || !names.every((n) => /^[\p{L}\p{N} _-]+$/u.test(n))) return null;
  const joined = names.join(', ');
  return [...joined].length <= 120 ? joined : null;
}

function fontSize(raw: string): string | null {
  const m = /^([0-9]*\.?[0-9]+)\s*(pt|px)$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n >= 1 && n <= 400)) return null;
  return `${Math.round(n * 100) / 100}${m[2]}`;
}

/** Reduce a `style` value to NoteKroft's formatting properties in canonical
 *  form, or null when nothing valid is left. */
export function normaliseStyle(value: string): string | null {
  const kept = new Map<string, string>();
  for (const declaration of value.split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const raw = declaration.slice(at + 1).trim();
    let parsed: string | null = null;
    if (property === 'font-family') parsed = fontFamily(raw);
    else if (property === 'font-size') parsed = fontSize(raw);
    else if (property === 'color' || property === 'background-color') parsed = normaliseColour(raw);
    else if (property === 'text-align') parsed = /^(left|center|right|justify)$/i.test(raw) ? raw.toLowerCase() : null;
    if (parsed) kept.set(property, parsed);
  }
  const parts = STYLE_PROPERTIES.filter((p) => kept.has(p)).map((p) => `${p}: ${kept.get(p)}`);
  return parts.length ? parts.join('; ') : null;
}

// ---- elements -----------------------------------------------------------------

function swap(el: Element, tag: string): Element {
  const next = el.ownerDocument.createElement(tag);
  next.append(...Array.from(el.childNodes));
  el.replaceWith(next);
  return next;
}

function walk(parent: Element) {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }
    let el = child as Element;
    let tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    walk(el);
    if (RENAME[tag]) {
      tag = RENAME[tag];
      el = swap(el, tag);
    } else if (BLOCKY.has(tag)) {
      tag = 'div';
      el = swap(el, tag);
    } else if (!TAGS.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }

    const keep = ATTRS[tag] ?? [];
    const blocky = BLOCK_TAGS.has(tag);
    const classes = blocky ? Array.from(el.classList).filter((c) => BLOCK_CLASSES.has(c)) : [];
    const style = blocky || STYLED_ONLY.has(tag) ? normaliseStyle(el.getAttribute('style') ?? '') : null;
    for (const attr of Array.from(el.attributes)) {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (classes.length) el.setAttribute('class', classes.join(' '));
    if (style) el.setAttribute('style', style);
    if (tag === 'img') {
      if (!ASSET_NAME.test(el.getAttribute('data-asset') ?? '')) {
        el.remove();
        continue;
      }
      for (const dim of ['width', 'height']) {
        if (!DIMENSION.test(el.getAttribute(dim) ?? '')) el.removeAttribute(dim);
      }
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (!SAFE_URL.test(href.trim())) el.removeAttribute('href');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

export function sanitizeHtml(html: string): string {
  // DOMParser documents are inert: nothing in them loads or runs.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  walk(doc.body);
  return doc.body.innerHTML;
}

/** Only http(s) and mailto links are allowed; bare domains get https. */
export function normaliseUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (SAFE_URL.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `mailto:${raw}`;
  return `https://${raw}`;
}
