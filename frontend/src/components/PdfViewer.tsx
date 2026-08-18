// The drafted pattern is one page per cut piece, so this reads
// pattern-pages.pdf directly: every page rendered in a scrollable column on
// the left, a thumbnail of every page on the right, and clicking a thumbnail
// jumps the left column to that page.
//
// Renders with pdfjs-dist instead of the vendored pdf.js the standalone app
// used — worker is served from the plugin backend to avoid CDN CSP blocks.
import { useEffect, useRef, useState, type ReactNode } from "react"
import * as pdfjsLib from "pdfjs-dist"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"
import { fetchBinary } from "../api"

type PageEntry = { canvas: HTMLCanvasElement; wrap: HTMLDivElement; fit: number }

export default function PdfViewer({ url, downloads }: { url: string; downloads: ReactNode }) {
  const { t } = usePluginTranslations(STRINGS)
  const scrollRef = useRef<HTMLDivElement>(null)
  const thumbsRef = useRef<HTMLDivElement>(null)
  const [zoomPct, setZoomPct] = useState(100)
  const [hint, setHint] = useState(t("pdfViewer.loadingPages"))
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<{ zoom: (dir: "in" | "out" | "reset" | "toggle") => void } | null>(null)

  useEffect(() => {
    let destroyed = false
    let cleanupScroll: (() => void) | null = null
    let doc: any = null
    setError(null)
    setHint(t("pdfViewer.loadingPages"))
    setPageCount(0)
    setZoomPct(100)
    controllerRef.current = null

    if (scrollRef.current) {
      scrollRef.current.innerHTML = `<div class="tp-pdf-loading"><span class="tp-spinner"></span><span>${t("pdfViewer.loadingPages")}</span></div>`
    }
    if (thumbsRef.current) thumbsRef.current.innerHTML = ""

    const dpr = window.devicePixelRatio || 1
    const docPages: any[] = []
    const pages: PageEntry[] = []
    let zoom = 1
    let active: number | null = null
    let renderSeq = 0
    let zoomTimer: number | undefined

    function markActive(i: number) {
      if (active === i) return
      active = i
      const thumbsEl = thumbsRef.current
      if (thumbsEl) Array.from(thumbsEl.children).forEach((t, j) => t.classList.toggle("is-active", j === i))
    }
    function setActivePage(i: number) {
      const p = pages[i]
      if (!p) return
      markActive(i)
      // Instant, not smooth: the container can scroll thousands of px, and a
      // CSS ease-out glide crawls for seconds before visibly moving.
      p.canvas.scrollIntoView({ block: "start" })
    }
    async function renderAll(scale: number) {
      const seq = ++renderSeq
      setHint(t("pdfViewer.renderingPages"))
      let next = 0
      const pool = Math.min(4, Math.max(1, docPages.length))
      async function worker() {
        for (;;) {
          const i = next++
          if (i >= docPages.length || seq !== renderSeq) return
          const vp = docPages[i].getViewport({ scale: scale * dpr })
          const canvas = pages[i].canvas
          canvas.width = vp.width
          canvas.height = vp.height
          canvas.style.width = `${vp.width / dpr}px`
          const task = docPages[i].render({ canvasContext: canvas.getContext("2d")!, viewport: vp })
          try {
            await task.promise
          } catch {
            /* superseded by a newer render request */
          }
        }
      }
      await Promise.all(Array.from({ length: pool }, worker))
      if (seq === renderSeq) setHint(t("pdfViewer.clickPageHint"))
    }

    controllerRef.current = {
      zoom: (dir) => {
        if (dir === "in") zoom = Math.min(4, zoom * 1.25)
        else if (dir === "out") zoom = Math.max(0.25, zoom / 1.25)
        // Clicking a page toggles it between its fit-to-width size and a
        // fixed 3x close-up — a single click to read fine print, a second
        // to back out, instead of hunting for the +/- buttons.
        else if (dir === "toggle") zoom = zoom > 1.2 ? 1 : 3
        else zoom = 1
        setZoomPct(Math.round(zoom * 100))
        window.clearTimeout(zoomTimer)
        zoomTimer = window.setTimeout(() => {
          if (pages[0]) void renderAll(pages[0].fit * zoom)
        }, 120)
      },
    }

    async function load() {
      // Derive worker URL from the pdf URL so it works in local dev, staging,
      // and preview environments without needing a separate pluginId prop.
      // url = "http://host/<prefix>/jobs/<id>/file/pattern-pages.pdf"
      pdfjsLib.GlobalWorkerOptions.workerSrc = url.replace(/\/jobs\/.*$/, "/assets/pdf.worker.min.mjs")
      const data = await fetchBinary(url)
      if (destroyed) return
      doc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise
      if (destroyed) return
      setPageCount(doc.numPages)
      const scroll = scrollRef.current
      const thumbsEl = thumbsRef.current
      if (!scroll || !thumbsEl) return
      scroll.innerHTML = ""
      thumbsEl.innerHTML = ""

      // Slots are created in order; only the pixel-heavy page.render() is
      // deferred to parallel passes afterwards, so pages/thumbnails stay in order.
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        docPages[i - 1] = page
        const base = page.getViewport({ scale: 1 })
        const fit = Math.max(0.3, Math.min(1.6, (scroll.clientWidth - 32) / base.width))
        const wrap = document.createElement("div")
        wrap.className = "tp-pdf-page"
        wrap.title = t("pdfViewer.clickToZoom")
        const canvas = document.createElement("canvas")
        wrap.appendChild(canvas)
        wrap.addEventListener("click", () => controllerRef.current?.zoom("toggle"))
        scroll.appendChild(wrap)
        pages.push({ canvas, wrap, fit })

        const tv = page.getViewport({ scale: 46 / base.width })
        const tCanvas = document.createElement("canvas")
        tCanvas.className = "tp-pdf-thumb-canvas"
        tCanvas.width = tv.width
        tCanvas.height = tv.height
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "tp-pdf-thumb"
        btn.title = t("pdfViewer.goToPage", { n: i })
        btn.appendChild(tCanvas)
        const label = document.createElement("span")
        label.textContent = t("pdfViewer.page", { n: i })
        btn.appendChild(label)
        btn.addEventListener("click", () => setActivePage(i - 1))
        thumbsEl.appendChild(btn)
      }
      if (destroyed) return

      await Promise.all(
        docPages.map((page, i) => {
          const tCanvas = thumbsEl.children[i]?.querySelector("canvas") as HTMLCanvasElement | null
          if (!tCanvas) return Promise.resolve()
          const base = page.getViewport({ scale: 1 })
          const tv = page.getViewport({ scale: 46 / base.width })
          tCanvas.width = tv.width
          tCanvas.height = tv.height
          return page.render({ canvasContext: tCanvas.getContext("2d")!, viewport: tv }).promise.catch(() => {})
        }),
      )
      if (destroyed) return
      await renderAll(pages[0].fit)
      markActive(0)

      // The page column no longer scrolls itself — the overlay panel around
      // it does — so "current page" is measured against the panel's own
      // viewport rather than a scrollTop this column doesn't have.
      const panel = (scroll.closest(".tp-overlay-panel") as HTMLElement | null) || (document.scrollingElement as HTMLElement | null)
      function onScroll() {
        const top = (panel && panel.getBoundingClientRect ? panel.getBoundingClientRect().top : 0) + 8
        let cur = 0
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].wrap.getBoundingClientRect().top <= top) cur = i
          else break
        }
        markActive(cur)
      }
      panel?.addEventListener("scroll", onScroll, { passive: true })
      cleanupScroll = () => panel?.removeEventListener("scroll", onScroll)
    }

    load().catch((err) => setError(String(err?.message || err)))

    return () => {
      destroyed = true
      cleanupScroll?.()
      window.clearTimeout(zoomTimer)
      doc?.destroy?.()
    }
  }, [url, t])

  return (
    <div className="tp-viewer-layout">
      <div className="tp-viewer-main">
        <div className="tp-pdf-viewer">
          <div className="tp-svg-controls">
            <button type="button" className="tp-ctrl-btn" title={t("pdfViewer.zoomOut")} aria-label={t("pdfViewer.zoomOut")} onClick={() => controllerRef.current?.zoom("out")}>
              &minus;
            </button>
            <span className="tp-svg-zoom-level">{zoomPct}%</span>
            <button type="button" className="tp-ctrl-btn" title={t("pdfViewer.zoomIn")} aria-label={t("pdfViewer.zoomIn")} onClick={() => controllerRef.current?.zoom("in")}>
              +
            </button>
            <button type="button" className="tp-ctrl-btn" onClick={() => controllerRef.current?.zoom("reset")}>
              {t("pdfViewer.reset")}
            </button>
            <span className="tp-layer-toggle">{hint}</span>
          </div>
          <div className="tp-pdf-scroll" ref={scrollRef} />
          {error && <p className="panel-loading err">{t("pdfViewer.couldNotLoad", { error })}</p>}
        </div>
        <div className="tp-modal-actions" style={{ marginTop: 12 }}>
          {downloads}
        </div>
      </div>
      <aside className="tp-parts-card tp-pdf-pages-card">
        <div className="tp-parts-head">
          <h3>
            {t("pdfViewer.pages")} <span className="tp-parts-count">{pageCount || ""}</span>
          </h3>
        </div>
        <div className="tp-parts-list" ref={thumbsRef} />
      </aside>
    </div>
  )
}
