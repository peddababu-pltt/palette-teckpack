import { useCallback, useEffect, useRef, useState } from "react"
import { usePlatform, usePluginTranslations } from "@palettelab/sdk"
import type { PluginComponentProps } from "@palettelab/sdk"
import { STRINGS } from "../strings"
import {
  bootstrapBaseUrl,
  cancelJobApi,
  deleteJobApi,
  generateJob,
  isUpscaleWarningLine,
  listJobs,
  resolveUrl,
  watchJob,
  type Job,
  type OverlayTab,
} from "../api"
import { StageEngine } from "../engine"
import Sidebar, { type GenerateSubmission } from "./Sidebar"
import Gallery from "./Gallery"
import Overlay from "./Overlay"
import PlatformBar from "./PlatformBar"

// Measures the sticky sidebar's real usable height: it sits ~92px down until
// the page header scrolls away, so its available height changes as the page
// scrolls. --sidebar-max (consumed by style.css) keeps the Generate footer on
// screen in both states without permanently reserving header-sized space.
function useSidebarSizing() {
  useEffect(() => {
    const STICKY_TOP = 20
    let queued = false
    function sizeSidebar() {
      const layout = document.querySelector(".studio-layout") as HTMLElement | null
      queued = false
      if (!layout) return
      const docTop = layout.getBoundingClientRect().top + window.scrollY
      const top = Math.max(STICKY_TOP, docTop - window.scrollY)
      document.documentElement.style.setProperty("--sidebar-max", `${window.innerHeight - top - STICKY_TOP}px`)
    }
    function queueSizeSidebar() {
      if (queued) return
      queued = true
      requestAnimationFrame(sizeSidebar)
    }
    window.addEventListener("scroll", queueSizeSidebar, { passive: true })
    window.addEventListener("resize", queueSizeSidebar)
    sizeSidebar()
    return () => {
      window.removeEventListener("scroll", queueSizeSidebar)
      window.removeEventListener("resize", queueSizeSidebar)
    }
  }, [])
}

export default function App(_props: PluginComponentProps) {
  const platform = usePlatform()
  const pluginId = platform.pluginId || "techpack"
  const { t } = usePluginTranslations(STRINGS)
  useSidebarSizing()

  // style.css keys dark mode off `:root.dark`, but the real Palette host
  // scopes every plugin selector under `[data-palette-plugin-root]` at build
  // time -- `:root.dark` compiles to `[data-palette-plugin-root].dark`, which
  // only ever matches that wrapper element, never `<html>`. Local dev's
  // simulator sidesteps this by putting the class straight on `<html>`
  // (.palette/dev/simulator-entry.jsx), which is why the toggle worked there
  // but not on a real hosted preview.
  useEffect(() => {
    const root = document.querySelector(`[data-palette-plugin-root="${pluginId}"]`) as HTMLElement | null
    if (!root) return
    root.classList.toggle("dark", platform.colorMode === "dark")
    root.classList.toggle("light", platform.colorMode === "light")
    root.style.colorScheme = platform.colorMode === "dark" ? "dark" : "light"
  }, [platform.colorMode, pluginId])

  // Every other network call in this app (image src/download URLs, SSE,
  // multipart uploads) is built off the SDK's module-level `getBaseUrl()`,
  // which nothing in pltt dev's local simulator points at the real backend
  // port on its own — only the context-scoped `platform.apiFetch` is wired
  // correctly there. Fix it once, before anything else fetches.
  const [baseReady, setBaseReady] = useState(false)
  useEffect(() => {
    void bootstrapBaseUrl(platform.apiFetch, pluginId).then(() => setBaseReady(true))
  }, [platform.apiFetch, pluginId])

  const [jobs, setJobs] = useState<Job[]>([])
  const [generating, setGenerating] = useState(false)
  const [genPercent, setGenPercent] = useState(0)
  const [latestJobId, setLatestJobId] = useState<string | null>(null)
  const [useAsSketchUrl, setUseAsSketchUrl] = useState<string | null>(null)
  const [upscaleWarning, setUpscaleWarning] = useState<{ exhausted: boolean } | null>(null)
  const [overlay, setOverlay] = useState<{ jobId: string; tab: OverlayTab } | null>(null)

  const patchJob = useCallback((jobId: string, patch: (job: Job) => Job) => {
    setJobs((prev) => prev.map((j) => (j.job_id === jobId ? patch(j) : j)))
  }, [])

  const engineRef = useRef<StageEngine | null>(null)
  if (!engineRef.current) engineRef.current = new StageEngine(pluginId, patchJob)
  const engine = engineRef.current

  const reloadJobs = useCallback(async () => {
    const fresh = await listJobs(pluginId)
    setJobs(fresh)
    // A page reload wipes the engine's in-memory live-stage tracking, so any
    // parts/pattern trace that was still running (or never got past a failed
    // start) at the moment of reload would otherwise show a static "queued"
    // placeholder forever -- nothing else re-attaches to it. autoTrace() is
    // a no-op for jobs that are already live or already have their output,
    // so this is safe to run on every reload, not just the first one.
    fresh.forEach((job) => engine.autoTrace(job))
    return fresh
  }, [pluginId, engine])

  useEffect(() => {
    if (baseReady) void reloadJobs()
  }, [baseReady, reloadJobs])

  const handleGenerate = useCallback(
    async (sub: GenerateSubmission) => {
      setGenerating(true)
      setGenPercent(0)
      const res = await generateJob(pluginId, {
        photo: sub.photo,
        references: sub.references,
        prompt: sub.prompt,
        measurements: sub.measurements,
        mode: sub.outputMode,
        variants: sub.outputMode === "sketch" ? 2 : undefined,
        colors: sub.colors,
        season: sub.season,
      })
      if ("error" in res) {
        setGenerating(false)
        window.alert(res.error)
        return
      }
      const jobId = res.job_id
      setLatestJobId(jobId)
      watchJob(pluginId, jobId, {
        onProgress: (d) => setGenPercent(d.percent),
        onLine: (line) => {
          const warn = isUpscaleWarningLine(line)
          if (warn) setUpscaleWarning((prev) => prev || warn)
        },
        onStageDone: () => setGenPercent(100),
        onDone: async () => {
          setGenerating(false)
          const fresh = await reloadJobs()
          const job = fresh.find((j) => j.job_id === jobId)
          if (job) {
            // Trace parts + draft the pattern in the background so the card
            // usually opens on a finished artefact instead of kicking off a
            // minutes-long run when the tab is clicked.
            engine.autoTrace(job)
            if (sub.sourceMode === "image" && job.sketch) setUseAsSketchUrl(resolveUrl(job.sketch))
          }
        },
        onError: (msg) => {
          setGenerating(false)
          window.alert(msg)
        },
        onCancelled: () => setGenerating(false),
      })
    },
    [pluginId, engine, reloadJobs],
  )

  const handleCancelGenerate = useCallback(() => {
    if (latestJobId) void cancelJobApi(pluginId, latestJobId)
  }, [pluginId, latestJobId])

  const openCard = useCallback((job: Job, tab: OverlayTab = "overview") => {
    setOverlay({ jobId: job.job_id, tab })
  }, [])

  const handleDeleteJob = useCallback(
    async (job: Job) => {
      // Deleting takes the whole job directory: variants, parts SVG, pattern
      // and spec included — say so rather than implying only the tile goes.
      const extras = (job.variations || []).length
      const what =
        extras > 1 ? t("app.confirmDeleteJobMulti", { count: extras }) : t("app.confirmDeleteJobSingle")
      if (!window.confirm(t("app.confirmDelete", { what }))) return
      await deleteJobApi(pluginId, job.job_id)
      setOverlay((cur) => (cur && cur.jobId === job.job_id ? null : cur))
      await reloadJobs()
    },
    [pluginId, reloadJobs, t],
  )

  const handleDeleteAll = useCallback(async () => {
    if (jobs.length === 0) return
    if (!window.confirm(t("app.confirmDeleteAll", { count: jobs.length }))) return
    await Promise.all(jobs.map((j) => deleteJobApi(pluginId, j.job_id)))
    setOverlay(null)
    await reloadJobs()
  }, [jobs, pluginId, reloadJobs, t])

  const overlayJob = overlay ? jobs.find((j) => j.job_id === overlay.jobId) : null

  return (
    <div className="app-shell">
      <main className="app-main">
        {upscaleWarning && (
          <div id="upscale-warning" className="app-banner">
            {upscaleWarning.exhausted ? (
              <>
                <strong>{t("app.upscaleExhaustedTitle")}</strong> {t("app.upscaleExhaustedBody")}
              </>
            ) : (
              <>
                <strong>{t("app.upscaleFailedTitle")}</strong> {t("app.upscaleFailedBody")}
              </>
            )}
          </div>
        )}

        <header className="dash-head">
          <div className="app-brand">
            <svg
              className="app-brand-mark"
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2.5 2.5 7 12 11.5 21.5 7 12 2.5z" />
              <path d="M2.5 12 12 16.5 21.5 12" />
              <path d="M2.5 17 12 21.5 21.5 17" />
            </svg>
            {t("app.brand")}
          </div>
          <div className="tp-modal-actions">
            <PlatformBar />
            <button type="button" className="btn-reset btn-danger-text" onClick={handleDeleteAll}>
              {t("app.deleteAll")}
            </button>
          </div>
        </header>

        <div className="studio-layout">
          <Sidebar pluginId={pluginId} generating={generating} useAsSketchUrl={useAsSketchUrl} overlayOpen={!!overlay} onGenerate={handleGenerate} />
          <Gallery
            jobs={jobs}
            generating={generating}
            genPercent={genPercent}
            onCancelGenerate={handleCancelGenerate}
            onOpenCard={openCard}
            onDeleteJob={handleDeleteJob}
          />
        </div>
      </main>

      {overlay && overlayJob && (
        <Overlay
          job={overlayJob}
          tab={overlay.tab}
          pluginId={pluginId}
          engine={engine}
          onTabChange={(tab) => setOverlay({ jobId: overlayJob.job_id, tab })}
          onClose={() => setOverlay(null)}
          onPatchJob={patchJob}
        />
      )}
    </div>
  )
}
