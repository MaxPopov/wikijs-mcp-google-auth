# Project rules for AI assistants

Guidance for Claude Code / AI agents working in this repo. Keep it accurate —
if the release workflow or branching model changes, update this file in the
same PR.

## Branching model

- **`dev`** — integration branch. All work lands here first, via PR.
- **`main`** — release branch. It only ever receives merges from `dev`.
  Every push to `main` is a potential release (see below).
- Feature/fix branches → PR into `dev`. Never open day-to-day work PRs
  straight into `main`; the one exception is a release-enabling hotfix to the
  release workflow itself.
- The repo has a ruleset requiring a PR + approving review to merge. Merges are
  done with admin bypass ("Bypass rules and merge") or via the API with an
  admin token.
- A merged branch is finished. Never stack new commits on already-merged
  history — restart the working branch from the latest base
  (`git checkout -B <branch> origin/dev`).

## How releases work (READ THIS BEFORE MERGING TO `main`)

Releases are **fully automatic** via `.github/workflows/release-on-main.yml`
(`Release on main`). There is **no manual tagging** and **no PAT/secret** — it
uses only the built-in `GITHUB_TOKEN`.

### To cut a release
1. On `dev`, **bump `version` in `package.json`** (semver) — this is what
   drives the release. Do it in the PR that closes out the release scope.
2. Open a PR **`dev` → `main`** and merge it (merge commit, so history stays
   aligned).
3. The push to `main` triggers `Release on main`, which:
   - reads `version` from `package.json`;
   - if the tag `vX.Y.Z` does **not** exist yet → builds and pushes the image
     to GHCR, then creates the git tag `vX.Y.Z` **and** a GitHub Release
     (auto-generated notes) in the **same** run;
   - if `vX.Y.Z` already exists (version unchanged) → the run is a **no-op**.

> Why one job does everything: a tag/release created with `GITHUB_TOKEN` does
> not trigger other workflows (GitHub blocks recursive triggers), so a separate
> "build on tag" workflow would never fire.

### Published artifacts
- Image: `ghcr.io/<owner-lowercased>/wikijs-mcp-server:vX.Y.Z` (+ `:latest`).
- Git tag `vX.Y.Z` and a matching GitHub Release.

### Non-obvious rules / gotchas (learned the hard way)
- **GHCR paths must be lowercase.** `github.repository_owner` keeps the
  account's original casing (e.g. `MaxPopov`), but Docker/GHCR reject an
  uppercase repository path (`repository name must be lowercase`). The workflow
  lowercases the owner in the `meta` step — do **not** reintroduce a raw
  `ghcr.io/${{ github.repository_owner }}/...` tag.
- The workflow needs `permissions: contents: write` (tag + Release) and
  `packages: write` (push image). These are set in the workflow file.
- If the **"Create tag and GitHub Release"** step fails with **403/permission**:
  - Settings → Actions → General → **Workflow permissions = Read and write**, and/or
  - if a **tag ruleset** protects `v*`, add **GitHub Actions** to its bypass list.
  (These were **not** needed as of v0.1.0 — current token perms sufficed — but
  this is the first thing to check if tag/release creation starts 403-ing.)
- The GHCR package is **private** by default. To allow anonymous `docker pull`,
  make the package **Public** once in its GHCR package settings. Otherwise
  consumers `docker login ghcr.io` first.

### If a release run fails
Diagnose from the run logs before touching repo settings — the failure is
usually in the workflow/build, not permissions (e.g. the v0.1.0 casing bug
failed at *Build and push image*, not at tag creation). Since a failed run
produces no tag/release, fixing the cause and re-landing on `main` re-runs the
release cleanly for the same version.

### After a release: keep branches in sync
Merging a hotfix into `main` leaves `dev` behind. Sync it back with a PR
`main` → `dev` so the branches don't drift.

## Local checks before pushing
- `npm ci && npm run build` — typecheck/build.
- `npm run e2e` and the docker e2e stacks
  (`deploy/docker-compose.e2e.yml`) run in CI on pushes to `dev`/`main`; run
  the relevant stack locally when changing auth/MCP/seed code so CI isn't the
  first place a failure shows up.
