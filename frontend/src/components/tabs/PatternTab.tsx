import { useSyncExternalStore } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { downloadUrl, resolveUrl, withCacheBust, type Job } from "../../api"
import type { StageEngine } from "../../engine"
import { STRINGS } from "../../strings"
import SvgViewer, { ViewerTaskPanel } from "../SvgViewer"
import PdfViewer from "../PdfViewer"
import { dlIcon } from "../icons"

export default function PatternTab({ job, pluginId, engine }: { job: Job; pluginId: string; engine: StageEngine }) {
  void pluginId
  useSyncExternalStore(engine.subscribe, () => engine.version)
  const { t } = usePluginTranslations(STRINGS)

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
  if (pdfUrl) return <PdfViewer url={pdfUrl} downloads={downloads} />
  return (
    <SvgViewer downloads={downloads}>
      {/* key forces a real unmount/remount on every redraft -- see PartsTab's
          identical <object> for why the `data` attribute alone isn't enough. */}
      <object key={svgUrl} type="image/svg+xml" data={svgUrl} />
    </SvgViewer>
  )
}
