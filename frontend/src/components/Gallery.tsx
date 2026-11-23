import { useEffect, useMemo, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { resolveUrl, type Job } from "../api"
import { STRINGS } from "../strings"
import GalleryCard, { garmentLabel } from "./GalleryCard"

export default function Gallery({
  jobs,
  generating,
  generatingJobId,
  genPercent,
  search,
  onCancelGenerate,
  onCancelJob,
  onOpenCard,
  onDeleteJob,
  onShareJob,
}: {
  jobs: Job[]
  generating: boolean
  generatingJobId: string | null
  genPercent: number
  search: string
  onCancelGenerate: () => void
  onCancelJob: (job: Job) => void
  onOpenCard: (job: Job, tab: "overview" | "parts" | "pattern" | "spec") => void
  onDeleteJob: (job: Job) => void
  onShareJob: (job: Job) => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const [view, setView] = useState<"grid" | "list">("grid")
  const [openMenuJobId, setOpenMenuJobId] = useState<string | null>(null)
  const [scope, setScope] = useState<"recent" | "all">("recent")
  const [scopeOpen, setScopeOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const scopeLabel = (v: "recent" | "all") =>
    v === "recent" ? t("gallery.scopeRecent") : t("gallery.scopeAll", { count: entries.length })
  // close the scope menu on an outside click or Escape
  useEffect(() => {
    if (!scopeOpen) return
    const onDown = (e: PointerEvent) => {
      if (!scopeRef.current?.contains(e.target as Node)) setScopeOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScopeOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [scopeOpen])
  const [cols, setCols] = useState(1)
  const gridRef = useRef<HTMLDivElement>(null)

  // The grid is `repeat(auto-fill, minmax(230px, 1fr))`, so how many cards
  // make a row is a runtime fact, not a constant -- read it off the resolved
  // track list rather than guessing from the window width, which would have
  // to re-derive the sidebar, the padding and the gap to get the same answer.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns.trim()
      setCols(tracks && tracks !== "none" ? tracks.split(/\s+/).length : 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view])

  useEffect(() => {
    // The toggle button's onClick calls stopPropagation, but that doesn't
    // reliably stop this native document listener from also seeing the very
    // same click that opened the menu -- closing it again in the same tick,
    // so it never appears to open at all. Ignoring clicks that originate
    // from the menu or its toggle button doesn't depend on stopPropagation
    // working the way that assumed.
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest(".tp-menu, [aria-haspopup='true']")) return
      setOpenMenuJobId(null)
    }
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [])

  // ONE card per techpack — variants and (in "both" mode) the realistic
  // render are the same garment, so they live inside the card's own overlay,
  // not as extra tiles competing with it on the dashboard.
  const entries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return jobs
      // The run in progress already has its skeleton card; the list poll can
      // pick the job up mid-run (its sketch lands early), which would show it
      // twice.
      .filter((job) => job.job_id !== generatingJobId)
      .map((job) => ({ job, img: resolveUrl(job.sketch), thumb: resolveUrl(job.thumb || job.sketch), label: garmentLabel(job, t) }))
      // A job the server still marks as generating shows as a skeleton (see
      // below), image or not: its sketch on disk is the unfinished first pass.
      .filter((e) => e.img || e.job.generating)
      .filter((e) => !q || e.label.toLowerCase().includes(q))
  }, [jobs, search, t, generatingJobId])

  // "Recent" is three rows; "All" is the whole grid. Past three rows the grid
  // runs several screens tall and the upload column on the left -- the thing
  // you came here to use -- scrolls away above it, so recent is the default.
  // The skeleton card for a run in progress takes one of the slots, so it is
  // never the card that gets cut.
  const ROWS_SHOWN = 3
  const limit = Math.max(1, cols * ROWS_SHOWN - (generating ? 1 : 0))
  const hidden = Math.max(0, entries.length - limit)
  const shown = scope === "all" || !hidden ? entries : entries.slice(0, limit)

  return (
    <div className="studio-main">
      <div className="studio-main-head">
        <div className="dash-title">
          <span className="dash-title-mark" aria-hidden="true">
            <span className="dash-title-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <circle cx="8.5" cy="9.5" r="1.4" />
                <path d="m4.5 17.5 4.5-4.5 3.5 3.5 3-2.5 4 4" />
              </svg>
            </span>
          </span>
          <div className="dash-title-text">
            <h2>{t("gallery.dashboard")}</h2>
            <span className="studio-note" id="gallery-count">
              {entries.length
                ? t(entries.length === 1 ? "gallery.techpackCountOne" : "gallery.techpackCountMany", { count: entries.length })
                : ""}
            </span>
          </div>
        </div>
        <div className="dash-tools">
          {/* Not a native <select>: macOS opens its menu ON TOP of the button
              (the checked row over the control), hiding it. This one drops below. */}
          <div className="dash-scope-wrap" ref={scopeRef}>
            <button
              type="button"
              className="tp-units-select dash-scope"
              id="gallery-scope"
              aria-label={t("gallery.scopeAria")}
              aria-haspopup="listbox"
              aria-expanded={scopeOpen}
              onClick={() => setScopeOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault()
                  setScope(scope === "recent" ? "all" : "recent")
                }
              }}
            >
              <span>{scopeLabel(scope)}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {scopeOpen && (
              <div className="dash-scope-menu" role="listbox" aria-label={t("gallery.scopeAria")}>
                {(["recent", "all"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="option"
                    aria-selected={scope === value}
                    className={`tp-menu-item${scope === value ? " active" : ""}`}
                    onClick={() => {
                      setScope(value)
                      setScopeOpen(false)
                    }}
                  >
                    <span className="dash-scope-check" aria-hidden="true">{scope === value ? "\u2713" : ""}</span>
                    {scopeLabel(value)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="toolbar-group" id="view-toolbar" role="group" aria-label={t("gallery.cardLayoutAria")}>
            <button
              type="button"
              className={`toolbar-btn icon-only${view === "grid" ? " active" : ""}`}
              title={t("gallery.gridView")}
              aria-label={t("gallery.gridView")}
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
            <button
              type="button"
              className={`toolbar-btn icon-only${view === "list" ? " active" : ""}`}
              title={t("gallery.listView")}
              aria-label={t("gallery.listView")}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3.5" y1="6" x2="3.5" y2="6" />
                <line x1="3.5" y1="12" x2="3.5" y2="12" />
                <line x1="3.5" y1="18" x2="3.5" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="studio-main-scroll">
        <div ref={gridRef} id="gallery" className={`tp-gallery${view === "list" ? " is-list" : ""}`}>
          {generating && <SkeletonCard percent={genPercent} onCancel={onCancelGenerate} />}
          {shown.map((e) =>
            // Started from another tab, or this tab lost its progress stream
            // (reload, dropped connection): the job is still running, so it
            // gets the same loading card -- never the half-made sketch with
            // Pattern/Spec buttons that only error until the run ends.
            e.job.generating ? (
              <SkeletonCard key={e.job.job_id} onCancel={() => onCancelJob(e.job)} />
            ) : (
            <GalleryCard
              key={e.job.job_id}
              job={e.job}
              imgUrl={e.img!}
              thumbUrl={e.thumb!}
              menuOpen={openMenuJobId === e.job.job_id}
              onToggleMenu={() => setOpenMenuJobId((cur) => (cur === e.job.job_id ? null : e.job.job_id))}
              onOpen={(tab) => onOpenCard(e.job, tab)}
              onDelete={() => onDeleteJob(e.job)}
              onShare={() => onShareJob(e.job)}
            />
            ),
          )}
        </div>
        {hidden > 0 && scope === "recent" && (
          <div className="tp-gallery-more">
            <span className="studio-note">{t("gallery.hiddenNote", { count: hidden })}</span>
          </div>
        )}
        <p className="studio-note" id="gallery-empty" style={{ display: entries.length > 0 || generating ? "none" : "block" }}>
          {t("gallery.emptyState")}
        </p>
      </div>
    </div>
  )
}

function SkeletonCard({ percent, onCancel }: { percent?: number; onCancel: () => void }) {
  const { t } = usePluginTranslations(STRINGS)
  return (
    <div className="tp-card tp-card-skeleton" aria-label={t("gallery.generatingAria")} aria-busy="true">
      <div className="tp-card-media">
        <button type="button" className="upload-preview-clear tp-cancel-btn" title={t("gallery.cancelRun")} aria-label={t("gallery.cancelRun")} onClick={onCancel}>
          &times;
        </button>
        <span className="tp-spinner" />
        {percent !== undefined && <span className="tp-skeleton-pct">{percent}%</span>}
      </div>
      <div className="tp-card-caption">
        <span className="tp-card-cat tp-ph tp-ph-cat" />
        <span className="tp-card-sub tp-ph tp-ph-sub" />
      </div>
      <div className="tp-card-foot">
        <span className="tp-card-foot-btn tp-ph" />
        <span className="tp-card-foot-btn tp-ph" />
      </div>
    </div>
  )
}
