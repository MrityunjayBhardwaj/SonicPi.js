# Release Runbook

This document is the sole source of truth for cutting a SonicPi.js release. Follow it top-to-bottom. Every step is observable — don't trust that commands "worked," verify what the consumer actually sees.

Full rationale for the criteria below lives in dharana §10 (Release Engineering Boundary) — this file is the executable procedure, the dharana entry is the theory.

---

## The non-negotiables

1. **One version string, all surfaces.** `package.json`, `src/app/version.ts`, git tag, GitHub release title, CHANGELOG header, npm dist-tag target — all identical. No "human-friendly" renaming (`beta 1` in copy while `package.json` says `beta.0`). That drift IS the silent failure this runbook prevents.
2. **Prereleases publish with `--tag beta` or `--tag next`. Never bare `npm publish` on a prerelease version.** Default behavior silently promotes the prerelease to `latest`, breaking every existing installer of the stable line.
3. **No force push on `main`, ever. No `--no-verify` on release commits.** Release commits must pass CI before merge.

---

## Version string convention

Follow semver prerelease suffixes, zero-indexed:

```
alpha cycle:  1.N.0-alpha.0 → 1.N.0-alpha.1 → ...
beta cycle:   1.N.0-beta.0  → 1.N.0-beta.1  → ...
rc cycle:     1.N.0-rc.0    → 1.N.0-rc.1    → ...
stable:       1.N.0
patch:        1.N.1, 1.N.2, ...
```

**First beta = `.0`. First RC = `.0`. Same string everywhere.**

---

## Release cycle transition criteria

Derived from dharana §10 (Release Engineering Boundary). All criteria below are observable Lokāyata gates — things you can measure, not things you feel.

### Beta → RC — ALL FOUR must hold
1. **Curve flat:** zero new bugs reported in the last 2 consecutive beta cycles
2. **Severity clear:** zero P0 and zero P1 bugs in the open issue list
3. **No pending architectural changes:** no open refactors in flight
4. **Real-world suite green:** the 56-composition test corpus still passes 100% in Chromium capture

### RC → stable — ALL THREE must hold
1. **RC clean window:** at least one full RC cycle with zero P0/P1 bug reports from community use
2. **Minimum time on clock:** at least 1 week of community exposure on the RC
3. **Zero code change from last RC to stable:** the stable release is a version bump + retag of the RC commit

### Upper bound (escape hatch)
- Soft ceiling: ~3-5 betas is normal
- Hard signal: if cutting beta.6+ and bug discovery rate has NOT decelerated, STOP. The problem is structural, not release-process. Return to diagnosis, restart from alpha if needed.

### Regression path
- RC breaks → RC.N+1 (not stable)
- Multiple P0s at RC → back to beta.N+1
- Structural problem surfaces → back to alpha

---

## Prerelease procedure (`1.X.Y-beta.N` or `1.X.Y-rc.N`)

### 1. Cut the release branch
```bash
git checkout main
git pull origin main
git checkout -b chore/v1.X.Y-beta.N
```

### 2. Update ALL version surfaces in a single commit
Edit each of these to the new version string (same literal string in all five):
- [ ] `package.json` → `"version": "1.X.Y-beta.N"`
- [ ] `src/app/version.ts` → `export const APP_VERSION = '1.X.Y-beta.N'`
- [ ] `CHANGELOG.md` → add `## v1.X.Y-beta.N` section at top with bugfix list
- [ ] `ROADMAP.md` → update the Released table row if applicable
- [ ] `README.md` → update if the version is referenced inline (usually not)

Composition pair (dharana §10): `package.json` and `src/app/version.ts` MUST change in the same commit. If the diff shows only one, the UI footer will lie.

### 3. Verify locally
```bash
npx tsc --noEmit             # zero errors
npx vitest run               # all tests pass, including version composition pair
npm run build:single         # production single-file app build succeeds
npm run build:lib            # library bundle (ESM + CJS) build succeeds
npx tsx tools/capture.ts "play 60; sleep 0.5; sample :bd_haus"
#                            ^ smoke test — inspect .captures/*.md for issues
```

The vitest run includes `src/app/__tests__/version.test.ts` which enforces the `package.json` ↔ `src/app/version.ts` composition pair from dharana §10. If you bumped one file and forgot the other, this test fails immediately. Do not skip it, do not `--no-verify` around it.

Both build commands must be run — `build:single` produces the sonicpi.cc deploy artifact, `build:lib` produces the npm package. A release that passes one but not the other ships a broken half-product.

### 4. Commit and push
```bash
git add package.json src/app/version.ts CHANGELOG.md ROADMAP.md
git commit -m "🚀 chore(release): v1.X.Y-beta.N

$(cat <<'EOF'
Problem: [short context for why this release is being cut]
Fix: Bump version across package.json, src/app/version.ts, CHANGELOG,
     ROADMAP in lockstep. Beta publishes with --tag beta to protect latest.
EOF
)"
git push -u origin chore/v1.X.Y-beta.N
```

Gitmoji convention used in this repo: `🐛 fix:`, `📝 docs:`, `⬆️ chore:`, `♻️ refactor:`. Release commits use `🚀 chore(release):` to pair a rocket with the existing `chore:` convention.

### 5. Open PR, wait for CI
```bash
gh pr create --title "🚀 release: v1.X.Y-beta.N" --body "Release notes in CHANGELOG.md"
```
CI must go green before merge. **Never `--no-verify`.**

### 6. Merge to main
```bash
gh pr merge --squash --delete-branch
git checkout main
git pull origin main
```

### 7. Update the ROADMAP Prereleases table
In the same release PR (or a follow-up before step 8), add the new row to `ROADMAP.md`'s **Prereleases** table. Convention:

- **Cutting a new beta (beta.N where N > 0):** replace the existing `beta.(N-1)` row in place. Only the current prerelease is shown in the table. Old beta entries are preserved in `CHANGELOG.md` — that's the permanent history.
- **Cutting an RC from a beta:** replace the beta row with the RC row.
- **Cutting stable from an RC:** remove the RC row from Prereleases, add the new stable to the **Stable releases** table.
- **Cutting an entirely new prerelease line while a stable is current:** add a new row (multiple prereleases of the same version won't coexist, so this is rare).

The Prereleases table is a "what's cookin' right now" view. The Stable releases table is the permanent history.

### 8. Tag the release commit
```bash
git tag -a v1.X.Y-beta.N -m "v1.X.Y-beta.N"
git push origin v1.X.Y-beta.N
```

### 9. Extract per-release notes for the GitHub release
`CHANGELOG.md` contains ALL versions back to v1.0.0. Using `gh release create --notes-file CHANGELOG.md` would dump the entire changelog into a single GitHub release — wrong. Extract just the current version's section into a temp file:

```bash
# Extracts from '## v1.X.Y-beta.N' up to the next '## ' header (exclusive)
awk '/^## v1\.X\.Y-beta\.N/{flag=1; next} /^## v/{flag=0} flag' CHANGELOG.md > /tmp/release-notes.md

# Verify the extraction is non-empty and sane before using it
cat /tmp/release-notes.md | head -5
wc -l /tmp/release-notes.md
```

Replace `1.X.Y-beta.N` with the literal version. If awk doesn't match, the CHANGELOG header format drifted and you need to fix the regex.

### 10. Cut the GitHub release (triggers automated npm publish)
```bash
gh release create v1.X.Y-beta.N \
  --title "v1.X.Y-beta.N" \
  --notes-file /tmp/release-notes.md \
  --prerelease                            # <-- mark as prerelease
```

**This fires `.github/workflows/publish.yml` automatically.** The workflow:
1. Runs tsc + vitest + `build:lib`
2. Runs `npm pack --dry-run` to surface what will be shipped
3. Detects `github.event.release.prerelease` and runs `npm publish --access public --tag beta` (prereleases) OR `npm publish --access public` (stable)
4. Sleeps 10s for npm registry propagation
5. Verifies `npm view @mjayb/sonicpijs@beta version` matches the tagged version — fails the workflow if not

**DO NOT manually run `npm publish`.** The CI workflow owns the publish boundary. Manual publishing conflicts with the automation (npm rejects republishing the same version) and bypasses the verification steps. If you need to publish from your local machine (disaster recovery only), see the "Recovery" section below.

### 11. Watch the publish.yml workflow run
```bash
gh run watch  # or gh run list then gh run view <id>
```

Wait for all steps green. Pay special attention to the "Verify dist-tags match expectation" step — if it fails, the release is in a bad state (dist-tag points to the wrong version, or registry propagation was slow).

### 12. Verify what npm actually serves (redundant but cheap)
```bash
npm view @mjayb/sonicpijs dist-tags
# Expected output for a beta release:
#   { latest: '1.X.(Y-1)', beta: '1.X.Y-beta.N' }
#
# Expected output for a stable release:
#   { latest: '1.X.Y', beta: '1.X.Y-rc.M' }  # or whatever the last prerelease was
```
**If `latest` moved on a prerelease, STOP and fix.** Recovery: `npm dist-tag add @mjayb/sonicpijs@<previous-stable> latest`.

### 13. Verify sonicpi.cc deploy
- Open sonicpi.cc in a fresh **incognito** window (your normal browser may serve a cached build)
- Read the version label in the top-right of the menu bar
- It MUST display `v1.X.Y-beta.N`
- If the old version shows:
  1. Check `deploy.yml` workflow run on main — if failed, read the logs
  2. Check Vercel project deployments page — may need to manually redeploy
  3. Check Vercel edge cache — may need manual purge
  4. If cache is the issue, wait 5-10 minutes; Vercel usually propagates within that window

### 14. Announcement (deferred to a separate step — NOT in this runbook)
- For betas: forum post at in-thread.sonic-pi.net + optional Sam Aaron courtesy message
- For stable: forum post + README update + social

Drafts for these live in `~/.anvideck/projects/sonicPiWeb/drafts/` (outside the repo).

---

## Recovery procedures

### If CI publish failed mid-flight
If `publish.yml` ran `npm publish` successfully but the dist-tag verification step failed (e.g., slow propagation), the package IS published but the verification didn't confirm it. Manually verify with `npm view @mjayb/sonicpijs dist-tags`. If correct, ignore the CI failure. If wrong, use dist-tag recovery below.

### Prerelease accidentally became `latest`
```bash
npm dist-tag add @mjayb/sonicpijs@<previous-stable> latest
npm dist-tag add @mjayb/sonicpijs@<new-prerelease> beta
```
Replace the placeholders with actual versions. This reassigns tags without republishing. Then file a post-mortem — this shouldn't happen with the current `publish.yml` but if it does, investigate the workflow logs.

### CI workflow needs to be bypassed (disaster only)
If `publish.yml` is broken and you need to publish manually from your local machine, use:
```bash
npm run build:lib
npm publish --access public --tag beta    # for prereleases
# OR
npm publish --access public                # for stable
npm view @mjayb/sonicpijs dist-tags        # verify
```
Then immediately fix `publish.yml` and commit the fix. This path should be used at most once per incident.

---

## Stable release procedure (`1.X.Y`)

Same as prerelease, with three changes:

1. **Version string has no suffix** (e.g., `1.5.0`, not `1.5.0-rc.N`)
2. **`npm publish` runs WITHOUT `--tag`** — default `latest` is what you want for stable
3. **GitHub release is NOT marked `--prerelease`**

**Critical: zero code change from the last RC.** If you change any code between the last clean RC and the stable release, it's RC.N+1, not stable. The stable release is a retag of the RC commit with a new version string. Preserve the test evidence.

---

## Patch release (`1.X.Y+1`)

For critical fixes on a released stable line:

1. Cut a branch from the last stable tag: `git checkout -b fix/critical v1.X.Y`
2. Cherry-pick the fix commits
3. Bump version in `package.json` and `src/app/version.ts` to `1.X.Y+1`
4. Add CHANGELOG entry
5. PR, merge, tag, publish (with default `latest` tag for patch on stable line)

---

## Checklist — paste this into the release PR description

```
Release: v1.X.Y-beta.N

Source-of-truth sync (dharana §10 composition pair, enforced by
src/app/__tests__/version.test.ts):
- [ ] package.json version
- [ ] src/app/version.ts APP_VERSION
- [ ] CHANGELOG.md header with full per-release notes
- [ ] ROADMAP.md Prereleases table row (replace existing prerelease row)

Pre-merge verification (runs locally AND in CI):
- [ ] npx tsc --noEmit — zero errors
- [ ] npx vitest run — all tests pass, including version.test.ts
- [ ] npm run build:single — app build succeeds
- [ ] npm run build:lib — library build succeeds
- [ ] npx tsx tools/capture.ts smoke test — clean
- [ ] PR CI green

Post-merge (after this PR is squash-merged to main):
- [ ] Tag pushed: git tag -a v1.X.Y-beta.N && git push --tags
- [ ] Release notes extracted from CHANGELOG.md to /tmp/release-notes.md
- [ ] gh release create --prerelease (triggers publish.yml automatically)
- [ ] publish.yml workflow watched to completion, all steps green
- [ ] Post-publish dist-tag check: npm view @mjayb/sonicpijs dist-tags
      (latest unchanged, beta points to new version)
- [ ] sonicpi.cc incognito check — menu bar footer shows new version
- [ ] Announcement (separate step — drafts in ~/.anvideck/.../drafts/)
```

---

## Known gaps in this runbook (TODO)

- [ ] Script to extract per-version CHANGELOG sections automatically (currently awk one-liner)
- [ ] Automated check that `v${package.json.version}` matches the git tag being pushed (currently manual)
- [ ] Second Vercel deploy target for `beta.sonicpi.cc` — deferred until after v1.5.0 stable (dharana §10 Distribution Channels subsection)
- [ ] Rollback automation for "prerelease accidentally became latest" — currently manual dist-tag reassignment
