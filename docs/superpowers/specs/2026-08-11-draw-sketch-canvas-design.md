# Draw Sketch Canvas — Design

## Purpose

Sidebar step 1 currently only accepts an uploaded image. Add a "Draw" option so the
user can hand-draw a sketch directly, and use it the same way an uploaded image is
used today (analysis, preview, generate).

## UI change

`#mode-toolbar` (currently a single always-active "Image" `toolbar-btn`) gets a second
button to its left:

```
[ Draw ] [ Image (active) ]
```

- **Image** stays the only real "mode" — always rendered active, unchanged behavior.
- **Draw** is not a mode toggle. Clicking it opens the `SketchCanvas` modal. It has no
  "active" state of its own.

The existing dropzone, preview thumbnail, clear (×) button, "Use this flat as the
sketch →" link, analysis note, and Generate button are all unchanged.

## New component: `SketchCanvas.tsx`

A fullscreen modal, structurally modeled on the existing `Overlay.tsx` (`.tp-overlay`
shell: click-outside-to-close backdrop, panel, close button).

Props:

```ts
{
  initialImageUrl: string | null   // drawnImageUrl from Sidebar, or null for a blank canvas
  onSelect: (file: File) => void   // fires on "Select Sketch"
  onClose: () => void              // fires on the X, or backdrop click
}
```

Internal state: current tool, pen color, stroke width, undo stack, redo stack.

### Canvas setup

- Plain `<canvas>`, no drawing library (none exists in `package.json` — `react`,
  `@palettelab/sdk`, `pdfjs-dist` only; not introducing a new dependency for this).
- Fixed size matching the modal's drawing area (no zoom/scroll in v1).
- On mount: if `initialImageUrl` is set, draw that image onto the canvas as the
  starting bitmap (`drawImage`) before any strokes are possible. Otherwise start from
  a blank white canvas.

### Toolbar (bottom of modal, matches reference screenshot)

| Tool | Behavior |
|---|---|
| Pen | Freehand stroke in the current color/width, drawn via pointer move events. |
| Eraser | Same stroke mechanics, draws using `destination-out` (or paints white) instead of color. |
| Color swatch | Opens a native `<input type="color">`; sets pen color. Does not affect eraser. |
| Stroke width | A small control (slider or stepped buttons) setting line width for pen and eraser. |
| Pan/hand | Switches pointer mode so dragging does not draw. No zoom in v1 — since the canvas doesn't scroll/zoom yet, this mode is a no-draw drag; reserved for future zoom support. |
| Select/frame | Rectangle marquee: drag to select a region, then **clear** (erase to white) that region on release or via the delete button. This is a "delete this part" tool, not move/copy — no pixel-move or copy/paste in v1. |
| Undo | Pops the undo stack, restores that bitmap, pushes current state to redo stack. |
| Redo | Pops the redo stack, restores that bitmap, pushes current state to undo stack. |
| Delete/clear | Pushes current state to undo stack, then clears the whole canvas to white. |

### Undo model

Snapshot-stack, not vector replay:

- Before each completed stroke, erase stroke, marquee-clear, or full clear, push the
  canvas's current bitmap (`canvas.toDataURL()` or `getImageData`) onto the undo stack.
- Cap the stack at ~30 entries (drop oldest) to bound memory.
- A new drawing action after an undo clears the redo stack (standard undo/redo
  semantics).
- This history is **session-only** — it lives in the modal's local state and is
  discarded when the modal closes. It is not persisted anywhere.

### Finalizing

- **"Select Sketch"** (top-right button): `canvas.toBlob("image/png")` → wrap as a
  `File` → call `onSelect(file)`.
- **Close X** (top-left) or backdrop click: call `onClose()` without exporting —
  discards this session's edits. The previously saved `drawnImageUrl` (if any) is
  untouched.

## Sidebar.tsx changes

New state:

```ts
const [drawOpen, setDrawOpen] = useState(false)
const [drawnImageUrl, setDrawnImageUrl] = useState<string | null>(null)
```

- **Draw button onClick**: `setDrawOpen(true)`.
- **`SketchCanvas` onSelect(file)`**:
  1. `setDrawnImageUrl(URL.createObjectURL(file))` (or a data URL) — so reopening Draw
     later continues from this image.
  2. Call the existing `handleUpload(file)` — same code path an uploaded file already
     takes (staging, analysis, preview thumbnail). No parallel/duplicate pipeline.
  3. `setDrawOpen(false)`.
- **`SketchCanvas` onClose`**: `setDrawOpen(false)`. No other state changes.
- Render: `{drawOpen && <SketchCanvas initialImageUrl={drawnImageUrl} onSelect={...} onClose={...} />}`.

## Explicitly out of scope

- No new npm dependency for canvas/drawing.
- No zoom on the canvas (pan tool is a no-op stub pending future zoom work).
- No pixel move/copy for the select/frame tool — clear-only.
- No cross-session undo history — only the loaded starting bitmap persists, not the
  stroke-by-stroke history.
- No changes to the generate pipeline, variations, SVG pattern tracing, or
  spec/measurements — `handleUpload(file)` is the only integration point, and it is
  reused unchanged.
- No changes to the gate-removal fix shipped earlier in this session (any image type
  already passes through to Generate; this feature doesn't touch that).
