// 3D virtual try-on (after github.com/Qingcsai/3DVirtualTryOn): a scanned body
// wearing pre-fitted garment scans picked by the pattern's garment type, cut to the
// pattern's lengths and warped live to its measurements.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../../strings"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { fetchBinary, fetchJson, resolveUrl, saveToDataRoom, startGarment3D, watchJob, withCacheBust, type Job, type PatternDesign, type PatternPieces3D } from "../../api"
import { loadManifest, loadScan, vtonBaseFrom, type ScanMesh } from "../../vton/assets"
import { BOTTOM_VARIANTS, TOP_VARIANTS, planFromPattern, type TryOnPlan } from "../../vton/plan"
import { VtonScene, type Look } from "../../vton/VtonScene"
import { loadSketch, type SketchViews } from "../../vton/sketch"
import { HumanoidScene, genderFor, type Gender, type ViewMode } from "../../vton/HumanoidScene"
import { loadPieces } from "../../garment/PatternPiece"
import { gradePattern, scalePieces } from "../../vton/gradePattern"
import type { PaperSrc } from "../../vton/patternLayout"
import * as THREE from "three"
import { loadBody, modelUrlFrom } from "../pattern3d/loadBody"

// which body wears the garment: the scanned man with his fitted scans, or the
// humanoid (man / woman) wearing the garment reconstructed from the input
type BodyMode = "auto" | "scan" | Gender

// "frontBodice" -> "Front bodice", the way the pattern pages name pieces
function pieceLabel(suffix: string): string {
  const words = suffix.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function draftCm(d: PatternDesign | null): Record<string, number> {
  const cm: Record<string, number> = {}
  for (const m of d?.measurements || []) if (m.cm) cm[m.key] = m.cm
  return cm
}

export default function VtonViewer({ job, pluginId, onClose, measurePanel, liveCm, liveSize, redrafting }: {
  job: Job
  pluginId: string
  onClose: () => void
  measurePanel?: ReactNode
  liveCm?: Record<string, number> | null // the size panel's current values, edited or not
  liveSize?: string | null // the size panel's size chip
  redrafting?: { pct: number } | null
}) {
  const { t } = usePluginTranslations(STRINGS)
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<VtonScene | null>(null)
  const scansRef = useRef<Map<string, ScanMesh>>(new Map())
  const [ready, setReady] = useState(false) // body on screen
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<TryOnPlan | null>(null)
  const [design, setDesign] = useState<PatternDesign | null>(null)
  const [topVariant, setTopVariant] = useState<string | null>(null)
  const [bottomVariant, setBottomVariant] = useState<string | null>(null)
  const [look, setLook] = useState<Look>("input")
  const [colour, setColour] = useState("#d8d2c4")
  const [sketch, setSketch] = useState<SketchViews | null>(null)
  const colourTouched = useRef(false) // picked by hand: kept over the type's default
  // the real 3D garment reconstructed by three.ws (garment3d.glb), when there is one
  const [gen, setGen] = useState<{ busy: boolean; pct: number; msg: string; err: boolean; confirm: boolean }>({ busy: false, pct: 0, msg: "", err: false, confirm: false })
  const [genStamp, setGenStamp] = useState(0) // bumps when a new GLB lands
  const [hasGen, setHasGen] = useState(false)
  const [genChecked, setGenChecked] = useState(false) // garment3d.json looked at (there or not)
  // the images the 3D garment was made from: T-pose sketches, then photos
  const [genImages, setGenImages] = useState<string[]>([])
  const [useGen, setUseGen] = useState(true)
  const genRoot = useRef<import("three").Object3D | null>(null)
  const [spin, setSpin] = useState(false)
  const [easeCm, setEaseCm] = useState(2) // cloth ease over the scans' own fit
  const humanHostRef = useRef<HTMLDivElement>(null)
  const humanRef = useRef<HumanoidScene | null>(null)
  const [bodyMode, setBodyMode] = useState<BodyMode>("auto")
  const [humanReady, setHumanReady] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("3d")
  const [pieceIndex, setPieceIndex] = useState<PatternPieces3D | null>(null)
  const [papers, setPapers] = useState<Map<string, PaperSrc>>(new Map())

  const fileUrl = resolveUrl(job.outputs.design || job.outputs.pattern_svg)
  const base = fileUrl ? vtonBaseFrom(fileUrl) : null
  const genderAuto = genderFor([job.classification?.category, job.classification?.subcategory, plan?.label, design?.garmentCategory].filter(Boolean).join(" "))
  // auto: the humanoid (man or woman by the garment); the scan is opt-in
  const mode: "scan" | Gender = bodyMode === "auto" ? genderAuto : bodyMode
  const human = mode !== "scan"
  const region = plan && !plan.top ? "lower" : "upper"
  const active = () => (human ? humanRef.current : sceneRef.current)

  // ---- scene + body, once ----
  useEffect(() => {
    const host = hostRef.current
    if (!host || !base) return
    const scene = new VtonScene(host)
    sceneRef.current = scene
    let dead = false
    ;(async () => {
      try {
        const manifest = await loadManifest(base)
        if (!manifest?.meshes?.length) throw new Error(t("vton.noAssets"))
        const body = manifest.meshes.find((m) => m.kind === "body")!
        const scans = await Promise.all(manifest.meshes.map((m) => loadScan(base, m)))
        if (dead) return
        for (const s of scans) scansRef.current.set(s.name, s)
        scene.setBody(scansRef.current.get(body.name)!)
        setReady(true)
      } catch (e: any) {
        if (!dead) setError(e?.message || String(e))
      }
    })()
    return () => {
      dead = true
      scene.dispose()
      sceneRef.current = null
    }
  }, [base])

  // ---- the techpack's input: its flat sketch (front + back) ----
  const sketchUrl = withCacheBust(resolveUrl(job.sketch), job.mtime)
  useEffect(() => {
    let dead = false
    if (!sketchUrl) return
    void loadSketch(sketchUrl, !!plan?.quilted).then((s) => { if (!dead) setSketch(s) })
    return () => { dead = true }
  }, [sketchUrl, plan?.quilted])

  // ---- the reconstructed garment: load garment3d.glb if this job has one ----
  const genMetaUrl = withCacheBust(resolveUrl(job.outputs.design?.replace(/[^/]*$/, "garment3d.json")), job.mtime + genStamp)
  // a file next to garment3d.json, fresh each run
  const genFile = (name: string) => genMetaUrl!.replace(/garment3d\.json/, name).replace(/([?&]v=)[^&]*/, `$1${Date.now()}`)
  // the T-pose is made from the uploaded cloth photo, else from the flat sketch
  const canGen = !!(job.input || job.has_sketch)
  useEffect(() => {
    let dead = false
    if (!genMetaUrl || !ready) return
    void (async () => {
      const meta = await fetchJson<{ glb: string | null; photos?: string[]; tpose_sketches?: string[] }>(genFile("garment3d.json"))
      if (dead) return
      if (!meta) { setGenChecked(true); return }
      // the T-pose pictures land before the 3D does: show them either way
      setGenImages([...(meta.tpose_sketches || []), ...(meta.photos || [])].map(genFile))
      if (!meta.glb) { setGenChecked(true); return }
      try {
        const bytes = await fetchBinary(genFile(meta.glb))
        const gltf = await new GLTFLoader().parseAsync(bytes, "")
        if (dead) return
        genRoot.current = gltf.scene
        setHasGen(true)
        setGenChecked(true)
      } catch (e: any) {
        if (!dead) { setGen((g) => ({ ...g, msg: `3D model unreadable: ${e?.message || e}`, err: true })); setGenChecked(true) }
      }
    })()
    return () => { dead = true }
  }, [genMetaUrl, ready])

  // the figure stands there with nothing to wear: make its garment, once per job
  // (input -> nano-banana T-pose -> three.ws 3D -> worn). Pictures but no 3D yet
  // means a run is under way (or died): the start call joins it, else restarts it.
  const autoStarted = useRef<string | null>(null)
  useEffect(() => {
    if (autoStarted.current === job.job_id || !genChecked || !humanReady || hasGen || gen.busy || !canGen) return
    autoStarted.current = job.job_id
    void generateReal(genImages.length > 0)
  }, [genChecked, humanReady, hasGen, gen.busy, job.job_id])
  // the progress stream is single-reader server-side: a closed viewer lets go of it
  const genStream = useRef<EventSource | null>(null)
  useEffect(() => () => genStream.current?.close(), [])
  // Don't depend on the progress stream to learn the garment is ready: on the
  // hosted app it can drop (an EventSource carries no auth headers; proxies cut
  // long connections), and the viewer then never looked again -- the figure
  // stood bare until the 3D view was reopened. While a build runs, look for
  // garment3d.json / .glb every 8s (re-reading genMetaUrl) for up to ~12 min.
  const [polling, setPolling] = useState(false)
  useEffect(() => {
    if (!polling || hasGen) return
    let ticks = 0
    const id = window.setInterval(() => {
      if (++ticks > 90) {
        window.clearInterval(id)
        setPolling(false)
        setGen((g) => ({ ...g, busy: false, err: true, msg: t("vton.genTimeout") }))
        return
      }
      setGenStamp(Date.now() / 1000)
    }, 8000)
    return () => window.clearInterval(id)
  }, [polling, hasGen])
  useEffect(() => {
    if (!hasGen) return
    setPolling(false)
    setGen((g) => (g.busy ? { busy: false, pct: 100, msg: "", err: false, confirm: false } : g))
  }, [hasGen])

  useEffect(() => {
    sceneRef.current?.setGenerated(hasGen && useGen ? genRoot.current : null)
  }, [hasGen, useGen, plan, easeCm])

  // ---- the humanoid: made on first use, shaped to the measurements, posed for the garment ----
  useEffect(() => {
    const host = humanHostRef.current
    if (!human || !host) return
    const scene = new HumanoidScene(host)
    humanRef.current = scene
    return () => { scene.dispose(); humanRef.current = null; setHumanReady(false) }
  }, [human])
  // The figure is the wearer: a standard size-M body (the pattern's own size
  // table), the same every time. A size or measurement change re-sizes the
  // garment on it, not the person wearing it.
  const liveHumanCm: Record<string, number> = { ...draftCm(design), ...(liveCm || {}) }
  const sizeM = (design as (PatternDesign & { sizeTable?: Record<string, Record<string, number>> }) | null)?.sizeTable?.M
  const wearerCm = sizeM && Object.keys(sizeM).length ? sizeM : liveHumanCm
  const humanCm = JSON.stringify(wearerCm)
  const garmentScale = wearerCm.chest && liveHumanCm.chest ? liveHumanCm.chest / wearerCm.chest : 1
  useEffect(() => {
    const scene = humanRef.current
    if (!human || !scene || !fileUrl || !plan) return
    let dead = false
    setHumanReady(false)
    // measurement edits arrive per keystroke: reshape once they settle
    const timer = setTimeout(() => {
      void loadBody(modelUrlFrom(fileUrl), JSON.parse(humanCm), String(design?.designKey || ""), mode as Gender).then(({ root, fit }) => {
        if (dead) return
        scene.setBody(root, fit, region)
        scene.setGarment(hasGen && useGen ? genRoot.current : null, easeCm, garmentScale, plan?.top?.lengthCm || 0)
        setHumanReady(true)
      }).catch((e) => { if (!dead) setError(e?.message || String(e)) })
    }, 250)
    return () => { dead = true; clearTimeout(timer) }
  }, [human, mode, region, humanCm, fileUrl, !!plan])
  useEffect(() => {
    if (human && humanReady) humanRef.current?.setGarment(hasGen && useGen ? genRoot.current : null, easeCm, garmentScale, plan?.top?.lengthCm || 0)
  }, [human, humanReady, hasGen, useGen, easeCm, genStamp, garmentScale])
  useEffect(() => { humanRef.current?.setSpin(spin && human) }, [spin, human])
  // ---- pattern view: the drafted pieces where they're worn, again after every redraft ----
  const patternPieces = useMemo(
    () => (pieceIndex ? loadPieces(pieceIndex, String(design?.garmentCategory || job.classification?.subcategory || "")) : null),
    [pieceIndex, design?.garmentCategory],
  )
  // each piece as the sewing pattern draws it (piece-paper.mjs), fetched once per draft
  useEffect(() => {
    let dead = false
    const made: THREE.Texture[] = []
    const piecesUrl = resolveUrl(job.outputs.pattern_pieces)
    if (!pieceIndex || !piecesUrl) { setPapers(new Map()); return }
    // paperFile is job-relative like the index itself: swap the file name, keep any query
    void Promise.all(pieceIndex.pieces.map(async (e) => {
      const raw = e as typeof e & { paperFile?: string; polygon?: [number, number][] | null; foldLine?: [[number, number], [number, number]] | null }
      if (!raw.paperFile || !raw.polygon || raw.polygon.length < 3) return null
      try {
        // a redraft rewrites the folder: a texture caught mid-write 404s for a moment
        const url = withCacheBust(piecesUrl.replace(/[^/?]+(?=\?|$)/, raw.paperFile), job.mtime)!
        let bytes: ArrayBuffer | null = null
        for (let attempt = 0; !bytes; attempt++) {
          try { bytes = await fetchBinary(url) } catch (e) {
            if (attempt >= 3 || dead) throw e
            await new Promise((r) => setTimeout(r, 1500))
          }
        }
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
        const tex = new THREE.Texture(bmp)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 4
        tex.needsUpdate = true
        made.push(tex)
        const f = raw.foldLine
        const foldX = f && Math.abs(f[1][0] - f[0][0]) < Math.abs(f[1][1] - f[0][1]) ? (f[0][0] + f[1][0]) / 2 : null
        return [e.suffix, { ring: raw.polygon, w: e.wMm, h: e.hMm, tex, foldX }] as const
      } catch {
        return null // that piece falls back to its plain outline
      }
    })).then((list) => {
      if (dead) { made.forEach((t) => t.dispose()); return }
      setPapers(new Map(list.filter((x): x is NonNullable<typeof x> => !!x)))
    })
    return () => { dead = true; made.forEach((t) => t.dispose()) }
  }, [pieceIndex])
  // resized to the size panel's values as they are typed (no redraft)
  const graded = useMemo(
    () => gradePattern(patternPieces, papers, draftCm(design), { ...draftCm(design), ...(liveCm || {}) }, design?.size || "M", liveSize || design?.size || "M"),
    [patternPieces, papers, design, liveCm, liveSize],
  )
  // each piece's own cutline width / length (cm) typed over the graded size;
  // picking a size starts every piece from that size again
  const [pieceCm, setPieceCm] = useState<Record<string, { w?: string; h?: string }>>({})
  useEffect(() => setPieceCm({}), [liveSize])
  const pieceList = useMemo(() => {
    const seen = new Map<string, { suffix: string; w: number; h: number }>()
    for (const p of graded.pieces || []) if (!seen.has(p.suffix)) seen.set(p.suffix, { suffix: p.suffix, w: p.width / 10, h: p.height / 10 })
    return [...seen.values()]
  }, [graded])
  const shown = useMemo(() => {
    const base = new Map(pieceList.map((p) => [p.suffix, p]))
    return scalePieces(graded.pieces, graded.papers, (suffix) => {
      const o = pieceCm[suffix], b = base.get(suffix)
      if (!o || !b) return undefined
      const w = parseFloat(o.w ?? ""), h = parseFloat(o.h ?? "")
      return { kx: w > 0 && b.w > 0 ? w / b.w : 1, ky: h > 0 && b.h > 0 ? h / b.h : 1 }
    })
  }, [graded, pieceList, pieceCm])
  useEffect(() => {
    if (human && humanReady) humanRef.current?.setPattern(shown.pieces, shown.papers)
  }, [human, humanReady, shown])
  function editPiece(suffix: string, dim: "w" | "h", raw: string) {
    setPieceCm((cur) => ({ ...cur, [suffix]: { ...cur[suffix], [dim]: raw } }))
    if (viewMode !== "pattern" && patternPieces?.length) { setSpin(false); setViewMode("pattern") }
  }
  useEffect(() => { humanRef.current?.setViewMode(viewMode) }, [viewMode, human, humanReady])

  async function generateReal(resume = false) {
    setGen({ busy: true, pct: 0, msg: t(resume ? "vton.genBuilding" : "vton.genStarting"), err: false, confirm: false })
    if (!resume) setGenImages([])
    const desc = [job.classification?.subcategory, job.classification?.category, plan?.label].filter(Boolean).join(", ")
    const res = await startGarment3D(pluginId, job.job_id, colour, desc, plan?.top ? "upper" : "lower")
    if (res.error) { setGen({ busy: false, pct: 0, msg: res.error, err: true, confirm: false }); return }
    setPolling(true)
    genStream.current?.close()
    genStream.current = watchJob(pluginId, job.job_id, {
      onLine: (l) => {
        const img = /\[garment3d\]\s+image\s+(\S+)/.exec(l)
        if (img) { const src = genFile(img[1]); setGenImages((list) => (list.includes(src) ? list : [...list, src])); return }
        const m = /\[garment3d\]\s+(\d+)%\s+(.*)/.exec(l)
        if (m) setGen((g) => ({ ...g, pct: +m[1], msg: m[2] }))
        else if (/garment3d:/.test(l)) setGen((g) => ({ ...g, msg: l.replace(/^.*garment3d:\s*/, "") }))
      },
      onDone: () => {
        // the stream can also end early on the hosted app: keep "building" up
        // and let the polling above pick the garment up when it lands
        setGen((g) => ({ ...g, busy: true, pct: Math.max(g.pct, 95), err: false }))
        setUseGen(true); setGenStamp(Date.now() / 1000)
        void saveToDataRoom(pluginId, job.job_id) // the 3D garment goes into the org's Data Room too
      },
      onError: (msg) => {
        // a dropped stream is not a failed build: keep waiting via the polling
        if (msg === "lost connection to the server") { setGen((g) => ({ ...g, busy: true, err: false })); return }
        setPolling(false)
        setGen((g) => ({ ...g, busy: false, msg: g.msg ? `${msg} — ${g.msg}` : msg, err: true }))
      },
      onCancelled: () => setGen({ busy: false, pct: 0, msg: "", err: false, confirm: false }),
    }, "garment3d")
  }

  // ---- the pattern: design + pieces, again after every redraft ----
  useEffect(() => {
    let dead = false
    const designUrl = withCacheBust(resolveUrl(job.outputs.design), job.mtime)
    const piecesUrl = withCacheBust(resolveUrl(job.outputs.pattern_pieces), job.mtime)
    void Promise.all([
      designUrl ? fetchJson<PatternDesign>(designUrl) : Promise.resolve(null),
      piecesUrl ? fetchJson<PatternPieces3D>(piecesUrl) : Promise.resolve(null),
    ]).then(([d, pieces]) => {
      if (dead) return
      const c = job.classification
      const p = planFromPattern(d, pieces, [c?.category, c?.subcategory].filter(Boolean).join(" "))
      setDesign(d)
      setPieceIndex(pieces)
      setPlan(p)
      setColour((c) => (colourTouched.current ? c : p.colour))
      setTopVariant((v) => v ?? p.top?.variant ?? null)
      setBottomVariant((v) => v ?? p.bottom?.variant ?? null)
    })
    return () => {
      dead = true
    }
  }, [job.mtime, job.outputs.design, job.outputs.pattern_pieces])

  // ---- dress: the pattern as drafted ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !ready || !plan) return
    const top = plan.top && topVariant ? { ...plan.top, variant: topVariant } : plan.top
    const bottom = plan.bottom && bottomVariant ? { ...plan.bottom, variant: bottomVariant } : plan.bottom
    const scans = scansRef.current
    // a skirt flares as much as the input sketch does (hem width over waist width)
    let skirt = plan.skirt
    if (skirt && sketch && sketch.topWidth > 0.05) {
      const flare = sketch.hemWidth / sketch.topWidth
      skirt = { ...skirt, pencil: flare < 1.12, hemRatio: flare >= 1.12 ? flare : undefined }
    }
    scene.dress({ ...plan, top, bottom, skirt }, scansRef.current, draftCm(design), easeCm, sketch)
    scene.setLook(look, colour)
    if (liveCm) scene.setMeasurements({ ...draftCm(design), ...liveCm })
  }, [ready, plan, topVariant, bottomVariant, easeCm, sketch])

  // ---- live: every measurement edit reshapes body + garment at once ----
  useEffect(() => {
    if (ready && liveCm) sceneRef.current?.setMeasurements({ ...draftCm(design), ...liveCm })
  }, [liveCm, ready])

  useEffect(() => { sceneRef.current?.setLook(look, colour) }, [look, colour])
  useEffect(() => { sceneRef.current?.setSpin(spin && !human) }, [spin, human])

  const chips = (list: string[], value: string | null, set: (v: string) => void) => (
    <div className="tp-size-chips vt-chips" role="group">
      {list.map((v, i) => (
        <button key={v} type="button" className={`tp-size-chip${v === value ? " is-active" : ""}`} aria-pressed={v === value} onClick={() => set(v)}>
          {t("vton.style", { n: i + 1 })}
        </button>
      ))}
    </div>
  )

  return (
    <div className="vt-root" role="dialog" aria-label={t("vton.title")}>
      <header className="vt-head">
        <h2>{t("vton.title")}</h2>
        <span className="vt-sub">{plan?.label}</span>
        <button type="button" className="tp-modal-btn" onClick={onClose}>{t("vton.close")}</button>
      </header>
      <aside className="vt-side">
        {measurePanel && (
          <div className="vt-measure">
            {measurePanel}
            <p className="studio-note">{t("vton.liveNote")}</p>
          </div>
        )}
        {pieceList.length > 0 && (
          <section className="vt-pieces">
            <h3>{t("vton.secPieces")}</h3>
            <p className="studio-note">{t("vton.piecesNote")}</p>
            <div className="vt-piece-head" aria-hidden="true">
              <span />
              <span>{t("vton.pieceWidth")}</span>
              <span>{t("vton.pieceLength")}</span>
            </div>
            {pieceList.map((p) => (
              <div className="vt-piece-row" key={p.suffix}>
                <span className="vt-piece-name" title={p.suffix}>{pieceLabel(p.suffix)}</span>
                {(["w", "h"] as const).map((dim) => (
                  <input
                    key={dim}
                    type="number"
                    step="0.5"
                    min="1"
                    inputMode="decimal"
                    aria-label={`${pieceLabel(p.suffix)} ${t(dim === "w" ? "vton.pieceWidth" : "vton.pieceLength")}`}
                    value={pieceCm[p.suffix]?.[dim] ?? (dim === "w" ? p.w : p.h).toFixed(1)}
                    onChange={(e) => editPiece(p.suffix, dim, e.target.value)}
                  />
                ))}
              </div>
            ))}
            {Object.keys(pieceCm).length > 0 && (
              <button type="button" className="link-btn" onClick={() => setPieceCm({})}>{t("vton.piecesReset")}</button>
            )}
          </section>
        )}
        <section>
          <h3>{t("vton.secBody")}</h3>
          <div className="toggle-group vt-look" role="group">
            {(["scan", "male", "female"] as const).map((m) => (
              <button key={m} type="button" className={`toggle-btn${mode === m ? " active" : ""}`} aria-pressed={mode === m} onClick={() => setBodyMode(m)}>
                {t(m === "scan" ? "vton.bodyScan" : m === "male" ? "vton.bodyMale" : "vton.bodyFemale")}
              </button>
            ))}
          </div>
          {human && <p className="studio-note">{t(region === "upper" ? "vton.humanTpose" : "vton.humanLower")}</p>}
        </section>
        <section>
          <h3>{t("vton.secGarment")}</h3>
          {plan?.top && (
            <div className="vt-garment">
              <p>
                <strong>{t("vton.top")}</strong> · {t("vton.lengthCm", { n: Math.round(plan.top.lengthCm) })} ·{" "}
                {plan.top.longSleeve ? t("vton.longSleeve") : t("vton.shortSleeve")}
              </p>
              {!human && chips(TOP_VARIANTS, topVariant, setTopVariant)}
            </div>
          )}
          {plan?.bottom && (
            <div className="vt-garment">
              <p>
                <strong>{t("vton.bottom")}</strong> ·{" "}
                {plan.bottom.lengthCm ? t("vton.lengthCm", { n: Math.round(plan.bottom.lengthCm) }) : t("vton.fullLength")}
              </p>
              {!human && chips(BOTTOM_VARIANTS, bottomVariant, setBottomVariant)}
            </div>
          )}
          <label className="vt-ease">
            {t("vton.ease")} <strong>{easeCm.toFixed(1)} cm</strong>
            <input type="range" min={0} max={6} step={0.5} value={easeCm} onChange={(e) => setEaseCm(+e.target.value)} />
          </label>
          {plan?.skirt && (
            <div className="vt-garment">
              <p><strong>{t("vton.skirt")}</strong> · {t("vton.lengthCm", { n: Math.round(plan.skirt.lengthCm) })}</p>
            </div>
          )}
        </section>
        <section>
          <h3>{t("vton.secReal")}</h3>
          {hasGen && (
            <div className="toggle-group vt-look">
              <button type="button" className={`toggle-btn${useGen ? " active" : ""}`} onClick={() => setUseGen(true)}>{t("vton.realOn")}</button>
              <button type="button" className={`toggle-btn${!useGen ? " active" : ""}`} onClick={() => setUseGen(false)}>{t("vton.realOff")}</button>
            </div>
          )}
          {gen.confirm ? (
            <div className="vt-confirm">
              <p className="studio-note">{t("vton.genWarn")}</p>
              <div className="vt-views">
                <button type="button" className="tp-modal-btn" onClick={() => void generateReal(false)}>{t("vton.genGo")}</button>
                <button type="button" className="tp-ctrl-btn" onClick={() => setGen((g) => ({ ...g, confirm: false }))}>{t("vton.genCancel")}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="tp-modal-btn vt-gen-btn" disabled={gen.busy || !canGen} onClick={() => setGen((g) => ({ ...g, confirm: true, msg: "", err: false }))}>
              {gen.busy ? <span className="tp-spinner" /> : null} {hasGen ? t("vton.genAgain") : t("vton.genReal")}
            </button>
          )}
          {genImages.length > 0 && (
            <>
              <p className="studio-note">{t("vton.genTpose")}</p>
              <div className="vt-gen-images">
                {genImages.map((src) => <a key={src} href={src} target="_blank" rel="noreferrer"><img src={src} alt={t("vton.genTpose")} /></a>)}
              </div>
            </>
          )}
          {gen.busy && <div className="vt-progress"><div style={{ width: `${gen.pct}%` }} /></div>}
          {gen.msg && <p className={`studio-note${gen.err ? " err" : ""}`}>{gen.busy ? `${gen.pct}% · ` : ""}{gen.msg}</p>}
        </section>
        {!human && <section>
          <h3>{t("vton.secLook")}</h3>
          <div className="toggle-group vt-look">
            {sketch && (
              <button type="button" className={`toggle-btn${look === "input" ? " active" : ""}`} onClick={() => setLook("input")}>{t("vton.lookInput")}</button>
            )}
            <button type="button" className={`toggle-btn${look === "scan" ? " active" : ""}`} onClick={() => setLook("scan")}>{t("vton.lookScan")}</button>
            <button type="button" className={`toggle-btn${look === "colour" ? " active" : ""}`} onClick={() => setLook("colour")}>{t("vton.lookColour")}</button>
          </div>
          <label className="vt-colour">
            {t("vton.colour")}
            <input type="color" value={colour} onChange={(e) => { colourTouched.current = true; setColour(e.target.value); if (look === "scan") setLook(sketch ? "input" : "colour") }} />
          </label>
        </section>}
        <section>
          <h3>{t("vton.secView")}</h3>
          <div className="vt-views">
            {(["front", "side", "back"] as const).map((v) => (
              <button key={v} type="button" className="tp-ctrl-btn" onClick={() => { setSpin(false); active()?.view(v) }}>{t(`vton.${v}`)}</button>
            ))}
            <button type="button" className={`tp-ctrl-btn${spin ? " is-active" : ""}`} aria-pressed={spin} onClick={() => setSpin((s) => !s)}>{t("vton.spin")}</button>
            <button type="button" className="tp-ctrl-btn" onClick={() => { setSpin(false); active()?.resetCamera() }}>{t("vton.reset")}</button>
          </div>
        </section>
      </aside>
      <main className="vt-main">
        <div className="vt-canvas-host" ref={humanHostRef} style={human ? undefined : { display: "none" }}>
          {humanReady && (
            <div className="toggle-group vt-viewmode" role="group">
              {(["3d", "pattern"] as const).map((m) => (
                <button key={m} type="button" className={`toggle-btn${viewMode === m ? " active" : ""}`} aria-pressed={viewMode === m}
                  disabled={m === "pattern" && !patternPieces?.length} title={m === "pattern" && !patternPieces?.length ? t("vton.patternNone") : undefined}
                  onClick={() => { setSpin(false); setViewMode(m) }}>
                  {t(m === "3d" ? "vton.view3d" : "vton.viewPattern")}
                </button>
              ))}
            </div>
          )}
          {humanReady && viewMode === "pattern" && <p className="vt-pattern-note">{t("vton.patternNote")}</p>}
          {error && <div className="vt-msg err">{error}</div>}
          {!error && !humanReady && <div className="vt-msg vt-dressing"><span className="tp-spinner" /> {t("vton.loading")}</div>}
          {/* never a bare figure: it only shows once it is wearing the garment */}
          {!error && humanReady && viewMode === "3d" && !hasGen && (gen.err ? (
            <div className="vt-msg vt-dressing err">
              {gen.msg}
              <button type="button" className="tp-modal-btn" disabled={!canGen} onClick={() => void generateReal(false)}>{t("vton.genAgain")}</button>
            </div>
          ) : (
            <div className="vt-msg vt-dressing">
              <span className="tp-spinner" /> {t("vton.dressing")}{gen.busy && gen.pct ? ` ${gen.pct}%` : ""}
              {gen.busy && <div className="vt-progress"><div style={{ width: `${gen.pct}%` }} /></div>}
            </div>
          ))}
          <span className="vt-hint">{t("vton.hint")}</span>
        </div>
        <div className="vt-canvas-host" ref={hostRef} style={human ? { display: "none" } : undefined}>
          {error && <div className="vt-msg err">{error}</div>}
          {!error && !ready && <div className="vt-msg"><span className="tp-spinner" /> {t("vton.loading")}</div>}
          {!error && ready && redrafting && (
            <div className="vt-badge"><span className="tp-spinner" /> {t("vton.refitting")} {redrafting.pct ? `${Math.round(redrafting.pct)}%` : ""}</div>
          )}
          <span className="vt-hint">{t("vton.hint")}</span>
        </div>
      </main>
    </div>
  )
}
