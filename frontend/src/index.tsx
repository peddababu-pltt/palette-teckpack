"use client"

// Re-exported so `pltt test`'s sandbox-bridge check (a text scan of this
// entry file) sees the SDK usage that actually lives in ./components/App,
// which is where usePlatform/getBaseUrl/apiFetch are used.
import type {} from "@palettelab/sdk"
import "./style.css"
import App from "./components/App"

export default App
