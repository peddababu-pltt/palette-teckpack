// Loads the 3D virtual try-on assets (backend/assets/vton, extracted from
// github.com/Qingcsai/3DVirtualTryOn by scripts/extract-vton-assets.py): a scanned
// body and T-shirt / trouser scans already aligned to it.
import * as THREE from "three"
import { assetUrlFrom, fetchBinary, fetchJson } from "../api"

export type ScanKind = "body" | "top" | "bottom"

export interface ScanMeta {
  name: string
  kind: ScanKind
  yMin: number
  yMax: number
}

export interface ScanMesh {
  name: string
  kind: ScanKind
  pos: Float32Array // scan space, metres, y up
  uv: Float32Array
  index: Uint32Array
  texture: THREE.Texture
  avgColour: string // texture's mean colour, for parts the scan doesn't cover
  colourAt: (u: number, v: number) => [number, number, number] // 0..255, from a small copy
}

interface Manifest {
  meshes: ScanMeta[]
}

/** Where each try-on asset is served: `.../jobs/<id>/file/...` -> `.../assets/vton/<name>`. */
export type VtonUrl = (name: string) => string

export function vtonBaseFrom(jobFileUrl: string): VtonUrl {
  return (name) => assetUrlFrom(jobFileUrl, `vton/${name}`)
}

// the assets never change: fetched once per session and shared by every job
let manifest: Promise<Manifest | null> | null = null
const meshes = new Map<string, Promise<ScanMesh>>()

export function loadManifest(base: VtonUrl): Promise<Manifest | null> {
  manifest ??= fetchJson<Manifest>(base("manifest.json"))
  return manifest
}

export function loadScan(base: VtonUrl, meta: ScanMeta): Promise<ScanMesh> {
  let p = meshes.get(meta.name)
  if (!p) {
    p = readScan(base, meta)
    p.catch(() => meshes.delete(meta.name))
    meshes.set(meta.name, p)
  }
  return p
}

async function readScan(base: VtonUrl, meta: ScanMeta): Promise<ScanMesh> {
  const [bin, jpg] = await Promise.all([fetchBinary(base(`${meta.name}.bin`)), fetchBinary(base(`${meta.name}.jpg`))])
  const head = new Uint32Array(bin, 0, 2)
  const nv = head[0], ni = head[1]
  const pos = new Float32Array(bin, 8, nv * 3)
  const uv = new Float32Array(bin, 8 + nv * 12, nv * 2)
  const index = new Uint32Array(bin, 8 + nv * 20, ni)
  // the scan's UVs expect a flipped image (three's default flipY for <img>)
  const bitmap = await createImageBitmap(new Blob([jpg], { type: "image/jpeg" }), { imageOrientation: "flipY" })
  const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement)
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  texture.needsUpdate = true
  return { name: meta.name, kind: meta.kind, pos, uv, index, texture, avgColour: meanColour(bitmap), colourAt: sampler(bitmap) }
}

function sampler(bitmap: ImageBitmap): ScanMesh["colourAt"] {
  const N = 128
  const c = document.createElement("canvas")
  c.width = c.height = N
  const g = c.getContext("2d")
  if (!g) return () => [122, 122, 122]
  g.drawImage(bitmap, 0, 0, N, N)
  const px = g.getImageData(0, 0, N, N).data
  // the bitmap is already flipped, so canvas row = v * N
  return (u, v) => {
    const x = Math.min(N - 1, Math.max(0, Math.floor(u * N))), y = Math.min(N - 1, Math.max(0, Math.floor(v * N)))
    const i = (y * N + x) * 4
    return [px[i], px[i + 1], px[i + 2]]
  }
}

function meanColour(bitmap: ImageBitmap): string {
  const c = document.createElement("canvas")
  c.width = c.height = 16
  const g = c.getContext("2d")
  if (!g) return "#7a7a7a"
  g.drawImage(bitmap, 0, 0, 16, 16)
  const px = g.getImageData(0, 0, 16, 16).data
  let r = 0, gr = 0, b = 0, n = 0
  for (let i = 0; i < px.length; i += 4) {
    // the atlas has empty (near-white / near-black) gutters: leave them out
    const s = px[i] + px[i + 1] + px[i + 2]
    if (s < 30 || s > 720) continue
    r += px[i]; gr += px[i + 1]; b += px[i + 2]; n++
  }
  if (!n) return "#7a7a7a"
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0")
  return `#${hex(r)}${hex(gr)}${hex(b)}`
}
