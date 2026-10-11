// TwoNote's own icon set: small line drawings on a 20-unit grid, coloured by
// the surrounding text.

const P = (d: string, extra = '') =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const lines = P('M8 5h9M8 10h9M8 15h9');

const ICONS: Record<string, string> = {
  undo: P('M7 4L3 8l4 4M3 8h8a5 5 0 010 10H8'),
  redo: P('M13 4l4 4-4 4M17 8H9a5 5 0 000 10h3'),
  paste: P('M7 4H5a1 1 0 00-1 1v12a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1h-2M7 3h6v3H7z'),
  cut: P('M6 14l9-10M14 14L5 4') + '<circle cx="5" cy="15.5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15" cy="15.5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  copy: P('M7 7h9v10H7zM4 13V3h9'),
  painter: P('M4 3h10v4H4zM14 5h3v5H9v3M8 13h2v5H8z'),
  clear: P('M5 4h10M10 4l-2.5 12M4 17l12-13'),
  bullets: '<g fill="currentColor"><circle cx="4" cy="5" r="1.5"/><circle cx="4" cy="10" r="1.5"/><circle cx="4" cy="15" r="1.5"/></g>' + lines,
  numbers: '<g fill="currentColor" font-size="6.5" font-family="sans-serif"><text x="1" y="7.5">1</text><text x="1" y="12.5">2</text><text x="1" y="17.5">3</text></g>' + lines,
  outdent: P('M10 5h7M10 10h7M10 15h7M6 7l-3 3 3 3'),
  indent: P('M10 5h7M10 10h7M10 15h7M3 7l3 3-3 3'),
  alignLeft: P('M3 5h14M3 10h9M3 15h12'),
  alignCenter: P('M3 5h14M6 10h8M4.5 15h11'),
  alignRight: P('M3 5h14M8 10h9M5 15h12'),
  todo: '<rect x="3" y="3" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' + P('M6.500 10.5l2.5 2.5 4.5-5.5'),
  tag: P('M3 3h7l7 7-7 7-7-7z') + '<circle cx="7" cy="7" r="1.3" fill="currentColor"/>',
  table: '<rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' + P('M2.5 8h15M2.5 12.3h15M7.500 3.5v13M12.5 3.5v13', 'stroke-width="1.2"'),
  picture: '<rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="8" r="1.5" fill="currentColor"/>' + P('M3 15l4.500-4 3 2.5 3-3.5 3.500 4'),
  link: P('M8.500 11.5a3.200 3.200 0 004.500 0l3-3a3.200 3.200 0 00-4.500-4.500l-1 1M11.5 8.5a3.200 3.200 0 00-4.500 0l-3 3a3.200 3.200 0 004.500 4.500l1-1'),
  date: '<rect x="3" y="4" width="14" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' + P('M3 8h14M7 2.500v3M13 2.500v3'),
  time: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>' + P('M10 6v4l3 2'),
  rule: P('M3 10h14'),
  symbol: '<text x="10" y="15" text-anchor="middle" font-size="15" font-family="serif" fill="currentColor">Ω</text>',
  cursor: P('M5 3l10 8-5 1-2 5z'),
  eraser: P('M8 16l-4-4 8-8 5 5-7 7zM8 16h9M7.500 8.500l5 5'),
  shapes: '<rect x="3" y="3" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12.5" cy="12.5" r="4.500" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  zoomOut: '<circle cx="9" cy="9" r="5.500" fill="none" stroke="currentColor" stroke-width="1.5"/>' + P('M13 13l4 4M6.500 9h5'),
  zoomIn: '<circle cx="9" cy="9" r="5.500" fill="none" stroke="currentColor" stroke-width="1.5"/>' + P('M13 13l4 4M6.500 9h5M9 6.500v5'),
  rules: P('M3 5h14M3 9h14M3 13h14M3 17h14', 'stroke-width="1.1"'),
  page: P('M5 3h7l3 3v11H5zM12 3v3h3'),
  theme: '<circle cx="10" cy="10" r="6.500" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 3.500a6.500 6.500 0 010 13z" fill="currentColor"/>',
  thickness: P('M3 5h14', 'stroke-width="1"') + P('M3 10h14', 'stroke-width="2.4"') + P('M3 15.500h14', 'stroke-width="4"'),
  pen: P('M4 16l1-4 8-8 3 3-8 8-4 1zM11.500 5.500l3 3'),
  marker: P('M6 17h8M7 14l-1-3 6-8 3 2-5 9z'),
};

/** An icon as an SVG element. Unknown names give an empty icon. */
export function icon(name: string): SVGSVGElement {
  const holder = document.createElement('template');
  holder.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return holder.content.firstElementChild as SVGSVGElement;
}
