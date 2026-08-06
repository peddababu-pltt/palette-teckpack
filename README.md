# Techpack Studio (Palette plugin)

Palette OS plugin: photo → flat sketch → seasonal variations → parts SVG →
sewing pattern → spec. The backend (`backend/api/main.py`) runs the pipeline
itself — vendored copies of the pipeline scripts live under `backend/pipeline/`
and are invoked directly as subprocesses. There is no separate service to run
alongside it; this plugin is self-contained.

Secrets (`ANTHROPIC_API_KEY`, etc.) are read per-request via `ctx.secret(...)`
from Palette's plugin-config system in production, or from
`.palette/.env.local` under `pltt dev`.

## 1. Prerequisites

- Node.js (recent LTS)
- Python 3.12+

## 2. Install dependencies

```bash
npm install
```

Backend runtime deps (`pyproject.toml`) are installed automatically by `pltt`
into its own managed venvs (`.palette/dev/backend-venv` for `pltt dev`,
`.palette/test-venv` for `pltt test`/`pltt preview`/`pltt publish`) — you
don't need to `pip install` anything by hand for normal use.

Only if you're running `ruff` directly against a venv of your own (not via
`pltt`), install the dev lint deps there:

```bash
pip install --group dev .   # from a venv with Python 3.12+, repo root
```

## 3. Configure secrets

```bash
cp .palette/.env.example .palette/.env.local
```

Edit `.palette/.env.local` and set at least `ANTHROPIC_API_KEY` (the sketch/
variation pipeline stages call it directly). `.palette/.env.local` is
gitignored — never commit real keys.

## 4. Run locally

```bash
npx pltt dev
```

Starts the local no-Docker Palette SDK simulator: frontend + backend + a
mocked platform, all in one process, hot-reloading both sides. Open the URL
it prints (default `http://localhost:7321`).

Sanity-check your local setup first if something looks off (Node version,
ports, manifest, entry files, frontend bundling):

```bash
npx pltt doctor
```

## 5. Before publishing

```bash
npx pltt test
```

Runs the full contract check: manifest validity, frontend/backend SDK and
platform compatibility, forbidden platform imports, backend import + route
permission gates, declared permissions, dependency policy, and bundle size.
`pltt preview` and `pltt publish` run this same check first and refuse to
publish if it fails.

**Known gotcha:** `pltt test`'s backend-import check runs inside its own
`.palette/test-venv`, built strictly from `pyproject.toml`'s `dependencies`
list — nothing else. `palette_sdk` (the Palette backend SDK, resolved from
`node_modules/@palettelab/cli/backend-sdk`) itself depends on `sqlalchemy`,
so if it's ever missing from `pyproject.toml` here, every fresh clone hits:

```
ModuleNotFoundError: No module named 'sqlalchemy'
```

on `pltt test` / `pltt preview` / `pltt publish`. It's already listed in
`pyproject.toml` — if this error comes back, check that entry wasn't removed,
or `rm -rf .palette/test-venv` and rerun `pltt test` to force a clean rebuild.

## 6. Publishing

```bash
npx pltt login --env staging --url https://apps-api.pltt.xyz --token pltt_xxxxx
npx pltt preview             # reviewable preview to the sandbox, no version bump needed
npx pltt publish --env staging       # release publish, requires a version bump past the last release
npx pltt publish --env production    # asks for confirmation
```

`capabilities.external_network` in `palette-plugin.json` must list every
external host the pipeline calls (currently `api.anthropic.com`,
`generativelanguage.googleapis.com`) before publishing past local dev.

## 7. Versioning

`package.json`'s `version` is the source of truth. Bump it and propagate to
`palette-plugin.json` and `pyproject.toml` in one step:

```bash
npm version patch --no-git-tag-version   # or minor / major
node scripts/sync-version.mjs
```

`pltt test` / `pltt publish` reject a release publish that doesn't bump
`palette-plugin.json`'s version past the last published release.
