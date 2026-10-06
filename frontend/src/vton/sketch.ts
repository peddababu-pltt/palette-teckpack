// Reads the techpack's own input -- its flat sketch, FRONT and BACK side by side
// on white -- so the try-on wears that garment: where each view sits on the
// sheet, the front view's outline (its hem-to-waist flare) and the sketch's lines
// turned into cloth relief -- seams sink into grooves, quilted cells puff up --
// so the 3D garment is shaped by the design instead of having it drawn on.
import * as THREE from "three"
import { fetchBinary } from "../api"

export interface Box { x0: number; y0: number; x1: number; y1: number } // 0..1, y down

export interface SketchViews {
  texture: THREE.Texture
  normalMap: THREE.Texture // the relief's surface normals, sheet-wide (same uv as texture)
  heightAt: (u: number, v: number) => number // relief 0 (on a line) .. 1 (open cloth)
  front: Box
  back: Box | null
  /** front view's ink width at the top / bottom rows over its widest point */
  topWidth: number
  hemWidth: number
}

const W = 1024 // analysis width

/** `cellPx`: how far (analysis pixels) the cloth rises from a line to full height --
 *  wide for quilting (cushions between the stitch lines), narrow for plain seams. */
export async function loadSketch(url: string, quilted: boolean): Promise<SketchViews | null> {
  try {
    const bytes = await fetchBinary(url)
    const bitmap = await createImageBitmap(new Blob([bytes]))
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * W))
    const c = document.createElement("canvas")
    c.width = W
    c.height = h
    const g = c.getContext("2d", { willReadFrequently: true })
    if (!g) return null
    g.fillStyle = "#fff"
    g.fillRect(0, 0, W, h)
    g.drawImage(bitmap, 0, 0, W, h)
    const px = g.getImageData(0, 0, W, h).data
    const ink = new Uint8Array(W * h)
    for (let i = 0; i < W * h; i++) ink[i] = Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) < 200 ? 1 : 0

    // a divider between the views is a thin column inked most of the way down
    const colInk = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      let n = 0
      for (let y = 0; y < h; y++) n += ink[y * W + x]
      colInk[x] = n
    }
    for (let x = 0; x < W; x++) if (colInk[x] > h * 0.55 && (colInk[x - 2] || 0) < h * 0.2 && (colInk[x + 2] || 0) < h * 0.2) colInk[x] = 0

    const spans = runs(Array.from(colInk, (n) => n > 0), Math.round(W * 0.02)).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
    const views = spans.slice(0, 2).filter((s) => s[1] - s[0] > W * 0.08).sort((a, b) => a[0] - b[0])
    if (!views.length) return null
    const boxes = views.map(([x0, x1]) => {
      // rows of this view; the tallest run is the garment (labels sit apart below)
      const rowInk = new Array(h).fill(false)
      for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) if (ink[y * W + x]) { rowInk[y] = true; break }
      const [y0, y1] = runs(rowInk, Math.round(h * 0.02)).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
      return { x0, x1, y0, y1 }
    })
    const f = boxes[0]
    const width = (y: number) => {
      let l = -1, r = -1
      for (let x = f.x0; x <= f.x1; x++) if (ink[y * W + x]) { if (l < 0) l = x; r = x }
      return l < 0 ? 0 : r - l
    }
    let widest = 1
    for (let y = f.y0; y <= f.y1; y++) widest = Math.max(widest, width(y))
    const band = (a: number, b: number) => {
      let m = 0
      for (let y = Math.round(a); y <= Math.round(b); y++) m = Math.max(m, width(y))
      return m / widest
    }
    const fh = f.y1 - f.y0
    const norm = (b: { x0: number; x1: number; y0: number; y1: number }): Box => ({ x0: b.x0 / W, x1: (b.x1 + 1) / W, y0: b.y0 / h, y1: (b.y1 + 1) / h })

    const { heightAt, normalMap } = relief(ink, h, quilted ? 16 : 3.5, quilted)
    const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.flipY = false // uv.v below is image-down
    texture.anisotropy = 8
    texture.needsUpdate = true
    return {
      texture,
      normalMap,
      heightAt,
      front: norm(f),
      back: boxes[1] ? norm(boxes[1]) : null,
      topWidth: band(f.y0, f.y0 + fh * 0.06),
      hemWidth: band(f.y1 - fh * 0.06, f.y1),
    }
  } catch {
    return null
  }
}

/** Distance from the nearest line (chamfer transform) shaped into a height field,
 *  and the normal map of that field. */
function relief(ink: Uint8Array, h: number, cell: number, round: boolean) {
  const INF = 1e6, d = new Float32Array(W * h)
  for (let i = 0; i < d.length; i++) d[i] = ink[i] ? 0 : INF
  const a = 1, b = 1.414
  for (let y = 0; y < h; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + a)
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - W] + a)
        if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + b)
        if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + b)
      }
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x
      if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + a)
      if (y < h - 1) {
        d[i] = Math.min(d[i], d[i + W] + a)
        if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + b)
        if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + b)
      }
    }
  const height = new Float32Array(W * h)
  for (let i = 0; i < d.length; i++) {
    const t = Math.min(1, d[i] / cell)
    // quilting: round cushions; seams: a soft groove
    height[i] = round ? Math.sqrt(1 - (1 - t) * (1 - t)) : t * t * (3 - 2 * t)
  }
  const at = (x: number, y: number) => height[Math.min(h - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]
  const data = new Uint8Array(W * h * 4)
  const k = round ? 2.2 : 1.4
  for (let y = 0; y < h; y++)
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k, dy = (at(x, y + 1) - at(x, y - 1)) * k
      const len = Math.hypot(dx, dy, 1)
      const i = (y * W + x) * 4
      // tangent-space normal; image y runs down, uv v runs down too (flipY off)
      data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((dy / len * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255)
      data[i + 3] = 255
    }
  const normalMap = new THREE.DataTexture(data, W, h, THREE.RGBAFormat)
  normalMap.flipY = false
  normalMap.magFilter = THREE.LinearFilter
  normalMap.minFilter = THREE.LinearMipmapLinearFilter
  normalMap.generateMipmaps = true
  normalMap.anisotropy = 8
  normalMap.needsUpdate = true
  return { heightAt: (u: number, v: number) => at(Math.round(u * (W - 1)), Math.round(v * (h - 1))), normalMap }
}

/** [start, end] runs of `true`, bridging gaps up to `gap` long. */
function runs(on: boolean[], gap: number): [number, number][] {
  const out: [number, number][] = []
  let start = -1, last = -1
  on.forEach((v, i) => {
    if (!v) return
    if (start >= 0 && i - last > gap + 1) { out.push([start, last]); start = -1 }
    if (start < 0) start = i
    last = i
  })
  if (start >= 0) out.push([start, last])
  return out
}

/** UVs projecting the sketch onto garment points (scan space): the front view on
 *  points in front of the body's centre line, the back view (mirrored, as it's
 *  seen from behind) on those behind it. `bounds` is the whole garment's extent. */
export function projectUVs(pos: Float32Array, s: SketchViews, bounds: { x0: number; x1: number; y0: number; y1: number }, centreZ: (x: number, y: number) => number): Float32Array {
  const uv = new Float32Array((pos.length / 3) * 2)
  const w = bounds.x1 - bounds.x0 || 1, hgt = bounds.y1 - bounds.y0 || 1
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    const front = !s.back || z >= centreZ(x, y)
    const b = front ? s.front : s.back!
    const tx = front ? (x - bounds.x0) / w : (bounds.x1 - x) / w
    const ty = (bounds.y1 - y) / hgt
    uv[j] = b.x0 + tx * (b.x1 - b.x0)
    uv[j + 1] = b.y0 + ty * (b.y1 - b.y0)
  }
  return uv
}
