// Panelled bodices (princess seams, side panels): the pieces round one half of the body
// from centre front to centre back, and which long edge of each panel sews to which
// neighbour. Side panels have no centre edge, so their orientation comes from edge
// lengths: the vertical edge that matches the centre panel's seam is the inner one.
import type { PieceInstance } from "./types"

export interface PanelInfo {
  front: boolean // on the front half of the body
  innerIds: number[] // edge ids toward the centre panel
  outerIds: number[] // edge ids toward the side seam / the other half
  innerLeft: boolean // the inner edges are on the pattern's left (small x)
  offset: number // m round the body from the centre line to the panel's middle
}

const VERT = new Set(["side", "unknown", "center"])

// a panel's long edges, grouped by which side of the pattern they lie on
function sides(inst: PieceInstance) {
  const p = inst.piece
  const midX = (id: number) => {
    const e = p.edges.find((q) => q.id === id)!
    const a = p.ring[e.from], b = p.ring[e.to]
    return (a[0] + b[0]) / 2
  }
  const x0 = Math.min(...p.ring.map((q) => q[0])), x1 = Math.max(...p.ring.map((q) => q[0]))
  const cx = (x0 + x1) / 2
  const vert = p.edges.filter((e) => VERT.has(e.kind) && e.length > p.height * 0.1)
  const left = vert.filter((e) => midX(e.id) < cx).map((e) => e.id)
  const right = vert.filter((e) => midX(e.id) >= cx).map((e) => e.id)
  const len = (ids: number[]) => ids.reduce((s, id) => s + p.edges.find((e) => e.id === id)!.length, 0)
  return { left, right, lenL: len(left), lenR: len(right) }
}

function isFrontPanel(inst: PieceInstance) {
  if (inst.piece.side === "front") return true
  if (inst.piece.side === "back") return false
  return !/back/i.test(inst.piece.suffix)
}

/** Side panels by instance key; empty when the bodice has none. */
export function panelLayout(instances: PieceInstance[]): Map<string, PanelInfo> {
  const out = new Map<string, PanelInfo>()
  const panels = instances.filter((i) => i.piece.category === "side_panel")
  if (!panels.length) return out
  const centreSeam = (list: PieceInstance[]) => {
    const c = list[0]
    if (!c) return { len: 0, half: 0 }
    const len = c.piece.edges.filter((e) => e.kind === "side" && (c.piece.centre.kind !== "full" || e.half === "l")).reduce((s, e) => s + e.length, 0)
    const half = (c.piece.centre.kind === "full" ? c.piece.width / 2 : c.piece.width) - 10
    return { len, half }
  }
  const fronts = instances.filter((i) => i.piece.category === "bodice_front")
  const backs = instances.filter((i) => i.piece.category === "bodice_back")
  const cf = centreSeam(fronts), cb = centreSeam(backs)
  for (const inst of panels) {
    const front = isFrontPanel(inst)
    const target = (front ? cf : cb).len
    const g = sides(inst)
    // the side whose length matches the centre panel's seam is the inner one (with
    // no centre panel on this half, the longer side goes inward)
    const innerLeft = target ? Math.abs(g.lenL - target) <= Math.abs(g.lenR - target) : g.lenL >= g.lenR
    out.set(inst.key, {
      front,
      innerIds: innerLeft ? g.left : g.right,
      outerIds: innerLeft ? g.right : g.left,
      innerLeft,
      offset: ((front ? cf : cb).half + (inst.piece.width - 20) / 2) / 1000,
    })
  }
  return out
}
