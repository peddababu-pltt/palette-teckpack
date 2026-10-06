// Pieces straight from a drafted pattern.svg -- for patterns drafted before
// pattern-pieces.json carried polygons, so the 3D garment builds from the SVG that's
// already there (no redraft needed). Same output shape as the backend export.
import type { PatternPieces3D, PatternPiece3D } from "../api"

type P = [number, number]
const PAD = 20 // mm, like the backend textures' margin

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

function cubic(p0: P, p1: P, p2: P, p3: P, out: P[]) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1])
  const n = Math.max(2, Math.min(64, Math.ceil(len / 2)))
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
}

/** SVG path data -> subpaths of points (M/L/H/V/C/Q/Z, absolute + relative). */
export function flattenPath(d: string): P[][] {
  const subs: P[][] = []
  let cur: P[] | null = null
  let pos: P = [0, 0], start: P = [0, 0]
  for (const m of d.matchAll(/([MLCQHVZmlcqhvz])([^MLCQHVZmlcqhvz]*)/g)) {
    const cmd = m[1], nums = (m[2].match(NUM) || []).map(Number)
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase()
    const Pt = (x: number, y: number): P => (rel ? [pos[0] + x, pos[1] + y] : [x, y])
    if (C === "Z") { pos = start; continue }
    let i = 0
    while (i < nums.length) {
      if (C === "M") {
        pos = Pt(nums[i], nums[i + 1]); i += 2
        start = pos; cur = [pos]; subs.push(cur)
      } else if (C === "L") { pos = Pt(nums[i], nums[i + 1]); i += 2; cur?.push(pos) }
      else if (C === "H") { pos = [rel ? pos[0] + nums[i] : nums[i], pos[1]]; i += 1; cur?.push(pos) }
      else if (C === "V") { pos = [pos[0], rel ? pos[1] + nums[i] : nums[i]]; i += 1; cur?.push(pos) }
      else if (C === "C") {
        const p1 = Pt(nums[i], nums[i + 1]), p2 = Pt(nums[i + 2], nums[i + 3]), p3 = Pt(nums[i + 4], nums[i + 5]); i += 6
        if (cur) cubic(pos, p1, p2, p3, cur)
        pos = p3
      } else if (C === "Q") {
        const q1 = Pt(nums[i], nums[i + 1]), q2 = Pt(nums[i + 2], nums[i + 3]); i += 4
        if (cur) cubic(pos, [pos[0] + (2 / 3) * (q1[0] - pos[0]), pos[1] + (2 / 3) * (q1[1] - pos[1])], [q2[0] + (2 / 3) * (q1[0] - q2[0]), q2[1] + (2 / 3) * (q1[1] - q2[1])], q2, cur)
        pos = q2
      } else break
    }
  }
  return subs.filter((s) => s.length >= 2)
}

/** Ramer-Douglas-Peucker on a closed ring (tol mm). */
function simplify(pts: P[], tol = 0.3): P[] {
  const c: P[] = []
  for (const p of pts) {
    const l = c[c.length - 1]
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= 0.2) c.push(p)
  }
  if (c.length > 2 && Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 0.2) c.pop()
  if (c.length < 4) return c
  const keep = new Uint8Array(c.length)
  const rdp = (i: number, j: number) => {
    const [ax, ay] = c[i], [bx, by] = c[j % c.length]
    const L = Math.hypot(bx - ax, by - ay) || 1
    let best = -1, bi = -1
    for (let k = i + 1; k < j; k++) {
      const q = c[k % c.length]
      const d = Math.abs((bx - ax) * (ay - q[1]) - (ax - q[0]) * (by - ay)) / L
      if (d > best) { best = d; bi = k }
    }
    if (best > tol) { keep[bi % c.length] = 1; rdp(i, bi); rdp(bi, j) }
  }
  let far = 1
  for (let k = 1; k < c.length; k++) if (Math.hypot(c[k][0] - c[0][0], c[k][1] - c[0][1]) > Math.hypot(c[far][0] - c[0][0], c[far][1] - c[0][1])) far = k
  keep[0] = 1; keep[far] = 1
  rdp(0, far)
  rdp(far, c.length)
  return c.filter((_, k) => keep[k])
}

const CUT = /<path\s+(?:style="[^"]*"\s+)?class="(?:fabric|lining|interfacing|various|contrast|canvas)"[^>]*\bd="([^"]+)"/g
const FOLD = /<path[^>]*marker-start="url\(#cutonfoldFrom\)"[^>]*\bd="([^"]+)"|<path[^>]*\bd="([^"]+)"[^>]*marker-start="url\(#cutonfoldFrom\)"/

export function piecesFromSvg(svg: string): PatternPieces3D {
  const re = /<g id="fs-stack-([\w]+\.([\w]+))"\s+transform="translate\(([-\d.]+),\s*([-\d.]+)\)">([\s\S]*?)<\/g>\s*<!-- end of group #fs-stack-\1 -->/g
  const pieces: PatternPiece3D[] = []
  for (const m of svg.matchAll(re)) {
    const [, , suffix, , , content] = m
    const inner = content.match(/<g id="fs-stack-[\w.]+-part-[\w.]+"\s+transform="translate\(([-\d.]+),\s*([-\d.]+)\)">/)
    const ox = inner ? +inner[1] : 0, oy = inner ? +inner[2] : 0
    let best: P[] | null = null, bestArea = 0
    for (const c of content.matchAll(CUT)) {
      const sub = flattenPath(c[1]).sort((a, b) => b.length - a.length)[0]
      if (!sub) continue
      const xs = sub.map((p) => p[0]), ys = sub.map((p) => p[1])
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      if (area > bestArea) { bestArea = area; best = sub.map(([x, y]) => [x + ox, y + oy] as P) }
    }
    if (!best || bestArea < 1) continue // freesewing's empty placeholder parts
    const x0 = Math.min(...best.map((p) => p[0])), y0 = Math.min(...best.map((p) => p[1]))
    const x1 = Math.max(...best.map((p) => p[0])), y1 = Math.max(...best.map((p) => p[1]))
    const shift = (p: P): [number, number] => [+(p[0] - x0 + PAD).toFixed(1), +(p[1] - y0 + PAD).toFixed(1)]
    const fm = content.match(FOLD)
    const fd = fm ? fm[1] || fm[2] : null
    const fl = fd ? flattenPath(fd)[0] : null
    const foldLine = fl && fl.length >= 2 ? [shift([fl[0][0] + ox, fl[0][1] + oy]), shift([fl[fl.length - 1][0] + ox, fl[fl.length - 1][1] + oy])] : null
    pieces.push({
      suffix,
      file: "",
      wMm: +(x1 - x0 + PAD * 2).toFixed(1),
      hMm: +(y1 - y0 + PAD * 2).toFixed(1),
      cutMm: { x: PAD, y: PAD, w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1) },
      onFold: !!foldLine,
      extra: content.includes('id="xp-'),
      polygon: simplify(best).map(shift),
      foldLine,
    } as PatternPiece3D & { polygon: [number, number][]; foldLine: [number, number][] | null })
  }
  return { dir: "", pieces }
}
