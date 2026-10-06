// Fabric materials: presets with a procedurally generated weave (normal + colour
// variation maps, tileable), physically based sheen/roughness, and the simulation
// parameters that go with the cloth (stretch, bend). UVs come from the pattern in
// real centimetres, so the weave has the same scale on every piece.
import * as THREE from "three"
import type { FabricSpec } from "./types"

export const FABRICS: Record<string, FabricSpec> = {
  cotton: { name: "cotton", baseColor: "#d8d0c5", roughness: 0.82, sheen: 0.35, normalStrength: 0.45, fabricScale: 26, stretch: 0.08, bend: 0.3, thickness: 0.0008 },
  denim: { name: "denim", baseColor: "#3b5773", roughness: 0.9, sheen: 0.2, normalStrength: 0.8, fabricScale: 18, stretch: 0.03, bend: 0.65, thickness: 0.0012 },
  silk: { name: "silk", baseColor: "#e9e2d8", roughness: 0.38, sheen: 0.9, normalStrength: 0.15, fabricScale: 60, stretch: 0.06, bend: 0.05, thickness: 0.0003 },
  wool: { name: "wool", baseColor: "#6e6258", roughness: 0.95, sheen: 0.7, normalStrength: 0.55, fabricScale: 14, stretch: 0.1, bend: 0.55, thickness: 0.0018 },
  linen: { name: "linen", baseColor: "#cfc3ad", roughness: 0.88, sheen: 0.25, normalStrength: 0.65, fabricScale: 16, stretch: 0.04, bend: 0.45, thickness: 0.0009 },
  leather: { name: "leather", baseColor: "#4a3426", roughness: 0.55, sheen: 0.1, normalStrength: 0.5, fabricScale: 8, stretch: 0.02, bend: 0.9, thickness: 0.0015 },
  knit: { name: "knit", baseColor: "#9aa6b2", roughness: 0.92, sheen: 0.55, normalStrength: 0.9, fabricScale: 12, stretch: 0.35, bend: 0.15, thickness: 0.0014 },
  mesh: { name: "mesh", baseColor: "#2d2f33", roughness: 0.7, sheen: 0.3, normalStrength: 0.6, fabricScale: 20, stretch: 0.25, bend: 0.1, thickness: 0.0006 },
}

// height field of one weave repeat, 0..1, at (u, v) in [0,1)
function weaveHeight(kind: string, u: number, v: number, noise: () => number): number {
  const TAU = Math.PI * 2
  switch (kind) {
    case "denim": // 3/1 twill: diagonal ridges
      return 0.5 + 0.5 * Math.sin(TAU * (u * 4 + v * 4)) * 0.7 + 0.15 * Math.sin(TAU * v * 16) + noise() * 0.1
    case "knit": { // columns of V stitches
      const col = (u * 6) % 1, row = (v * 8) % 1
      const vshape = Math.abs(col - 0.5) * 2 - row
      return 0.5 + 0.5 * Math.cos(TAU * vshape) * Math.sin(Math.PI * col)
    }
    case "silk": // satin: long smooth floats
      return 0.5 + 0.12 * Math.sin(TAU * v * 24) + noise() * 0.03
    case "wool":
      return 0.5 + 0.3 * Math.sin(TAU * u * 5) * Math.sin(TAU * v * 5) + noise() * 0.35
    case "leather": // pebbled grain
      return 0.5 + noise() * 0.6
    case "mesh": {
      const cu = (u * 6) % 1 - 0.5, cv = (v * 6) % 1 - 0.5
      return Math.hypot(cu, cv) < 0.28 ? 0 : 1
    }
    default: { // plain weave: over-under
      const wu = (u * 8) % 1, wv = (v * 8) % 1
      const ci = Math.floor(u * 8) + Math.floor(v * 8)
      const warp = Math.sin(Math.PI * wu), weft = Math.sin(Math.PI * wv)
      return 0.5 + 0.5 * (ci % 2 ? warp * 0.9 - weft * 0.3 : weft * 0.9 - warp * 0.3) + noise() * 0.05
    }
  }
}

const cache = new Map<string, { normal: THREE.Texture; color: THREE.Texture; alpha?: THREE.Texture }>()

function makeMaps(kind: string) {
  const hit = cache.get(kind)
  if (hit) return hit
  const S = 128
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const H = new Float32Array(S * S)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) H[y * S + x] = weaveHeight(kind, x / S, y / S, () => rnd() - 0.5)
  const at = (x: number, y: number) => H[((y + S) % S) * S + ((x + S) % S)]
  const nc = document.createElement("canvas"), cc = document.createElement("canvas")
  nc.width = nc.height = cc.width = cc.height = S
  const ng = nc.getContext("2d")!, cg = cc.getContext("2d")!
  const nd = ng.createImageData(S, S), cd = cg.createImageData(S, S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2, dy = (at(x, y + 1) - at(x, y - 1)) * 2
      const len = Math.hypot(dx, dy, 1)
      const i = (y * S + x) * 4
      nd.data[i] = ((-dx / len) * 0.5 + 0.5) * 255
      nd.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255
      nd.data[i + 2] = (1 / len) * 255
      nd.data[i + 3] = 255
      // colour: thread shading (valleys darker) -- multiplied onto the base colour
      const shade = 0.82 + at(x, y) * 0.18
      cd.data[i] = cd.data[i + 1] = cd.data[i + 2] = Math.max(0, Math.min(255, shade * 255))
      cd.data[i + 3] = kind === "mesh" && at(x, y) < 0.5 ? 0 : 255
    }
  }
  ng.putImageData(nd, 0, 0)
  cg.putImageData(cd, 0, 0)
  const mk = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const out = { normal: mk(nc, false), color: mk(cc, true) }
  cache.set(kind, out)
  return out
}

export function fabricMaterial(spec: FabricSpec, colour?: string): THREE.MeshPhysicalMaterial {
  const maps = makeMaps(spec.name)
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(colour || spec.baseColor),
    map: maps.color,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(spec.normalStrength, spec.normalStrength),
    roughness: spec.roughness,
    metalness: 0,
    sheen: spec.sheen,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(colour || spec.baseColor).lerp(new THREE.Color("#ffffff"), 0.4),
    side: THREE.DoubleSide,
    alphaTest: spec.name === "mesh" ? 0.5 : 0,
    transparent: false,
  })
  return m
}

/** Weave-scale UVs from the pattern's 2D positions (mm). */
export function fabricUVs(pos2d: Float32Array, spec: FabricSpec, mirrored: boolean): Float32Array {
  const n = pos2d.length / 2
  const uv = new Float32Array(n * 2)
  const per = 100 / spec.fabricScale // mm per repeat
  for (let i = 0; i < n; i++) {
    uv[i * 2] = ((mirrored ? -1 : 1) * pos2d[i * 2]) / per
    uv[i * 2 + 1] = pos2d[i * 2 + 1] / per
  }
  return uv
}

/** Pick a preset from the garment's own description (vision notes / AI fabric hint). */
export function guessFabric(hint: string | null | undefined, notes: string | null | undefined): string {
  const h = `${hint || ""} ${notes || ""}`.toLowerCase()
  for (const k of ["denim", "silk", "wool", "linen", "leather", "knit", "mesh"]) if (h.includes(k)) return k
  if (/jersey|rib|sweat|hood|tee|t-shirt|fleece/.test(h)) return "knit"
  if (/puffer|quilt|coat|tweed/.test(h)) return "wool"
  return "cotton"
}
