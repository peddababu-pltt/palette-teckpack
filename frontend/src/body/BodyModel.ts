// Body landmarks, measurements and the cloth-collision shape -- all read off the
// fitted body (components/pattern3d/body.ts `Fit`: the MakeHuman model shaped to
// the pattern's measurements, or the built-in mannequin). Nothing here assumes one
// fixed body: every number comes from the Fit.
import * as THREE from "three"
import { TAU, type Fit } from "../components/pattern3d/body"
import { BodySDF } from "./BodySDF"
import type { BodyLandmarks, BodyMeasurements, V3 } from "../garment/types"

const v3 = (v: THREE.Vector3): V3 => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)]

function perimeter(a: number, b: number) {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
}

export function landmarks(fit: Fit): BodyLandmarks {
  const armL = fit.arm(1), armR = fit.arm(-1), legL = fit.leg(1), legR = fit.leg(-1)
  const at = (line: typeof armL, i: number) => line.pts[Math.min(i, line.pts.length - 1)]
  const cz = (y: number) => fit.section(y).cz
  return {
    head: [0, fit.neckY + 0.12, cz(fit.neckY)],
    neck: [0, fit.neckY, cz(fit.neckY)],
    chest: [0, fit.chestY, cz(fit.chestY)],
    waist: [0, fit.waistY, cz(fit.waistY)],
    hip: [0, fit.hipY, cz(fit.hipY)],
    shoulderL: v3(at(armL, 0)), shoulderR: v3(at(armR, 0)),
    elbowL: v3(at(armL, 1)), elbowR: v3(at(armR, 1)),
    wristL: v3(at(armL, 2)), wristR: v3(at(armR, 2)),
    kneeL: v3(at(legL, 1)), kneeR: v3(at(legR, 1)),
    ankleL: v3(at(legL, 2)), ankleR: v3(at(legR, 2)),
  }
}

export function measurements(fit: Fit): BodyMeasurements {
  const g = (y: number) => {
    const s = fit.section(y)
    return (perimeter(s.a, s.zf) + perimeter(s.a, s.zb)) / 2
  }
  const arm = fit.arm(1), leg = fit.leg(1)
  const r3 = (n: number) => +n.toFixed(3)
  return {
    height: r3(fit.neckY + 0.22),
    shoulderWidth: r3(fit.shoulderX * 2),
    chest: r3(g(fit.chestY)),
    waist: r3(g(fit.waistY)),
    hip: r3(g(fit.hipY)),
    torsoLength: r3(fit.shoulderY - fit.hipY),
    armLength: r3(arm.length),
    upperArm: r3(arm.lens[0] || 0),
    forearm: r3(arm.lens[1] || 0),
    legLength: r3(fit.crotchY),
    thigh: r3(fit.rThigh * TAU),
    knee: r3(((fit.rThigh + fit.rAnkle) / 2) * TAU),
    ankle: r3(fit.rAnkle * TAU),
  }
}

// ---------------- collision ----------------

interface Capsule {
  ax: number; ay: number; az: number; bx: number; by: number; bz: number; ra: number; rb: number
  // bounding sphere (filled in once built): skips capsules nowhere near a particle
  cx?: number; cy?: number; cz?: number; br2?: number
}

/**
 * Push-out collider: torso by its sampled (grown) cross-sections, neck + head, arms
 * and legs as tapered capsules along the skeleton's limb lines, and the floor.
 */
const SDF_CACHE = new WeakMap<Fit, BodySDF>()

export class BodyCollider {
  private fit: Fit
  private caps: Capsule[] = []
  private y0: number
  private y1: number
  private secY: Float32Array
  private secA: Float32Array
  private secZf: Float32Array
  private secZb: Float32Array
  private secCz: Float32Array
  private step = 0.005
  headC: V3
  headR: V3

  /** the real body surface (from the fitted mesh), when there is one */
  sdf: BodySDF | null = null

  constructor(fit: Fit) {
    this.fit = fit
    if (fit.mesh) {
      let sdf = SDF_CACHE.get(fit)
      if (!sdf) { sdf = new BodySDF(fit.mesh); SDF_CACHE.set(fit, sdf) }
      this.sdf = sdf
    }
    this.y0 = fit.crotchY - 0.02
    this.y1 = fit.neckY + 0.03
    const n = Math.ceil((this.y1 - this.y0) / this.step) + 1
    this.secY = new Float32Array(n); this.secA = new Float32Array(n); this.secZf = new Float32Array(n)
    this.secZb = new Float32Array(n); this.secCz = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const y = this.y0 + i * this.step
      const s = fit.section(Math.min(y, fit.neckY))
      this.secY[i] = y; this.secA[i] = s.a; this.secZf[i] = s.zf; this.secZb[i] = s.zb; this.secCz[i] = s.cz
    }
    const limb = (line: ReturnType<Fit["arm"]>, r0: number, r1: number) => {
      const total = line.length || 1
      let acc = 0
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const a = line.pts[i], b = line.pts[i + 1]
        const t0 = acc / total, t1 = (acc + line.lens[i]) / total
        acc += line.lens[i]
        this.caps.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ra: r0 + (r1 - r0) * t0, rb: r0 + (r1 - r0) * t1 })
      }
    }
    // arms: short capsules sized to the skin sampled along them (fuller at the
    // shoulder than the biceps measurement), else a taper from biceps to wrist
    const armCaps = (line: ReturnType<Fit["arm"]>, side: number) => {
      if (!fit.armRadius) { limb(line, fit.rBiceps * 1.02, fit.rWrist * 1.05); return }
      const STEP = 0.05, L = line.length
      for (let d = 0; d < L - 1e-6; d += STEP) {
        const e = Math.min(L, d + STEP)
        const a = line.at(d).p, b = line.at(e).p
        const taper = (t: number) => fit.rBiceps * 1.02 + (fit.rWrist * 1.05 - fit.rBiceps * 1.02) * (t / L)
        const ra = Math.max(taper(d), fit.armRadius(side, d)), rb = Math.max(taper(e), fit.armRadius(side, Math.max(0, e - 0.001)))
        this.caps.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ra, rb })
      }
    }
    for (const s of [-1, 1]) {
      armCaps(fit.arm(s), s)
      limb(fit.leg(s), fit.rThigh * 0.98, fit.rAnkle * 1.05)
    }
    const nz = fit.section(fit.neckY).cz
    this.headC = [0, fit.neckY + 0.12, nz + 0.01]
    this.headR = [0.08, 0.115, 0.095]
    // neck column
    this.caps.push({ ax: 0, ay: fit.shoulderY, az: nz, bx: 0, by: fit.neckY + 0.06, bz: nz, ra: fit.rNeck, rb: fit.rNeck * 0.95 })
    for (const c of this.caps) {
      c.cx = (c.ax + c.bx) / 2; c.cy = (c.ay + c.by) / 2; c.cz = (c.az + c.bz) / 2
      const br = Math.hypot(c.bx - c.ax, c.by - c.ay, c.bz - c.az) / 2 + Math.max(c.ra, c.rb) + 0.05
      c.br2 = br * br
    }
  }

  // skin height across the top of the shoulders (what a garment hangs from)
  private shTop = new Float32Array(64)
  private shX = 0
  private shCz = 0
  private shD = 0

  private initShoulders() {
    const f = this.fit
    this.shX = f.shoulderX + 0.03
    for (let k = 0; k < 64; k++) this.shTop[k] = f.shoulderTop((k / 63) * this.shX)
    const s = f.section(f.shoulderY - 0.02)
    this.shCz = s.cz
    this.shD = Math.max(s.zf, s.zb) * 1.15
  }

  /** Moves (x,y,z) at `i` in `p` out of the body by `margin`; returns true if it moved. */
  // against the real skin: anything closer than `margin` moves out along the surface
  // normal; plus the floor
  private collideSurface(p: Float32Array, i: number, margin: number): boolean {
    const sdf = this.sdf!
    let hit = false
    const d = sdf.sample(p[i], p[i + 1], p[i + 2])
    if (d < margin) {
      const n = sdf.normal(p[i], p[i + 1], p[i + 2])
      const push = margin - d
      p[i] += n[0] * push; p[i + 1] += n[1] * push; p[i + 2] += n[2] * push
      hit = true
    }
    if (p[i + 1] < 0.003) { p[i + 1] = 0.003; hit = true }
    return hit
  }

  collide(p: Float32Array, i: number, margin: number, prevY = Infinity): boolean {
    if (this.sdf) return this.collideSurface(p, i, margin)
    let x = p[i], y = p[i + 1], z = p[i + 2]
    let hit = false
    if (!this.shD) this.initShoulders()
    // shoulders from above: cloth resting on them can't sink through
    {
      const ax = Math.abs(x)
      if (ax <= this.shX && Math.abs(z - this.shCz) <= this.shD) {
        const top = this.shTop[Math.min(63, Math.round((ax / this.shX) * 63))] + margin
        // only cloth coming down onto the shoulders (it was above them last step)
        if (y < top && prevY >= top - 0.004) {
          y = top
          hit = true
        }
      }
    }
    // torso sections
    if (y >= this.y0 && y <= this.y1) {
      const k = Math.min(this.secY.length - 1, Math.max(0, Math.round((y - this.y0) / this.step)))
      const a = this.secA[k] + margin, cz = this.secCz[k]
      const d = (z >= cz ? this.secZf[k] : this.secZb[k]) + margin
      const rx = x / a, rz = (z - cz) / d
      const r = Math.hypot(rx, rz)
      if (r < 1 && r > 1e-6) {
        x /= r
        z = cz + (z - cz) / r
        hit = true
      } else if (r <= 1e-6) { z = cz + d; hit = true }
    }
    // legs below the crotch: their sampled cross-sections (fuller than capsules)
    if (y < this.fit.crotchY) {
      for (const side of [-1, 1]) {
        const ls = this.fit.legSection(side, y)
        if (!ls) continue
        const dx = x - ls.cx, dz = z - ls.cz
        const d = Math.hypot(dx, dz), R = ls.r + margin
        if (d < R && d > 1e-6) { x = ls.cx + (dx / d) * R; z = ls.cz + (dz / d) * R; hit = true }
      }
    }
    // limbs + neck
    for (const c of this.caps) {
      const ex = x - c.cx!, ey = y - c.cy!, ez = z - c.cz!
      if (ex * ex + ey * ey + ez * ez > c.br2!) continue
      const dx = c.bx - c.ax, dy = c.by - c.ay, dz = c.bz - c.az
      const L2 = dx * dx + dy * dy + dz * dz || 1e-9
      let t = ((x - c.ax) * dx + (y - c.ay) * dy + (z - c.az) * dz) / L2
      if (t < -0.05 || t > 1.05) continue
      t = Math.max(0, Math.min(1, t))
      const qx = c.ax + dx * t, qy = c.ay + dy * t, qz = c.az + dz * t
      const R = c.ra + (c.rb - c.ra) * t + margin
      const ox = x - qx, oy = y - qy, oz = z - qz
      const dist = Math.hypot(ox, oy, oz)
      if (dist < R && dist > 1e-6) {
        const f = R / dist
        x = qx + ox * f; y = qy + oy * f; z = qz + oz * f
        hit = true
      }
    }
    // head
    {
      const [hx, hy, hz] = this.headC, [rx, ry, rz] = this.headR
      const ex = (x - hx) / (rx + margin), ey = (y - hy) / (ry + margin), ez = (z - hz) / (rz + margin)
      const r = Math.hypot(ex, ey, ez)
      if (r < 1 && r > 1e-6) {
        x = hx + (x - hx) / r; y = hy + (y - hy) / r; z = hz + (z - hz) / r
        hit = true
      }
    }
    if (y < 0.005) { y = 0.005; hit = true }
    p[i] = x; p[i + 1] = y; p[i + 2] = z
    return hit
  }

  get bodyFit() { return this.fit }
}
