# Obsidian Plugin Template

[![Build](https://github.com/notuntoward/obsidian-plugin-template/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/obsidian-plugin-template/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/obsidian-plugin-template/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/obsidian-plugin-template/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/obsidian-plugin-template/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/obsidian-plugin-template/actions/workflows/scorecard.yml)

A starting point for a new Obsidian plugin that ships with the same automated
code-quality checks as a mature plugin: ESLint, Prettier, TypeScript type
checking, unit tests (Vitest), browser tests (Playwright), CodeQL static
analysis, OpenSSF Scorecard, Dependabot, and a release workflow.

This template contains **no plugin logic** — only the tooling and a minimal
`src/main.ts` skeleton. Replace it with your own code.

## Use this template

1. Click **Use this template → Create a new repository** on GitHub.
2. Update the per-plugin placeholders (account-level values are already filled in):
   - `manifest.json`: `id`, `name`, `description` (`author`/`authorUrl` are pre-filled with your account).
   - `package.json`: `name`, `description` (`author` is pre-filled).
   - `README.md` / `SECURITY.md`: update the repo name in the URLs (the account is pre-filled).
   - `.github/enable-branch-protection.ps1`: `$REPO` (and `$OWNER` only if different).
3. Install dependencies: `npm install`
4. Start developing: `npm run dev`

## What's checked

| Check | How | Runs on |
| --- | --- | --- |
| Lint (ESLint + obsidianmd rules) | `npm run lint` | every push/PR |
| Type check (tsc) + bundle (esbuild) | `npm run build` | every push/PR |
| Unit tests (Vitest) | `npm run test:run` | your CI / local |
| Browser tests (Playwright) | `npm run test:browser` | local (after `npx playwright install chromium`) |
| CodeQL (SAST) | `codeql.yml` | push/PR + weekly |
| OpenSSF Scorecard | `scorecard.yml` | push/PR + weekly |
| Dependency updates | Dependabot | weekly |
| Release build | `release.yml` | on version tags |

Branch protection that satisfies Scorecard's "Branch-Protection" check can be
enabled with:

```powershell
pwsh .github/enable-branch-protection.ps1
```

## Scripts

- `npm run dev` — watch and rebuild `main.js` with esbuild.
- `npm run lint` — ESLint with zero-warning policy.
- `npm run build` — lint + type-check + production bundle.
- `npm run format` — Prettier write over `src`.
- `npm run test:run` — Vitest unit/integration suite.
- `npm run test:browser` — Playwright browser regression suite.

## Releasing

1. Bump the version: `npm version patch` (or `minor`/`major`). This updates
   `manifest.json` and `versions.json` via `version-bump.mjs`.
2. Push the tag: `git push && git push --tags`. The `release.yml` workflow
   builds the plugin and drafts a GitHub release containing `main.js`,
   `manifest.json`, and `styles.css`.
