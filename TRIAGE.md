# Triage — How Sonic Web bugs land

> **Purpose of this document:** make the bug-handling workflow predictable so the community knows what to expect, and so duplicate / known issues don't drown out the real ones.

This is a beta. We respond fast to issues that come with a clear repro and we close known-issues quickly with a pointer to the right place. The two things together are how a small project keeps an inbox sane.

---

## When you file a bug

The [bug template](./.github/ISSUE_TEMPLATE/bug_report.yml) has two pre-flight checkboxes you must tick:

1. **You've checked [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).** Most "audio sounds wrong" reports are already documented there (gain deficit, FX parity tier, env_curve quirk). If your bug matches a known issue, please add a 👍 reaction to the related issue rather than filing a new one — that's how we prioritize which known issues need a fix sooner.
2. **You've searched open issues for a duplicate.** Even a 30-second keyword search saves us the round-trip.

The template also asks for: **version, browser, OS, code that triggered the bug, expected behaviour, severity, and (for audio bugs) a WAV attachment** from the in-app ⏺ Rec button. Audio bugs reproduce ~10× faster when we can hear what you heard.

---

## Severity ladder + response-time guide

We use a 5-tier priority label that maps to how fast we look at the issue. Beta-mode timeframes:

| Label | Meaning | Examples | Target response |
|-------|---------|----------|-----------------|
| **P0** | Blocking — core functionality broken | App won't load, Run produces no sound at all, hot-swap corrupts state for everyone | Same day, hot-fix branch |
| **P1** | Significant — common path broken, no workaround | A specific common DSL function errors, FX silently drops audio for everyone, MIDI out fails on Chrome | Within a few days |
| **P2** | Significant — workaround exists OR niche path broken | One specific FX sounds off, an obscure DSL helper missing, browser-specific quirk with workaround | Within a week or two |
| **P3** | Annoyance — works but not as expected | Off-by-one in a help string, minor visual inconsistency, comparator tooling drift | Batched into a follow-up PR |
| **P4** | Future / nice-to-have | "Could you add X feature", performance ideas, distant DSL gaps | Tracked in the project board, no commitment |

**Reality check:** this is a small project. Beta means we triage quickly and may push things back for capacity reasons. We'll always tell you what bucket your bug is in within a few days; we won't ghost you. If a bug is sitting unread for >7 days, ping the issue and someone will respond.

---

## Label scheme

| Label | Used when |
|-------|-----------|
| `bug` | Issue is a bug (default for the bug template) |
| `enhancement` | Feature / DSL gap (default for the dsl_gap and feature_request templates) |
| `needs-triage` | Awaiting first look — applied automatically by the bug template |
| `needs-repro` | We can't reproduce yet; waiting on more info from the reporter |
| `confirmed` | We've reproduced the bug and accept it as real |
| `known-issue` | Documented in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) — closed with a link |
| `upstream` | Root cause is in supersonic-scsynth / scsynth WASM / esm.sh — we may track it but can't fix it directly |
| `area: audio` | Sound generation, FX, mixer, gain staging |
| `area: scheduler` | Virtual-time scheduler, sleep, sync, hot-swap, live_loop lifecycle |
| `area: transpiler` | Ruby → JS lowering (TreeSitter, sandbox, scope) |
| `area: ui` | Editor, toolbar, sample browser, console, scope, preferences |
| `area: midi` | Web MIDI input/output |
| `area: tooling` | Capture tool, comparator, fx-sweep, inspector, regression nets |
| `P0` … `P4` | Severity, see ladder above |

A typical issue ends up with 2–4 labels: one bug/enhancement, one priority, one or two area tags.

---

## Workflow we follow on every issue

### 1. First touch (within 1–3 days)

A maintainer reads the issue, removes `needs-triage`, and either:

- **Applies a priority + area label and sets a milestone** — we'll work on it.
- **Adds `needs-repro` and asks one targeted question** — usually "Can you share the exact buffer URL?" or "Does this happen on a fresh tab too?".
- **Adds `known-issue` and closes with a link** to the relevant `KNOWN_ISSUES.md` section. Not dismissive — that document tracks things we've consciously deferred. Add 👍 to the linked issue if you want to bump priority on a known one.
- **Adds `upstream` and either tracks or closes** depending on whether there's anything we can do on our side.

### 2. Repro lock-in

For non-trivial bugs we write a Playwright + WAV-analysis reproducer first, then fix. The four hot-swap bugs in PR #283 (SP78–SP81) all came in as user reports, became scripts in `tools/test-update-*.ts`, and the scripts are now permanent regression nets. **If a bug is interesting enough to fix once, it's worth pinning so it doesn't come back.** This pattern is why we ask for exact code + WAV — it's literally what feeds the reproducer.

### 3. Fix + atomic commit

We follow [AnviDev workflow](./CLAUDE.md): one issue → one branch → one focused commit (or a small chain) → PR with `closes #N` → reviewer feedback → merge.

Commits use gitmoji + a Problem/Fix body so the git log reads like a changelog. Example: see [`6df8dbe`](https://github.com/MrityunjayBhardwaj/SonicWeb/commit/6df8dbe) (drain scsynth queue on Stop).

### 4. Verify + close

For audio bugs we don't trust the event log — we capture a fresh WAV and analyse it. "Tests pass" is necessary but not sufficient; the audio is the truth. (See `tools/capture.ts` and `tools/spectrogram-compare.py` for what that looks like.)

We close with a comment naming the merge commit + the version it ships in. If the fix is on a release branch, you'll see the version tag too.

---

## What makes a bug land fast

Things that move a bug straight to **P0/P1 + same-week fix**:

1. **Exact code** that triggers it — preferably a buffer URL the editor encoded for you.
2. **Step-by-step repro** ("press Run, wait 3 seconds, press Update") that we can follow in a stock browser.
3. **A WAV** if the bug is audible — the in-app Rec button outputs raw float32 with no codec damage.
4. **Browser + version + OS** in the template — many bugs are browser-specific (the recorder Firefox bug, for instance).
5. **Whether it works in desktop Sonic Pi** — tells us if the bug is a parity gap or a regression we introduced.

Things that slow a bug down or get it `needs-repro`:

- "It doesn't work" with no code attached.
- A 200-line composition where any of 12 statements could be the trigger — please minimise to the smallest snippet that still reproduces.
- "Audio sounds bad" with no WAV — we can't hear what your speakers + Bluetooth + room sound like.
- Screenshots of the console without the actual error text — the text is searchable, the screenshot isn't.

---

## What we do NOT triage

- **Bugs in desktop Sonic Pi.** File those at <https://github.com/sonic-pi-net/sonic-pi> — we are not them.
- **Bugs in upstream supersonic-scsynth / scsynth WASM** — we may add a note to the relevant tracking issue but the fix has to land upstream.
- **Browser-engine bugs** — if Firefox's Web MIDI doesn't enumerate your device, that's Firefox, not us. We can sometimes work around them (we did for the Recorder MIME issue).

---

## Disclosure & security

If you find something that could be a security issue (XSS via shared buffer URL, prototype pollution via custom samples, etc.), **do not file a public issue**. Email the maintainer directly — the address is in `package.json` — and we'll work with you on a private fix + disclosure. We're a small project, but we take this seriously.

---

## Roadmap visibility

The active milestone work lives on the [SonicWeb Roadmap](https://github.com/users/MrityunjayBhardwaj/projects) board. The board's columns are the source of truth for "what's actually being worked on right now" — labels alone aren't enough to tell you that. Anything outside the active milestone is best-effort.

---

## Communication norms

- Be patient. Beta means small team, big surface area.
- Be specific. "X is broken" + repro >> "X seems weird".
- Be kind. We're trying to bring Sonic Pi to the browser as a first-of-its-kind thing; we're going to miss things, and we depend on you to find them.

Thank you for filing bugs. Genuinely — this is how a beta becomes a v1.0.
