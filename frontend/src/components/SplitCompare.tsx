import { useEffect, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

// A wipe, not two shrinking panes: both images fill the SAME box at the same
// object-fit, and the left layer is clipped at the divider, so the two plates
// stay in register (variations.py renders the realistic as the same two
// closed views, front-left/back-right, at the sketch's own aspect ratio, so
// `contain` in a shared box lands them pixel-for-pixel).
// Collapses to a single plate when there is genuinely nothing on the right.
export default function SplitCompare({
  leftUrl,
  rightUrl,
  leftLabel,
  rightLabel,
}: {
  leftUrl: string
  rightUrl: string | null
  leftLabel?: string
  rightLabel?: string
}) {
  const { t } = usePluginTranslations(STRINGS)
  const finalLeftLabel = leftLabel ?? t("splitCompare.sketch")
  const finalRightLabel = rightLabel ?? t("splitCompare.realistic")
  const [splitPct, setSplitPct] = useState(50)
  const [misaligned, setMisaligned] = useState(false)
  const [dragging, setDragging] = useState(false)
  const leftImgRef = useRef<HTMLImageElement>(null)
  const rightImgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSplitPct(50)
    setMisaligned(false)
  }, [leftUrl, rightUrl])

  function checkAlignment() {
    const sk = leftImgRef.current
    const re = rightImgRef.current
    if (!sk || !re || !sk.naturalWidth || !re.naturalWidth) return
    const ar = (i: HTMLImageElement) => i.naturalWidth / i.naturalHeight
    // 12% covers a render that added an opened row (taller) without flagging
    // ordinary few-pixel differences in the generated canvas size.
    setMisaligned(Math.abs(ar(sk) - ar(re)) / ar(sk) > 0.12)
  }

  if (!rightUrl) {
    return (
      <div className="tp-split tp-split-single">
        <div className="tp-split-layer">
          <img src={leftUrl} alt={finalLeftLabel} />
        </div>
        <span className="tp-tag">{finalLeftLabel}</span>
      </div>
    )
  }

  function setFromClientX(clientX: number) {
    const box = containerRef.current?.getBoundingClientRect()
    if (!box) return
    setSplitPct(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)))
  }

  return (
    <div
      className={`tp-split${misaligned ? " is-misaligned" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ ["--split" as any]: `${splitPct}%` }}
      ref={containerRef}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".tp-split-divider")) return
        setFromClientX(e.clientX)
      }}
    >
      <div className="tp-split-layer" data-side="realistic">
        <img ref={rightImgRef} src={rightUrl} alt={finalRightLabel} onLoad={checkAlignment} />
      </div>
      <div className="tp-split-layer tp-split-clip" data-side="sketch">
        <img ref={leftImgRef} src={leftUrl} alt={finalLeftLabel} onLoad={checkAlignment} />
      </div>
      <span className="tp-tag">{finalLeftLabel}</span>
      <span className="tp-tag tp-tag-right">{finalRightLabel}</span>
      <div
        className="tp-split-divider"
        role="separator"
        aria-label={t("splitCompare.dragToChangeSplit")}
        title={t("splitCompare.dragToChangeSplit")}
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragging(true)
          const move = (ev: PointerEvent) => setFromClientX(ev.clientX)
          const up = () => {
            window.removeEventListener("pointermove", move)
            window.removeEventListener("pointerup", up)
            setDragging(false)
          }
          window.addEventListener("pointermove", move)
          window.addEventListener("pointerup", up)
        }}
      >
        <span className="tp-split-grip">&#8249;&#8250;</span>
      </div>
      {misaligned && (
        <div className="tp-split-warn">{t("splitCompare.misaligned")}</div>
      )}
    </div>
  )
}
