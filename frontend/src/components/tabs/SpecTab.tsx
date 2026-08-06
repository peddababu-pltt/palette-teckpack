import { useEffect, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { SIZES, cancelJobApi, downloadUrl, fetchJson, makeLogProgress, resolveUrl, startMeasure, watchJob, type Job, type MeasureResult } from "../../api"
import { STRINGS } from "../../strings"
import { dlIcon } from "../icons"
import TaskPanel from "../TaskPanel"

export default function SpecTab({
  job,
  pluginId,
  onPatchJob,
}: {
  job: Job
  pluginId: string
  onPatchJob: (jobId: string, patch: (job: Job) => Job) => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const out = job.outputs
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<MeasureResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<{ pct: number; size: string } | null>(null)
  const [anchorSize, setAnchorSize] = useState("M")
  const [highlightSize, setHighlightSize] = useState("M")

  useEffect(() => {
    setData(null)
    setError(null)
    setRunning(null)
    setAnchorSize("M")
    if (out.measurements) {
      const url = resolveUrl(out.measurements)
      if (!url) return
      setLoading(true)
      void fetchJson<MeasureResult>(url).then((res) => {
        setLoading(false)
        if (!res) {
          setError(t("specTab.couldNotReadSpec"))
          return
        }
        setData(res)
        setHighlightSize(res.selected_size || "M")
      })
    } else {
      setLoading(false)
    }
  }, [job.job_id, out.measurements])

  async function runMeasure(size: string) {
    setRunning({ pct: 0, size })
    setError(null)
    const startRes = await startMeasure(pluginId, job.job_id, size)
    if (startRes.error) {
      setError(startRes.error)
      setRunning(null)
      return
    }
    const onLine = makeLogProgress((p) => setRunning({ pct: p, size }), "measure")
    await new Promise<void>((resolve) => {
      let payload: any = null
      watchJob(pluginId, job.job_id, {
        onProgress: (d) => setRunning({ pct: d.percent, size }),
        onLine,
        onStageDone: (d) => {
          payload = d
        },
        onDone: () => {
          setRunning(null)
          if (payload) {
            onPatchJob(job.job_id, (current) => ({ ...current, outputs: { ...current.outputs, measurements: payload.file } }))
            setData(payload.result)
            setHighlightSize((payload.result && payload.result.selected_size) || size)
          }
          resolve()
        },
        onError: (msg) => {
          setError(msg)
          setRunning(null)
          resolve()
        },
        onCancelled: () => {
          setRunning(null)
          resolve()
        },
      })
    })
  }

  if (running) {
    return (
      <TaskPanel
        label={t("specTab.measuringGarment", { size: running.size })}
        pct={running.pct}
        onCancel={() => cancelJobApi(pluginId, job.job_id)}
      />
    )
  }
  if (loading) return <TaskPanel label={t("specTab.loadingSpec")} />

  if (!out.measurements && !data) {
    return (
      <>
        <p className="studio-note">{t("specTab.notMeasuredYet")}</p>
        <div className="tp-modal-actions">
          <label className="tp-units-label">
            {t("specTab.anchorSize")}
            <select className="tp-units-select" value={anchorSize} onChange={(e) => setAnchorSize(e.target.value)}>
              {SIZES.map((sz) => (
                <option key={sz} value={sz}>
                  {sz}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" onClick={() => void runMeasure(anchorSize)}>
            {t("specTab.measureGarment")}
          </button>
        </div>
      </>
    )
  }

  if (error && !data) return <p className="panel-loading err">{error}</p>
  if (!data) return null

  if (data.status === "failure") {
    return (
      <>
        <p className="panel-loading err">
          {t("specTab.notGarment", { confidence: data.confidence, reasoning: data.reasoning })}
        </p>
        <div className="tp-modal-actions" style={{ marginTop: 12 }}>
          <button type="button" className="tp-modal-btn" onClick={() => void runMeasure("M")}>
            {t("specTab.measureAgain")}
          </button>
        </div>
      </>
    )
  }

  const selected = highlightSize
  const measurementsUrl = resolveUrl(out.measurements)

  return (
    <div className="tp-spec-editor">
      <div className="tp-spec-section">
        <h3>{t("specTab.classification")}</h3>
        <table className="tp-spec-table">
          <tbody>
            <tr>
              <th>{t("specTab.category")}</th>
              <td>{t(`taxonomy.category.${data.category}`, undefined, data.category)}</td>
            </tr>
            <tr>
              <th>{t("specTab.subcategory")}</th>
              <td>{t(`taxonomy.subcategory.${data.subcategory}`, undefined, data.subcategory)}</td>
            </tr>
            <tr>
              <th>{t("specTab.blockType")}</th>
              <td>{t(`taxonomy.blockType.${data.block_type}`, undefined, data.block_type)}</td>
            </tr>
            <tr>
              <th>{t("specTab.confidence")}</th>
              <td>{data.confidence}</td>
            </tr>
            <tr>
              <th>{t("specTab.construction")}</th>
              <td>{(data.construction_elements || []).join(", ") || "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="tp-spec-section">
        <h3>{t("specTab.pointsOfMeasure")}</h3>
        <div className="tp-modal-actions">
          <label className="tp-units-label">
            {t("specTab.highlightSize")}
            <select className="tp-units-select" value={selected} onChange={(e) => setHighlightSize(e.target.value)}>
              {SIZES.map((sz) => (
                <option key={sz} value={sz}>
                  {sz}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="tp-modal-btn" onClick={() => void runMeasure(selected)}>
            {t("specTab.remeasure")}
          </button>
          {measurementsUrl && (
            <a className="tp-modal-btn" href={downloadUrl(measurementsUrl)!} download>
              {dlIcon} {t("specTab.jsonFile")}
            </a>
          )}
        </div>
        <div className="tp-measure-table-wrap">
          <table className="measure-table">
            <thead>
              <tr>
                <th>{t("specTab.measurementCm")}</th>
                {SIZES.map((sz) => (
                  <th key={sz} className={sz === selected ? "hl" : ""}>
                    {sz}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data.poms || []).map((p) => (
                <tr key={p.name}>
                  <th>{p.name}</th>
                  {SIZES.map((sz) => {
                    const v = p.values ? p.values[sz] : null
                    return (
                      <td key={sz} className={sz === selected ? "hl" : ""}>
                        {v != null ? v.toFixed(1) : "—"}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="studio-note">
          {t("specTab.aiEstimateNote")}
        </p>
      </div>
    </div>
  )
}
