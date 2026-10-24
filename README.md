# Gridl

A desktop database client that looks and feels like a macOS app. It works with **PostgreSQL**, **MySQL / MariaDB**, and **SQLite**. The UI runs on Tauri 2 and the data engine is a standalone Rust crate, with no Electron: the app weighs about 20 MB and uses a fraction of the memory of Electron or Java based clients.

Gridl is available in English and Spanish and follows the system language.

- [Install](#install)
- [Getting started](#getting-started)
- [Features](#features)
- [Per-environment safety](#per-environment-safety)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Where data is stored](#where-data-is-stored)
- [Development](#development)
- [Releasing](#releasing)
- [Architecture](#architecture)

## Install

### macOS (recommended)

Paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mfsa93/Gridl/master/install.sh | sh
```

The script finds the latest version in the [GitHub releases](https://github.com/mfsa93/Gridl/releases), downloads the `.dmg`, copies Gridl to Applications, and opens it. The app is universal: it runs on Apple Silicon and Intel Macs.

Options:

| Variable | Effect |
|---|---|
| `GRIDL_TARGET=~/Applications` | Installs into your home folder, without an administrator password. |
| `GRIDL_VERSION=v0.2.0` | Installs a specific version instead of the latest. |
| `GRIDL_NO_OPEN=1` | Does not open Gridl when done. |

Example: `curl -fsSL https://raw.githubusercontent.com/mfsa93/Gridl/master/install.sh | GRIDL_TARGET=~/Applications sh`

### macOS, by hand

1. Download `Gridl_X.Y.Z_universal.dmg` from the [releases](https://github.com/mfsa93/Gridl/releases).
2. Open it and drag Gridl to Applications.
3. Gridl is not signed by Apple, so macOS blocks it the first time:
   - **macOS 15 (Sequoia) or later:** open Gridl, dismiss the warning, go to **System Settings → Privacy & Security**, and click **Open Anyway** next to Gridl.
   - **macOS 14 or earlier:** right-click Gridl → **Open** → **Open**.
   - Or from Terminal: `xattr -dr com.apple.quarantine /Applications/Gridl.app`

The Terminal installer avoids this step because files downloaded with `curl` are not flagged by macOS.

### Updates

Gridl checks for a new version when it starts, and from **Gridl → Check for Updates…** (**Buscar actualizaciones…** in Spanish). When there is one, it shows the release notes and installs it with **Install and Restart**. Every update is signed, and the app rejects any file without a valid signature. If you have unsaved changes, it asks before restarting.

Running the install script again also updates to the latest version.

### Optional tools

The **Backup** menu uses each engine's command line tools. For PostgreSQL and MySQL, install them with:

```bash
brew install libpq mysql-client
```

SQLite needs nothing extra.

### Uninstall

Delete `/Applications/Gridl.app`. Saved connections live in `~/Library/Application Support/app.gridl.desktop/` and passwords in the macOS Keychain, under `app.gridl.desktop`.

## Getting started

1. Click **New Connection** (⌘N), pick the engine, and fill in host, port, database, and user. For SQLite, just choose the file.
2. Optionally check **Save password in the keychain**. The password is never written to the connections file.
3. The **SSL** and **Tunnel** tabs configure TLS with certificates or an SSH tunnel with a key or password.
4. At the bottom of **General**, pick the **environment** (Local, Development, Staging, or Production) and, under **Safety rules**, what that connection is allowed to do. See [Per-environment safety](#per-environment-safety).
5. **Test** checks the connection without saving it; **Connect** saves and opens it.

Right-click a connection to edit, duplicate, remove, or open it in a new window (⌘-click does the same). Each window has its own connection.

## Features

**SQL editor**
- Table and column autocompletion, and syntax highlighting for each engine.
- Errors underlined as you type: each statement is prepared on the server, without running, and the problem is marked where it is.
- Run the statement under the cursor (⌘↵) or the whole script (⇧⌘↵), format (⌘I), and truly cancel a running query on the server.
- Query history with search and favorites.
- Results show up to 10,000 rows; when there are more, **Load up to 100,000 rows** fetches the rest on demand.
- Transactions behave as in a terminal: `BEGIN`, `SET`, and temporary tables persist across queries.

**Tables**
- Paging, per-column filters (including free SQL), and sorting by clicking a header.
- Columns fit their content automatically; right-click a header to refit them.
- A **Row** panel with every value and formatted JSON.
- Right-click a cell: open the related row through a foreign key, copy, copy as `INSERT`, filter by that value, set NULL, or delete.
- Select cells or rows (click the row number) to copy (⌘C), paste (⌘V), or delete (⌫).

**Editing data**
- Edit cells, add rows, paste from Excel or Numbers, and mark rows for deletion.
- Nothing is written until you click **Save** (⌘S). **SQL** shows the exact statements first.
- Everything is applied in **a single transaction**: if one row fails, none is saved.
- Changes survive page changes, filtering, and sorting, and are saved together. Gridl warns before you leave the connection, close a tab, or quit with anything unsaved.

**Structure**
- Add, rename, change, or drop columns.
- Relations (foreign keys): view, create, and drop them, and jump to the related table.
- **New table** with type, size, default, primary key (composite too), not null, unique, and references, with a live `CREATE TABLE` preview.

**Data in and out**
- Export to CSV, JSON, or SQL `INSERT`s. For a table, every row matching the filter is exported, straight to the file without loading it into memory.
- Import CSV with delimiter detection, column matching by name, and a preview. Everything goes in one transaction.
- Back up the database (`pg_dump`, `mysqldump`, or a copy of the SQLite file) and restore a backup.

**Connections**
- TLS with certificate verification, an SSH tunnel with server fingerprint verification, and passwords in the system keychain.
- Read-only mode enforced by the server itself, not just the UI.
- If the connection drops (sleep, VPN, tunnel), **Reconnect** brings it back.
- Light and dark mode following the system appearance.

## Per-environment safety

Each connection has an environment and a set of rules. Picking the environment suggests these rules, which you can change:

| Environment | Change data | Change structure | Time limit |
|---|---|---|---|
| Local / Development | Allow | Allow | None |
| Staging | Ask | Ask | 60 s |
| Production | Block | Block | 30 s |

- **Change data**: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, procedure calls, and any statement Gridl does not recognize.
- **Change structure**: `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`.
- **Ask** shows the statement before running it. In Production, and for destructive operations, you must type the database name to confirm.
- **Always confirm destructive operations** (on by default): `DELETE` or `UPDATE` without `WHERE`, `DROP`, and `TRUNCATE` ask for confirmation even locally.
- **Time limit**: the query is cancelled on the server after that time.

The rules are enforced in the backend, before the statement reaches the database, and cover the editor, the grid, structure changes, imports, and restores. Gridl judges by the statement's shape: it cannot know what a function does inside (`SELECT purge_everything()` counts as a read). For a hard block, also turn on **Read-only**, which the server enforces.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘↵ | Run the statement under the cursor or the selection |
| ⇧⌘↵ | Run the whole script |
| ⌘I | Format SQL |
| ⌘S | Save the table's changes |
| ⌘Z | Undo the last pending change |
| ⌘R | Reload the data (or the explorer, in the SQL editor) |
| ⌘C / ⌘V / ⌫ | Copy, paste, or delete the grid selection |
| ⌘N | New connection |
| ⇧⌘G | New group |
| ⌘W | Close the tab |
| ⌘K | Search connections |
| ⌘-click a connection | Open it in a new window |

## Where data is stored

| What | Where |
|---|---|
| Connections and groups | `~/Library/Application Support/app.gridl.desktop/connections.json` |
| Passwords | macOS Keychain, service `app.gridl.desktop` |
| History, open tabs, and pane sizes | The app's local storage, per connection |

The connections file never contains passwords.

## Development

### Requirements

- Rust 1.88 or later, with `rustfmt` and `clippy` (`rustup component add rustfmt clippy`).
- Node.js 22 and pnpm 10.
- macOS: Xcode Command Line Tools.
- Linux: the [Tauri 2](https://v2.tauri.app/start/prerequisites/) dependencies.
- Windows: WebView2 and the C++ Build Tools.
- Docker, to run the tests against PostgreSQL and MySQL.

### Run

```bash
git clone https://github.com/mfsa93/Gridl.git gridl
cd gridl
pnpm install
pnpm dev      # the first Tauri build takes a few minutes
```

`pnpm dev` rebuilds the backend and reloads the UI on save. Option-right-click opens the web inspector.

### Tests

```bash
pnpm check    # formatting, clippy, Rust tests, lint, frontend tests, and TypeScript
```

Piece by piece:

```bash
cargo test --workspace          # core and shell (SQLite always; PG and MySQL when a server is set)
pnpm --dir frontend test        # Vitest: generated SQL, filters, export, errors, pending edits
pnpm lint
pnpm --dir frontend exec tsc --noEmit
```

The PostgreSQL and MySQL tests are skipped without a server. To run them against throwaway servers:

```bash
docker run -d --rm --name gridl-pg-test -e POSTGRES_PASSWORD=gridl -e POSTGRES_DB=gridl -p 35432:5432 postgres:17
docker run -d --rm --name gridl-mysql-check -e MYSQL_ROOT_PASSWORD=gridl -e MYSQL_DATABASE=gridl -p 33306:3306 mysql:8.4

GRIDL_TEST_PG=postgres:gridl@127.0.0.1:35432/gridl \
GRIDL_TEST_MYSQL=root:gridl@127.0.0.1:33306/gridl \
cargo test --workspace
```

The backup and restore tests also need `GRIDL_TEST_BACKUP=1` and `brew install libpq mysql-client`.

GitHub CI (`.github/workflows/ci.yml`) runs all of this on every push and pull request, with PostgreSQL and MySQL as services.

### Build the app

```bash
pnpm build
```

This leaves `Gridl.app` and the `.dmg` in `target/release/bundle/`. Generating signed update artifacts needs the private key in `TAURI_SIGNING_PRIVATE_KEY` (see below).

## Releasing

1. Bump the version in `crates/gridl-desktop/tauri.conf.json` (`"version"`) and `Cargo.toml` (`[workspace.package] version`). It must be higher than the published one.
2. Merge it into `master` through a pull request from `develop` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
3. Tag `master` and push the tag:

   ```bash
   git switch master && git pull
   git tag -a v0.2.1 -m "Gridl 0.2.1"
   git push origin v0.2.1
   ```

4. `.github/workflows/release.yml` builds the universal app, signs it, and publishes the release with the `.dmg`, the update bundle, and `latest.json`. It takes about 15 minutes.
5. Installed copies offer it on start or from **Check for Updates**.

### Update signing key

Updates are signed with a project key (this is not Apple's signature):

- The public key is in `crates/gridl-desktop/tauri.conf.json` (`plugins.updater.pubkey`).
- The private key lives outside the repository, in `~/.tauri/gridl.key`, and in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Keep a backup of `~/.tauri/gridl.key`.** If it is lost, installed copies can no longer receive updates and must be reinstalled by hand with a new key.

### Apple signing (optional)

Opening Gridl without any warning needs the Apple Developer Program (99 USD a year), a Developer ID certificate, and notarization. `tauri-action` supports it once the secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID` are added.

## Architecture

```text
frontend/                  React, CodeMirror 6, Glide Data Grid
        |  invoke + Channel<RowChunk>
crates/gridl-desktop/      Tauri shell: IPC commands, windows, profiles, keychain,
        |                  safety policy, export, import, and backup
        |  DatabaseDriver, CredentialVault
crates/gridl-core/         ports and drivers (SQLite, PostgreSQL, MySQL/MariaDB)
```

`DatabaseDriver` is the port; `SqliteDriver`, `PostgresDriver`, and `MysqlDriver` are the adapters, registered in `builtin_drivers()`. Each engine's differences live in its `EngineSpec`, which the frontend reads through `list_engines`. The shell does not speak SQL: it opens a session, asks for the catalog, and consumes row chunks. Passwords are not part of `ConnectionConfig`; they are stored with the `keyring` crate (Keychain, Credential Manager, or Secret Service).

- **Streaming**: queries are never materialized whole. The driver pushes 500-row `RowChunk`s through a Tauri `Channel` and the grid virtualizes rendering. Caps: 1,000,000 rows per result and 256 KiB per cell.
- **Editor session**: each connection keeps a pinned connection for the editor, so transactions span several queries. Inline error checking uses another pool connection, so it never aborts an open transaction.
- **Writes**: grid and structure changes go through `execute_batch` in a pool transaction.
- **Safety**: `gridl-core/src/guard.rs` classifies each statement (read, session, data, structure) and decides according to the connection's policy. The Tauri commands enforce it before reaching the driver.
- **Cancellation**: sends `pg_cancel_backend` or `KILL QUERY` to the server.
- **Windows**: each window owns its connections; closing it disconnects them.

### Repository layout

```text
Cargo.toml                          workspace
crates/gridl-core/                  DatabaseDriver, types, drivers, safety policy, export and import
crates/gridl-core/tests/            per-engine tests (PG and MySQL against a real server)
crates/gridl-desktop/               Tauri app: commands, windows, menu, SSH tunnel, backup
crates/gridl-desktop/icons/         icons (source.svg is the original)
frontend/src/App.tsx                workspace
frontend/src/workspace/             model, grid, structure, relations, export, import
frontend/src/editor/                SQL editor and diagnostics
frontend/src/home/                  connections, connection form, and updates
frontend/src/__tests__/             frontend tests
install.sh                          macOS installer
.github/workflows/                  CI and releases
```

### Adding an engine

An engine is a driver (`DatabaseDriver`) and a spec (`EngineSpec` in `crates/gridl-core/src/engines.rs`) that describes how it differs: connection defaults, SQL dialect, column types, capabilities. The rest of the app reads the spec instead of branching on engine names. Step by step: [docs/adding-an-engine.md](docs/adding-an-engine.md).

## License

[MIT](LICENSE).
