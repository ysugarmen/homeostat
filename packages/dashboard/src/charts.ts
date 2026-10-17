/** Escapes text for HTML and SVG. */
export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export interface Datum {
  label: string;
  value: number;
  /** Shown in the hover tooltip; defaults to "label: value". */
  title?: string;
}

/** A bar whose data end (top) is rounded 4px and whose base sits square on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** The same, lying down: rounded on the right (data) end, square on the left baseline. */
function rowPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return "";
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

/**
 * Vertical bars for one series over categories or days. Labels only the bars named in
 * `labelled` (selective direct labels); every bar has a hover tooltip.
 */
export function columns(
  data: readonly Datum[],
  opts: { title: string; height?: number; labelled?: "all" | "ends"; tickEvery?: number },
): string {
  const width = 560;
  const height = opts.height ?? 140;
  const pad = { top: 18, bottom: 22, left: 4, right: 4 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const inner = height - pad.top - pad.bottom;
  const slot = (width - pad.left - pad.right) / Math.max(data.length, 1);
  const gap = 2;
  const bar = Math.max(2, Math.min(36, slot - gap));
  const maxIndex = data.findIndex((d) => d.value === max);
  const show = (i: number) =>
    opts.labelled === "all" ||
    (opts.labelled === "ends" && (i === data.length - 1 || i === maxIndex));

  const marks = data
    .map((d, i) => {
      const h = (d.value / max) * inner;
      const x = pad.left + i * slot + (slot - bar) / 2;
      const y = pad.top + inner - h;
      const label =
        show(i) && d.value > 0
          ? `<text class="v" x="${x + bar / 2}" y="${y - 5}" text-anchor="middle">${d.value}</text>`
          : "";
      const tick =
        opts.tickEvery && i % opts.tickEvery === 0
          ? `<text class="t" x="${x + bar / 2}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>`
          : !opts.tickEvery
            ? `<text class="t" x="${x + bar / 2}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>`
            : "";
      // The hit target spans the whole slot, taller and wider than the mark.
      return `<g class="m"><rect class="hit" x="${pad.left + i * slot}" y="${pad.top}" width="${slot}" height="${inner}"/><path d="${columnPath(x, y, bar, h)}"/>${label}${tick}<title>${esc(d.title ?? `${d.label}: ${d.value}`)}</title></g>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.title)}"><line class="base" x1="0" x2="${width}" y1="${pad.top + inner}" y2="${pad.top + inner}"/>${marks}</svg>`;
}

/** Horizontal bars for one series, each labelled at its data end. */
export function rows(data: readonly Datum[], opts: { title: string; labelWidth?: number }): string {
  const width = 560;
  const rowH = 22;
  const labelW = opts.labelWidth ?? 220;
  const height = Math.max(rowH, data.length * rowH) + 4;
  const max = Math.max(1, ...data.map((d) => d.value));
  const track = width - labelW - 40;
  // Labels are right-aligned against the bars, so a long one would run off the left edge.
  // Monospace at the chart's 12px label size is about 7.2 units a character.
  const fit = Math.floor((labelW - 12) / 7.2);
  const label = (s: string) => (s.length > fit ? `${s.slice(0, fit - 1)}…` : s);
  const marks = data
    .map((d, i) => {
      const y = i * rowH + 4;
      const w = (d.value / max) * track;
      return `<g class="m"><rect class="hit" x="0" y="${y - 2}" width="${width}" height="${rowH}"/><text class="t" x="${labelW - 8}" y="${y + 12}" text-anchor="end">${esc(label(d.label))}</text><path d="${rowPath(labelW, y + 2, w, rowH - 8)}"/><text class="v" x="${labelW + w + 6}" y="${y + 12}">${d.value}</text><title>${esc(d.title ?? `${d.label}: ${d.value}`)}</title></g>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.title)}"><line class="base" x1="${labelW}" x2="${labelW}" y1="0" y2="${height}"/>${marks}</svg>`;
}

/**
 * The homeostat's dial: a half-circle meter with a needle at `value` (0..1). Ashby's machine
 * showed each unit's state on a needle; here it is the share of the KB that is healthy.
 */
export function dial(value: number, opts: { title: string; caption: string }): string {
  const v = Math.max(0, Math.min(1, value));
  const cx = 110;
  const cy = 104;
  const r = 86;
  const point = (t: number, radius: number) => {
    const a = Math.PI * (1 - t);
    return [cx + radius * Math.cos(a), cy - radius * Math.sin(a)];
  };
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const [x1, y1] = point(i / 10, r - (i % 5 === 0 ? 12 : 7));
    const [x2, y2] = point(i / 10, r);
    return `<line class="tick${i % 5 === 0 ? " major" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join("");
  const [ax, ay] = point(0, r);
  const [bx, by] = point(1, r);
  const [nx, ny] = point(v, r - 18);
  const [vx, vy] = point(v, r);
  const large = 0;
  return `<svg class="dial" viewBox="0 0 220 158" role="img" aria-label="${esc(opts.title)}: ${Math.round(v * 100)}%">
<path class="track" d="M${ax},${ay} A${r},${r} 0 ${large} 1 ${bx},${by}"/>
<path class="fill" d="M${ax},${ay} A${r},${r} 0 ${large} 1 ${vx},${vy}"/>
${ticks}
<line class="needle" x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}"/>
<circle class="hub" cx="${cx}" cy="${cy}" r="5"/>
<text class="dial-value" x="${cx}" y="${cy + 34}" text-anchor="middle">${Math.round(v * 100)}%</text>
<text class="dial-caption" x="${cx}" y="${cy + 52}" text-anchor="middle">${esc(opts.caption)}</text>
<title>${esc(opts.title)}: ${Math.round(v * 100)}%</title>
</svg>`;
}

/** The table view every chart offers, for screen readers and exact numbers. */
export function dataTable(data: readonly Datum[], headers: [string, string]): string {
  return `<details class="table-view"><summary>Table</summary><table><thead><tr><th>${esc(headers[0])}</th><th class="num">${esc(headers[1])}</th></tr></thead><tbody>${data
    .map((d) => `<tr><td>${esc(d.label)}</td><td class="num">${d.value}</td></tr>`)
    .join("")}</tbody></table></details>`;
}

/**
 * An (i) that shows `html` on hover or keyboard focus. Explanations live here instead of in
 * paragraphs. The text stays in the page for screen readers; only its box is hidden.
 */
export function info(html: string): string {
  return `<span class="info" tabindex="0"><span class="i" aria-hidden="true">i</span><span class="tip" role="tooltip">${html}</span></span>`;
}
