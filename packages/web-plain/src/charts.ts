import { h, s } from './dom.ts';

const ROW = 34;
const BAR = 18;
const RADIUS = 4;
const GAP = 2;

function barPath(x: number, y: number, w: number, t: number, roundEnd: boolean): string {
  if (!roundEnd || w <= RADIUS) {
    return `M${x},${y}h${w}v${t}h${-w}z`;
  }

  return `M${x},${y}h${w - RADIUS}a${RADIUS},${RADIUS} 0 0 1 ${RADIUS},${RADIUS}v${t - 2 * RADIUS}a${RADIUS},${RADIUS} 0 0 1 ${-RADIUS},${RADIUS}h${-(w - RADIUS)}z`;
}

let tooltip: HTMLDivElement | null = null;
function tip(): HTMLDivElement {
  if (tooltip === null) {
    tooltip = h('div', { class: 'tooltip', role: 'status' });
    document.body.append(tooltip);
  }
  return tooltip;
}

export function attachTooltip(target: Element, lines: () => readonly string[]): void {
  const move = (e: Event): void => {
    if (!(e instanceof MouseEvent)) {
      return;
    }
    
    const t = tip();

    t.replaceChildren(...lines().map((l, i) => h(i === 0 ? 'strong' : 'span', {}, l)));
    t.style.display = 'block';

    const x = Math.min(e.clientX + 14, window.innerWidth - t.offsetWidth - 8);
    const y = Math.min(e.clientY + 14, window.innerHeight - t.offsetHeight - 8);
    
    t.style.left = `${Math.max(8, x)}px`;
    t.style.top = `${Math.max(8, y)}px`;
  };

  target.addEventListener('mousemove', move);
  target.addEventListener('mouseleave', () => {
    tip().style.display = 'none';
  });
}

export type Series = { readonly key: string; readonly label: string; readonly color: string };
export function legend(series: readonly Series[]): HTMLElement {
  return h(
    'ul',
    { class: 'legend' },
    ...series.map((x) => h('li', {}, h('span', { class: 'swatch', style: `background:${x.color}` }), x.label)),
  );
}

export type StackedRow = {
  readonly label: string;
  readonly values: Readonly<Record<string, number>>;
  readonly endLabel: string;
  readonly shortEndLabel?: string;
  readonly tooltip: readonly string[];
};
export function stackedBars(rows: readonly StackedRow[], series: readonly Series[], ariaLabel: string, width: number): SVGSVGElement {
  const WIDTH = Math.max(280, Math.round(width));

  const narrow = WIDTH < 520;
  
  const LABEL = narrow ? 84 : 104;
  const RIGHT = narrow ? 76 : 150;
  
  const max = Math.max(0, ...rows.map((r) => series.reduce((n, x) => n + (r.values[x.key] ?? 0), 0)));
  const plot = WIDTH - LABEL - RIGHT;
  const height = rows.length * ROW + 8;
  const svg = s('svg', { viewBox: `0 0 ${WIDTH} ${height}`, width: WIDTH, height, role: 'img', 'aria-label': ariaLabel, class: 'chart' });
  
  svg.append(s('line', { x1: LABEL, x2: LABEL, y1: 0, y2: height - 4, class: 'axis' }));

  rows.forEach((row, i) => {
    const y = 4 + i * ROW;
    const barY = y + (ROW - BAR) / 2;
    const group = s('g', { class: 'row' });

    group.append(s('rect', { x: 0, y, width: WIDTH, height: ROW, class: 'hit' }));
    group.append(s('text', { x: LABEL - 10, y: y + ROW / 2, class: 'label', 'text-anchor': 'end', 'dominant-baseline': 'central' }, row.label));

    const present = series.filter((x) => (row.values[x.key] ?? 0) > 0);
    let x = LABEL;
    present.forEach((serie, j) => {
      const value = row.values[serie.key] ?? 0;
      const raw = max === 0 ? 0 : (value / max) * plot;
      const last = j === present.length - 1;
      const w = Math.max(1, raw - (last ? 0 : GAP));
      const seg = s('path', { d: barPath(x, barY, w, BAR, last), fill: serie.color, class: 'mark' });
      group.append(seg);
      x += w + (last ? 0 : GAP);
    });

    group.append(s('text', { x: x + 6, y: y + ROW / 2, class: 'value', 'dominant-baseline': 'central' }, narrow ? (row.shortEndLabel ?? row.endLabel) : row.endLabel));

    attachTooltip(group, () => row.tooltip);

    svg.append(group);
  });

  return svg;
}
