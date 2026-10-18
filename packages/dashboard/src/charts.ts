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

/**
 * A smooth area chart: one series as a curve over a soft gradient, with day labels below and the
 * last point marked and labelled. Each point has a hover title.
 */
export function areaChart(
  data: readonly Datum[],
  opts: { title: string; id: string; unit?: string },
): string {
  const w = 560;
  const h = 170;
  const pad = { top: 26, bottom: 24, left: 4, right: 14 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const x = (i: number) =>
    pad.left + (i * (w - pad.left - pad.right)) / Math.max(1, data.length - 1);
  const y = (v: number) => pad.top + (1 - v / max) * (h - pad.top - pad.bottom);
  const pts = data.map((d, i) => [x(i), y(d.value)] as const);
  // Catmull-Rom to cubic Bezier: a smooth curve through every point.
  let line = pts.length ? `M${pts[0]?.[0]},${pts[0]?.[1]}` : "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    if (!p0 || !p1 || !p2 || !p3) continue;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    line += ` C${c1[0]?.toFixed(1)},${c1[1]?.toFixed(1)} ${c2[0]?.toFixed(1)},${c2[1]?.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const base = h - pad.bottom;
  const area = pts.length ? `${line} L${pts.at(-1)?.[0]},${base} L${pts[0]?.[0]},${base} Z` : "";
  const last = data.at(-1);
  const lp = pts.at(-1);
  // Wide enough for the value and its unit, at about 7.5px a character.
  const cw = Math.max(70, 16 + 7.5 * `${last?.value ?? ""} ${opts.unit ?? ""}`.length);
  const grid = [0.25, 0.5, 0.75]
    .map(
      (f) =>
        `<line class="gridline" x1="0" x2="${w}" y1="${(pad.top + f * (base - pad.top)).toFixed(1)}" y2="${(pad.top + f * (base - pad.top)).toFixed(1)}"/>`,
    )
    .join("");
  const labels = data
    .map((d, i) =>
      (i % 2 === 0 && i !== data.length - 2) || i === data.length - 1
        ? `<text class="xl" x="${x(i).toFixed(1)}" y="${h - 4}" text-anchor="middle">${esc(d.label)}</text>`
        : "",
    )
    .join("");
  const hits = data
    .map(
      (d, i) =>
        `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="9"><title>${esc(d.title ?? `${d.label}: ${d.value}`)}</title></circle>`,
    )
    .join("");
  return `<svg class="area" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opts.title)}"><defs><linearGradient id="g-${opts.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.45"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#g-${opts.id})"/><path class="curve" d="${line}"/>${labels}${hits}${
    last && lp
      ? `<circle class="last" cx="${lp[0].toFixed(1)}" cy="${lp[1].toFixed(1)}" r="5"/><g class="callout" transform="translate(${(lp[0] - 14 - cw).toFixed(1)},${Math.max(lp[1] - 17, 4).toFixed(1)})"><rect width="${cw}" height="34" rx="6"/><text x="8" y="14" class="cl">${esc(last.label)}</text><text x="8" y="28" class="cv">${last.value}${opts.unit ? ` <tspan class="cu">${esc(opts.unit)}</tspan>` : ""}</text></g>`
      : ""
  }</svg>`;
}

/** Concentric rings, one per segment, each filled to its share of the largest. */
export function rings(
  segments: readonly { label: string; value: number; color: string }[],
  title: string,
): string {
  const size = 200;
  const c = size / 2;
  const max = Math.max(1, ...segments.map((s) => s.value));
  const arcs = segments
    .map((s, i) => {
      const r = 86 - i * 17;
      const len = 2 * Math.PI * r;
      const share = s.value / max;
      return `<circle class="ring-track" cx="${c}" cy="${c}" r="${r}"/><circle class="ring" cx="${c}" cy="${c}" r="${r}" stroke="${s.color}" stroke-dasharray="${(len * share * 0.75).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 ${c} ${c})"><title>${esc(`${s.label}: ${s.value}`)}</title></circle>`;
    })
    .join("");
  return `<svg class="rings" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(title)}">${arcs}</svg>`;
}
