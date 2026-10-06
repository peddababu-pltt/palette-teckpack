// The body as a signed distance field, built from the fitted humanoid mesh itself: every
// part (torso, shoulders, arms, hands, legs, neck, head) exactly as it's drawn, no
// shape assumptions. Cloth collides against this surface.
//
// A voxel grid over the body: cells near the skin hold the true distance to the nearest
// triangle (+ outside, - inside); cells further out are "far outside", and cells deep
// inside (not reached by a flood fill from the grid's border) are "far inside".

export interface BodyMeshData {
  verts: Float32Array // x,y,z per vertex, metres, world space
  tris: Uint32Array
}

const BAND = 0.05 // m: exact distances within this of the skin

export class BodySDF {
  readonly cell: number
  private ox: number; private oy: number; private oz: number
  private nx: number; private ny: number; private nz: number
  private d: Float32Array

  constructor(mesh: BodyMeshData, cell = 0.012) {
    this.cell = cell
    const v = mesh.verts
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < v.length; i += 3) {
      x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i])
      y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1])
      z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2])
    }
    const pad = BAND + cell * 2
    this.ox = x0 - pad; this.oy = y0 - pad; this.oz = z0 - pad
    this.nx = Math.ceil((x1 - x0 + pad * 2) / cell) + 1
    this.ny = Math.ceil((y1 - y0 + pad * 2) / cell) + 1
    this.nz = Math.ceil((z1 - z0 + pad * 2) / cell) + 1
    const N = this.nx * this.ny * this.nz
    const dist = new Float32Array(N).fill(Infinity) // unsigned, in the band
    const sgn = new Int8Array(N) // sign of the nearest triangle's side
    const t = mesh.tris
    const bandC = Math.ceil(BAND / cell)
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3
      const ax = v[a], ay = v[a + 1], az = v[a + 2], bx = v[b], by = v[b + 1], bz = v[b + 2], cx = v[c], cy = v[c + 1], cz = v[c + 2]
      // face normal (outward for a consistently wound mesh)
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az
      let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx
      const fl = Math.hypot(fx, fy, fz)
      if (fl < 1e-12) continue
      fx /= fl; fy /= fl; fz /= fl
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.ox) / cell) - bandC)
      const i1 = Math.min(this.nx - 1, Math.ceil((Math.max(ax, bx, cx) - this.ox) / cell) + bandC)
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - this.oy) / cell) - bandC)
      const j1 = Math.min(this.ny - 1, Math.ceil((Math.max(ay, by, cy) - this.oy) / cell) + bandC)
      const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - this.oz) / cell) - bandC)
      const k1 = Math.min(this.nz - 1, Math.ceil((Math.max(az, bz, cz) - this.oz) / cell) + bandC)
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let kk = k0; kk <= k1; kk++) {
        const px = this.ox + i * cell, py = this.oy + j * cell, pz = this.oz + kk * cell
        const q = closestOnTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz)
        const dx = px - q[0], dy = py - q[1], dz = pz - q[2]
        const dd = Math.hypot(dx, dy, dz)
        if (dd > BAND) continue
        const idx = (i * this.ny + j) * this.nz + kk
        if (dd < dist[idx] - 1e-7) {
          dist[idx] = dd
          sgn[idx] = dx * fx + dy * fy + dz * fz >= 0 ? 1 : -1
        }
      }
    }
    // far cells: outside if reachable from the border without crossing the band
    const outside = new Uint8Array(N)
    const stack: number[] = []
    const push = (i: number, j: number, k: number) => {
      if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return
      const idx = (i * this.ny + j) * this.nz + k
      if (outside[idx]) return
      if (dist[idx] !== Infinity && sgn[idx] < 0) return
      outside[idx] = 1
      if (dist[idx] === Infinity) stack.push(i, j, k)
    }
    for (let i = 0; i < this.nx; i++) for (let j = 0; j < this.ny; j++) { push(i, j, 0); push(i, j, this.nz - 1) }
    for (let i = 0; i < this.nx; i++) for (let k = 0; k < this.nz; k++) { push(i, 0, k); push(i, this.ny - 1, k) }
    for (let j = 0; j < this.ny; j++) for (let k = 0; k < this.nz; k++) { push(0, j, k); push(this.nx - 1, j, k) }
    while (stack.length) {
      const k = stack.pop()!, j = stack.pop()!, i = stack.pop()!
      push(i + 1, j, k); push(i - 1, j, k); push(i, j + 1, k); push(i, j - 1, k); push(i, j, k + 1); push(i, j, k - 1)
    }
    this.d = new Float32Array(N)
    for (let idx = 0; idx < N; idx++) {
      if (dist[idx] !== Infinity) this.d[idx] = dist[idx] * sgn[idx]
      else this.d[idx] = outside[idx] ? BAND : -BAND
    }
  }

  /** Signed distance (m) at a point, trilinear; BAND when outside the grid. */
  sample(x: number, y: number, z: number): number {
    const fx = (x - this.ox) / this.cell, fy = (y - this.oy) / this.cell, fz = (z - this.oz) / this.cell
    if (fx < 0 || fy < 0 || fz < 0 || fx >= this.nx - 1 || fy >= this.ny - 1 || fz >= this.nz - 1) return BAND
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz)
    const tx = fx - i, ty = fy - j, tz = fz - k
    const D = this.d, NY = this.ny, NZ = this.nz
    const at = (a: number, b: number, c: number) => D[(a * NY + b) * NZ + c]
    const c00 = at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx
    const c10 = at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx
    const c01 = at(i, j, k + 1) * (1 - tx) + at(i + 1, j, k + 1) * tx
    const c11 = at(i, j + 1, k + 1) * (1 - tx) + at(i + 1, j + 1, k + 1) * tx
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz
  }

  /** Outward surface normal at a point (the distance gradient). */
  normal(x: number, y: number, z: number): [number, number, number] {
    const h = this.cell * 0.5
    const gx = this.sample(x + h, y, z) - this.sample(x - h, y, z)
    const gy = this.sample(x, y + h, z) - this.sample(x, y - h, z)
    const gz = this.sample(x, y, z + h) - this.sample(x, y, z - h)
    const l = Math.hypot(gx, gy, gz) || 1
    return [gx / l, gy / l, gz / l]
  }
}

// closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5)
function closestOnTri(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az]
  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz]
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [ax + abx * v, ay + aby * v, az + abz * v] }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz]
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [ax + acx * w, ay + acy * w, az + acz * w] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w]
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w]
}
