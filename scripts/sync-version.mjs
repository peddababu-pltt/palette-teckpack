#!/usr/bin/env node
// Propagates package.json's version into palette-plugin.json and pyproject.toml
// so the three manifests never drift. package.json is the source of truth —
// `npm version <bump>` writes it first, then `make bump` calls this script.
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const pkgPath = path.join(root, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const version = pkg.version

if (!semver.test(version)) {
  console.error(`sync-version: package.json version "${version}" is not valid semver`)
  process.exit(1)
}

const manifestPath = path.join(root, "palette-plugin.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.version = version
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

const pyprojectPath = path.join(root, "pyproject.toml")
const pyproject = readFileSync(pyprojectPath, "utf8")
const updated = pyproject.replace(/^version = "[^"]*"/m, `version = "${version}"`)
if (updated === pyproject) {
  console.error("sync-version: no version field found in pyproject.toml")
  process.exit(1)
}
writeFileSync(pyprojectPath, updated)

console.log(`sync-version: ${version} -> palette-plugin.json, pyproject.toml`)
