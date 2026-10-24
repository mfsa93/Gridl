# Adding a database engine

An engine is two pieces: a **driver** that talks to the database, and a **spec**
that tells the rest of the app how that database differs from the others. Nothing
else in the app branches on the engine's name, so these two pieces are the whole job.

## 1. The engine id

Add a variant to `DatabaseEngine` in `crates/gridl-core/src/types.rs` and to the
`DatabaseEngine` type in `frontend/src/lib/api.ts`. The id (`"duckdb"`) is what
saved connections store.

## 2. The driver

Create `crates/gridl-core/src/drivers/<engine>.rs` implementing `DatabaseDriver`
(`crates/gridl-core/src/driver.rs`), then add it to `builtin_drivers()` in
`crates/gridl-core/src/drivers/mod.rs`. The existing drivers are the reference;
SQLite (≈600 lines) is the smallest.

- `connect` / `probe` / `disconnect`: open a session. TLS and the SSH tunnel come
  in through `ConnectionConfig` and the endpoint argument.
- `introspect`, `list_relations`, `describe_relation`, `foreign_keys`: read the
  catalog in parallel queries. Prefer the engine's own catalog tables over slow
  `information_schema` views.
- `query`: stream rows. Never collect the result; call `ChunkSink::on_chunk` for
  each chunk. Keep one pinned connection for the editor and another for
  `request.browse`, so the table browser never waits behind the editor.
- Decode every value to `SqlValue`: text from the server's own output, numbers as
  `Int`/`Float`, binary as `Bytes`. Unknown types fall back to text, never to an error.
- `execute_batch`: one transaction, bound parameters.
- `check`: report the position of a syntax error without running the statement.

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
