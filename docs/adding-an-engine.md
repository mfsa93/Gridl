# Adding a database engine

An engine is two pieces: a **driver** that talks to the database, and a **spec**
that tells the rest of the app how that database differs from the others. Nothing
else in the app branches on the engine's name, so these two pieces are the whole job.

## 1. The engine id

Add a variant to `DatabaseEngine` in `crates/gridl-core/src/types.rs` and to the
`DatabaseEngine` type in `frontend/src/lib/api.ts`. The id (`"duckdb"`) is what
saved connections store. Add a one-line description in `frontend/src/home/engines.ts`
and both locales.

## 2. The driver

Create a folder `crates/gridl-core/src/drivers/<engine>/` and add the driver to
`builtin_drivers()` in `crates/gridl-core/src/drivers/mod.rs`. Every driver has
the same layout, so each file answers one question:

| File | What it holds |
|---|---|
| `mod.rs` | The `DatabaseDriver` impl: short methods that delegate to the files below |
| `connect.rs` | Connection options, TLS, the SSH tunnel endpoint, opening the pool |
| `catalog.rs` | Tables, views, columns, keys, foreign keys |
| `objects.rs` | Routines, triggers, indexes, sequences (when the engine has them) |
| `query.rs` | Running the editor's SQL, cancelling it, decoding rows |
| `literal.rs` / `lexer.rs` | Engine-specific SQL text handling (placeholders, batches) |
| `backup.rs` | Backup and restore with the engine's command line tools |

What is the same for every engine lives in `drivers/common/` and is not written again:

- `session`: `Sessions` (open sessions by connection id) and `Pinned` (the
  editor's and the table browser's connections).
- `cancel`: `interruptible` (ask the server to stop, then let the statement
  finish) and `abandonable` (drop the request, then tell the server).
- `result`: the `QueryResult` and the closing chunk (`streamed`, `done`, `cancelled`).
- `stream`: `emit_chunks` turns any row stream into chunks; never collect a result.
- `bind`: parameters for sqlx engines (`bound::<Postgres>(sql, params)`).
- `catalog`: `push_column` and `push_key_column` build schemas from catalog
  rows; `definition_only` and `plain_column` for simple objects.
- `decode`: per-cell size limits.

Rules every driver keeps:

- Read the catalog in parallel queries, from the engine's own catalog tables
  rather than slow `information_schema` views.
- Decode every value to `SqlValue`: text from the server's own output, numbers
  as `Int`/`Float`, binary as `Bytes`. Unknown types fall back to text, never to an error.
- `execute_batch`: one transaction, bound parameters.
- `check`: report the position of a syntax error without running the statement.
- `table_objects`: the indexes and triggers of one table, with `parent` set, so
  a structure change reloads only what it touched.
- `backup` / `restore` (optional): the engine's own tools, run through
  `drivers/common/tools.rs` (`Tool`, `address`, `run`). Passwords go in the
  environment, never on the command line. Engines without them keep the
  trait's default, which refuses with a clear message. The desktop shell
  never names an engine: it checks paths and the safety policy and calls these.
- Keep files under ~300 lines; split by responsibility, not by size.

SQLite is the smallest example; SQL Server shows an engine without sqlx
(tiberius, with its own small pool in `pool.rs`).

## 3. The spec

Add a function returning the engine's `EngineSpec` in
`crates/gridl-core/src/engines.rs`, and list it in `spec()` and `builtin_specs()`.
Each field is documented there. The groups are:

- `connection`: whether the engine uses a file or a server, plus the default port, user and name.
- `sql`: identifier quote, `$1` or `?` parameters, editor dialect, string escapes, comments, how text casts and NULL-safe comparisons are written, literals, and `NOW()`.
- `structure`: whether there are schemas, the ALTER strategy, the column types the structure editor offers, and what can be changed on an existing table.
- `tools`: the EXPLAIN format, the row estimate source, and backup and restore.

Then regenerate the frontend's copy:

```sh
GRIDL_WRITE_ENGINES=1 cargo test -p gridl-core engines
```

`cargo test` fails while `frontend/src/engines/builtin.json` is out of date, so the
two never drift apart.

If the engine needs something a spec option does not express yet (a new EXPLAIN
format, another ALTER style), add an option to the spec and implement it once next
to the existing ones: `workspace/plan.ts`, `workspace/changes.ts`. Do not branch on
the engine's id.

## 4. Tests

Copy one of `crates/gridl-core/tests/*_driver.rs`. Most important is the
"reads and writes back every type" test against a live server in Docker: it is
what catches decoding mistakes. Also add the engine to the `list_engines`
expectations in `frontend/src/__tests__/engines.test.ts`.

## Toward external plugins

`EngineSpec` serializes to JSON and the frontend reads the engine list from the
backend at startup (`list_engines`). An external plugin will provide the same
spec plus a driver behind a process boundary. That is why options are plain data,
and why nothing outside the driver and the spec may depend on a particular engine.
