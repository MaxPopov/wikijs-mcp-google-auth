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

## Commit messages: Conventional Commits are load-bearing

Release versions are computed FROM COMMIT MESSAGES. A commit that does not
follow the convention is invisible to the release tooling, so a release that
consists only of such commits never gets proposed.

Prefix every commit subject:

| Prefix | Effect on the next version |
|---|---|
| `fix:` | patch (0.2.0 -> 0.2.1) |
| `feat:` | minor (0.2.0 -> 0.3.0) |
| `feat!:` / `fix!:`, or a `BREAKING CHANGE:` footer | major (0.2.0 -> 1.0.0) |
| `chore:`, `docs:`, `test:`, `refactor:`, `ci:`, `build:` | none — shipped, but does not by itself trigger a release |

The prefix must be on the COMMIT, not only on the PR title: this repo merges
feature branches with merge commits, so the individual commits are what the
tooling reads. (If a PR is squash-merged instead, the PR title becomes the
commit subject and it is the title that must carry the prefix.)

## How releases work (READ THIS BEFORE MERGING TO `main`)

Releases are automatic and **the version is never edited by hand**. Two
workflows split the job:

- `.github/workflows/release-please.yml` (`Release please`) — runs on every
  push to `dev`. Reads the Conventional Commits since the last release and
  keeps a release PR open against `dev`, titled `chore(dev): release X.Y.Z`.
  Merging it bumps the version everywhere, writes `CHANGELOG.md`, and creates
  the `vX.Y.Z` tag + GitHub Release.
- `.github/workflows/release-on-main.yml` (`Release on main`) — runs on every
  push to `main`. Builds the image and pushes it to GHCR under the version in
  `package.json`, skipping itself if that image tag is already published. It
  holds no version logic; it only carries a safety net — if that version has
  no tag yet, it creates the tag + Release after publishing the image.

Neither needs a PAT or any secret — both use the built-in `GITHUB_TOKEN`.

### To cut a release
1. Land the work on `dev` via PRs, with Conventional Commit messages.
2. Merge the open **`chore(dev): release X.Y.Z`** PR into `dev`. This is the
   release decision — everything about the number is already computed.
3. Open a PR **`dev` → `main`** and merge it (merge commit, so history stays
   aligned). The image is built and published.

### Published artifacts
- Image: `ghcr.io/<owner-lowercased>/wikijs-mcp-server:vX.Y.Z` (+ `:latest`).
- Git tag `vX.Y.Z`, a matching GitHub Release, and a `CHANGELOG.md` entry.

### What the version applies to
`release-please-config.json` lists every file carrying the version. Besides
the root `package.json` it updates the three workspace `package.json` files
and — via `x-release-please-version` annotations — the version the MCP server
advertises over the protocol (`packages/mcp-server/src/index.ts` and
`src/mcp.ts`). **If you add another place that hardcodes the version, add it
to `extra-files` in the same PR**, or it will silently go stale.

### Non-obvious rules / gotchas (learned the hard way)
- **No release PR appeared?** Almost always the commits since the last release
  are all `chore:`/`docs:`-class, or carry no prefix at all. That is the
  tooling working as designed, not a failure.
- **The GitHub Release exists before the image does.** The tag and Release are
  created when the release PR merges into `dev`; the image is only built when
  `dev` reaches `main`. Between the two, `docker pull` for that version 404s.
  Do the `dev` → `main` merge promptly after a release PR.
- **A hand-set version still releases.** If `package.json` carries a version
  release-please never tagged — someone edited it, or it predates adopting
  release-please — `Release on main` creates the tag and Release itself, after
  the image. Without that, such a version would ship an image and nothing else.
  This is a safety net, not a second way to release: it writes no CHANGELOG
  entry, so the normal path stays the release PR on `dev`.
- **The tag does not trigger the image build.** A tag created with
  `GITHUB_TOKEN` does not trigger other workflows (GitHub blocks recursive
  triggers), which is exactly why the build hangs off the push to `main`.
- **GHCR paths must be lowercase.** `github.repository_owner` keeps the
  account's original casing (e.g. `MaxPopov`), but Docker/GHCR reject an
  uppercase repository path (`repository name must be lowercase`). The
  workflow lowercases the owner in the `meta` step — do **not** reintroduce a
  raw `ghcr.io/${{ github.repository_owner }}/...` tag.
- **`package-lock.json` lags for the workspace packages.** release-please
  updates the root entry but not the `packages/*` version entries. `npm ci`
  tolerates that (verified), and the next `npm install` resyncs it.
- The workflows need `contents: write` + `pull-requests: write` + `issues:
  write` (release PR, tag, Release, its `autorelease:*` labels) and
  `packages: write` (push the image). These are set in the workflow files.
- If a step fails with **403/permission**:
  - Settings → Actions → General → **Workflow permissions = Read and write**, and/or
  - if a **tag ruleset** protects `v*`, add **GitHub Actions** to its bypass list.
- The GHCR package is **private** by default. To allow anonymous `docker pull`,
  make the package **Public** once in its GHCR package settings. Otherwise
  consumers `docker login ghcr.io` first.

### If a run never starts
**Every** workflow here accepts a manual **Run workflow** from the Actions tab
(`workflow_dispatch`). That matters because a push-triggered run that is never
created — Actions disabled, quota exhausted, an outage — is not retried when
the service comes back, and the triggering push cannot be replayed. Merge a
`dev` → `main` PR while Actions is down and the release simply does not
happen; merge to `dev` and you get no CI verdict on that head at all. Once
Actions is back, dispatch the workflow by hand against the branch instead of
pushing a dummy commit to bait a trigger.

Distinguish this from a run that starts and fails: check the run list. If no
run was *created* for a push, it is this problem, not a broken workflow — the
workflows will still show as `active`.

### If a release run fails
Diagnose from the run logs before touching repo settings — the failure is
usually in the workflow/build, not permissions (e.g. the v0.1.0 casing bug
failed at *Build and push image*, not at tag creation). A failed
`Release on main` produces no image; re-running it after the fix republishes
the same version cleanly, since the build is idempotent.

### After a release: keep branches in sync
Merging a hotfix into `main` leaves `dev` behind. Sync it back with a PR
`main` → `dev` so the branches don't drift. Normal releases do not need this:
the version bump is made on `dev` and flows to `main`, not the other way.


## Local checks before pushing
- `npm ci && npm run build` — typecheck/build.
- `npm run e2e` and the docker e2e stacks
  (`deploy/docker-compose.e2e.yml`) run in CI on pushes to `dev`/`main`; run
  the relevant stack locally when changing auth/MCP/seed code so CI isn't the
  first place a failure shows up.
