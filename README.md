# Techpack Studio (Palette plugin)

Thin Palette OS wrapper around the standalone techpack FastAPI service
(`../app.py`): photo → flat sketch → seasonal variations → parts SVG → sewing
pattern. This plugin's backend (`backend/api/main.py`) only proxies requests
to that service over the network declared in `palette-plugin.json`'s
`capabilities.external_network` — it does not run the pipeline itself.

## Setup

```bash
npm install
pip install fastapi httpx sqlalchemy --group dev   # from a venv with Python 3.12+
```

`TECHPACK_API_TOKEN` in this repo's root `.env` (read by `app.py`) must match
this plugin's `TECHPACK_API_TOKEN` secret — set both to the same value.

## Local development

```bash
make dev       # local no-Docker SDK simulator (frontend + backend + mock platform)
make doctor    # Node version, ports, manifest, entry files, frontend bundling
```

`make dev` expects `../app.py` running separately (`uvicorn app:app --reload`
from the repo root) at the host in `.palette/.env.local`'s `TECHPACK_HOST`.

## Before publishing

```bash
make prepublish   # lint + typecheck + pltt test (SDK/permission/manifest checks) + network guard + build
```

`make prepublish` is the gate `make publish-staging` / `make publish-production`
run first. It fails on:

- TypeScript errors (`make typecheck`) — catches SDK-shape misuse that `pltt
  test`'s esbuild bundling step doesn't type-check.
- `ruff` findings (`make ruff`).
- Any `pltt test` failure — manifest validity, frontend/backend SDK and
  platform compatibility, forbidden platform imports, backend route
  permission gates, declared permissions, dependency policy, and bundle size.
- `capabilities.external_network` still containing the scaffold's
  `YOUR-TECHPACK-HOST.example` placeholder (`make guard-network`) — replace it
  with `app.py`'s real public host before publishing past local dev.

Run `make help` for the full target list.

## Versioning

`package.json`'s `version` is the source of truth. Bump it and propagate to
`palette-plugin.json` and `pyproject.toml` in one step:

```bash
make bump-patch   # or bump-minor / bump-major
```

`pltt test` / `pltt publish` reject a release publish that doesn't bump
`palette-plugin.json`'s version past the last published release.

## Publishing

```bash
npx pltt login --env staging --url https://apps-api.pltt.xyz --token pltt_xxxxx
make publish-staging       # preview publish, env=staging
make publish-production    # release publish, asks for confirmation
```

The staging URL is the Palette platform's own backend/API origin (must serve
`/api/v1/*`), not `app.py`'s host.
