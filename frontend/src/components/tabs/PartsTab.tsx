import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { downloadUrl, getParts, resolveUrl, withCacheBust, type Job, type PartInfo, type PartsResponse } from "../../api"
import type { StageEngine } from "../../engine"
import { STRINGS } from "../../strings"
import SvgViewer, { PartsCanvas, ViewerTaskPanel } from "../SvgViewer"
import { dlIcon, eyeOffIcon, eyeOnIcon } from "../icons"
import { useConfirm } from "../ConfirmDialog"

// The part PNG is the full sketch canvas, so a plain thumbnail is a
// near-empty square. Blow the image up so the part's bbox fills the tile and
// offset it so that box lands in view — a CSS-only crop, no extra assets.
function thumbStyle(p: PartInfo): CSSProperties {
  const b = p.bbox
  if (!b || !b.w || !b.h) return { backgroundImage: `url('${p.image}')`, backgroundSize: "contain" }
  const TILE = 32
  const pad = 2
  const scale = Math.min((TILE - pad * 2) / b.w, (TILE - pad * 2) / b.h)
  const w = b.cw * scale
  const h = b.ch * scale
  const x = TILE / 2 - (b.x + b.w / 2) * scale
  const y = TILE / 2 - (b.y + b.h / 2) * scale
  return {
    backgroundImage: `url('${p.image}')`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${w.toFixed(2)}px ${h.toFixed(2)}px`,
    backgroundPosition: `${x.toFixed(2)}px ${y.toFixed(2)}px`,
  }
}

export default function PartsTab({ job, pluginId, engine }: { job: Job; pluginId: string; engine: StageEngine }) {
  // Re-renders on every engine tick, so a run finishing (or a percentage
  // moving) in the background repaints this tab without restarting anything.
  useSyncExternalStore(engine.subscribe, () => engine.version)
  const { t } = usePluginTranslations(STRINGS)
  const confirm = useConfirm()

  const out = job.outputs
  const [data, setData] = useState<PartsResponse | null>(null)
  const [visible, setVisible] = useState<boolean[]>([])
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setData(null)
    setVisible([])
    setLoadError(false)
    if (out.parts_svg) {
      let cancelled = false
      void getParts(pluginId, job.job_id, Math.round((job.mtime || 0) * 1000)).then((res) => {
        if (cancelled) return
        if (!res || !res.parts.length) {
          setLoadError(true)
          return
        }
        // Every rerun keeps the same part names (front_collar, back_yoke, ...),
        // so their image URLs are byte-identical across runs -- without a
        // cache-bust, the browser happily serves the previous run's cached
        // PNG at that URL even though the file on disk was overwritten,
        // compositing old pieces alongside new ones into a garment that
        // never actually existed.
        const resolved: PartsResponse = {
          ...res,
          parts: res.parts.map((p) => ({
            ...p,
            image: withCacheBust(resolveUrl(p.image), job.mtime)!,
            layer: p.layer ? withCacheBust(resolveUrl(p.layer), job.mtime)! : null,
          })),
        }
        setData(resolved)
        setVisible(resolved.parts.map(() => true))
      })
      return () => {
        cancelled = true
      }
    }
    // Not yet traced: join the run already in flight (a generate run
    // auto-queues this) or start it — queue() is a no-op if one is live.
    if (job.has_sketch) engine.queue(job, "parts")
  }, [job.job_id, out.parts_svg, job.mtime, job.has_sketch, pluginId, engine])

  const live = engine.getLive(job.job_id, "parts")

  function setPartVisible(i: number, on: boolean) {
    setVisible((prev) => prev.map((v, idx) => (idx === i ? on : v)))
  }
  // Clicking the row (not the eye) solos that part — quickest way to check
  // one piece in isolation without clicking every other eye off.
  function soloOrShowAll(i: number) {
    setVisible((prev) => {
      const soloed = prev.every((v, idx) => v === (idx === i))
      return prev.map((_, idx) => (soloed ? true : idx === i))
    })
  }

  async function rerun() {
    if (engine.isLive(job.job_id, "parts")) return
    if (!(await confirm({ message: t("partsTab.confirmRerun"), confirmLabel: t("partsTab.rerun") }))) return
    void engine.queue(job, "parts")
  }
  const rerunSpec = { label: t("partsTab.rerun"), title: t("partsTab.rerunTitle"), onClick: rerun }

  if (!out.parts_svg && !job.has_sketch) {
    return (
      <p className="studio-note">
        {t("partsTab.noSketchToTrace")}
      </p>
    )
  }

  // A run in flight (first trace OR a rerun over existing output) always
  // gets its own progress panel — otherwise a rerun looks like a dead
  // button: the old parts.svg stays on screen, unchanged, for however long
  // the naming/verify AI calls take, with zero sign anything is happening.
  if (live) {
    if (live.error) {
      return (
        <p className="panel-loading err">
          {live.error}
          <br />
          <button type="button" className="tp-modal-btn" onClick={() => void engine.retry(job, "parts")}>
            {t("partsTab.rerun")}
          </button>
        </p>
      )
    }
    if (!live.cancelled) {
      return (
        <ViewerTaskPanel
          label={live.label || t("partsTab.tracingPartsSvg")}
          pct={live.pct || 0}
          status={!live.started ? t("partsTab.queued") : undefined}
          onCancel={() => engine.cancel(job.job_id, "parts")}
        />
      )
    }
  }

  if (!out.parts_svg) {
    return (
      <ViewerTaskPanel
        label={t("partsTab.tracingPartsSvg")}
        pct={0}
        status={t("partsTab.queued")}
        onCancel={() => engine.cancel(job.job_id, "parts")}
      />
    )
  }

  const svgUrl = withCacheBust(resolveUrl(out.parts_svg), job.mtime)!
  const downloads = (
    <a className="tp-modal-btn" href={downloadUrl(svgUrl)!} download>
      {dlIcon} {t("partsTab.partsSvgFile")}
    </a>
  )

  if (loadError || !data) {
    // Traced before part export, or none written — the drawing is still usable.
    return (
      <SvgViewer downloads={downloads} rerun={rerunSpec}>
        {/* key forces a real unmount/remount on every new trace -- an <object>
            left in place does not reliably reload its embedded document when
            only its `data` attribute changes, so a rerun's fresh SVG can sit
            behind the previous run's still-rendered one. */}
        <object key={svgUrl} type="image/svg+xml" data={svgUrl} />
      </SvgViewer>
    )
  }

  const aside = (
    <aside className="tp-parts-card">
      <div className="tp-parts-head">
        <h3>
          {t("partsTab.parts")} <span className="tp-parts-count">{data.parts.length}</span>
        </h3>
        {data.garment_type && <div className="studio-note">{data.garment_type}</div>}
        <div className="tp-parts-bulk">
          <button type="button" className="link-btn" onClick={() => setVisible(data.parts.map(() => true))}>
            {t("partsTab.showAll")}
          </button>
          <button type="button" className="link-btn" onClick={() => setVisible(data.parts.map(() => false))}>
            {t("partsTab.hideAll")}
          </button>
        </div>
      </div>
      <div className="tp-parts-list">
        {data.parts.map((p, i) => (
          <div className={`tp-part-row${visible[i] ? "" : " is-hidden"}`} key={p.name} onClick={() => soloOrShowAll(i)}>
            <button
              type="button"
              className={`tp-part-eye${visible[i] ? " is-on" : ""}`}
              title={visible[i] ? t("partsTab.hide", { label: p.label }) : t("partsTab.show", { label: p.label })}
              aria-label={visible[i] ? t("partsTab.hide", { label: p.label }) : t("partsTab.show", { label: p.label })}
              aria-pressed={visible[i]}
              onClick={(e) => {
                e.stopPropagation()
                setPartVisible(i, !visible[i])
              }}
            >
              {visible[i] ? eyeOnIcon : eyeOffIcon}
            </button>
            <span className="tp-part-thumb" style={thumbStyle(p)} aria-hidden="true" />
            <span className="tp-part-name">{p.label}</span>
          </div>
        ))}
      </div>
    </aside>
  )

  return (
    <SvgViewer downloads={downloads} aside={aside} rerun={rerunSpec}>
      <PartsCanvas parts={data.parts} visible={visible} />
    </SvgViewer>
  )
}
