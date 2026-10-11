// What is on each ribbon tab, and what each control does.

import type { Rules } from './api';
import type { Editor, ParagraphStyle, ToggleCommand, Tool } from './editor';
import type { Shape } from './ink';
import { symbolGrid, tableGrid, type Control, type Tab } from './ribbon';
import type { NoteTag } from './sanitize';
import type { MenuItem } from './widgets';

export type Theme = 'system' | 'light' | 'dark';

export interface RibbonContext {
  editor: Editor;
  hasPage(): boolean;
  notify(message: string): void;
  pickImages(): void;
  askForLink(): void;
  fileMenu(): MenuItem[];
  helpMenu(): MenuItem[];
  zoom(): number;
  setZoom(zoom: number): void;
  rules(): Rules | null;
  setRules(rules: Rules | null): void;
  pageColor(): string | null;
  setPageColor(color: string | null): void;
  theme(): Theme;
  setTheme(theme: Theme): void;
}

const FONTS = [
  'Calibri', 'Calibri Light', 'Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Georgia',
  'Times New Roman', 'Cambria', 'Courier New', 'Consolas', 'Comic Sans MS',
];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

const TEXT_COLOURS = [
  '#000000', '#444444', '#7f7f7f', '#c00000', '#e03131', '#f08c00', '#e8b100', '#2f9e44',
  '#0c8599', '#1971c2', '#1f3a93', '#6741d9', '#c2255c', '#8d5524', '#ffffff',
];
const HIGHLIGHT_COLOURS = [
  '#ffff00', '#00ff00', '#00ffff', '#ff66ff', '#ffc000', '#ff7f7f', '#b4e3a3', '#a5d8ff',
  '#d0bfff', '#ffd8a8', '#e9ecef', '#c0c0c0',
];
const PAGE_COLOURS = [
  '#fff9db', '#ffe8cc', '#ffe3e3', '#f3d9fa', '#e5dbff', '#dbe4ff', '#d0ebff', '#c5f6fa',
  '#d3f9d8', '#e9fac8', '#f1f3f5', '#e7e0d4',
];
const INK_COLOURS = [
  '#1b1b1b', '#7f7f7f', '#d1242f', '#f08c00', '#e8b100', '#1a7f37', '#0c8599', '#1f6feb',
  '#6741d9', '#c2255c', '#8d5524', '#ffe600', '#7cfc00', '#00e5ff', '#ff7ad9',
];
const SYMBOLS = [
  '€', '£', '¥', '¢', '©', '®', '™', '°', '±', '×', '÷', '≠', '≤', '≥', '≈', '∞', 'µ', 'π', 'Ω', 'Σ',
  '√', '∆', '←', '→', '↑', '↓', '↔', '⇒', '•', '…', '§', '¶', '†', '‡', '½', '¼', '¾', '²', '³', '✓',
];

const STYLES: [ParagraphStyle, string, string][] = [
  ['h1', 'Heading 1', 'Ctrl+Alt+1'],
  ['h2', 'Heading 2', 'Ctrl+Alt+2'],
  ['h3', 'Heading 3', 'Ctrl+Alt+3'],
  ['h4', 'Heading 4', 'Ctrl+Alt+4'],
  ['h5', 'Heading 5', 'Ctrl+Alt+5'],
  ['h6', 'Heading 6', 'Ctrl+Alt+6'],
  ['cite', 'Citation', ''],
  ['quote', 'Quote', ''],
  ['code', 'Code', ''],
  ['div', 'Normal', 'Ctrl+Shift+N'],
];

const TAGS: [NoteTag, string, string][] = [
  ['important', 'Important', 'Ctrl+2'],
  ['question', 'Question', 'Ctrl+3'],
  ['remember', 'Remember for later', 'Ctrl+4'],
  ['definition', 'Definition', 'Ctrl+5'],
  ['highlight', 'Highlight', ''],
  ['contact', 'Contact', ''],
  ['address', 'Address', ''],
  ['phone', 'Phone number', ''],
  ['website', 'Website to visit', ''],
  ['idea', 'Idea', ''],
  ['password', 'Password', ''],
  ['critical', 'Critical', ''],
  ['movie', 'Movie to see', ''],
  ['book', 'Book to read', ''],
  ['music', 'Music to listen to', ''],
  ['source', 'Source for article', ''],
];

const ZOOMS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

interface Pen {
  name: string;
  icon: string;
  color: string;
  width: number;
  opacity: number;
}

export function buildTabs(ctx: RibbonContext): Tab[] {
  const { editor } = ctx;
  /** Most controls need a page to act on. */
  const page = (fn: () => void) => () => {
    if (ctx.hasPage()) fn();
    else ctx.notify('Open or add a page first.');
  };
  const fmt = () => editor.formatState();

  const toggle = (command: ToggleCommand, title: string, extra: Partial<Extract<Control, { kind: 'button' }>>): Control => ({
    kind: 'button',
    title,
    pressed: () => !!fmt()?.[command],
    onClick: page(() => editor.exec(command)),
    ...extra,
  });

  // ---- Home -------------------------------------------------------------------

  const home: Control[] = [
    { kind: 'button', icon: 'undo', title: 'Undo (Ctrl+Z)', disabled: () => !editor.canUndo, onClick: () => editor.undo() },
    { kind: 'button', icon: 'redo', title: 'Redo (Ctrl+Y)', disabled: () => !editor.canRedo, onClick: () => editor.redo() },
    'separator',
    { kind: 'button', icon: 'paste', title: 'Paste (Ctrl+V)', onClick: page(() => void editor.paste()) },
    { kind: 'button', icon: 'cut', title: 'Cut (Ctrl+X)', onClick: page(() => editor.cut()) },
    { kind: 'button', icon: 'copy', title: 'Copy (Ctrl+C)', onClick: page(() => editor.copy()) },
    {
      kind: 'button',
      icon: 'painter',
      title: 'Format painter: copy the formatting here, then select the text to give it to',
      pressed: () => editor.painting,
      onClick: page(() => editor.toggleFormatPainter()),
    },
    'separator',
    {
      kind: 'menu',
      title: 'Font',
      width: 132,
      label: () => fmt()?.font || 'Default font',
      items: () => [
        { label: 'Default font', checked: !fmt()?.font, onSelect: page(() => editor.setFont(null)) },
        'separator',
        ...FONTS.map((font): MenuItem => ({
          label: font,
          font: `"${font}", sans-serif`,
          checked: fmt()?.font === font,
          onSelect: page(() => editor.setFont(font)),
        })),
      ],
    },
    {
      kind: 'menu',
      title: 'Font size',
      width: 58,
      label: () => String(fmt()?.size ?? 11),
      items: () => SIZES.map((size): MenuItem => ({
        label: String(size),
        checked: fmt()?.size === size,
        onSelect: page(() => editor.setFontSize(size)),
      })),
    },
    toggle('bold', 'Bold (Ctrl+B)', { label: 'B', labelClass: 'g-bold' }),
    toggle('italic', 'Italic (Ctrl+I)', { label: 'I', labelClass: 'g-italic' }),
    toggle('underline', 'Underline (Ctrl+U)', { label: 'U', labelClass: 'g-underline' }),
    toggle('strikeThrough', 'Strikethrough (Ctrl+-)', { label: 'ab', labelClass: 'g-strike' }),
    toggle('subscript', 'Subscript (Ctrl+=)', { label: 'x₂' }),
    toggle('superscript', 'Superscript (Ctrl+Shift+=)', { label: 'x²' }),
    {
      kind: 'colour',
      title: 'Highlight (Ctrl+Alt+H)',
      glyph: 'ab',
      glyphClass: 'g-highlight',
      color: () => editor.highlightColor,
      onClick: page(() => editor.toggleHighlight()),
      items: () => [
        { label: 'No highlight', onSelect: page(() => editor.setHighlight(null)) },
        { swatches: HIGHLIGHT_COLOURS, current: editor.highlightColor, onPick: (c) => page(() => editor.setHighlight(c))() },
      ],
    },
    {
      kind: 'colour',
      title: 'Font colour',
      glyph: 'A',
      glyphClass: 'g-bold',
      color: () => editor.fontColor,
      onClick: page(() => editor.setColor(editor.fontColor)),
      items: () => [
        { label: 'Automatic', onSelect: page(() => editor.setColor(null)) },
        { swatches: TEXT_COLOURS, current: editor.fontColor, onPick: (c) => page(() => editor.setColor(c))() },
      ],
    },
    { kind: 'button', icon: 'clear', title: 'Clear formatting', onClick: page(() => editor.exec('removeFormat')) },
    'separator',
    toggle('insertUnorderedList', 'Bullet list (Ctrl+.)', { icon: 'bullets' }),
    toggle('insertOrderedList', 'Numbered list (Ctrl+/)', { icon: 'numbers' }),
    { kind: 'button', icon: 'outdent', title: 'Decrease indent (Alt+Shift+Left)', onClick: page(() => editor.exec('outdent')) },
    { kind: 'button', icon: 'indent', title: 'Increase indent (Alt+Shift+Right)', onClick: page(() => editor.exec('indent')) },
    {
      kind: 'menu',
      icon: 'alignLeft',
      title: 'Paragraph alignment',
      items: () => [
        { label: 'Align left', hint: 'Ctrl+L', checked: fmt()?.align === 'left', onSelect: page(() => editor.align('left')) },
        { label: 'Centre', checked: fmt()?.align === 'center', onSelect: page(() => editor.align('center')) },
        { label: 'Align right', hint: 'Ctrl+R', checked: fmt()?.align === 'right', onSelect: page(() => editor.align('right')) },
        { label: 'Justify', checked: fmt()?.align === 'justify', onSelect: page(() => editor.align('justify')) },
      ],
    },
    'separator',
    {
      kind: 'menu',
      title: 'Paragraph style',
      width: 108,
      label: () => STYLES.find(([style]) => style === (fmt()?.style ?? 'div'))?.[1] ?? 'Normal',
      items: () => STYLES.map(([style, label, hint]): MenuItem => ({
        label,
        hint,
        preview: `pv-${style}`,
        checked: fmt()?.style === style,
        onSelect: page(() => editor.setStyle(style)),
      })),
    },
    'separator',
    {
      kind: 'button',
      icon: 'todo',
      label: 'To Do',
      title: 'To-do tag (Ctrl+1)',
      pressed: () => !!fmt()?.todo,
      onClick: page(() => editor.toggleTodo()),
    },
    {
      kind: 'menu',
      icon: 'tag',
      label: 'Tags',
      title: 'Tag this paragraph',
      items: () => [
        { label: 'To Do', hint: 'Ctrl+1', checked: !!fmt()?.todo, onSelect: page(() => editor.toggleTodo()) },
        ...TAGS.map(([tag, label, hint]): MenuItem => ({
          label,
          hint,
          preview: `pv-tag pv-tag-${tag}`,
          checked: fmt()?.tag === tag,
          onSelect: page(() => editor.setTag(tag)),
        })),
        'separator',
        { label: 'Remove tag', hint: 'Ctrl+0', onSelect: page(() => editor.setTag(null)) },
      ],
    },
  ];

  // ---- Insert -----------------------------------------------------------------

  const now = () => new Date();
  const date = () => now().toLocaleDateString();
  const time = () => now().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const insert: Control[] = [
    {
      kind: 'panel',
      icon: 'table',
      label: 'Table',
      title: 'Insert a table (or press Tab after some text)',
      build: (close) => tableGrid((rows, columns) => {
        close();
        page(() => editor.insertTable(rows, columns))();
      }),
    },
    'separator',
    { kind: 'button', icon: 'picture', label: 'Picture', title: 'Insert pictures (or paste, or drop them on the page)', onClick: page(ctx.pickImages) },
    { kind: 'button', icon: 'link', label: 'Link', title: 'Insert link (Ctrl+K)', onClick: page(ctx.askForLink) },
    'separator',
    { kind: 'button', icon: 'date', label: 'Date', title: 'Insert today\'s date (Alt+Shift+D)', onClick: page(() => editor.insertText(date())) },
    { kind: 'button', icon: 'time', label: 'Time', title: 'Insert the time (Alt+Shift+T)', onClick: page(() => editor.insertText(time())) },
    { kind: 'button', icon: 'date', label: 'Date & Time', title: 'Insert date and time (Alt+Shift+F)', onClick: page(() => editor.insertText(`${date()} ${time()}`)) },
    'separator',
    { kind: 'button', icon: 'rule', label: 'Line', title: 'Insert a horizontal line', onClick: page(() => editor.insertRule()) },
    {
      kind: 'panel',
      icon: 'symbol',
      label: 'Symbol',
      title: 'Insert a symbol',
      build: (close) => symbolGrid(SYMBOLS, (symbol) => {
        close();
        page(() => editor.insertText(symbol))();
      }),
    },
  ];

  // ---- Draw -------------------------------------------------------------------

  const pens: Pen[] = [
    { name: 'Black pen', icon: 'pen', color: '#1b1b1b', width: 2, opacity: 1 },
    { name: 'Red pen', icon: 'pen', color: '#d1242f', width: 2, opacity: 1 },
    { name: 'Blue pen', icon: 'pen', color: '#1f6feb', width: 2, opacity: 1 },
    { name: 'Green pen', icon: 'pen', color: '#1a7f37', width: 3, opacity: 1 },
    { name: 'Yellow highlighter', icon: 'marker', color: '#ffe600', width: 16, opacity: 0.4 },
  ];
  let activePen = 0;
  let shape: Shape = 'line';
  const tool = (): Tool => editor.currentTool;
  const usePen = (index: number) => {
    activePen = index;
    const p = pens[index];
    editor.setTool({ kind: 'pen', color: p.color, width: p.width, opacity: p.opacity });
  };
  const useShape = (next: Shape) => {
    shape = next;
    const p = pens[activePen];
    editor.setTool({ kind: 'shape', shape, color: p.color, width: Math.min(p.width, 6) });
  };
  /** Re-apply the current drawing tool after its pen changed. */
  const reapply = () => {
    if (tool().kind === 'shape') useShape(shape);
    else usePen(activePen);
  };
  const SHAPES: [Shape, string][] = [['line', 'Line'], ['arrow', 'Arrow'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse']];

  const draw: Control[] = [
    {
      kind: 'button',
      icon: 'cursor',
      label: 'Type',
      title: 'Type and select (Esc)',
      pressed: () => tool().kind === 'type',
      onClick: () => editor.setTool({ kind: 'type' }),
    },
    {
      kind: 'button',
      icon: 'eraser',
      label: 'Eraser',
      title: 'Erase strokes by rubbing over them',
      pressed: () => tool().kind === 'eraser',
      onClick: page(() => editor.setTool({ kind: 'eraser' })),
    },
    'separator',
    ...pens.map((pen, index): Control => ({
      kind: 'pen',
      icon: pen.icon,
      title: pen.name,
      color: () => pens[index].color,
      pressed: () => tool().kind === 'pen' && activePen === index,
      onClick: page(() => usePen(index)),
    })),
    {
      kind: 'menu',
      label: 'Colour',
      title: 'Change the colour of the selected pen',
      items: () => [{
        swatches: INK_COLOURS,
        current: pens[activePen].color,
        onPick: (color) => page(() => {
          pens[activePen].color = color;
          reapply();
        })(),
      }],
    },
    {
      kind: 'menu',
      icon: 'thickness',
      title: 'Change the thickness of the selected pen',
      items: () => {
        const marker = pens[activePen].opacity < 1;
        const options: [string, number][] = marker
          ? [['Narrow', 10], ['Medium', 16], ['Wide', 24]]
          : [['Fine', 1.5], ['Medium', 2], ['Bold', 3], ['Thick', 5], ['Very thick', 8]];
        return options.map(([label, width]): MenuItem => ({
          label,
          checked: pens[activePen].width === width,
          onSelect: page(() => {
            pens[activePen].width = width;
            reapply();
          }),
        }));
      },
    },
    'separator',
    {
      kind: 'menu',
      icon: 'shapes',
      label: 'Shapes',
      title: 'Draw a shape by dragging',
      items: () => SHAPES.map(([value, label]): MenuItem => ({
        label,
        checked: tool().kind === 'shape' && shape === value,
        onSelect: page(() => useShape(value)),
      })),
    },
  ];

  // ---- View -------------------------------------------------------------------

  const stepZoom = (direction: number) => {
    const current = ctx.zoom();
    const next = direction > 0 ? ZOOMS.find((z) => z > current + 0.001) : [...ZOOMS].reverse().find((z) => z < current - 0.001);
    if (next) ctx.setZoom(next);
  };

  const view: Control[] = [
    { kind: 'button', icon: 'zoomOut', title: 'Zoom out (Ctrl+Alt+-)', disabled: () => ctx.zoom() <= ZOOMS[0], onClick: () => stepZoom(-1) },
    {
      kind: 'menu',
      title: 'Zoom',
      width: 66,
      label: () => `${Math.round(ctx.zoom() * 100)}%`,
      items: () => ZOOMS.map((zoom): MenuItem => ({
        label: `${Math.round(zoom * 100)}%`,
        checked: Math.abs(ctx.zoom() - zoom) < 0.001,
        onSelect: () => ctx.setZoom(zoom),
      })),
    },
    { kind: 'button', icon: 'zoomIn', title: 'Zoom in (Ctrl+Alt+=)', disabled: () => ctx.zoom() >= ZOOMS[ZOOMS.length - 1], onClick: () => stepZoom(1) },
    { kind: 'button', label: '100%', title: 'Zoom to 100%', onClick: () => ctx.setZoom(1) },
    'separator',
    {
      kind: 'menu',
      icon: 'rules',
      label: 'Rule Lines',
      title: 'Show lines or a grid behind this page',
      items: () => [
        { label: 'None', checked: !ctx.rules(), onSelect: page(() => ctx.setRules(null)) },
        { label: 'Ruled lines', checked: ctx.rules() === 'ruled', onSelect: page(() => ctx.setRules('ruled')) },
        { label: 'Grid', checked: ctx.rules() === 'grid', onSelect: page(() => ctx.setRules('grid')) },
      ],
    },
    {
      kind: 'menu',
      icon: 'page',
      label: 'Page Colour',
      title: 'Change this page\'s background colour',
      items: () => [
        { label: 'No colour', checked: !ctx.pageColor(), onSelect: page(() => ctx.setPageColor(null)) },
        { swatches: PAGE_COLOURS, current: ctx.pageColor(), onPick: (color) => page(() => ctx.setPageColor(color))() },
      ],
    },
    'separator',
    {
      kind: 'menu',
      icon: 'theme',
      label: 'Theme',
      title: 'Light or dark appearance',
      items: () => (['system', 'light', 'dark'] as Theme[]).map((theme): MenuItem => ({
        label: { system: 'Match the system', light: 'Light', dark: 'Dark' }[theme],
        checked: ctx.theme() === theme,
        onSelect: () => ctx.setTheme(theme),
      })),
    },
  ];

  return [
    { id: 'file', label: 'File', menu: ctx.fileMenu },
    { id: 'home', label: 'Home', controls: home },
    { id: 'insert', label: 'Insert', controls: insert },
    { id: 'draw', label: 'Draw', controls: draw },
    { id: 'view', label: 'View', controls: view },
    { id: 'help', label: 'Help', menu: ctx.helpMenu },
  ];
}
