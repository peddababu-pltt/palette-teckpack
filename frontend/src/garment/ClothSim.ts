// Cloth simulation (position-based dynamics).
//
// Particles = the pattern meshes' vertices, placed by GarmentFitting. Constraints:
//   stretch  -- every mesh edge keeps its drafted 2D length (the fabric's grain)
//   bend     -- vertices opposite a shared edge keep their 2D distance (drape stiffness)
//   seams    -- stitched vertex pairs, pulled together over the first frames ("sewing")
// plus gravity, damping, body collision with friction, and the floor. The upper
// garment is simulated first; the lower garment is added once it has settled.
import type { BodyCollider } from "../body/BodyModel"
import type { Mesh2D } from "./PatternGeometry"
import type { FabricSpec, PieceInstance, Seam, SeamEnd } from "./types"

export interface SimPart {
  inst: PieceInstance
  mesh: Mesh2D
  initial: Float32Array // 3 per vertex, metres
  layer: "upper" | "lower"
  offset: number // first global particle index (filled by ClothSim)
  tris: Uint32Array // winding corrected to face outward
  /** local vertices the rest of the piece hangs from (shoulders, waist, cap...) */
  roots: number[]
  /** where roots rest on the body (3 per root) -- set for pieces that hang from the body */
  anchors: Float32Array | null
}

export interface StitchPair { a: number; b: number; d0: number; seam: string }

const G = -9.81

export class ClothSim {
  parts: SimPart[]
  N: number
  x: Float32Array
  prev: Float32Array
  invMass: Float32Array
  margin: Float32Array
  layerOf: Uint8Array // 0 upper, 1 lower
  private sI: Int32Array; private sRest: Float32Array
  private bI: Int32Array; private bRest: Float32Array
  stitches: StitchPair[]
  private tI: Int32Array; private tRest: Float32Array // tethers: vertex -> its nearest root
  private pinI: Int32Array; private pinP: Float32Array // soft body attachment
  private collider: BodyCollider
  private fabric: FabricSpec
  frame = 0
  rampFrames = 150
  active = new Uint8Array(2) // which layers move
  warnings: string[] = []

  constructor(parts: SimPart[], seams: (Seam & { chainA?: SeamEnd[]; chainB?: SeamEnd[] })[], collider: BodyCollider, fabric: FabricSpec) {
    this.parts = parts
    this.collider = collider
    this.fabric = fabric
    let N = 0
    for (const p of parts) { p.offset = N; N += p.mesh.pos.length / 2 }
    this.N = N
    this.x = new Float32Array(N * 3)
    this.prev = new Float32Array(N * 3)
    this.invMass = new Float32Array(N)
    this.margin = new Float32Array(N)
    this.layerOf = new Uint8Array(N)
    const hasLower = parts.some((p) => p.layer === "lower")
    for (const p of parts) {
      this.x.set(p.initial, p.offset * 3)
      const n = p.mesh.pos.length / 2
      for (let i = 0; i < n; i++) {
        this.invMass[p.offset + i] = 1
        // upper cloth sits over the lower garment's waist, so it keeps a larger gap
        this.margin[p.offset + i] = p.layer === "upper" ? (hasLower ? 0.016 : 0.008) : 0.005
        this.layerOf[p.offset + i] = p.layer === "upper" ? 0 : 1
      }
      p.tris = orientOutward(p)
    }
    this.prev.set(this.x)
    // stretch + bend from each part's 2D mesh
    const sI: number[] = [], sR: number[] = [], bI: number[] = [], bR: number[] = []
    for (const p of parts) {
      const pos = p.mesh.pos, o = p.offset
      const d2 = (a: number, b: number) => Math.hypot(pos[a * 2] - pos[b * 2], pos[a * 2 + 1] - pos[b * 2 + 1]) / 1000
      const edgeTri = new Map<string, number[]>()
      const t = p.tris
      for (let k = 0; k < t.length; k += 3) {
        const tri = [t[k], t[k + 1], t[k + 2]]
        for (let e = 0; e < 3; e++) {
          const a = tri[e], b = tri[(e + 1) % 3], c = tri[(e + 2) % 3]
          const key = a < b ? `${a},${b}` : `${b},${a}`
          const list = edgeTri.get(key)
          if (list) {
            list.push(c)
            // second triangle on this edge: bend constraint across it
            bI.push(o + list[0], o + c)
            bR.push(d2(list[0], c))
          } else {
            edgeTri.set(key, [c])
            sI.push(o + a, o + b)
            sR.push(d2(a, b))
          }
        }
      }
    }
    this.sI = Int32Array.from(sI); this.sRest = Float32Array.from(sR)
    this.bI = Int32Array.from(bI); this.bRest = Float32Array.from(bR)
    // long-range tethers: nothing may drift further from its nearest root than it is
    // in the flat pattern (stops heavy panels stretching like rubber)
    const tI: number[] = [], tR: number[] = [], pI: number[] = [], pP: number[] = []
    for (const p of parts) {
      if (!p.roots.length) continue
      const pos = p.mesh.pos, n = pos.length / 2
      for (let v = 0; v < n; v++) {
        let best = Infinity, bi = -1
        for (const r of p.roots) {
          const d = Math.hypot(pos[v * 2] - pos[r * 2], pos[v * 2 + 1] - pos[r * 2 + 1])
          if (d < best) { best = d; bi = r }
        }
        if (bi >= 0 && bi !== v) { tI.push(p.offset + v, p.offset + bi); tR.push((best / 1000) * 1.03) }
      }
      if (p.anchors) p.roots.forEach((r, k) => {
        pI.push(p.offset + r)
        pP.push(p.anchors![k * 3], p.anchors![k * 3 + 1], p.anchors![k * 3 + 2])
      })
    }
    this.tI = Int32Array.from(tI); this.tRest = Float32Array.from(tR)
    this.pinI = Int32Array.from(pI); this.pinP = Float32Array.from(pP)
    this.stitches = this.buildStitches(seams)
    this.shareAnchors()
    this.active[0] = 1
    this.active[1] = parts.some((p) => p.layer === "upper") ? 0 : 1
  }

  // Two anchored vertices sewn together (a side seam's top at the waist, pieces meeting
  // at a corner) must rest on one spot, or their pins hold the seam open: each group of
  // stitched, pinned vertices gets the average of its anchor targets.
  private shareAnchors() {
    const pinOf = new Map<number, number>()
    this.pinI.forEach((v, c) => pinOf.set(v, c))
    const parent = new Map<number, number>()
    const find = (v: number): number => { let r = v; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r }
    for (const st of this.stitches) {
      if (!pinOf.has(st.a) || !pinOf.has(st.b)) continue
      const ra = find(st.a), rb = find(st.b)
      if (!parent.has(ra)) parent.set(ra, ra)
      if (!parent.has(rb)) parent.set(rb, rb)
      if (ra !== rb) parent.set(ra, rb)
    }
    const groups = new Map<number, number[]>()
    for (const v of parent.keys()) { const r = find(v); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(v) }
    for (const g of groups.values()) {
      if (g.length < 2) continue
      const m = [0, 0, 0]
      for (const v of g) for (let k = 0; k < 3; k++) m[k] += this.pinP[pinOf.get(v)! * 3 + k] / g.length
      for (const v of g) this.pinP.set(m, pinOf.get(v)! * 3)
    }
  }

  /** Global particle index of a part's local vertex. */
  private g(inst: string, local: number) {
    const p = this.parts.find((q) => q.inst.key === inst)!
    return p.offset + local
  }

  private chainVerts(ends: SeamEnd[]): { verts: number[]; len2d: number[] } {
    const verts: number[] = []
    const len2d: number[] = []
    const P = (gi: number) => [this.x[gi * 3], this.x[gi * 3 + 1], this.x[gi * 3 + 2]]
    const dist = (a: number, b: number) => { const p = P(a), q = P(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
    // every edge of the chain as global vertex runs, in order
    const segsAll: number[][] = []
    for (const end of ends) {
      const part = this.parts.find((q) => q.inst.key === end.instance)
      if (!part) continue
      for (const id of end.edges) {
        const local = part.mesh.edgeVerts.get(id)
        if (local) segsAll.push(local.map((l) => part.offset + l))
      }
    }
    // link the runs by nearest endpoint so the chain follows the body round (a
    // waistband's waist edges come from several pieces, split by darts)
    if (segsAll.length > 2) {
      // start at an open end of the chain (the endpoint furthest from every other run,
      // e.g. a skirt's centre-back opening) so the walk goes round in one direction
      let si0 = 0, sd = -1, flip = false
      segsAll.forEach((sg, i) => {
        for (const [e, f] of [[sg[0], false], [sg[sg.length - 1], true]] as const) {
          let md = Infinity
          segsAll.forEach((o, j) => { if (j !== i) md = Math.min(md, dist(e, o[0]), dist(e, o[o.length - 1])) })
          if (md > sd) { sd = md; si0 = i; flip = f }
        }
      })
      const first = segsAll.splice(si0, 1)[0]
      const ordered = [flip ? first.slice().reverse() : first]
      let tail = ordered[0][ordered[0].length - 1]
      while (segsAll.length) {
        let bi = 0, bd = Infinity, rev = false
        segsAll.forEach((sg, i) => {
          const d0 = dist(tail, sg[0]), d1 = dist(tail, sg[sg.length - 1])
          if (Math.min(d0, d1) < bd) { bd = Math.min(d0, d1); bi = i; rev = d1 < d0 }
        })
        const sg = segsAll.splice(bi, 1)[0]
        const o = rev ? sg.slice().reverse() : sg
        ordered.push(o)
        tail = o[o.length - 1]
      }
      segsAll.push(...ordered)
    }
    for (let si = 0; si < segsAll.length; si++) {
      let seg = segsAll[si]
      {
        if (!verts.length && segsAll.length > 1) {
          // first edge: run it toward the next edge of the chain
          const nx = segsAll[1]
          const toNext = (v: number) => Math.min(dist(v, nx[0]), dist(v, nx[nx.length - 1]))
          if (toNext(seg[0]) < toNext(seg[seg.length - 1])) seg = seg.slice().reverse()
        }
        if (verts.length) {
          const last = verts[verts.length - 1]
          if (dist(last, seg[seg.length - 1]) < dist(last, seg[0])) seg = seg.slice().reverse()
          if (seg[0] === last) seg = seg.slice(1)
        }
        for (const gi of seg) {
          const prevG = verts[verts.length - 1]
          len2d.push(prevG === undefined ? 0 : len2d[len2d.length - 1] + this.dist2d(prevG, gi))
          verts.push(gi)
        }
      }
    }
    return { verts, len2d }
  }

  // A closed chain (a whole neckline) re-started at the vertex nearest `to`.
  private rotateTo(c: { verts: number[]; len2d: number[] }, to: number | number[]) {
    const P = (gi: number) => [this.x[gi * 3], this.x[gi * 3 + 1], this.x[gi * 3 + 2]]
    const q = typeof to === "number" ? P(to) : to
    let bi = 0, bd = Infinity
    c.verts.forEach((v, i) => { const p = P(v); const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (d < bd) { bd = d; bi = i } })
    if (bi === 0) return c
    const verts = [...c.verts.slice(bi), ...c.verts.slice(0, bi)]
    const len2d: number[] = [0]
    for (let i = 1; i < verts.length; i++) len2d.push(len2d[i - 1] + (this.dist2d(verts[i - 1], verts[i]) || 0.001))
    return { verts, len2d }
  }

  private dist2d(a: number, b: number) {
    const pa = this.partOf(a), pb = this.partOf(b)
    if (pa !== pb) return 0.001
    const la = a - pa.offset, lb = b - pb.offset
    return Math.hypot(pa.mesh.pos[la * 2] - pa.mesh.pos[lb * 2], pa.mesh.pos[la * 2 + 1] - pa.mesh.pos[lb * 2 + 1]) / 1000
  }

  partOf(gi: number): SimPart {
    let lo = 0, hi = this.parts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.parts[mid].offset <= gi) lo = mid
      else hi = mid - 1
    }
    return this.parts[lo]
  }

  private buildStitches(seams: (Seam & { chainA?: SeamEnd[]; chainB?: SeamEnd[] })[]): StitchPair[] {
    const out: StitchPair[] = []
    const seen = new Set<string>()
    for (const s of seams) {
      const A = this.chainVerts(s.chainA || [s.a])
      let B = this.chainVerts(s.chainB || [s.b])
      if (A.verts.length < 2 || B.verts.length < 2) { this.warnings.push(`seam ${s.id} (${s.kind}): an edge has no mesh vertices`); continue }
      const p = (gi: number) => [this.x[gi * 3], this.x[gi * 3 + 1], this.x[gi * 3 + 2]]
      const d = (a: number, b: number) => { const u = p(a), v = p(b); return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]) }
      // a closed loop on one side (a full neckline) starts where the other side starts
      // (pieces start apart, so "closed" is relative to the chain's own length)
      const closed = (c: typeof A) => d(c.verts[0], c.verts[c.verts.length - 1]) < Math.max(0.03, 0.15 * (c.len2d[c.len2d.length - 1] || 0))
      // ...at the middle of the open side's gap (a hood's opening at centre front), so
      // both open ends land either side of it
      if (closed(B) && !closed(A)) {
        const u = p(A.verts[0]), v = p(A.verts[A.verts.length - 1])
        B = this.rotateTo(B, [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2])
      }
      const a0 = A.verts[0], a1 = A.verts[A.verts.length - 1], b0 = B.verts[0], b1 = B.verts[B.verts.length - 1]
      if (d(a0, b0) + d(a1, b1) > d(a0, b1) + d(a1, b0)) {
        const total = B.len2d[B.len2d.length - 1]
        B = { verts: B.verts.slice().reverse(), len2d: B.len2d.slice().reverse().map((l) => total - l) }
      }
      const fa = A.len2d.map((l) => l / (A.len2d[A.len2d.length - 1] || 1))
      const fb = B.len2d.map((l) => l / (B.len2d[B.len2d.length - 1] || 1))
      const nearest = (f: number[], t: number) => {
        let lo = 0, hi = f.length - 1
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f[m] < t) lo = m; else hi = m }
        return Math.abs(f[lo] - t) < Math.abs(f[hi] - t) ? lo : hi
      }
      const pair = (ga: number, gb: number) => {
        if (ga === gb) return
        const k = ga < gb ? `${ga},${gb}` : `${gb},${ga}`
        if (seen.has(k)) return
        seen.add(k)
        out.push({ a: ga, b: gb, d0: d(ga, gb), seam: s.id })
      }
      A.verts.forEach((ga, i) => pair(ga, B.verts[nearest(fb, fa[i])]))
      B.verts.forEach((gb, i) => pair(A.verts[nearest(fa, fb[i])], gb))
    }
    return out
  }

  /**
   * Close whatever the solver left open: every group of stitched vertices still within
   * `maxGap` of each other moves to its common centre (seam ends where several pieces
   * meet, anchored corners). Run once, after the garment has settled.
   */
  weld(maxGap = 0.2) {
    const x = this.x
    const parent = new Int32Array(this.N).map((_, i) => i)
    const find = (v: number): number => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v] } return v }
    for (const st of this.stitches) {
      const d = Math.hypot(x[st.a * 3] - x[st.b * 3], x[st.a * 3 + 1] - x[st.b * 3 + 1], x[st.a * 3 + 2] - x[st.b * 3 + 2])
      if (d > maxGap) continue
      const ra = find(st.a), rb = find(st.b)
      if (ra !== rb) parent[ra] = rb
    }
    const sum = new Map<number, number[]>() // group -> [x, y, z, count]
    const seen = new Set<number>()
    for (const st of this.stitches) for (const v of [st.a, st.b]) {
      if (seen.has(v)) continue
      seen.add(v)
      const r = find(v)
      const m = sum.get(r) || [0, 0, 0, 0]
      sum.set(r, m)
      m[0] += x[v * 3]; m[1] += x[v * 3 + 1]; m[2] += x[v * 3 + 2]; m[3]++
    }
    for (const v of seen) {
      const m = sum.get(find(v))!
      if (m[3] < 2) continue
      x[v * 3] = m[0] / m[3]; x[v * 3 + 1] = m[1] / m[3]; x[v * 3 + 2] = m[2] / m[3]
      this.prev[v * 3] = x[v * 3]; this.prev[v * 3 + 1] = x[v * 3 + 1]; this.prev[v * 3 + 2] = x[v * 3 + 2]
    }
  }

  /** Start moving the lower garment (after the upper one has settled). */
  activateLower() {
    this.active[1] = 1
    this.frame = 0
    // the settled upper garment stays put while the lower one is sewn
    for (let i = 0; i < this.N; i++) if (this.layerOf[i] === 0) this.invMass[i] = 0
  }

  /** Let the whole garment settle together. */
  release() {
    for (let i = 0; i < this.N; i++) this.invMass[i] = 1
  }

  /** One frame (1/60 s): `substeps` x (integrate, constraints, collision). */
  step(substeps = 6, iterations = 3) {
    const h = 1 / 60 / substeps
    const x = this.x, prev = this.prev, w = this.invMass, N = this.N
    const damp = 0.992
    const gdt = G * h * h
    const ramp = Math.max(0, 1 - this.frame / this.rampFrames)
    const stretchK = 1 - this.fabric.stretch * 0.4
    const bendK = 0.05 + this.fabric.bend * 0.35
    const moving = (i: number) => w[i] > 0 && this.active[this.layerOf[i]] === 1
    for (let s = 0; s < substeps; s++) {
      for (let i = 0; i < N; i++) {
        if (!moving(i)) continue
        const k = i * 3
        const vx = (x[k] - prev[k]) * damp, vy = (x[k + 1] - prev[k + 1]) * damp, vz = (x[k + 2] - prev[k + 2]) * damp
        prev[k] = x[k]; prev[k + 1] = x[k + 1]; prev[k + 2] = x[k + 2]
        x[k] += vx; x[k + 1] += vy + gdt; x[k + 2] += vz
      }
      for (let it = 0; it < iterations; it++) {
        this.solve(this.sI, this.sRest, stretchK, moving)
        this.solve(this.bI, this.bRest, bendK, moving)
        // seams: rest length shrinks from its start gap to 0
        // (two passes: seams are what turn separate pieces into one garment)
        for (let pass = 0; pass < 2; pass++) {
          for (const st of this.stitches) {
            if (!moving(st.a) && !moving(st.b)) continue
            this.project(st.a, st.b, st.d0 * ramp, 0.9, moving)
          }
        }
        // tethers only pull when too far (inequality)
        for (let c = 0; c < this.tRest.length; c++) {
          const a = this.tI[c * 2], b = this.tI[c * 2 + 1]
          const ia = a * 3, ib = b * 3
          const L = Math.hypot(x[ia] - x[ib], x[ia + 1] - x[ib + 1], x[ia + 2] - x[ib + 2])
          if (L > this.tRest[c]) this.project(a, b, this.tRest[c], 1, (i) => i === a && moving(a))
        }
        // roots ease onto the body over the sewing ramp, then rest there
        const pk = 0.08 + 0.3 * (1 - ramp)
        for (let c = 0; c < this.pinI.length; c++) {
          const i = this.pinI[c]
          if (!moving(i)) continue
          const k = i * 3
          x[k] += (this.pinP[c * 3] - x[k]) * pk
          x[k + 1] += (this.pinP[c * 3 + 1] - x[k + 1]) * pk
          x[k + 2] += (this.pinP[c * 3 + 2] - x[k + 2]) * pk
        }
      }
      for (let i = 0; i < N; i++) {
        if (!moving(i)) continue
        const k = i * 3
        if (this.collider.collide(x, k, this.margin[i], prev[k + 1])) {
          // friction: most of the tangential motion stops on contact
          prev[k] = x[k] + (prev[k] - x[k]) * 0.4
          prev[k + 1] = x[k + 1] + (prev[k + 1] - x[k + 1]) * 0.4
          prev[k + 2] = x[k + 2] + (prev[k + 2] - x[k + 2]) * 0.4
        }
      }
    }
    this.frame++
  }

  private solve(I: Int32Array, R: Float32Array, k: number, moving: (i: number) => boolean) {
    for (let c = 0; c < R.length; c++) this.project(I[c * 2], I[c * 2 + 1], R[c], k, moving)
  }

  private project(a: number, b: number, rest: number, k: number, moving: (i: number) => boolean) {
    const wa = moving(a) ? this.invMass[a] : 0, wb = moving(b) ? this.invMass[b] : 0
    const ws = wa + wb
    if (!ws) return
    const x = this.x, ia = a * 3, ib = b * 3
    const dx = x[ib] - x[ia], dy = x[ib + 1] - x[ia + 1], dz = x[ib + 2] - x[ia + 2]
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (L < 1e-9) return
    const corr = ((L - rest) / L / ws) * k
    x[ia] += dx * corr * wa; x[ia + 1] += dy * corr * wa; x[ia + 2] += dz * corr * wa
    x[ib] -= dx * corr * wb; x[ib + 1] -= dy * corr * wb; x[ib + 2] -= dz * corr * wb
  }

  /** Largest remaining gap across any seam (m). */
  seamGap(): number {
    let g = 0
    for (const st of this.stitches) {
      const ia = st.a * 3, ib = st.b * 3
      g = Math.max(g, Math.hypot(this.x[ib] - this.x[ia], this.x[ib + 1] - this.x[ia + 1], this.x[ib + 2] - this.x[ia + 2]))
    }
    return g
  }
}

// Mirrored copies come out inside-out: flip the winding of any part whose faces point
// toward the body instead of away from it.
function orientOutward(p: SimPart): Uint32Array {
  const t = p.mesh.tris, v = p.initial
  let score = 0
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]
    const nx = uy * wz - uz * wy, nz = ux * wy - uy * wx
    const cx = (v[a] + v[b] + v[c]) / 3, cz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3
    score += nx * cx + nz * cz
  }
  if (score >= 0) return t
  const f = new Uint32Array(t.length)
  for (let k = 0; k < t.length; k += 3) { f[k] = t[k]; f[k + 1] = t[k + 2]; f[k + 2] = t[k + 1] }
  return f
}
