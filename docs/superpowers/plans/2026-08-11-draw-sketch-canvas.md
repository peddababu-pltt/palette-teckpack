# Draw Sketch Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Draw" button to Sidebar step 1 that opens a fullscreen canvas modal where the user hand-draws a sketch, then feeds the exported PNG into the exact same upload pipeline an uploaded file already uses.

**Architecture:** One new self-contained component, `SketchCanvas.tsx` (plain `<canvas>`, no drawing library), rendered conditionally by `Sidebar.tsx`. Its only integration point with the rest of the app is calling `Sidebar`'s existing `handleUpload(file)` — no parallel pipeline, no changes to `App.tsx`, `api.ts`, or the backend.

**Tech Stack:** React 19, plain HTML5 Canvas 2D API, existing `@palettelab/sdk` translation hook (`usePluginTranslations`), existing CSS custom properties in `frontend/src/style.css`.

## Global Constraints

- No new npm dependency — verified `package.json` has only `@palettelab/sdk`, `pdfjs-dist`, `react`; do not add a canvas/drawing library.
- This repo has no unit test framework (no `jest`/`vitest` config, no `*.test.*` files anywhere in `frontend/src`). Every other component in this codebase is verified by `tsc --noEmit` (via `npm run typecheck`, which runs `tsc --noEmit` from the project root where `tsconfig.json` lives) plus manual verification in the browser via `pltt dev` — this plan follows that same convention. Do not invent a test framework or fake test files.
- Every user-facing string goes through `t("namespace.key")` via `usePluginTranslations(STRINGS)`, with both an `en` and a `ko` entry in `frontend/src/strings.ts` — follow this for every new string.
- Match existing icon style: inline `<svg>` with `stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"`, no icon library.
- Do not run `git commit` after implementing — the user reviews and commits this themselves.

---

### Task 1: Add translation strings

**Files:**
- Modify: `frontend/src/strings.ts` (en `sidebar` block ~line 66-100, ko `sidebar` block ~line 59-90, and add a new `sketchCanvas` block to both the `en` and `ko` top-level objects, alongside the existing `overlay`/`sidebar` blocks)

**Interfaces:**
- Produces: string keys `sidebar.draw`, `sidebar.drawTabTitle`, `sketchCanvas.selectSketch`, `sketchCanvas.close`, `sketchCanvas.pen`, `sketchCanvas.eraser`, `sketchCanvas.color`, `sketchCanvas.strokeWidth`, `sketchCanvas.pan`, `sketchCanvas.select`, `sketchCanvas.undo`, `sketchCanvas.redo`, `sketchCanvas.clear` — Task 2 and Task 4 both call `t()` with these exact keys.

- [ ] **Step 1: Add the two `sidebar` keys to the `en` block**

In `frontend/src/strings.ts`, find the `en.sidebar` block (starts `sidebar: {` under `en:`). Add these two keys right after `step1: "1. Sketch",`:

```ts
      step1: "1. Sketch",
      draw: "Draw",
      drawTabTitle: "Draw a sketch on a blank canvas",
```

- [ ] **Step 2: Add the matching `sidebar` keys to the `ko` block**

Find the `ko.sidebar` block (starts `sidebar: {` under `ko:`). Add these two keys right after `step1: "1. 스케치",`:

```ts
      step1: "1. 스케치",
      draw: "그리기",
      drawTabTitle: "빈 캔버스에 스케치 그리기",
```

- [ ] **Step 3: Add a new `sketchCanvas` block to the `en` object**

In the `en:` object, add a new top-level block right after the `overlay` block closes (after `overlay: { ... },`):

```ts
    sketchCanvas: {
      selectSketch: "Select Sketch",
      close: "Close",
      pen: "Pen",
      eraser: "Eraser",
      color: "Color",
      strokeWidth: "Stroke width",
      pan: "Pan",
      select: "Select area",
      undo: "Undo",
      redo: "Redo",
      clear: "Clear canvas",
    },
```

- [ ] **Step 4: Add the matching `sketchCanvas` block to the `ko` object**

In the `ko:` object, add the same block right after its `overlay` block closes:

```ts
    sketchCanvas: {
      selectSketch: "스케치 선택",
      close: "닫기",
      pen: "펜",
      eraser: "지우개",
      color: "색상",
      strokeWidth: "선 굵기",
      pan: "이동",
      select: "선택 영역",
      undo: "실행 취소",
      redo: "다시 실행",
      clear: "캔버스 지우기",
    },
```

- [ ] **Step 5: Typecheck**

Run: `cd /Users/peddababu/Desktop/palette-teckpack/palette-teckpack && npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit code 0. `strings.ts` has no type annotations on these object literals, so a typo in a key name will not fail here — double-check the keys visually against Step 1-4 before moving on.

- [ ] **Step 6: Manual check**

Not independently visible yet (nothing references these keys until Task 2/4) — skip manual verification for this task, the typecheck is the gate.

---

### Task 2: Build the `SketchCanvas` component

**Files:**
- Create: `frontend/src/components/SketchCanvas.tsx`

**Interfaces:**
- Consumes: `usePluginTranslations` from `@palettelab/sdk`, `STRINGS` from `../strings` (needs `sketchCanvas.*` keys from Task 1).
- Produces: `export default function SketchCanvas(props: { initialImageUrl: string | null; onSelect: (file: File) => void; onClose: () => void }): JSX.Element` — Task 4 imports and renders this with exactly these three props.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/SketchCanvas.tsx`:

```tsx
import { useEffect, useRef, useState } from "react"
import { usePluginTranslations } from "@palettelab/sdk"
import { STRINGS } from "../strings"

type Tool = "pen" | "eraser" | "pan" | "select"

const MAX_HISTORY = 30
const CANVAS_WIDTH = 900
const CANVAS_HEIGHT = 640

function loadImageOnto(ctx: CanvasRenderingContext2D, url: string, width: number, height: number): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = "#FFFFFF"
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      resolve()
    }
    img.onerror = () => resolve()
    img.src = url
  })
}

export default function SketchCanvas({
  initialImageUrl,
  onSelect,
  onClose,
}: {
  initialImageUrl: string | null
  onSelect: (file: File) => void
  onClose: () => void
}) {
  const { t } = usePluginTranslations(STRINGS)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [tool, setTool] = useState<Tool>("pen")
  const [color, setColor] = useState("#111111")
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [undoStack, setUndoStack] = useState<string[]>([])
  const [redoStack, setRedoStack] = useState<string[]>([])
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)

  // Load the starting bitmap once on mount: the previously-saved drawing if
  // there is one, otherwise a blank white page.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    if (initialImageUrl) {
      void loadImageOnto(ctx, initialImageUrl, canvas.width, canvas.height)
    } else {
      ctx.fillStyle = "#FFFFFF"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  function snapshot(): string {
    const canvas = canvasRef.current
    if (!canvas) return ""
    return canvas.toDataURL("image/png")
  }

  function pushUndo() {
    const data = snapshot()
    if (!data) return
    setUndoStack((prev) => {
      const next = [...prev, data]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
    setRedoStack([])
  }

  async function restore(data: string) {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    await loadImageOnto(ctx, data, canvas.width, canvas.height)
  }

  async function undo() {
    if (!undoStack.length) return
    const data = undoStack[undoStack.length - 1]
    const current = snapshot()
    setUndoStack((prev) => prev.slice(0, -1))
    setRedoStack((prev) => [...prev, current])
    await restore(data)
  }

  async function redo() {
    if (!redoStack.length) return
    const data = redoStack[redoStack.length - 1]
    const current = snapshot()
    setRedoStack((prev) => prev.slice(0, -1))
    setUndoStack((prev) => [...prev, current])
    await restore(data)
  }

  function clearCanvas() {
    pushUndo()
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.fillStyle = "#FFFFFF"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "pan") return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const point = pointFromEvent(e)
    if (tool === "select") {
      marqueeStartRef.current = point
      setMarquee({ x: point.x, y: point.y, w: 0, h: 0 })
      return
    }
    pushUndo()
    drawingRef.current = true
    lastPointRef.current = point
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.lineWidth = strokeWidth
    ctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : color
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const point = pointFromEvent(e)
    if (tool === "select" && marqueeStartRef.current) {
      const start = marqueeStartRef.current
      setMarquee({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      })
      return
    }
    if (!drawingRef.current || tool === "pan") return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx || !lastPointRef.current) return
    ctx.beginPath()
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
    lastPointRef.current = point
  }

  function onPointerUp() {
    if (tool === "select" && marquee) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (canvas && ctx && marquee.w > 0 && marquee.h > 0) {
        pushUndo()
        ctx.fillStyle = "#FFFFFF"
        ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
      }
      marqueeStartRef.current = null
      setMarquee(null)
      return
    }
    drawingRef.current = false
    lastPointRef.current = null
  }

  function handleSelectSketch() {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const file = new File([blob], "sketch.png", { type: "image/png" })
      onSelect(file)
    }, "image/png")
  }

  const canvasEl = canvasRef.current
  const rect = canvasEl?.getBoundingClientRect()
  const scaleX = rect ? rect.width / CANVAS_WIDTH : 1
  const scaleY = rect ? rect.height / CANVAS_HEIGHT : 1

  return (
    <div className="sketch-canvas-overlay">
      <button
        type="button"
        className="sketch-canvas-close"
        title={t("sketchCanvas.close")}
        aria-label={t("sketchCanvas.close")}
        onClick={onClose}
      >
        &times;
      </button>
      <button type="button" className="sketch-canvas-select-btn" onClick={handleSelectSketch}>
        {t("sketchCanvas.selectSketch")}
      </button>

      <div
        className="sketch-canvas-stage-wrap"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="sketch-canvas-stage">
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className={`sketch-canvas${tool === "pan" ? " pan" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
          {marquee && (
            <div
              className="sketch-canvas-marquee"
              style={{
                left: marquee.x * scaleX,
                top: marquee.y * scaleY,
                width: marquee.w * scaleX,
                height: marquee.h * scaleY,
              }}
            />
          )}
        </div>
      </div>

      <div className="sketch-canvas-toolbar">
        <button
          type="button"
          className={`sc-tool-btn${tool === "pen" ? " active" : ""}`}
          title={t("sketchCanvas.pen")}
          onClick={() => setTool("pen")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "eraser" ? " active" : ""}`}
          title={t("sketchCanvas.eraser")}
          onClick={() => setTool("eraser")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 20H9L4 15a1.5 1.5 0 010-2l8-8a2 2 0 013 0l6 6a2 2 0 010 3l-5 5" />
          </svg>
        </button>
        <label className="sc-color-swatch" title={t("sketchCanvas.color")}>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <input
          type="range"
          className="sc-stroke-width"
          title={t("sketchCanvas.strokeWidth")}
          min={1}
          max={20}
          value={strokeWidth}
          onChange={(e) => setStrokeWidth(Number(e.target.value))}
        />
        <button
          type="button"
          className={`sc-tool-btn${tool === "pan" ? " active" : ""}`}
          title={t("sketchCanvas.pan")}
          onClick={() => setTool("pan")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v7M10 10.5V6a2 2 0 00-4 0v9a7 7 0 0014 0v-3a2 2 0 00-4 0" />
          </svg>
        </button>
        <button
          type="button"
          className={`sc-tool-btn${tool === "select" ? " active" : ""}`}
          title={t("sketchCanvas.select")}
          onClick={() => setTool("select")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3">
            <rect x="4" y="4" width="16" height="16" rx="1" />
          </svg>
        </button>
        <button type="button" className="sc-tool-btn" disabled={!undoStack.length} title={t("sketchCanvas.undo")} onClick={undo}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-1" />
          </svg>
        </button>
        <button type="button" className="sc-tool-btn" disabled={!redoStack.length} title={t("sketchCanvas.redo")} onClick={redo}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h1" />
          </svg>
        </button>
        <button type="button" className="sc-tool-btn sc-tool-danger" title={t("sketchCanvas.clear")} onClick={clearCanvas}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
```

Note on the click-outside-to-close: the handler lives on `.sketch-canvas-stage-wrap` (which fills all the space around the canvas), not on the outer `.sketch-canvas-overlay`, and checks `e.target === e.currentTarget` — this only fires when the click lands on the wrap's own empty padding, not when it lands on the canvas (which must draw) or bubbles up from the toolbar (a separate sibling, not a descendant of the wrap, so its clicks never reach this handler at all).

- [ ] **Step 2: Typecheck**

Run: `cd /Users/peddababu/Desktop/palette-teckpack/palette-teckpack && npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual check (component in isolation)**

This component isn't rendered anywhere yet (Task 4 wires it up), so there's nothing to click in the browser yet. Skip manual verification for this task — Task 4's manual check covers it end-to-end.

- [ ] **Step 4: Commit**

Do NOT run `git commit` — leave the change in the working tree for the user to review and commit themselves (per Global Constraints).

---

### Task 3: Add CSS for the draw modal

**Files:**
- Modify: `frontend/src/style.css` (append a new section; a natural spot is right after the existing `/* --- overlays ----- */` block, since this reuses the same `overlay-in` keyframe and `--shadow-lg`/`--dur`/`--ease` tokens)

**Interfaces:**
- Consumes: existing CSS custom properties `--zinc-100`, `--zinc-800`, `--zinc-900`, `--surface`, `--surface-2`, `--border`, `--border-strong`, `--fg`, `--fg-muted`, `--primary`, `--on-primary`, `--danger`, `--danger-weak`, `--r-sm`, `--r-md`, `--r-lg`, `--sp-1`, `--sp-2`, `--sp-4`, `--sp-6`, `--sp-8`, `--sp-10`, `--dur`, `--ease`, `--shadow-lg`, and the `overlay-in` keyframe — all already defined earlier in this file.
- Produces: class names `sketch-canvas-overlay`, `sketch-canvas-close`, `sketch-canvas-select-btn`, `sketch-canvas-stage-wrap`, `sketch-canvas-stage`, `sketch-canvas` (and its `.pan` modifier), `sketch-canvas-marquee`, `sketch-canvas-toolbar`, `sc-tool-btn` (and its `.active`/`.sc-tool-danger` modifiers), `sc-color-swatch`, `sc-stroke-width` — Task 2's JSX already references these exact names.

- [ ] **Step 1: Append the CSS block**

Add this block to `frontend/src/style.css`, right after the existing `.tp-overlay-close:hover { color: var(--fg); background: var(--surface-2); }` line:

```css

/* --- sketch canvas draw modal -------------------------------------------- */
.sketch-canvas-overlay {
  position: fixed; inset: 0;
  background: var(--zinc-100);
  z-index: 200;
  display: flex; align-items: center; justify-content: center;
  animation: overlay-in var(--dur) var(--ease);
}
.sketch-canvas-close {
  position: absolute; top: var(--sp-4); left: var(--sp-4);
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 50%;
  font-size: 20px; line-height: 1; color: var(--fg-muted);
  z-index: 1;
}
.sketch-canvas-close:hover { color: var(--fg); background: var(--surface-2); }
.sketch-canvas-select-btn {
  position: absolute; top: var(--sp-4); right: var(--sp-4);
  background: var(--zinc-900); color: #fff;
  border: none; border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-4);
  font-weight: 600; font-size: 14px;
  z-index: 1;
}
.sketch-canvas-select-btn:hover { background: var(--zinc-800); }
.sketch-canvas-stage-wrap {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  padding: var(--sp-10) var(--sp-8) 100px;
  box-sizing: border-box;
}
.sketch-canvas-stage { position: relative; box-shadow: var(--shadow-lg); }
.sketch-canvas {
  display: block;
  background: #FFFFFF; border-radius: var(--r-sm);
  max-width: 100%; max-height: 100%;
  cursor: crosshair; touch-action: none;
}
.sketch-canvas.pan { cursor: grab; }
.sketch-canvas-marquee {
  position: absolute; pointer-events: none;
  border: 1px dashed var(--fg-muted);
  background: rgba(9, 9, 11, .05);
}
.sketch-canvas-toolbar {
  position: absolute; bottom: var(--sp-6); left: 50%;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: var(--sp-1);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); box-shadow: var(--shadow-lg);
  padding: var(--sp-1);
}
.sc-tool-btn {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; border-radius: var(--r-md);
  color: var(--fg-muted);
}
.sc-tool-btn:hover { background: var(--surface-2); color: var(--fg); }
.sc-tool-btn.active { background: var(--primary); color: var(--on-primary); }
.sc-tool-btn:disabled { opacity: .35; }
.sc-tool-btn.sc-tool-danger:hover { background: var(--danger-weak); color: var(--danger); }
.sc-color-swatch {
  width: 28px; height: 28px; border-radius: 50%;
  overflow: hidden; border: 1px solid var(--border-strong);
  margin: 0 var(--sp-1);
  display: flex; cursor: pointer;
}
.sc-color-swatch input[type=color] {
  width: 100%; height: 100%; border: none; padding: 0; cursor: pointer;
}
.sc-stroke-width { width: 90px; margin: 0 var(--sp-2); accent-color: var(--primary); }
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/peddababu/Desktop/palette-teckpack/palette-teckpack && npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit code 0 (CSS changes can't break TypeScript, but this confirms nothing else broke).

- [ ] **Step 3: Manual check**

Still nothing renders this yet — deferred to Task 4's manual check.

- [ ] **Step 4: Commit**

Do NOT run `git commit` (per Global Constraints).

---

### Task 4: Wire the Draw button and modal into `Sidebar.tsx`

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `SketchCanvas` from `./SketchCanvas` (Task 2's `{ initialImageUrl, onSelect, onClose }` props), `t("sidebar.draw")` / `t("sidebar.drawTabTitle")` (Task 1).
- Produces: nothing new consumed elsewhere — this is the top of the wiring chain for this feature.

- [ ] **Step 1: Add the import**

At the top of `frontend/src/components/Sidebar.tsx`, add this import alongside the existing ones:

```tsx
import SketchCanvas from "./SketchCanvas"
```

- [ ] **Step 2: Add the new state**

In the state declarations near the top of the `Sidebar` function body (right after `const [dragOver, setDragOver] = useState(false)`), add:

```tsx
  const [drawOpen, setDrawOpen] = useState(false)
  const [drawnImageUrl, setDrawnImageUrl] = useState<string | null>(null)
```

- [ ] **Step 3: Add the `onSelect` handler**

Add this function near `onUseAsSketchClick` (same section of the file):

```tsx
  function onDrawSelect(file: File) {
    const url = URL.createObjectURL(file)
    setDrawnImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    void handleUpload(file)
    setDrawOpen(false)
  }
```

This reuses `handleUpload`, the exact same function the file-input and drop-zone already call — the drawn PNG goes through identical staging/analysis/preview logic as an uploaded file.

- [ ] **Step 4: Add the "Draw" button before the "Image" button**

Find the `#mode-toolbar` div (currently containing just the single "Image" `toolbar-btn`). Add a new button immediately before it:

```tsx
            <div className="toolbar-group" id="mode-toolbar">
              <button
                type="button"
                className="toolbar-btn"
                title={t("sidebar.drawTabTitle")}
                onClick={() => setDrawOpen(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
                {t("sidebar.draw")}
              </button>
              <button type="button" className="toolbar-btn active" title={t("sidebar.imageTabTitle")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                {t("sidebar.image")}
              </button>
            </div>
```

(The "Image" button's markup is unchanged from what's already there — only the new "Draw" button before it is new.)

- [ ] **Step 5: Render the modal conditionally**

The component currently `return`s a single `<div className="studio-sidebar">...</div>`. Wrap it in a fragment and add the conditional render as a sibling, right after that div closes:

```tsx
  return (
    <>
      <div className="studio-sidebar">
        {/* ...unchanged existing content... */}
      </div>
      {drawOpen && (
        <SketchCanvas
          initialImageUrl={drawnImageUrl}
          onSelect={onDrawSelect}
          onClose={() => setDrawOpen(false)}
        />
      )}
    </>
  )
```

- [ ] **Step 6: Typecheck**

Run: `cd /Users/peddababu/Desktop/palette-teckpack/palette-teckpack && npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit code 0.

- [ ] **Step 7: Manual check in the browser**

Run: `cd /Users/peddababu/Desktop/palette-teckpack/palette-teckpack && npm run dev` (this runs `pltt dev`)

In the browser:
1. Confirm step 1 now shows two buttons: "Draw" then "Image" (Image still active/highlighted).
2. Click "Draw" — a fullscreen white canvas modal opens with a bottom toolbar (pen, eraser, color swatch, stroke-width slider, pan, select, undo, redo, delete) and a "Select Sketch" button top-right, close (×) top-left.
3. Draw a stroke with the pen tool — a line appears, colored per the color swatch.
4. Switch to eraser, draw over part of the line — it turns white (erased).
5. Click undo twice — first undo reverts the eraser stroke, second reverts the pen stroke back toward blank. Click redo — it comes back.
6. Switch to the select tool, drag a rectangle over a drawn area, release — that rectangular area clears to white.
7. Click the delete/clear button — the whole canvas goes white; undo brings the drawing back.
8. Draw something, click "Select Sketch" — modal closes, the drawn sketch appears in the existing preview area (same spot an uploaded image would show), and the existing analysis note area behaves as it does for a normal upload.
9. Click "Draw" again — the modal reopens with the previous drawing already on the canvas (loaded from `drawnImageUrl`), confirming "continue drawing" works.
10. Open "Draw" and click the × close button without hitting "Select Sketch" — modal closes, the previously staged sketch/preview is unchanged.
11. Confirm the rest of the sidebar (Reference Images, Measurements, Color, Season, prompt box, Generate button) is untouched and still works as before.

- [ ] **Step 8: Commit**

Do NOT run `git commit` (per Global Constraints) — leave everything in the working tree for the user to review and commit.

---

## Self-Review Notes

- **Spec coverage:** Draw button placement (before Image, spec + user follow-up) → Task 4 Step 4. Fullscreen modal reusing overlay conventions → Task 2 + Task 3. Full toolbar (pen/eraser/color/stroke-width/pan-stub/select-marquee-clear/undo/redo/clear) → Task 2. Snapshot-stack undo capped at 30 → Task 2 `MAX_HISTORY`. `drawnImageUrl` reopen-with-last-image behavior → Task 2's mount effect + Task 4's state. Finalize via existing `handleUpload` → Task 4 Step 3. Close discards session, doesn't touch saved `drawnImageUrl` → Task 2's `onClose` (no state mutation) + Task 4. No new dependency, no backend/App.tsx/api.ts change, no touch to gate-removal/generate/variations/SVG/spec pipeline → none of the four tasks touch those files.
- **Placeholder scan:** no TBD/TODO; every step has literal code, not a description of code.
- **Type consistency:** `SketchCanvas` props (`initialImageUrl: string | null`, `onSelect: (file: File) => void`, `onClose: () => void`) match exactly between Task 2's definition and Task 4's usage. CSS class names match exactly between Task 2's JSX and Task 3's stylesheet.
- **Scope:** single cohesive feature, four tasks, each independently testable via typecheck (+ manual check where something becomes visible) — no further decomposition needed.
