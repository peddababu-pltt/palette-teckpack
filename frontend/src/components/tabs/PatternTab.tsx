import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { SIZES, downloadUrl, fetchJson, resolveUrl, withCacheBust, type Job, type PatternDesign } from "../../api"
import type { StageEngine } from "../../engine"
import { STRINGS } from "../../strings"
import SvgViewer, { ViewerTaskPanel } from "../SvgViewer"
import PdfViewer from "../PdfViewer"
import { dlIcon } from "../icons"

// three.js only loads once someone opens the 3D try-on.
const VtonViewer = lazy(() => import("../vton/VtonViewer"))

export default function PatternTab({ job, pluginId, engine }: { job: Job; pluginId: string; engine: StageEngine }) {
  void pluginId
  useSyncExternalStore(engine.subscribe, () => engine.version)
  const { t } = usePluginTranslations(STRINGS)
  const [view, setView] = useState<"pages" | "3d">("pages")
  // the size panel's values inside the try-on, so the body follows each keystroke
  const [liveCm, setLiveCm] = useState<Record<string, number> | null>(null)
  const [liveSize, setLiveSize] = useState<string | null>(null)

  const out = job.outputs
  const live = engine.getLive(job.job_id, "pattern")

  if (!out.pattern_svg) {
    if (!job.has_sketch) {
      return (
        <p className="studio-note">
          {t("patternTab.noSketchToDraft")}
        </p>
      )
    }
    if (live?.error) {
      return (
        <p className="panel-loading err">
          {live.error}
          <br />
          <button type="button" className="tp-modal-btn" onClick={() => void engine.retry(job, "pattern")}>
            {t("partsTab.rerun")}
          </button>
        </p>
      )
    }
    return (
      <ViewerTaskPanel
        label={live?.label || t("patternTab.drafting")}
        pct={live?.pct || 0}
        status={!live?.started ? t("partsTab.queued") : undefined}
        onCancel={() => engine.cancel(job.job_id, "pattern")}
      />
    )
  }

  const svgUrl = withCacheBust(resolveUrl(out.pattern_svg), job.mtime)!
  const pdfUrl = out.pattern_pages ? withCacheBust(resolveUrl(out.pattern_pages), job.mtime) : null
  const downloads = (
    <>
      <a className="tp-modal-btn" href={downloadUrl(svgUrl)!} download>
        {dlIcon} {t("patternTab.patternSvgFile")}
      </a>
      {pdfUrl && (
        <a className="tp-modal-btn" href={downloadUrl(pdfUrl)!} download>
          {dlIcon} {t("patternTab.patternPagesFile")}
        </a>
      )}
    </>
  )

  // The sewing pattern tab reads pattern-pages.pdf directly when it exists —
  // every page on the left, a page list to jump around on the right. Only
  // falls back to the raw pattern.svg (no pagination) when the PDF is absent.
  const panel = <PatternSizePanel job={job} engine={engine} />
  const viewToggle = (
    <button type="button" className="tp-ctrl-btn tp-3d-toggle" onClick={() => setView("3d")}>
      {t("patternTab.view3d")}
    </button>
  )
  const workspace =
    view === "3d" ? (
      <Suspense fallback={null}>
        <VtonViewer
          job={job}
          pluginId={pluginId}
          onClose={() => setView("pages")}
          measurePanel={<PatternSizePanel job={job} engine={engine} onValues={(cm, size) => { setLiveCm(cm); setLiveSize(size) }} preview />}
          liveCm={liveCm}
          liveSize={liveSize}
        />
      </Suspense>
    ) : null
  if (pdfUrl) return (
    <>
      <PdfViewer url={pdfUrl} downloads={downloads} aside={panel} toolbarRight={viewToggle} />
      {workspace}
    </>
  )
  return (
    <>
    <SvgViewer downloads={<>{downloads}{viewToggle}{panel}</>}>
      {/* key forces a real unmount/remount on every redraft -- see PartsTab's
          identical <object> for why the `data` attribute alone isn't enough. */}
      <object key={svgUrl} type="image/svg+xml" data={svgUrl} />
    </SvgViewer>
    {workspace}
    </>
  )
}

// Size chips + editable body measurements for the drafted pattern. Clicking a size
// redrafts at once, with every field refilled from that size's defaults
// (pattern-design.json sizeTable). Typing over a field redrafts on its own once
// the user pauses -- no separate button. Only fields that differ from the size's
// defaults are sent, so the draft log / design.json can tell which were the user's.
const EDIT_REDRAFT_DELAY_MS = 900
const PREVIEW_SIZE = "L" // the 3D try-on's starting size

// Same wording as designs.mjs humanLabel -- applied here too so patterns drafted
// before that changed ("Hps To Waist Back") read the same as new ones.
function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(" ")
  return words.map((w, i) => (w === "hps" ? "HPS" : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ")
}

function PatternSizePanel({ job, engine, onValues, preview }: {
  job: Job
  engine: StageEngine
  onValues?: (cm: Record<string, number>, size: string) => void // every change, typed or from a size pick
  // 3D try-on: the body follows the values on its own, so edits stay local and
  // never redraft the pattern.
  preview?: boolean
}) {
  const { t } = usePluginTranslations(STRINGS)
  const [design, setDesign] = useState<PatternDesign | null>(null)
  const [size, setSize] = useState("M")
  const [values, setValues] = useState<Record<string, string>>({})
  const editTimer = useRef<number | undefined>(undefined)
  const live = engine.getLive(job.job_id, "pattern")
  const running = !preview && !!live && !live.error

  const designUrl = withCacheBust(resolveUrl(job.outputs.design), job.mtime)
  useEffect(() => {
    let cancelled = false
    if (!designUrl) return
    void fetchJson<PatternDesign>(designUrl).then((d) => {
      if (cancelled || !d) return
      setDesign(d)
      // the 3D try-on opens on size L, filled from that size's table
      const tableL = preview ? d.sizeTable?.[PREVIEW_SIZE] : undefined
      setSize(tableL ? PREVIEW_SIZE : d.size && (SIZES as readonly string[]).includes(d.size) ? d.size : "M")
      setValues(Object.fromEntries((d.measurements || []).map((m) => {
        const cm = tableL ? tableL[m.key] ?? m.cm : m.cm
        return [m.key, cm == null ? "" : String(cm)]
      })))
    })
    return () => {
      cancelled = true
    }
  }, [designUrl])

  useEffect(() => () => window.clearTimeout(editTimer.current), [])

  useEffect(() => {
    if (!onValues) return
    const cm: Record<string, number> = {}
    for (const [k, raw] of Object.entries(values)) {
      const v = parseFloat(raw)
      if (Number.isFinite(v) && v > 0) cm[k] = v
    }
    onValues(cm, size)
  }, [values, size])

  const fields = design?.measurements || []
  const sizes = design?.sizes?.length ? design.sizes : [...SIZES]

  async function redraft(nextSize: string, nextValues: Record<string, string>) {
    window.clearTimeout(editTimer.current)
    if (preview) return
    const table = design?.sizeTable?.[nextSize] || {}
    const measurements: Record<string, number> = {}
    for (const m of fields) {
      const v = parseFloat(nextValues[m.key])
      if (Number.isFinite(v) && v > 0 && v !== table[m.key]) measurements[m.key] = v
    }
    void engine.redraftPattern(job, { size: nextSize, measurements })
  }

  function sizeDefaults(sz: string): Record<string, string> {
    const table = design?.sizeTable?.[sz]
    if (!table) return values
    return Object.fromEntries(fields.map((m) => [m.key, table[m.key] == null ? "" : String(table[m.key])]))
  }

  function pickSize(next: string) {
    if (running) return
    const nextValues = sizeDefaults(next)
    setSize(next)
    setValues(nextValues)
    void redraft(next, nextValues)
  }

  function editField(key: string, raw: string) {
    const nextValues = { ...values, [key]: raw }
    setValues(nextValues)
    window.clearTimeout(editTimer.current)
    const v = parseFloat(raw)
    if (!Number.isFinite(v) || v <= 0 || preview) return // wait for a usable number
    editTimer.current = window.setTimeout(() => void redraft(size, nextValues), EDIT_REDRAFT_DELAY_MS)
  }

  return (
    <section className="tp-parts-card tp-pattern-size">
      <div className="tp-parts-head">
        <h3>{t(preview ? "patternTab.size" : "patternTab.sizeAndMeasurements")}</h3>
      </div>
      <div className="tp-pattern-size-top">
        {design?.design && (
          <p className="studio-note">
            {design.custom ? t("patternTab.customDraft") : design.design}
          </p>
        )}
        <div className="tp-size-chips" role="group" aria-label={t("patternTab.size")}>
          {sizes.map((sz) => (
            <button
              key={sz}
              type="button"
              className={`tp-size-chip${sz === size ? " is-active" : ""}`}
              aria-pressed={sz === size}
              disabled={running && sz !== size}
              onClick={() => sz !== size && pickSize(sz)}
            >
              {sz}
            </button>
          ))}
        </div>
        {running && (
          <div className="tp-pattern-redraft-progress" role="status">
            <span className="tp-spinner" />
            <span>
              {t("patternTab.redrafting", { size })} {live?.pct ? `${Math.round(live.pct)}%` : ""}
            </span>
          </div>
        )}
        {!preview && live?.error && <p className="panel-loading err">{live.error}</p>}
      </div>
      {/* Only this part scrolls: the size chips above stay put while the
          (often dozen-plus) measurement fields scroll inside the card. */}
      {!preview && <div className="tp-pattern-size-scroll">
        {fields.length ? (
          <div className="measure-fields">
            {fields.map((m) => (
              <label className="measure-field" title={m.how} key={m.key}>
                <span>{fieldLabel(m.key)}</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  inputMode="decimal"
                  disabled={running}
                  value={values[m.key] ?? ""}
                  onChange={(e) => editField(m.key, e.target.value)}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="studio-note">{t("patternTab.noMeasurementList")}</p>
        )}
        {fields.length > 0 && !running && (
          <button type="button" className="link-btn" onClick={() => pickSize(size)}>
            {t("patternTab.resetToSize", { size })}
          </button>
        )}
      </div>}
    </section>
  )
}
