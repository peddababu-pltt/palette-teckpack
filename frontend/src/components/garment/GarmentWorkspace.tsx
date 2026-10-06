// 3D garment workspace: pattern pieces -> classified -> body measured -> upper
// garment fitted -> lower garment fitted -> seams sewn -> cloth draped -> fabric.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../../strings"
import { fetchBinary, fetchJson, resolveUrl, uploadPatternImage, watchJob, withCacheBust, type Job, type PatternDesign, type PatternPieces3D } from "../../api"
import { piecesFromSvg } from "../../garment/svgPieces"
import { loadBody, modelUrlFrom } from "../pattern3d/loadBody"
import { assemble, simulate, type Assembly } from "../../garment/GarmentAssembly"
import type { ClothSim } from "../../garment/ClothSim"
import { FABRICS, guessFabric } from "../../garment/FabricMaterial"
import { INTERNAL, SURFACE, loadPieces, scaleIndex } from "../../garment/PatternPiece"
import { labelEdges } from "../../garment/PatternGeometry"
import { garmentSizing, type GarmentSizing } from "../../garment/GarmentSizing"
import type { GarmentLayer, PatternPiece, Stage } from "../../garment/types"
import type { Fit } from "../pattern3d/body"
import { GarmentScene, type Toggles } from "./GarmentScene"

type StepState = "todo" | "active" | "done" | "warn"
const QUALITY = { preview: 20, final: 12 } // mesh spacing, mm
const REASSIGN: { label: string; category: string; layer: GarmentLayer | null }[] = [
  { label: "Bodice front", category: "bodice_front", layer: "upper" },
  { label: "Bodice back", category: "bodice_back", layer: "upper" },
  { label: "Sleeve", category: "sleeve", layer: "upper" },
  { label: "Collar", category: "collar", layer: "upper" },
  { label: "Cuff", category: "cuff", layer: "upper" },
  { label: "Skirt front", category: "skirt_front", layer: "lower" },
  { label: "Skirt back", category: "skirt_back", layer: "lower" },
  { label: "Trouser front", category: "trouser_front", layer: "lower" },
  { label: "Trouser back", category: "trouser_back", layer: "lower" },
  { label: "Waistband", category: "waistband", layer: "lower" },
  { label: "Accessory", category: "accessory", layer: "accessory" },
  { label: "Ignore", category: "__ignore", layer: null },
]

// The pieces the workspace works on: the job's drafted pattern, or an uploaded image
// of pattern pieces (a job of its own).
interface Source { id: string; mtime: number; pieces: string | null | undefined; design: string | null | undefined; svg?: string | null; kind: "draft" | "image" }

// `measurePanel` is the pattern's size / measurement editor, shown in the sidebar so
// measurements can be changed while looking at the garment; `redrafting` is the
// redraft's progress while one runs. Each finished redraft bumps job.mtime, which
// reloads the pieces and re-sizes the body, so the cloth follows the new numbers.
export default function GarmentWorkspace({ job, pluginId, onClose, measurePanel, redrafting }: {
  job: Job
  pluginId?: string
  onClose: () => void
  measurePanel?: ReactNode
  redrafting?: { pct: number } | null
}) {
  const { t } = usePluginTranslations(STRINGS)
  const draftSource = (): Source => ({ id: job.job_id, mtime: job.mtime, pieces: job.outputs.pattern_pieces, design: job.outputs.design, svg: job.outputs.pattern_svg, kind: "draft" })
  const [src, setSrc] = useState<Source>(draftSource)
  const [upload, setUpload] = useState<{ busy: boolean; msg: string; err: boolean }>({ busy: false, msg: "", err: false })
  const [longestCm, setLongestCm] = useState(70)
  const bodyRootRef = useRef<import("three").Object3D | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<GarmentScene | null>(null)
  const fitRef = useRef<Fit | null>(null)
  const indexRef = useRef<PatternPieces3D | null>(null)
  const simRef = useRef<ClothSim | null>(null)
  const snapRef = useRef<{ upper?: Float32Array; full?: Float32Array }>({})
  const runRef = useRef(0)
  const [design, setDesign] = useState<PatternDesign | null>(null)
  const [pieces, setPieces] = useState<PatternPiece[]>([])
  const [sizing, setSizing] = useState<GarmentSizing | null>(null)
  // cloth size: every piece enlarged evenly (1 = as drafted)
  const [clothScale, setClothScale] = useState(1.08)
  const bodyCmRef = useRef<Record<string, number>>({})
  const [assembly, setAssembly] = useState<Assembly | null>(null)
  const [stage, setStage] = useState<Stage>("pieces")
  const [toggles, setTogglesState] = useState<Toggles>({ mannequin: true, pieces: false, seams: true, wireframe: false, realistic: true, debug: false })
  const [fabric, setFabric] = useState("cotton")
  const [colour, setColour] = useState(FABRICS.cotton.baseColor)
  const quality: keyof typeof QUALITY = "preview"
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sim, setSim] = useState<{ phase: "idle" | "upper" | "lower" | "settle" | "done"; pct: number; gap: number }>({ phase: "idle", pct: 0, gap: 0 })
  const [bodyReady, setBodyReady] = useState(false)
  const category = String(design?.garmentCategory || "")
  // a fabric picked by hand survives reloads; otherwise each load guesses one
  const userFabricRef = useRef(false)

  // a redraft finished: follow the new pattern (unless an uploaded image is shown)
  useEffect(() => {
    if (src.kind !== "draft" || src.mtime === job.mtime) return
    setPieces([]); setAssembly(null); setBodyReady(false); setError(null)
    setSrc(draftSource())
  }, [job.mtime])

  // ---- load: pieces, design, body ----
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scene = new GarmentScene(host)
    sceneRef.current = scene
    scene.onPick = (k) => setSelected(k)
    let dead = false
    ;(async () => {
      try {
        const piecesUrl = withCacheBust(resolveUrl(src.pieces), src.mtime)
        const svgUrl = withCacheBust(resolveUrl(src.svg), src.mtime)
        const designUrl = withCacheBust(resolveUrl(src.design), src.mtime)
        const [fromJson, d] = await Promise.all([
          piecesUrl ? fetchJson<PatternPieces3D>(piecesUrl) : Promise.resolve(null),
          designUrl ? fetchJson<PatternDesign>(designUrl) : Promise.resolve(null),
        ])
        let index = fromJson
        // a pattern drafted before the piece file carried polygons: read the pieces
        // straight from its pattern.svg (keeping any AI classification that fits)
        if (!index?.pieces?.some((p: any) => p.polygon) && svgUrl) {
          const svg = new TextDecoder().decode(await fetchBinary(svgUrl))
          const fromSvg = piecesFromSvg(svg)
          const place = new Map((fromJson?.pieces || []).filter((p: any) => p.place?.category).map((p: any) => [p.suffix, p.place]))
          fromSvg.pieces = fromSvg.pieces.map((p) => (place.has(p.suffix) ? { ...p, place: place.get(p.suffix) } : p))
          index = { ...fromSvg, garment: fromJson?.garment ?? null }
        }
        if (!index?.pieces?.length) throw new Error(t("garment.noPieces"))
        if (dead) return
        indexRef.current = index
        setDesign(d)
        if (!userFabricRef.current) {
          const f = guessFabric((index.garment as any)?.fabric, d?.notes as string)
          setFabric(f)
          setColour(FABRICS[f].baseColor)
        }
        const cm: Record<string, number> = {}
        for (const m of d?.measurements || []) if (m.cm) cm[m.key] = m.cm
        // size the body to the garment it wears (its own waist / hip, minus ease)
        const loaded = loadPieces(index, String(d?.garmentCategory || ""))
        const sz = garmentSizing(loaded, cm)
        setSizing(sz)
        Object.assign(cm, sz.bodyCm)
        bodyCmRef.current = { ...cm }
        const body = await loadBody(modelUrlFrom((piecesUrl || svgUrl)!), cm, String(d?.designKey || ""))
        if (dead) return
        fitRef.current = body.fit
        bodyRootRef.current = body.root
        scene.setBody(body.root)
        setBodyReady(true)
        applyScale(clothScale, index, String(d?.garmentCategory || ""))
      } catch (e: any) {
        if (!dead) setError(e?.message || String(e))
      }
    })()
    return () => {
      dead = true
      runRef.current++
      scene.dispose()
      sceneRef.current = null
    }
  }, [src.id, src.mtime])

  // the displayed garment at the chosen cloth size (the body stays sized to the draft)
  function applyScale(k: number, index = indexRef.current, cat = category) {
    if (!index) return
    const list = loadPieces(scaleIndex(index, k), cat)
    setSizing((sz) => {
      const now = garmentSizing(list, bodyCmRef.current)
      return sz ? { ...now, adjusted: sz.adjusted } : now
    })
    setPieces(list)
  }

  // ---- fit: assemble whenever pieces / quality change ----
  useEffect(() => {
    const scene = sceneRef.current, fit = fitRef.current, index = indexRef.current
    if (!scene || !fit || !index || !pieces.length) return
    runRef.current++
    const a = assemble(index, category, fit, QUALITY[quality], pieces)
    const s = simulate(a, FABRICS[fabric])
    simRef.current = s
    snapRef.current = {}
    scene.build(a)
    scene.setFabric(FABRICS[fabric], colour)
    scene.buildSeams(s)
    setAssembly(a)
    setSim({ phase: "idle", pct: 0, gap: s.seamGap() })
    // sew straight away: the garment is only meaningful with its seams closed
    runSimulation(a)
  }, [pieces, quality, bodyReady])

  useEffect(() => { sceneRef.current?.setFabric(FABRICS[fabric], colour) }, [fabric, colour])
  useEffect(() => { sceneRef.current?.setToggles(toggles) }, [toggles])

  // ---- sewing: the pieces are stitched onto the body out of sight (upper first, then
  // lower, then everything settles) and only the finished garment is shown ----
  function runSimulation(aNow?: Assembly) {
    const scene = sceneRef.current, a = aNow || assembly
    if (!scene || !a) return
    const s = simulate(a, FABRICS[fabric])
    simRef.current = s
    scene.buildSeams(s)
    if ((window as any).__gw) (window as any).__gwDebug = { sim: s, assembly: a, scene }
    const run = ++runRef.current
    const hasUpper = a.parts.some((p) => p.layer === "upper"), hasLower = a.parts.some((p) => p.layer === "lower")
    const plan: { phase: "upper" | "lower" | "settle"; frames: number }[] = []
    if (hasUpper) plan.push({ phase: "upper", frames: 260 })
    if (hasLower) plan.push({ phase: "lower", frames: 260 })
    plan.push({ phase: "settle", frames: 90 })
    const total = plan.reduce((n, p) => n + p.frames, 0)
    let pi = 0, f = 0, done = 0
    if (!hasUpper) s.activateLower()
    scene.setGarmentHidden(true)
    const tick = () => {
      if (run !== runRef.current) return
      const t0 = performance.now()
      while (performance.now() - t0 < 30 && pi < plan.length) {
        s.step()
        f++; done++
        if (f >= plan[pi].frames) {
          if (plan[pi].phase === "upper" && hasLower) s.activateLower()
          if (plan[pi].phase === "lower") s.release()
          pi++; f = 0
        }
      }
      const phase = pi < plan.length ? plan[pi].phase : "done"
      setSim({ phase, pct: Math.round((done / total) * 100), gap: s.seamGap() })
      if (pi < plan.length) { requestAnimationFrame(tick); return }
      s.weld()
      snapRef.current.full = s.x.slice()
      scene.showState(s.x)
      scene.setGarmentHidden(false)
      setStage("final")
      scene.setStage("final")
    }
    requestAnimationFrame(tick)
  }

  function chooseStage(st: Stage) {
    const scene = sceneRef.current
    if (!scene || !assembly || !snapRef.current.full) return
    setStage(st)
    scene.setStage(st)
    scene.showState(snapRef.current.full)
  }



  function reassign(id: string, choice: string) {
    const opt = REASSIGN.find((r) => r.category === choice)
    if (!opt) return
    setPieces((list) => list.map((p) => {
      if (p.id !== id) return p
      if (opt.category === "__ignore") return { ...p, status: "ignored" }
      const q = { ...p, category: opt.category, garmentLayer: opt.layer, status: "ok" as const, confidence: 1 }
      q.edges = labelEdges(q.ring, q.category, q.centre)
      return q
    }))
  }

  const setToggle = (k: keyof Toggles) => setTogglesState((s) => ({ ...s, [k]: !s[k] }))

  async function onUpload(file: File | undefined) {
    if (!file || !pluginId) return
    setUpload({ busy: true, msg: t("garment.uploading"), err: false })
    const res = await uploadPatternImage(pluginId, file, longestCm, String(design?.size || "M"))
    if (!res.job_id) { setUpload({ busy: false, msg: res.error || "upload failed", err: true }); return }
    let payload: any = null
    watchJob(pluginId, res.job_id, {
      onProgress: (d: any) => setUpload({ busy: true, msg: `${t("garment.segmenting")} ${d.percent ?? ""}%`, err: false }),
      onLine: (l: string) => { if (/pieces/.test(l)) setUpload({ busy: true, msg: l.replace(/^\[[^\]]*\]\s*/, ""), err: false }) },
      onStageDone: (d: any) => { payload = d },
      onDone: () => {
        if (!payload) { setUpload({ busy: false, msg: "no result", err: true }); return }
        setUpload({ busy: false, msg: "", err: false })
        setPieces([]); setAssembly(null); setBodyReady(false)
        setSrc({ id: res.job_id!, mtime: Date.now() / 1000, pieces: payload.pattern_pieces, design: payload.design, kind: "image" })
      },
      onError: (m: string) => setUpload({ busy: false, msg: m, err: true }),
      onCancelled: () => setUpload({ busy: false, msg: "", err: false }),
    })
  }

  // ---- derived lists ----
  const byLayer = useMemo(() => {
    const out = { upper: [] as PatternPiece[], lower: [] as PatternPiece[], accessory: [] as PatternPiece[], internal: [] as PatternPiece[], review: [] as PatternPiece[] }
    for (const p of pieces) {
      if (p.status === "needs_review") out.review.push(p)
      else if (p.status === "ignored") continue
      else if (INTERNAL.test(p.category) || SURFACE.test(p.category)) out.internal.push(p)
      else if (p.garmentLayer) out[p.garmentLayer].push(p)
    }
    return out
  }, [pieces])

  const inspector = useMemo(() => {
    if (!assembly || !selected) return null
    const inst = assembly.instances.find((i) => i.key === selected)
    if (!inst) return null
    const p = inst.piece
    const seams = assembly.seams.filter((s) => [...(s.chainA || [s.a]), ...(s.chainB || [s.b])].some((e) => e.instance === inst.key))
    const connected = new Set<string>()
    for (const s of seams) for (const e of [...(s.chainA || [s.a]), ...(s.chainB || [s.b])]) if (e.instance !== inst.key) connected.add(e.instance.split(":")[0])
    return { inst, p, seams, connected: [...connected], placement: assembly.placements.get(inst.key) }
  }, [assembly, selected])

  const steps: { label: string; state: StepState }[] = [
    { label: pieces.length ? t("garment.stepAnalyzed", { n: pieces.length }) : t("garment.stepAnalyzing"), state: pieces.length ? "done" : "active" },
    { label: t("garment.stepLayers", { u: byLayer.upper.length, l: byLayer.lower.length, a: byLayer.accessory.length }), state: pieces.length ? "done" : "todo" },
    ...(byLayer.review.length ? [{ label: t("garment.stepReview", { n: byLayer.review.length }), state: "warn" as StepState }] : []),
    { label: t("garment.stepBody"), state: bodyReady ? "done" : "active" },
    { label: sim.phase === "done" ? t("garment.stepSewn") : `${t("garment.stepSewing")} ${sim.pct}%`, state: sim.phase === "done" ? "done" : assembly ? "active" : "todo" },
  ]

  const m = assembly?.measurements
  const STAGES: { id: Stage; label: string }[] = [
    { id: "pieces", label: t("garment.stagePieces") },
    { id: "full", label: t("garment.stageFull") },
    { id: "final", label: t("garment.stageFinal") },
  ]

  return (
    <div className="gw-root" role="dialog" aria-label={t("garment.title")}>
      <header className="gw-head">
        <h2>{t("garment.title")}</h2>
        <span className="gw-sub">{design?.design as string}</span>
        <button type="button" className="tp-modal-btn" onClick={onClose}>{t("garment.close")}</button>
      </header>
      <aside className="gw-side">
        <section>
          <h3>{t("garment.secPattern")}</h3>
          <p className="studio-note">{src.kind === "image" ? t("garment.sourceImage") : t("garment.sourceDraft")}</p>
          {pluginId && (
            <div className="gw-upload">
              <label className="gw-row-label">{t("garment.longest")}
                <input type="number" min={5} max={300} value={longestCm} onChange={(e) => setLongestCm(+e.target.value || 70)} />
              </label>
              <label className={`tp-modal-btn gw-upload-btn${upload.busy ? " is-busy" : ""}`}>
                {upload.busy ? <span className="tp-spinner" /> : null} {t("garment.uploadImage")}
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={upload.busy} onChange={(e) => void onUpload(e.target.files?.[0])} />
              </label>
              {src.kind === "image" && (
                <button type="button" className="link-btn" onClick={() => { setPieces([]); setAssembly(null); setBodyReady(false); setSrc(draftSource()) }}>{t("garment.backToDraft")}</button>
              )}
              {upload.msg && <p className={`studio-note${upload.err ? " err" : ""}`}>{upload.msg}</p>}
            </div>
          )}
          <ul className="gw-list">
            {pieces.map((p) => (
              <li key={p.id} className={`gw-piece is-${p.status}`}>
                <span className="gw-pid">{p.id}</span>
                <span className="gw-pname" title={p.suffix}>{p.suffix}</span>
                <span className={`gw-tag is-${p.garmentLayer || "none"}`}>{p.status === "needs_review" ? "review" : p.garmentLayer || "—"}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>{t("garment.secGarment")}</h3>
          <p className="gw-count">{t("garment.upper")}: {byLayer.upper.length} · {t("garment.lower")}: {byLayer.lower.length} · {t("garment.accessories")}: {byLayer.accessory.length}</p>
          {!!byLayer.internal.length && <p className="studio-note">{t("garment.internal", { n: byLayer.internal.length })}</p>}
          {byLayer.review.map((p) => (
            <div key={p.id} className="gw-review">
              <p>{t("garment.reviewMsg", { id: p.id, name: p.suffix })}</p>
              <select defaultValue="" onChange={(e) => reassign(p.id, e.target.value)}>
                <option value="" disabled>{t("garment.assign")}</option>
                {REASSIGN.map((r) => <option key={r.category} value={r.category}>{r.label}</option>)}
              </select>
            </div>
          ))}
        </section>
        {measurePanel && src.kind === "draft" && <div className="gw-measure">{measurePanel}</div>}
        <section>
          <h3>{t("garment.secBody")}</h3>
          <label className="gw-check"><input type="checkbox" checked={toggles.mannequin} onChange={() => setToggle("mannequin")} /> {t("garment.humanoid")}</label>
          {m && (
            <table className="gw-meas">
              <tbody>
                {[["height", m.height], ["shoulderWidth", m.shoulderWidth], ["chest", m.chest], ["waist", m.waist], ["hip", m.hip], ["torsoLength", m.torsoLength], ["armLength", m.armLength], ["legLength", m.legLength]].map(([k, v]) => (
                  <tr key={k as string}><td>{t(`garment.m_${k}`)}</td><td>{((v as number) * 100).toFixed(1)} cm</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {sizing && sizing.rows.length > 0 && (
            <>
              <h4 className="gw-subhead">{t("garment.fitTitle")}</h4>
              <table className="gw-meas gw-fit">
                <thead><tr><th /><th>{t("garment.fitGarment")}</th><th>{t("garment.fitBody")}</th><th>{t("garment.fitEase")}</th></tr></thead>
                <tbody>
                  {sizing.rows.map((r) => (
                    <tr key={r.key} className={`is-${r.status}`}>
                      <td>{t(`garment.fit_${r.key}`)}</td><td>{r.garmentCm}</td><td>{r.bodyCm}</td>
                      <td title={t(`garment.fitStatus_${r.status}`)}>{r.easeCm > 0 ? "+" : ""}{r.easeCm} · {t(`garment.fitStatus_${r.status}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sizing.adjusted.length > 0 && <p className="studio-note">{t("garment.fitAdjusted", { list: sizing.adjusted.map((k) => t(`garment.fit_${k}`)).join(", ") })}</p>}
            </>
          )}
        </section>
        <section>
          <h3>{t("garment.secSim")}</h3>
          <label className="gw-row-label gw-scale">{t("garment.clothSize")} <strong>{Math.round(clothScale * 100)}%</strong>
            <input type="range" min={100} max={130} step={1} value={Math.round(clothScale * 100)}
              onChange={(e) => setClothScale(+e.target.value / 100)}
              onPointerUp={() => applyScale(clothScale)} onKeyUp={() => applyScale(clothScale)} />
          </label>
          <div className="gw-row">
            <label>{t("garment.fabric")}
              <select value={fabric} onChange={(e) => { userFabricRef.current = true; setFabric(e.target.value); setColour(FABRICS[e.target.value].baseColor) }}>
                {Object.keys(FABRICS).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <input type="color" value={colour} onChange={(e) => { userFabricRef.current = true; setColour(e.target.value) }} aria-label={t("garment.colour")} />
          </div>
        </section>
        <section>
          <h3>{t("garment.secView")}</h3>
          <div className="gw-views">
            {(["front", "side", "back", "360"] as const).map((v) => (
              <button key={v} type="button" className="tp-ctrl-btn" onClick={() => sceneRef.current?.view(v)}>{t(`garment.v_${v}`)}</button>
            ))}
            <button type="button" className="tp-ctrl-btn" onClick={() => sceneRef.current?.resetCamera()}>{t("garment.resetCam")}</button>
          </div>
        </section>
      </aside>
      <main className="gw-main">
        <div className="gw-toolbar">
          <div className="toggle-group">
            {STAGES.map((s) => (
              <button key={s.id} type="button" className={`toggle-btn${stage === s.id ? " active" : ""}`} onClick={() => chooseStage(s.id)}>{s.label}</button>
            ))}
          </div>
          <div className="gw-toggles">
            {(["pieces", "seams", "wireframe", "realistic", "debug"] as (keyof Toggles)[]).map((k) => (
              <label key={k} className="gw-check"><input type="checkbox" checked={toggles[k]} onChange={() => setToggle(k)} /> {t(`garment.t_${k}`)}</label>
            ))}
          </div>
        </div>
        <div className="gw-canvas-host" ref={hostRef}>
          {error && <div className="gw-msg err">{error}</div>}
          {!error && redrafting && src.kind === "draft" && (
            <div className="gw-msg"><span className="tp-spinner" /> {t("garment.refitting")} {redrafting.pct ? `${Math.round(redrafting.pct)}%` : ""}</div>
          )}
          {!error && !redrafting && !assembly && <div className="gw-msg"><span className="tp-spinner" /> {t("garment.loading")}</div>}
          {!error && assembly && sim.phase !== "done" && <div className="gw-msg"><span className="tp-spinner" /> {t("garment.stepSewing")} {sim.pct}%</div>}
        </div>
        {inspector && (
          <div className="gw-inspector">
            <div className="gw-insp-head"><strong>{inspector.p.id}</strong> <span>{inspector.p.suffix}</span>
              <button type="button" className="tp-ctrl-btn" onClick={() => { setSelected(null); sceneRef.current?.select(null) }}>×</button></div>
            <dl>
              <dt>{t("garment.i_category")}</dt><dd>{inspector.p.category}</dd>
              <dt>{t("garment.i_layer")}</dt><dd>{inspector.p.garmentLayer}</dd>
              <dt>{t("garment.i_side")}</dt><dd>{inspector.inst.bodySide > 0 ? "left" : inspector.inst.bodySide < 0 ? "right" : inspector.p.side}{inspector.inst.mirrored ? " (mirrored copy)" : ""}</dd>
              <dt>{t("garment.i_dims")}</dt><dd>{(inspector.p.width / 10).toFixed(1)} × {(inspector.p.height / 10).toFixed(1)} cm{inspector.p.unfolded ? " (unfolded)" : ""}</dd>
              <dt>{t("garment.i_conf")}</dt><dd>{Math.round(inspector.p.confidence * 100)}%</dd>
              <dt>{t("garment.i_region")}</dt><dd>{inspector.placement?.targetRegion}</dd>
              <dt>{t("garment.i_connected")}</dt><dd>{inspector.connected.join(", ") || "—"}</dd>
            </dl>
            <p className="gw-insp-sub">{t("garment.i_edges")}</p>
            <ul className="gw-edges">
              {inspector.p.edges.map((e) => <li key={e.id}>{e.id}: {e.kind}{e.half ? ` (${e.half})` : ""} · {(e.length / 10).toFixed(1)} cm</li>)}
            </ul>
            <p className="gw-insp-sub">{t("garment.i_seams")}</p>
            <ul className="gw-edges">
              {inspector.seams.map((s) => <li key={s.id} className={s.needsReview ? "is-review" : ""}>{s.id} {s.kind} · {(s.lengthA / 10).toFixed(0)}/{(s.lengthB / 10).toFixed(0)} cm{s.needsReview ? " ⚠" : ""}</li>)}
            </ul>
          </div>
        )}
      </main>
      <footer className="gw-status">
        {steps.map((s, i) => (
          <span key={i} className={`gw-step is-${s.state}`}>{s.state === "done" ? "✓" : s.state === "warn" ? "!" : s.state === "active" ? "→" : "·"} {s.label}</span>
        ))}
        {assembly?.warnings.slice(0, 3).map((w, i) => <span key={`w${i}`} className="gw-step is-warn" title={w}>! {w}</span>)}
      </footer>
    </div>
  )
}
