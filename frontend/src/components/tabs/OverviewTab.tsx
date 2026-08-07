import { useEffect, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { downloadUrl, fetchJson, getParts, imgCrossOrigin, resolveUrl, type Job, type PatternDesign } from "../../api"
import { STRINGS } from "../../strings"
import { dlIcon } from "../icons"
import SplitCompare from "../SplitCompare"

function detailRows(
  job: Job,
  design: PatternDesign | null,
  partCount: number | null,
  t: (key: string, values?: undefined, defaultValue?: string) => string,
): [string, string][] {
  const rows: [string, string][] = []
  const c = job.classification
  if (c && c.status === "success")
    rows.push([
      t("overviewTab.category"),
      `${t(`taxonomy.category.${c.category}`, undefined, c.category)} / ${t(`taxonomy.subcategory.${c.subcategory}`, undefined, c.subcategory)}`,
    ])
  else rows.push([t("overviewTab.category"), t("overviewTab.notYetClassified")])

  if (design) {
    if (design.fit) rows.push([t("overviewTab.fit"), String(design.fit)])
    if (design.closure) {
      rows.push([
        t("overviewTab.closure"),
        design.closure === "button" && design.buttonCount ? `${design.closure} (${design.buttonCount})` : String(design.closure),
      ])
    }
    const pockets = design.pockets
    if (pockets) {
      rows.push([
        t("overviewTab.pockets"),
        pockets.type === "none" || !pockets.count
          ? t("overviewTab.none")
          : `${pockets.count} × ${pockets.type}${pockets.position && pockets.position !== "n/a" ? ` (${pockets.position})` : ""}`,
      ])
    }
    if (design.collarStyle && design.collarStyle !== "n/a") rows.push([t("overviewTab.collarType"), String(design.collarStyle)])
    else if (design.neckline) rows.push([t("overviewTab.collarType"), String(design.neckline)])
    if (design.sleeveLength) rows.push([t("overviewTab.sleeveType"), String(design.sleeveLength)])
  }
  rows.push([t("overviewTab.parts"), partCount == null ? "—" : String(partCount)])
  return rows
}

// No single variation ever carries both halves: a "both" run yields
// [Default(sketch), Realistic(realistic)], a sketch run yields
// [Default, Variant 1, ...] with no realistic at all. So the compare bar's
// two sides come from different entries, and picking a variant swaps only
// the side that variant actually owns.
function pairFor(
  idx: number,
  variations: Job["variations"],
  defaultSketch: string,
  jobRealistic: string | null,
  baseLabel: string,
  realisticLabel: string,
) {
  const v = variations[idx]
  if (!v) return { leftUrl: defaultSketch, rightUrl: jobRealistic, leftLabel: baseLabel, rightLabel: realisticLabel, dlSketch: defaultSketch, dlRealistic: jobRealistic }
  const vSketch = resolveUrl(v.sketch)
  const vRealistic = resolveUrl(v.realistic)
  if (vRealistic) {
    const leftUrl = vSketch || defaultSketch
    return { leftUrl, rightUrl: vRealistic, leftLabel: vSketch ? v.label : baseLabel, rightLabel: realisticLabel, dlSketch: vSketch || leftUrl, dlRealistic: vRealistic }
  }
  if (jobRealistic) {
    const leftUrl = vSketch || defaultSketch
    return { leftUrl, rightUrl: jobRealistic, leftLabel: vSketch ? v.label : baseLabel, rightLabel: realisticLabel, dlSketch: vSketch || leftUrl, dlRealistic: jobRealistic }
  }
  const rightUrl = !vSketch || vSketch === defaultSketch ? null : vSketch
  return { leftUrl: defaultSketch, rightUrl, leftLabel: baseLabel, rightLabel: v.label, dlSketch: vSketch || defaultSketch, dlRealistic: null as string | null }
}

export default function OverviewTab({ job, pluginId }: { job: Job; pluginId: string }) {
  const { t } = usePluginTranslations(STRINGS)
  const out = job.outputs
  const variations = job.variations || []
  const defaultSketch = resolveUrl(variations[0]?.sketch) || resolveUrl(job.sketch)!
  const jobRealistic = resolveUrl(variations.find((v) => v.realistic)?.realistic || null)
  const baseLabel = variations[0]?.label || t("splitCompare.sketch")

  const [activeIdx, setActiveIdx] = useState(0)
  const [design, setDesign] = useState<PatternDesign | null>(null)
  const [partCount, setPartCount] = useState<number | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)

  useEffect(() => {
    setActiveIdx(0)
    setDesign(null)
    setPartCount(null)
    setNotesOpen(false)
  }, [job.job_id])

  // Design attributes and the part count are separate files; fill the table
  // in when they arrive instead of holding the plate back on two requests.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const designUrl = resolveUrl(out.design)
      const d = designUrl ? await fetchJson<PatternDesign>(designUrl) : null
      const p = out.parts_svg ? await getParts(pluginId, job.job_id) : null
      if (cancelled) return
      setDesign(d)
      setPartCount(p ? p.parts.length : out.parts_svg ? null : 0)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [job.job_id, out.design, out.parts_svg, pluginId])

  const pair = pairFor(activeIdx, variations, defaultSketch, jobRealistic, baseLabel, t("splitCompare.realistic"))
  const refs = (job.references || []).map((r) => resolveUrl(r)).filter(Boolean) as string[]
  const rows = detailRows(job, design, partCount, t)
  const constructionElements = job.classification?.construction_elements

  return (
    <div>
      <div className="tp-detail-body">
        <div className="tp-detail-media tp-detail-media-plain">
          <SplitCompare leftUrl={pair.leftUrl} rightUrl={pair.rightUrl} leftLabel={pair.leftLabel} rightLabel={pair.rightLabel} />
        </div>
        <div className="tp-detail-side">
          <h3>{t("overviewTab.sketchDetails")}</h3>
          <table className="tp-spec-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {variations.length > 0 && (
            <>
              <h3>{t("overviewTab.variations")}</h3>
              <div className="tp-thumb-row">
                {variations.map((v, i) => {
                  const img = resolveUrl(v.sketch || v.realistic)
                  if (!img) return null
                  return (
                    <div
                      className={`tp-thumb-item${i === activeIdx ? " is-active" : ""}`}
                      key={i}
                      onClick={() => setActiveIdx(i)}
                    >
                      <img src={img} crossOrigin={imgCrossOrigin()} alt={v.label} />
                      <span>{v.label}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {refs.length > 0 && (
            <>
              <h3>{t("overviewTab.referenceImages")}</h3>
              <div className="tp-thumb-row">
                {refs.map((r, i) => (
                  <div className="tp-thumb-item" key={i}>
                    <img src={r} crossOrigin={imgCrossOrigin()} alt="" />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="tp-modal-actions" style={{ marginTop: 12 }}>
        <a className="tp-modal-btn" href={downloadUrl(pair.dlSketch)!} download>
          {dlIcon} {t("overviewTab.sketchPng")}
        </a>
        {pair.dlRealistic && (
          <a className="tp-modal-btn" href={downloadUrl(pair.dlRealistic)!} download>
            {dlIcon} {t("overviewTab.realisticPng")}
          </a>
        )}
        {constructionElements && constructionElements.length > 0 && (
          <button type="button" className="tp-modal-btn" onClick={() => setNotesOpen((v) => !v)}>
            {t("overviewTab.constructionNotes")}
          </button>
        )}
      </div>
      {notesOpen && constructionElements && (
        <div className="tp-spec-section" style={{ marginTop: 12 }}>
          <h3>{t("overviewTab.construction")}</h3>
          <ul className="tp-notes-list">
            {constructionElements.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          {job.classification?.reasoning && <p className="studio-note">{job.classification.reasoning}</p>}
        </div>
      )}
    </div>
  )
}
