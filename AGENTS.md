# Agent Instructions for this Obsidian plugin template

## Task scope and validation

Cache exact instructions per checkout/task; read guides only for changed areas.
Restore only missing/changed sections after compaction.
- Docs/instructions-only: text/link/format checks, not application tests/builds,
  browsers, installs or consumer sweeps. This qualifies completion gates below.
- Publication-only: reuse green checks/artifacts for unchanged code, dependencies,
  build inputs AND linked commons; validate unchecked pending source once.
- Source changes: targeted iteration tests, required final checks once; reuse
  composite steps and verify their bundle rather than rebundling.
Keep fresh Git branch/identity/message/hook checks and final remote-tip verification.

## Shared library: commons

Use commons for workspace/window/tab/focus, per-window timers/clipboard, modal,
search, geometry, page-color and line-flash helpers; never duplicate its
undocumented Obsidian adapters in plugin code. For an owned-area change, consult
the installed module exports and relevant commons guide sections. Change commons
with a regression test if needed, never a local copy. Docs/publication-only work
does not require opening the library or rebuilding its consumers.
Local adoption uses file:../obsidian-commons; obey the library's existing
commons-adoption branch and explicit-ref/tag-disabled publication rules.

<!-- BEGIN SUITE IMPACT -->
## Suite impact

Before and after source or contract changes, run
`node ../obsidian-commons/scripts/inventory.mjs impact`. Read only the listed required contract peers and
same-surface symmetry candidates; do not scan every sibling repository. Run
their configured checks only when the report or changed contract requires them.

Run `node ../obsidian-commons/scripts/inventory.mjs release-check` before source release. The report
distinguishes a valid bundled runtime artifact from reproducible source
dependencies. If the project declares a shared-package link, pin an immutable
tag/commit before release and pass the check again.

Run `node ../obsidian-commons/scripts/inventory.mjs community-review <project|all>` for the Obsidian
community-rule lint gate. This command runs only each selected repository's
local `npm run lint:community-review`; a consumer check/build must never start a
suite traversal. Standalone browser userscripts are outside the Obsidian
runtime profile and remain under the repository's normal lint rules.

For manual repository maintenance, run `node ../obsidian-commons/scripts/inventory.mjs bot-prs
<project...>` and `node ../obsidian-commons/scripts/inventory.mjs maintain <project...>`. They default to
dry-run; add `--apply` only to approve/update eligible bot PRs and synchronized
rule dependencies. `maintain` implicitly adds commons for any Obsidian review
target; positional `all` selects the entire inventory.
<!-- END SUITE IMPACT -->
Before and after source or contract changes, run
`node ../obsidian-commons/scripts/inventory.mjs impact`. Read only the listed
required contract peers and same-surface symmetry candidates; do not scan every
sibling repository. Run their configured checks only when the report or changed
contract requires them.

`file:../obsidian-commons` is valid local build input because esbuild bundles
imported commons source into `main.js`. Before source release, pin an immutable
commons tag/commit and pass
`node ../obsidian-commons/scripts/inventory.mjs release-check`.

## PDF/search safety

For PDF adapters/controllers, scroll geometry or monkey-patches, read relevant
sections of [the regression guide](docs/AGENT-REGRESSIONS.md) and cited tests.
The full risks/examples are preserved verbatim. Keep native PDF.js find, instance-
scoped restored patches, canonical match selectors, suppression windows, no
currentPageNumber steering, match-element geometry, deferred steering queues and
8px outline padding. Prove scrolling with realistic rects/deltas, not state-only
assertions. Preserve per-window cleanup/refocus, quiet debug defaults and the
incremental-search manifest id. Do not reintroduce dead custom PDF search paths.

## Build verification rule

For changed source/build inputs, use the package's fast bundler only during an
actual runtime iteration. At completion, run its production build and required
unit tests once; skip steps already included in the composite build. Record the
build start and verify root main.js is newer and contains a unique changed
literal via the repository verifier or a line-length-safe Node check, not grep
for minified names. Reuse unchanged evidence for docs/publication-only follow-ups.
Never search for a vault, change its link or build/copy from another checkout.

## Tooling

- Lint: `npm run lint` (ESLint with `eslint-plugin-obsidianmd` rules, zero warnings).
- Type-check + bundle: `npm run build`.
- Unit tests: `npm run test:run` (Vitest). `obsidian` resolves to a mock in
  `tests/__mocks__/obsidian.ts`.
- Browser tests: `npm run test:browser` (Playwright, requires
  `npx playwright install chromium`).

## Native Obsidian APIs

Prefer fileManager.processFrontMatter, metadataCache.getFileCache (remove
frontmatter.position before copying), vault.cachedRead/process, native createEl
and SuggestModal/FuzzySuggestModal over custom YAML/I/O/DOM/pickers. Use the
installed obsidian.d.ts for new/uncertain API signatures, not a full rescan for
already verified calls. Keep esbuild/sample-plugin structure, theme variables and
unload cleanup. Bootstrap official scaffolding/types only in a confirmed blank repo.
