# Contributing to Gridl

The data core lives in `crates/gridl-core` and does not depend on Tauri. The desktop shell in `crates/gridl-desktop` adapts IPC, windows, and the system keychain. A new engine implements the `DatabaseDriver` trait.

## Branches

- `master`: stable. Releases are cut from here. It only accepts pull requests from `develop` (or an urgent `hotfix/…`), with CI passing.
- `develop`: integration and testing. Work branches are merged here through pull requests.
- Work branches, always from `develop`: `feat/…` for features, `fix/…` for bugs, `chore/…` for maintenance, `docs/…` for documentation.

```bash
git switch develop && git pull
git switch -c feat/excel-import
# … commits …
git push -u origin feat/excel-import
gh pr create --base develop
```

Nobody pushes directly to `master` or `develop`, and neither can be deleted or rewritten.

## Releasing

1. Open a PR from `develop` to `master` with the version already bumped (see [Releasing](README.md#releasing)).
2. Once CI passes and it is merged, create the `vX.Y.Z` tag on `master`. Only administrators can create `v*` tags.

## Before opening a pull request

```bash
pnpm install
cargo fmt --all
pnpm check
```

`pnpm check` runs formatting, clippy, the Rust tests, lint, the frontend tests (Vitest), and TypeScript. For the tests against real PostgreSQL and MySQL servers, see [Tests](README.md#tests) in the README.

The per-environment safety rules (`crates/gridl-core/src/guard.rs`) are enforced in the backend. Any new command that runs user SQL must go through `guard()` in `crates/gridl-desktop/src/commands.rs`.

Never store passwords in `ConnectionConfig`, in logs, or in the profiles JSON. Secrets go into the system keychain or live in memory only for the session.

Documentation and code comments are in English.

## Interface text

Gridl speaks English and Spanish and follows the system language: Spanish when the first preferred language starts with `es`, English otherwise. Never hard-code a visible string, and never decide behavior by matching translated text; use an error code (`CodedError` in `frontend/src/lib/errors.ts`, `CoreError` variants in Rust) instead.

- **Frontend:** add the key to both `frontend/src/locales/en.ts` and `frontend/src/locales/es.ts`, then use `t("area.key", { name })` from `frontend/src/lib/i18n.ts`. `es.ts` is typed against the keys of `en.ts`, so a missing translation fails `tsc`, and a test checks both have the same placeholders. Counts use a `.one` / `.other` pair and `plural("area.key", count)`. Format numbers and dates with `formatNumber`, `formatDate`, and `formatTime`, never with a fixed locale.
- **Backend:** write both texts where the message is raised, with `gridl_core::tr!("English {value}", "Español {value}")`. Set `GRIDL_LANG=en` or `GRIDL_LANG=es` to force the backend language. Tests that check wording pick the language with `gridl_core::with_locale`, so they pass on any machine.

Keep English short and follow macOS conventions: title case for menu items ("Open in New Window", "Check for Updates…"), sentence case for labels and messages.
