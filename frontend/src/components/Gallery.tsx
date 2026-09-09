import { useEffect, useMemo, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { resolveUrl, type Job } from "../api"
import { STRINGS } from "../strings"
import GalleryCard, { garmentLabel } from "./GalleryCard"

export default function Gallery({
  jobs,
  generating,
  genPercent,
  search,
  onCancelGenerate,
  onOpenCard,
  onDeleteJob,
}: {
  jobs: Job[]
  generating: boolean
  genPercent: number
  search: string
  onCancelGenerate: () => void
  onOpenCard: (job: Job, tab: "overview" | "parts" | "pattern" | "spec") => void
  onDeleteJob: (job: Job) => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const [view, setView] = useState<"grid" | "list">("grid")
  const [openMenuJobId, setOpenMenuJobId] = useState<string | null>(null)
  const [scope, setScope] = useState<"recent" | "all">("recent")
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
      .map((job) => ({ job, img: resolveUrl(job.sketch), thumb: resolveUrl(job.thumb || job.sketch), label: garmentLabel(job, t) }))
      .filter((e) => e.img)
      .filter((e) => !q || e.label.toLowerCase().includes(q))
  }, [jobs, search, t])

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
          <select
            className="tp-units-select dash-scope"
            id="gallery-scope"
            aria-label={t("gallery.scopeAria")}
            value={scope}
            onChange={(e) => setScope(e.target.value as "recent" | "all")}
          >
            <option value="recent">{t("gallery.scopeRecent")}</option>
            <option value="all">{t("gallery.scopeAll", { count: entries.length })}</option>
          </select>
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
          {generating && (
            <div className="tp-card tp-card-skeleton" aria-label={t("gallery.generatingAria")} aria-busy="true">
              <div className="tp-card-media">
                <button type="button" className="upload-preview-clear tp-cancel-btn" title={t("gallery.cancelRun")} aria-label={t("gallery.cancelRun")} onClick={onCancelGenerate}>
                  &times;
                </button>
                <span className="tp-spinner" />
                <span className="tp-skeleton-pct">{genPercent}%</span>
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
          )}
          {shown.map((e) => (
            <GalleryCard
              key={e.job.job_id}
              job={e.job}
              imgUrl={e.img!}
              thumbUrl={e.thumb!}
              menuOpen={openMenuJobId === e.job.job_id}
              onToggleMenu={() => setOpenMenuJobId((cur) => (cur === e.job.job_id ? null : e.job.job_id))}
              onOpen={(tab) => onOpenCard(e.job, tab)}
              onDelete={() => onDeleteJob(e.job)}
            />
          ))}
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
