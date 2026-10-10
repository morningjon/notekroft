// Reduce arbitrary HTML (pasted content, loaded pages) to the subset TwoNote
// stores. The Rust core applies the same allowlist again before anything
// touches disk and when pages are read back; this copy keeps the live DOM
// clean and makes pasting behave predictably.

const TAGS = new Set([
  'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'mark', 'sub', 'sup',
  'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'table', 'tbody', 'tr',
  'td', 'th', 'a', 'span',
]);

/** Removed together with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math',
  'head', 'title', 'meta', 'link', 'base', 'form', 'input', 'button', 'select', 'textarea',
  'img', 'picture', 'video', 'audio', 'canvas',
]);

/** Unknown block-level tags become plain divs so line structure survives. */
const BLOCKY = new Set([
  'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption',
  'address', 'dl', 'dt', 'dd', 'center', 'details', 'summary', 'fieldset', 'hr', 'caption',
]);

const RENAME: Record<string, string> = { h4: 'h3', h5: 'h3', h6: 'h3', thead: 'tbody', tfoot: 'tbody' };

const ATTRS: Record<string, string[]> = {
  a: ['href'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
};

const CLASS_TAGS = new Set(['div', 'p', 'li']);
const CLASSES = new Set(['todo', 'done']);
const SAFE_URL = /^(https?:|mailto:)/i;

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
    const classes = CLASS_TAGS.has(tag)
      ? Array.from(el.classList).filter((c) => CLASSES.has(c))
      : [];
    for (const attr of Array.from(el.attributes)) {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (classes.length) el.setAttribute('class', classes.join(' '));
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
