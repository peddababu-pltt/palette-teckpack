\
# Techpack Studio (Palette plugin) — dev, compatibility, and publish flow.
# `pltt` runs via node_modules/.bin so nothing needs a global npm install.
# `pltt dev`/`pltt test`/`pltt preview`/`pltt publish` manage their own
# Python venvs (.palette/dev/backend-venv, .palette/test-venv) automatically.
# Only `make ruff`/`make install` need a venv of your own activated first.

SHELL := /bin/bash
.DEFAULT_GOAL := help
PLTT := npx --no-install pltt
ENV ?= staging

.PHONY: help install doctor dev typecheck ruff lint \
        contract-test guard-network build package \
        prepublish bump-patch bump-minor bump-major \
        preview publish-staging publish-production clean

help: ## Show this list
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

install: ## Install frontend (npm) deps and backend (pip) lint/runtime deps
	npm install
	pip install --group dev .

doctor: ## Check local tooling: Node version, ports, manifest, entries, bundling
	$(PLTT) doctor

dev: ## Run the local no-Docker SDK simulator
	$(PLTT) dev

typecheck: ## TypeScript check for the frontend (catches SDK-shape bugs pltt test misses)
	npx tsc --noEmit

ruff: ## Python lint for the backend proxy
	python3 -m ruff check backend

lint: typecheck ruff ## Run all linters/typecheckers

contract-test: ## Manifest, SDK/platform compatibility, permission-grant, and bundling checks
	$(PLTT) test

guard-network: ## Fail if capabilities.external_network still has the template placeholder
	@if grep -q 'YOUR-TECHPACK-HOST.example' palette-plugin.json; then \
		echo "guard-network: palette-plugin.json capabilities.external_network still has the placeholder host — set app.py's real public host before publishing" >&2; \
		exit 1; \
	fi

build: ## Validate manifest + entry files, lint migrations
	$(PLTT) build

package: ## Bundle into dist/<id>-<version>.tar.gz without uploading
	$(PLTT) package

prepublish: lint contract-test guard-network build ## Full gate: lint + grants/compat check + network guard + build
	@echo "prepublish: all checks passed"

bump-patch: ## Bump patch version across package.json, palette-plugin.json, pyproject.toml
	npm version patch --no-git-tag-version
	node scripts/sync-version.mjs

bump-minor: ## Bump minor version across all three manifests
	npm version minor --no-git-tag-version
	node scripts/sync-version.mjs

bump-major: ## Bump major version across all three manifests
	npm version major --no-git-tag-version
	node scripts/sync-version.mjs

# Decoupled from `prepublish` on purpose: run `make prepublish` yourself first,
# then `make preview` — `pltt publish --preview` still runs its own internal
# preflight (`pltt test --publish-type preview`), but not lint/typecheck/guard-network.
preview: ## Preview-type publish to staging: fast, skips the release semver-bump check
	$(PLTT) publish --env staging --preview

publish-staging: prepublish ## Release-type publish to staging (requires a version bump past the last release)
	$(PLTT) publish --env staging

publish-production: prepublish ## Release-type publish to production (asks for confirmation)
	$(PLTT) publish --env production

clean: ## Remove build artifacts and caches
	rm -rf dist .palette/dev/__pycache__ backend/api/__pycache__
