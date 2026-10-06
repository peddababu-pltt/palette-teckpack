// The pipeline, end to end (UI-free, so it runs in the viewer and in tests alike):
//
//   pattern-pieces.json -> pieces (true polygons, classified) -> copies (L/R)
//   -> seam graph -> cloth meshes -> body landmarks / measurements
//   -> initial assembly per body region (upper, then lower) -> ClothSim
import { BodyCollider, landmarks, measurements } from "../body/BodyModel"
import type { Fit } from "../components/pattern3d/body"
import type { PatternPieces3D } from "../api"
import { ClothSim, type SimPart } from "./ClothSim"
import { fitPatternPiece, garmentContext, type Placement } from "./GarmentFitting"
import { meshPiece, type Mesh2D } from "./PatternGeometry"
import { instancesOf, loadPieces } from "./PatternPiece"
import { buildSeams, type SeamWithChains } from "./SeamGraph"
import type { BodyLandmarks, BodyMeasurements, FabricSpec, PatternPiece, PieceInstance } from "./types"

export interface Assembly {
  pieces: PatternPiece[]
  instances: PieceInstance[]
  seams: SeamWithChains[]
  meshes: Map<string, Mesh2D> // by instance key
  placements: Map<string, Placement>
  parts: SimPart[]
  landmarks: BodyLandmarks
  measurements: BodyMeasurements
  collider: BodyCollider
  warnings: string[]
}

export function assemble(index: PatternPieces3D, garmentCategory: string, fit: Fit, spacingMm = 18, pieces?: PatternPiece[]): Assembly {
  const warnings: string[] = []
  const all = pieces ?? loadPieces(index, garmentCategory)
  for (const p of all) if (p.status === "needs_review") warnings.push(`Piece ${p.id} (${p.suffix}) could not be confidently classified — not placed.`)
  const instances = instancesOf(all)
  const seams = buildSeams(instances) as SeamWithChains[]
  for (const s of seams) if (s.needsReview) warnings.push(`Seam ${s.id} (${s.kind}) edge lengths differ (${(s.lengthA / 10).toFixed(0)} vs ${(s.lengthB / 10).toFixed(0)} cm) — check it.`)
  const lm = landmarks(fit)
  const ms = measurements(fit)
  const collider = new BodyCollider(fit)
  const ctx = garmentContext(instances)
  const meshes = new Map<string, Mesh2D>()
  const placements = new Map<string, Placement>()
  const parts: SimPart[] = []
  const meshCache = new Map<string, Mesh2D>()
  for (const inst of instances) {
    let mesh = meshCache.get(inst.piece.id)
    if (!mesh) {
      mesh = meshPiece(inst.piece.ring, inst.piece.edges, spacingMm)
      meshCache.set(inst.piece.id, mesh)
    }
    meshes.set(inst.key, mesh)
    const { positions, placement } = fitPatternPiece(inst, mesh, fit, ms, lm, ctx)
    placements.set(inst.key, placement)
    warnings.push(...placement.warnings)
    if (placement.targetRegion === "none") continue
    const layer = inst.piece.garmentLayer === "lower" ? "lower" : "upper"
    const roots = rootsOf(inst, mesh)
    // pieces a garment hangs from rest their roots on the body: bodice shoulders +
    // neckline, yoke, and the lower garment's waist
    // (with a yoke, the fronts / back hang from it through their seams instead)
    const hasYoke = instances.some((i) => i.piece.category === "yoke")
    // (a skirt / trousers with a waistband hang from the band)
    const lowerBand = instances.some((i) => i.piece.category === "waistband" && i.piece.garmentLayer !== "upper")
    const hangs = /^yoke$/.test(inst.piece.category) ||
      (!lowerBand && /^(skirt_front|skirt_back|trouser_front|trouser_back)$/.test(inst.piece.category)) ||
      (inst.piece.category === "waistband" && inst.piece.garmentLayer !== "upper") ||
      (!hasYoke && /^(bodice_front|bodice_back)$/.test(inst.piece.category))
    let anchors: Float32Array | null = null
    if (hangs && roots.length) {
      const surface = fitPatternPiece(inst, mesh, fit, ms, lm, ctx, 0.006).positions
      anchors = new Float32Array(roots.length * 3)
      roots.forEach((r, k) => anchors!.set(surface.subarray(r * 3, r * 3 + 3), k * 3))
    }
    parts.push({ inst, mesh, initial: positions, layer, offset: 0, tris: mesh.tris, roots, anchors })
  }
  // upper first, then lower: the solver's particle order follows it
  parts.sort((a, b) => (a.layer === b.layer ? 0 : a.layer === "upper" ? -1 : 1))
  // seams only between placed parts
  const placed = new Set(parts.map((p) => p.inst.key))
  const usable = seams.filter((s) => [...(s.chainA || [s.a]), ...(s.chainB || [s.b])].every((e) => placed.has(e.instance)))
  // a piece nothing is sewn to (and that doesn't rest on the body itself) would just
  // fall off: leave it out rather than show it on the floor
  const sewn = new Set(usable.flatMap((s) => [...(s.chainA || [s.a]), ...(s.chainB || [s.b])].filter((e) => e.edges.length).map((e) => e.instance)))
  const kept = parts.filter((p) => {
    if (sewn.has(p.inst.key) || p.anchors) return true
    warnings.push(`${p.inst.piece.id} (${p.inst.piece.suffix}) isn't sewn to anything — not placed.`)
    return false
  })
  return { pieces: all, instances, seams: usable, meshes, placements, parts: kept, landmarks: lm, measurements: ms, collider, warnings }
}

// The vertices a piece hangs from: where it is sewn to (or rests on) what holds it up.
const ROOT_KINDS: Record<string, string[]> = {
  bodice_front: ["shoulder", "neckline"], bodice_back: ["shoulder", "neckline"], side_panel: ["armhole"],
  yoke: ["neckline", "yoke_front"], sleeve: ["cap"], sleeve_left: ["cap"], sleeve_right: ["cap"],
  cuff: ["attach"], collar: ["attach"], collar_stand: ["attach"], hood: ["neckline", "hood_back"], neckline: ["attach"],
  skirt_front: ["waist"], skirt_back: ["waist"], skirt_side: ["waist"],
  trouser_front: ["waist"], trouser_back: ["waist"], waistband: ["attach", "band_free"],
}
function rootsOf(inst: PieceInstance, mesh: Mesh2D): number[] {
  const kinds = ROOT_KINDS[inst.piece.category] || []
  const out = new Set<number>()
  for (const e of inst.piece.edges) if (kinds.includes(e.kind)) for (const v of mesh.edgeVerts.get(e.id) || []) out.add(v)
  return [...out]
}

export function simulate(a: Assembly, fabric: FabricSpec) {
  return new ClothSim(a.parts, a.seams, a.collider, fabric)
}
