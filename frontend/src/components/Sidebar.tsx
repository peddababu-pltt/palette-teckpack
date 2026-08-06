import { useEffect, useMemo, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { analyzeImage, fetchAsFile, isAnalyzeUnavailable, type AnalyzeResponse, type AnalyzeResult } from "../api"
import { STRINGS } from "../strings"

export interface GenerateSubmission {
  photo: File
  references: File[]
  prompt: string
  measurements: Record<string, number> | null
  outputMode: "sketch" | "both"
  colors?: string[]
  season?: string
  sourceMode: "image" | "sketch"
}

const DEFAULT_COLORS = ["#e8e0d8", "#c4b5a0", "#8b7355"]

function computeGate(analysis: AnalyzeResponse | null, mode: "image" | "sketch", t: (key: string) => string): string {
  if (!analysis || isAnalyzeUnavailable(analysis)) return ""
  if (mode === "image") {
    if (analysis.imageKind === "flat_sketch") {
      return t("sidebar.flatSketchGate")
    }
    if (analysis.imageKind === "not_a_garment") {
      return t("sidebar.notGarmentGate")
    }
  } else if (mode === "sketch") {
    if (analysis.imageKind === "photo") {
      return t("sidebar.photoGate")
    }
  }
  return ""
}

export default function Sidebar({
  pluginId,
  generating,
  useAsSketchUrl,
  overlayOpen,
  onGenerate,
}: {
  pluginId: string
  generating: boolean
  useAsSketchUrl: string | null
  overlayOpen: boolean
  onGenerate: (sub: GenerateSubmission) => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const [mode, setMode] = useState<"image" | "sketch">("image")
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const analysisSeqRef = useRef(0)
  const [showUseAsSketch, setShowUseAsSketch] = useState(false)
  const [dragOver, setDragOver] = useState<"image" | "sketch" | null>(null)

  const [referenceFiles, setReferenceFiles] = useState<File[]>([])
  const refUrlsRef = useRef<string[]>([])

  const [measureTab, setMeasureTab] = useState<"ai" | "manual">("ai")
  const [measureCurrent, setMeasureCurrent] = useState<Record<string, number>>({})

  const [colorTab, setColorTab] = useState<"ai" | "picker">("ai")
  const [colorChecked, setColorChecked] = useState([true, true, true])
  const [colorValues, setColorValues] = useState<string[]>([...DEFAULT_COLORS])

  const [seasonTab, setSeasonTab] = useState<"ai" | "options">("options")
  const [selectedSeason, setSelectedSeason] = useState<string | null>(null)

  const [promptText, setPromptText] = useState("")
  const [outputType, setOutputType] = useState<"sketch" | "both">("sketch")

  useEffect(() => {
    if (useAsSketchUrl) setShowUseAsSketch(true)
  }, [useAsSketchUrl])

  // Reset the manual measurement fields to the newly-detected defaults
  // whenever a fresh analysis result lands.
  useEffect(() => {
    if (analysis && !isAnalyzeUnavailable(analysis) && analysis.measurements.length) {
      const next: Record<string, number> = {}
      for (const m of analysis.measurements) next[m.key] = m.cm ?? 0
      setMeasureCurrent(next)
    } else {
      setMeasureCurrent({})
    }
  }, [analysis])

  // Only Image mode + a closed overlay accepts a clipboard paste.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (mode !== "image" || overlayOpen) return
      const file = e.clipboardData?.files?.[0]
      if (file && file.type.startsWith("image/")) void handleUpload(file)
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, overlayOpen])

  const gateMessage = useMemo(() => computeGate(analysis, mode, t), [analysis, mode, t])
  const uploadBlocked = !!gateMessage

  const analysisNote = useMemo(() => {
    if (analysisLoading) return t("sidebar.analyzing")
    if (!analysis) return ""
    if (isAnalyzeUnavailable(analysis)) {
      return t("sidebar.analysisUnavailable", { reason: analysis.unavailable })
    }
    return analysis.notes || ""
  }, [analysis, analysisLoading, t])

  async function runAnalysis(file: File) {
    const seq = ++analysisSeqRef.current
    setAnalysisLoading(true)
    setAnalysis(null)
    const data = await analyzeImage(pluginId, file)
    if (seq !== analysisSeqRef.current) return // a newer upload already superseded this
    setAnalysisLoading(false)
    setAnalysis(data)
  }

  async function handleUpload(file: File) {
    setStagedFile(file)
    setShowUseAsSketch(false)
    const reader = new FileReader()
    reader.onload = (e) => setPreviewUrl(String(e.target?.result || ""))
    reader.readAsDataURL(file)
    void runAnalysis(file)
  }

  function clearUpload() {
    setStagedFile(null)
    setPreviewUrl(null)
    setShowUseAsSketch(false)
    analysisSeqRef.current++ // orphan any analysis still in flight
    setAnalysis(null)
    setAnalysisLoading(false)
  }

  async function stageDroppedUrl(url: string) {
    try {
      const file = await fetchAsFile(url)
      await handleUpload(file)
    } catch (err: any) {
      window.alert(t("sidebar.couldNotLoadImage", { message: err?.message || err }))
    }
  }

  function droppedUrl(dt: DataTransfer): string {
    const raw = dt.getData("text/uri-list") || dt.getData("text/plain") || ""
    const line = raw
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#"))
    return line || ""
  }

  function makeDropHandlers(zoneMode: "image" | "sketch") {
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        setDragOver(zoneMode)
      },
      onDragLeave: () => setDragOver((d) => (d === zoneMode ? null : d)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        setDragOver(null)
        const file = e.dataTransfer.files?.[0]
        if (file) {
          void handleUpload(file)
          return
        }
        const url = droppedUrl(e.dataTransfer)
        if (url) void stageDroppedUrl(url)
      },
    }
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void handleUpload(file)
    e.target.value = ""
  }

  // ---- reference images ----
  function onRefFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    setReferenceFiles((prev) => {
      const next = [...prev]
      for (const f of files) {
        if (next.length >= 5) break
        next.push(f)
      }
      return next
    })
    e.target.value = ""
  }
  function removeRef(i: number) {
    setReferenceFiles((prev) => prev.filter((_, idx) => idx !== i))
  }
  const refThumbUrls = useMemo(() => {
    refUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    refUrlsRef.current = referenceFiles.map((f) => URL.createObjectURL(f))
    return refUrlsRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceFiles])
  useEffect(() => () => refUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)), [])

  // ---- measurements ----
  // "unavailable" (vision down) reads the same as "nothing uploaded yet" here
  // — only a real, successful analysis with no matching design block gets the
  // more specific "no pattern for this garment" text.
  const cleanAnalysis = analysis && !isAnalyzeUnavailable(analysis) ? (analysis as AnalyzeResult) : null
  const measurements = cleanAnalysis ? cleanAnalysis.measurements : []
  const emptyMeasureText = cleanAnalysis ? t("sidebar.noMatchingBlock") : t("sidebar.uploadToDetect")
  const REGION_LABEL: Record<string, string> = {
    upper: t("sidebar.upperBody"),
    lower: t("sidebar.lowerBody"),
    full: t("sidebar.fullBody"),
  }
  const region = cleanAnalysis ? REGION_LABEL[cleanAnalysis.bodyRegion || ""] || t("sidebar.garmentFallback") : ""
  const garment = cleanAnalysis ? cleanAnalysis.garmentCategory.replace(/_/g, " ") : ""
  const rawSize = cleanAnalysis ? cleanAnalysis.apparentSize : ""
  const sizeForDefaults = rawSize === "unknown" ? "M" : rawSize
  const sizeNote = rawSize === "unknown" ? t("sidebar.sizeUnclear") : rawSize

  function resetMeasurements() {
    const next: Record<string, number> = {}
    for (const m of measurements) next[m.key] = m.cm ?? 0
    setMeasureCurrent(next)
  }
  function changedMeasurements(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const m of measurements) {
      const v = measureCurrent[m.key]
      const def = m.cm ?? 0
      if (Number.isFinite(v) && v > 0 && v !== def) out[m.key] = v
    }
    return out
  }

  // ---- color / season ----
  function syncColorChecked(i: number, checked: boolean) {
    setColorChecked((prev) => prev.map((c, idx) => (idx === i ? checked : c)))
  }
  function resetColors() {
    setColorValues([...DEFAULT_COLORS])
    setColorChecked([true, true, true])
  }

  // ---- output type / generate ----
  function handleGenerateClick() {
    if (!stagedFile) {
      window.alert(t("sidebar.uploadFirst"))
      return
    }
    if (uploadBlocked) {
      window.alert(gateMessage)
      return
    }
    const sub: GenerateSubmission = {
      photo: stagedFile,
      references: referenceFiles,
      prompt: promptText.trim(),
      measurements: measureTab === "manual" ? changedMeasurements() : null,
      outputMode: outputType,
      sourceMode: mode,
    }
    if (outputType === "both") {
      if (colorTab === "picker") {
        sub.colors = colorChecked.map((checked, i) => (checked ? colorValues[i] : ""))
      }
      if (seasonTab === "options" && selectedSeason) sub.season = selectedSeason
    }
    onGenerate(sub)
  }

  async function onUseAsSketchClick() {
    if (!useAsSketchUrl) return
    setMode("sketch")
    await stageDroppedUrl(useAsSketchUrl)
  }

  return (
    <div className="studio-sidebar">
      <div className="studio-sidebar-scroll">
        <div className="studio-step">
          <div className="studio-step-head">
            <span className="studio-step-title">{t("sidebar.step1")}</span>
            <div className="toolbar-group" id="mode-toolbar">
              <button
                type="button"
                className={`toolbar-btn${mode === "image" ? " active" : ""}`}
                title={t("sidebar.imageTabTitle")}
                onClick={() => setMode("image")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                {t("sidebar.image")}
              </button>
              <button
                type="button"
                className={`toolbar-btn${mode === "sketch" ? " active" : ""}`}
                title={t("sidebar.sketchTabTitle")}
                onClick={() => setMode("sketch")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
                {t("sidebar.sketch")}
              </button>
            </div>
          </div>

          <div id="upload-area">
            <div id="image-upload" className={`upload-mode${mode !== "image" ? " hidden" : ""}`}>
              <label
                id="image-dropzone"
                className={`dropzone small s2-dropzone${dragOver === "image" ? " dragover" : ""}`}
                htmlFor="image-file"
                {...makeDropHandlers("image")}
              >
                <div className="dropzone-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </div>
                <div className="dropzone-title">{t("sidebar.uploadGarmentImage")}</div>
                <div className="dropzone-hint">{t("sidebar.dropImageHint")}</div>
                <div className="dropzone-formats">{t("sidebar.imageFormats")}</div>
              </label>
              <input type="file" id="image-file" className="hidden" accept="image/jpeg,image/png,image/webp" onChange={onFileInputChange} />
            </div>
            <div id="sketch-upload" className={`upload-mode${mode !== "sketch" ? " hidden" : ""}`}>
              <label
                id="sketch-dropzone"
                className={`dropzone small s2-dropzone${dragOver === "sketch" ? " dragover" : ""}`}
                htmlFor="sketch-file"
                {...makeDropHandlers("sketch")}
              >
                <div className="dropzone-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </div>
                <div className="dropzone-title">{t("sidebar.uploadSketch")}</div>
                <div className="dropzone-hint">{t("sidebar.dropSketchHint")}</div>
                <div className="dropzone-formats">{t("sidebar.sketchFormats")}</div>
              </label>
              <input type="file" id="sketch-file" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={onFileInputChange} />
            </div>
          </div>

          <div className={`upload-preview-wrap${!previewUrl ? " hidden" : ""}`}>
            {previewUrl && <img id="upload-preview" className="result" src={previewUrl} alt="" />}
            <button type="button" id="clear-upload" className="upload-preview-clear" title={t("sidebar.removeImage")} aria-label={t("sidebar.removeImage")} onClick={clearUpload}>
              &times;
            </button>
          </div>
          <p className={`studio-note${!analysisNote ? " hidden" : ""}`}>{analysisNote}</p>
          <p className={`upload-error${!gateMessage ? " hidden" : ""}`}>{gateMessage}</p>
          <button
            type="button"
            id="use-as-sketch"
            className={`link-btn${!(showUseAsSketch && useAsSketchUrl) ? " hidden" : ""}`}
            style={{ marginTop: "var(--sp-2)" }}
            onClick={onUseAsSketchClick}
          >
            {t("sidebar.useAsSketch")}
          </button>
        </div>

        <div className="studio-substep">
          <div className="studio-substep-label">
            {t("sidebar.referenceImages")} <span>{t("sidebar.upToFive")}</span>
          </div>
          <div id="ref-thumbs" className="ref-thumbs">
            {referenceFiles.map((_, i) => (
              <div className="ref-thumb" key={i}>
                <img src={refThumbUrls[i]} alt="" />
                <button type="button" className="ref-thumb-remove" onClick={() => removeRef(i)}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <label
            id="ref-dropzone"
            className="dropzone ref-dropzone"
            htmlFor="ref-file-input"
            style={{ display: referenceFiles.length >= 5 ? "none" : "flex" }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>{t("sidebar.clickToUpload")}</span>
          </label>
          <input type="file" id="ref-file-input" accept="image/*" multiple className="hidden" onChange={onRefFilesChange} />
        </div>

        <div className="studio-step">
          <p className="studio-note">
            {t("sidebar.savedWithRunPrefix")}
            <strong>{t("sidebar.sewingPatternBold")}</strong>
            {t("sidebar.isDraftedSuffix")}
          </p>
          <div className="studio-step-head">
            <span className="studio-step-title">{t("sidebar.step2")}</span>
            <div className="toggle-group" id="measure-tabs">
              <button type="button" className={`toggle-btn${measureTab === "ai" ? " active" : ""}`} onClick={() => setMeasureTab("ai")}>
                {t("sidebar.aiRecommendation")}
              </button>
              <button type="button" className={`toggle-btn${measureTab === "manual" ? " active" : ""}`} onClick={() => setMeasureTab("manual")}>
                {t("sidebar.manual")}
              </button>
            </div>
          </div>

          <div id="measure-detected" className={`measure-detected${!measurements.length ? " hidden" : ""}`}>
            <div className="measure-detected-region" id="measure-region">
              {region} — {garment}
            </div>
            <div className="studio-note" id="measure-design">
              {cleanAnalysis ? `${cleanAnalysis.designLabel} · size ${sizeNote}` : ""}
            </div>
          </div>

          <div id="measure-panel-ai" className={`tab-panel${measureTab !== "ai" ? " hidden" : ""}`}>
            <p className="studio-note" id="measure-ai-note">
              {measurements.length
                ? t("sidebar.measurementsUsingDefaults", { count: measurements.length, size: sizeForDefaults })
                : emptyMeasureText}
            </p>
          </div>
          <div id="measure-panel-manual" className={`tab-panel${measureTab !== "manual" ? " hidden" : ""}`}>
            <p className="studio-note" id="measure-manual-empty" style={{ display: measurements.length ? "none" : "block" }}>
              {emptyMeasureText}
            </p>
            <div className="measure-fields" id="measure-fields">
              {measurements.map((m) => (
                <label className="measure-field" title={m.how} key={m.key}>
                  <span>{m.label}</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={measureCurrent[m.key] ?? ""}
                    onChange={(e) => setMeasureCurrent((prev) => ({ ...prev, [m.key]: parseFloat(e.target.value) }))}
                  />
                </label>
              ))}
            </div>
            <button type="button" className={`link-btn${!measurements.length ? " hidden" : ""}`} id="reset-measure-btn" onClick={resetMeasurements}>
              {t("sidebar.resetToSizeDefaults")}
            </button>
          </div>
        </div>

        <div className="studio-step">
          <p className="studio-note">
            {t("sidebar.appliesToPrefix")}
            <strong>{t("sidebar.sketchRealisticBold")}</strong>
            {t("sidebar.outputSuffix")}
          </p>
          <div className="studio-step-head">
            <span className="studio-step-title">{t("sidebar.step3")}</span>
            <div className="toggle-group" id="color-tabs">
              <button type="button" className={`toggle-btn${colorTab === "ai" ? " active" : ""}`} onClick={() => setColorTab("ai")}>
                {t("sidebar.aiRecommendation")}
              </button>
              <button type="button" className={`toggle-btn${colorTab === "picker" ? " active" : ""}`} onClick={() => setColorTab("picker")}>
                {t("sidebar.picker")}
              </button>
            </div>
          </div>
          <div id="color-panel-ai" className={`tab-panel${colorTab !== "ai" ? " hidden" : ""}`}>
            <p className="studio-note">{t("sidebar.aiColorNote")}</p>
          </div>
          <div id="color-panel-picker" className={`tab-panel${colorTab !== "picker" ? " hidden" : ""}`}>
            <div className="color-fields">
              {[
                ["Primary", t("sidebar.primary")],
                ["Secondary", t("sidebar.secondary")],
                ["Tertiary", t("sidebar.tertiary")],
              ].map(([key, label], i) => (
                <div className={`color-field${!colorChecked[i] ? " off" : ""}`} key={key}>
                  <input type="checkbox" id={`use-color${i + 1}`} checked={colorChecked[i]} onChange={(e) => syncColorChecked(i, e.target.checked)} />
                  <label className="color-field-name" htmlFor={`use-color${i + 1}`}>
                    {label}
                  </label>
                  <input
                    type="color"
                    id={`color${i + 1}`}
                    value={colorValues[i]}
                    aria-label={`${label} color`}
                    onChange={(e) =>
                      setColorValues((prev) => prev.map((c, idx) => (idx === i ? e.target.value : c)))
                    }
                  />
                </div>
              ))}
            </div>
            <button type="button" className="link-btn" id="reset-colors-btn" onClick={resetColors}>
              {t("sidebar.resetColors")}
            </button>
          </div>
        </div>

        <div className="studio-step">
          <p className="studio-note">
            {t("sidebar.appliesToPrefix")}
            <strong>{t("sidebar.sketchRealisticBold")}</strong>
            {t("sidebar.outputSuffix")}
          </p>
          <div className="studio-step-head">
            <span className="studio-step-title">{t("sidebar.step4")}</span>
            <div className="toggle-group" id="season-tabs">
              <button type="button" className={`toggle-btn${seasonTab === "ai" ? " active" : ""}`} onClick={() => setSeasonTab("ai")}>
                {t("sidebar.aiRecommendation")}
              </button>
              <button type="button" className={`toggle-btn${seasonTab === "options" ? " active" : ""}`} onClick={() => setSeasonTab("options")}>
                {t("sidebar.options")}
              </button>
            </div>
          </div>
          <div id="season-panel-ai" className={`tab-panel${seasonTab !== "ai" ? " hidden" : ""}`}>
            <p className="studio-note">{t("sidebar.aiSeasonNote")}</p>
          </div>
          <div id="season-panel-options" className={`tab-panel${seasonTab !== "options" ? " hidden" : ""}`}>
            <div className="season-cards" id="season-cards">
              {[
                ["spring", "🌱", t("sidebar.spring")],
                ["summer", "☀️", t("sidebar.summer")],
                ["autumn", "🍂", t("sidebar.autumn")],
                ["winter", "❄️", t("sidebar.winter")],
                ["rain", "🌧️", t("sidebar.rain")],
              ].map(([key, icon, label]) => (
                <div
                  className={`season-card${selectedSeason === key ? " active" : ""}`}
                  data-season={key}
                  key={key}
                  onClick={() => setSelectedSeason((prev) => (prev === key ? null : key))}
                >
                  <div className={`season-icon ${key}`}>{icon}</div>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="studio-step">
          <div className="studio-step-title">{t("sidebar.step5")}</div>
          <textarea
            id="extra-prompt"
            rows={3}
            placeholder={t("sidebar.promptPlaceholder")}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
          />
        </div>
      </div>

      <div className="studio-footer">
        <div className="output-type-field">
          <label htmlFor="output-type">{t("sidebar.outputType")}</label>
          <select id="output-type" value={outputType} onChange={(e) => setOutputType(e.target.value as "sketch" | "both")}>
            <option value="sketch">{t("sidebar.sketchOnly")}</option>
            <option value="both">{t("sidebar.sketchPlusRealistic")}</option>
          </select>
        </div>
        <button type="button" id="generate-btn" disabled={uploadBlocked || generating} onClick={handleGenerateClick}>
          {t("sidebar.generateTechPack")}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
          </svg>
        </button>
      </div>
    </div>
  )
}
