// svg-flatten.mjs — SVG path data -> polylines, for exporting each cut piece's true
// cutline polygon to the 3D garment pipeline (pattern-pieces.json `polygon`).
//
// freesewing writes absolute M / L / C / Q / z commands; relative forms and H/V are
// handled too so AI-drafted and hand-edited paths flatten the same way. Curves are
// subdivided adaptively (~2mm chords) so necklines and armholes keep their shape.

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

function tokenize(d) {
  const out = []
  const re = /([MLCQHVZmlcqhvz])([^MLCQHVZmlcqhvz]*)/g
  for (const m of d.matchAll(re)) out.push({ cmd: m[1], nums: (m[2].match(NUM) || []).map(Number) })
  return out
}

function cubic(p0, p1, p2, p3, out) {
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

function quad(p0, p1, p2, out) {
  cubic(p0, [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])],
    [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])], p2, out)
}

// Returns an array of subpaths, each an array of [x, y].
export function flattenPath(d) {
  const subpaths = []
  let cur = null
  let pos = [0, 0], start = [0, 0]
  for (const { cmd, nums } of tokenize(d)) {
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const P = (x, y) => (rel ? [pos[0] + x, pos[1] + y] : [x, y])
    if (C === 'Z') {
      if (cur) cur.closed = true
      pos = start
      continue
    }
    let i = 0
    const take = (k) => { const r = nums.slice(i, i + k); i += k; return r }
    while (i < nums.length) {
      if (C === 'M') {
        const [x, y] = take(2)
        pos = P(x, y)
        start = pos
        cur = [pos]
        subpaths.push(cur)
        // further pairs after M are implicit L
        while (i + 1 < nums.length) { const [a, b] = take(2); pos = P(a, b); cur.push(pos) }
      } else if (C === 'L') {
        const [x, y] = take(2); pos = P(x, y); cur?.push(pos)
      } else if (C === 'H') {
        const [x] = take(1); pos = [rel ? pos[0] + x : x, pos[1]]; cur?.push(pos)
      } else if (C === 'V') {
        const [y] = take(1); pos = [pos[0], rel ? pos[1] + y : y]; cur?.push(pos)
      } else if (C === 'C') {
        const [x1, y1, x2, y2, x, y] = take(6)
        const p1 = P(x1, y1), p2 = P(x2, y2), p3 = P(x, y)
        if (cur) cubic(pos, p1, p2, p3, cur)
        pos = p3
      } else if (C === 'Q') {
        const [x1, y1, x, y] = take(4)
        const p1 = P(x1, y1), p2 = P(x, y)
        if (cur) quad(pos, p1, p2, cur)
        pos = p2
      } else break
      if (nums.length === 0) break
    }
  }
  return subpaths.filter((sp) => sp.length >= 2)
}

// Drop duplicates, then Ramer-Douglas-Peucker at `tol` mm: straight runs collapse to
// their ends, curves keep every point needed to stay within tol of the original.
export function simplify(pts, tol = 0.3) {
  const clean = []
  for (const p of pts) {
    const last = clean[clean.length - 1]
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.2) continue
    clean.push(p)
  }
  if (clean.length > 2) {
    const a = clean[0], b = clean[clean.length - 1]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.2) clean.pop()
  }
  if (clean.length < 4) return clean
  const keep = new Uint8Array(clean.length)
  const rdp = (i, j) => {
    const [ax, ay] = clean[i], [bx, by] = clean[j]
    const len = Math.hypot(bx - ax, by - ay) || 1
    let best = -1, bi = -1
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - clean[k][1]) - (ax - clean[k][0]) * (by - ay)) / len
      if (d > best) { best = d; bi = k }
    }
    if (best > tol) { keep[bi] = 1; rdp(i, bi); rdp(bi, j) }
  }
  // closed ring: split at the point farthest from the first one
  let far = 1
  for (let k = 1; k < clean.length; k++)
    if (Math.hypot(clean[k][0] - clean[0][0], clean[k][1] - clean[0][1]) > Math.hypot(clean[far][0] - clean[0][0], clean[far][1] - clean[0][1])) far = k
  keep[0] = 1; keep[far] = 1
  rdp(0, far)
  const ring = [...clean.slice(far), clean[0]]
  const keep2 = new Uint8Array(ring.length)
  keep2[0] = 1; keep2[ring.length - 1] = 1
  const rdp2 = (i, j) => {
    const [ax, ay] = ring[i], [bx, by] = ring[j]
    const len = Math.hypot(bx - ax, by - ay) || 1
    let best = -1, bi = -1
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - ring[k][1]) - (ax - ring[k][0]) * (by - ay)) / len
      if (d > best) { best = d; bi = k }
    }
    if (best > tol) { keep2[bi] = 1; rdp2(i, bi); rdp2(bi, j) }
  }
  rdp2(0, ring.length - 1)
  for (let k = 1; k < ring.length - 1; k++) if (keep2[k]) keep[far + k] = 1
  return clean.filter((_, k) => keep[k])
}

export function polygonArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}
