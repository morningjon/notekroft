// Freehand ink: turning pointer input into strokes, strokes into SVG, and a
// handful of drawn shapes.

import type { InkBlock, Stroke } from './api';

export type Point = [number, number];
export type Shape = 'line' | 'arrow' | 'rect' | 'ellipse';

const SVG = 'http://www.w3.org/2000/svg';
const r1 = (n: number) => Math.round(n * 10) / 10;

/** SVG path data for a stroke. Dense point runs (handwriting, ellipses) are
 *  smoothed; sparse ones (lines, rectangles, arrows) keep their corners. */
export function pathData(points: Point[]): string {
  if (!points.length) return '';
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${r1(x0)} ${r1(y0)}l0.01 0`;
  if (points.length < 8) return `M${points.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L')}`;
  let d = `M${r1(x0)} ${r1(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d}L${r1(lx)} ${r1(ly)}`;
}

/** The outline of a shape dragged from `a` to `b`, as stroke points. */
export function shapePoints(shape: Shape, a: Point, b: Point): Point[] {
  const [x1, y1] = a;
  const [x2, y2] = b;
  switch (shape) {
    case 'line':
      return [a, b];
    case 'rect':
      return [a, [x2, y1], b, [x1, y2], a];
    case 'arrow': {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.min(18, Math.hypot(x2 - x1, y2 - y1) / 2);
      const wing = (turn: number): Point => [
        x2 - head * Math.cos(angle + turn),
        y2 - head * Math.sin(angle + turn),
      ];
      return [a, b, wing(0.45), b, wing(-0.45)];
    }
    case 'ellipse': {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      const steps = 64;
      return Array.from({ length: steps + 1 }, (_, i): Point => {
        const t = (i / steps) * Math.PI * 2;
        return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
      });
    }
  }
}

/** One visible path, plus a wider invisible one so thin lines are easy to
 *  click or rub out. */
export function strokeElement(stroke: Stroke, index: number): SVGGElement {
  const g = document.createElementNS(SVG, 'g');
  g.dataset.i = String(index);
  const d = pathData(stroke.points);
  const line = document.createElementNS(SVG, 'path');
  line.setAttribute('d', d);
  line.setAttribute('stroke', stroke.color);
  line.setAttribute('stroke-width', String(stroke.width));
  if (stroke.opacity !== undefined && stroke.opacity < 1) line.setAttribute('stroke-opacity', String(stroke.opacity));
  line.setAttribute('class', 'line');
  const hit = document.createElementNS(SVG, 'path');
  hit.setAttribute('d', d);
  hit.setAttribute('stroke-width', String(Math.max(stroke.width + 8, 14)));
  hit.setAttribute('class', 'hit');
  g.append(line, hit);
  return g;
}

export function inkSvg(strokes: Stroke[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.append(...strokes.map(strokeElement));
  return svg;
}

/** Place strokes given in page coordinates into a block that just fits them. */
export function blockFromAbsolute(id: string, strokes: Stroke[]): InkBlock {
  const pad = Math.max(...strokes.map((s) => s.width)) / 2 + 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  // Blocks cannot sit left of or above the page.
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return {
    kind: 'ink',
    id,
    x: r1(x),
    y: r1(y),
    w: r1(Math.max(1, maxX + pad - x)),
    h: r1(Math.max(1, maxY + pad - y)),
    strokes: strokes.map((s) => ({ ...s, points: s.points.map(([px, py]): Point => [r1(px - x), r1(py - y)]) })),
  };
}

/** A block's strokes back in page coordinates. */
export function absoluteStrokes(block: InkBlock): Stroke[] {
  return block.strokes.map((s) => ({ ...s, points: s.points.map(([x, y]): Point => [x + block.x, y + block.y]) }));
}
