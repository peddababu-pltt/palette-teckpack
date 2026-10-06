// Loads the body the garment is fitted to: the CC0 MakeHuman model
// (backend/assets/mannequin.glb) shaped to the pattern's measurements, or the
// built-in sized mannequin when that file isn't installed.
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { fetchBinary } from "../../api"
import { buildProceduralMannequin, fitModel, proceduralBody, type Fit } from "./body"

// fetched once per session: it's the same for every job
let modelBytes: Promise<ArrayBuffer | null> | null = null
function loadModelBytes(url: string): Promise<ArrayBuffer | null> {
  modelBytes ??= fetchBinary(url).catch(() => null)
  return modelBytes
}

export async function loadBody(modelUrl: string, cm: Record<string, number>, designKey: string, gender: "male" | "female" = "male"): Promise<{ root: THREE.Object3D; fit: Fit; realistic: boolean }> {
  const proc = proceduralBody(cm)
  const height = proc.fit.neckY + 0.21
  const bytes = await loadModelBytes(modelUrl)
  if (bytes) {
    try {
      const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), "")
      const { root, fit } = fitModel(gltf, cm, designKey, height, gender)
      return { root, fit, realistic: true }
    } catch (e) {
      console.warn("[techpack] 3D model unusable, using built-in mannequin:", e)
    }
  }
  return { root: buildProceduralMannequin(proc), fit: proc.fit, realistic: false }
}

/** `.../jobs/<id>/file/...` -> `.../assets/mannequin.glb` (same origin + prefix). */
export function modelUrlFrom(jobFileUrl: string): string {
  return jobFileUrl.replace(/\/jobs\/[^?]*/, "/assets/mannequin.glb").replace(/\?.*$/, "")
}
