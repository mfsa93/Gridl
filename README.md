# Gridl

Cliente de bases de datos de escritorio, open source y modular. La interfaz corre en Tauri 2 y el motor de datos es una crate Rust independiente, sin Electron.

## Instalar

En macOS, pega esto en Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mfsa93/Gridl/master/install.sh | sh
```

Descarga la última versión desde las releases de GitHub, la copia a Aplicaciones y la abre. Como lo descarga `curl`, macOS no pide confirmación aunque la app no esté firmada por Apple. Después, Gridl se actualiza solo desde **Gridl → Buscar actualizaciones…**

Para publicar una versión nueva: sube el número de versión en `crates/gridl-desktop/tauri.conf.json` y en `Cargo.toml`, crea la etiqueta `vX.Y.Z` y súbela. El flujo `release.yml` compila, firma y publica.

## Arquitectura

```text
frontend/                  React, CodeMirror 6, Glide Data Grid
        |  invoke + Channel<RowChunk>
crates/gridl-desktop/      shell Tauri: comandos IPC, perfiles, keyring
        |  DatabaseDriver, CredentialVault
crates/gridl-core/         puertos y drivers (SQLite, PostgreSQL, MySQL/MariaDB)
```

`DatabaseDriver` es el puerto. `SqliteDriver`, `PostgresDriver` y `MysqlDriver` son los adaptadores. El shell no habla SQL: abre una sesión, pide el catálogo y consume bloques de filas. Las contraseñas no forman parte de `ConnectionConfig`; si el usuario lo pide, se guardan con el crate `keyring` (Keychain, Credential Manager o Secret Service).

Las consultas no se materializan enteras en el backend. El driver empuja `RowChunk` (500 filas por defecto) por un `Channel` de Tauri y la grilla virtualiza el pintado. Hay un tope de 1.000.000 de filas por resultado y de 256 KiB por celda para no agotar la RAM.

Cada sesión mantiene una conexión fija para el editor, así que `BEGIN`, `SET` y las tablas temporales se conservan entre consultas. Los cambios hechos en la grilla o en la estructura se aplican con `execute_batch` en una sola transacción: si una sentencia falla, no se aplica ninguna. El modo solo lectura lo hace cumplir el servidor (PostgreSQL y MySQL) o el archivo (SQLite), no solo la interfaz. Cancelar envía `pg_cancel_backend` o `KILL QUERY` al servidor.

## Funciones

- Editor SQL con autocompletado, formateo (⌘I), ejecutar la sentencia del cursor (⌘↵) o el script completo (⇧⌘↵) e historial con favoritas.
- Tablas paginadas con filtros por columna, orden al hacer clic en la cabecera y panel de detalle de fila con JSON formateado.
- Edición de celdas, filas nuevas, borrado, pegado desde hojas de cálculo y vista previa del SQL antes de guardar.
- Editor de estructura: agregar, renombrar, cambiar o quitar columnas.
- Exportar a CSV, JSON o `INSERT` SQL (en una tabla, todas las filas que cumplen el filtro).
- Conexiones con TLS, túnel SSH y contraseñas en el llavero del sistema.

## Requisitos

- Rust 1.88 o superior, con `rustfmt` y `clippy` (`rustup component add rustfmt clippy`, o el toolchain de Homebrew).
- Node.js 22 y pnpm 10.
- En macOS, Xcode Command Line Tools.
- En Linux, las dependencias de [Tauri 2](https://v2.tauri.app/start/prerequisites/).
- En Windows, WebView2 y las Build Tools de C++.

## Inicializar el repositorio

Desde cero, en esta máquina el proyecto ya está en `~/Projects/gridl`. En otra máquina:

```bash
git clone <url-del-repo> gridl
cd gridl
```

Instalar el frontend y comprobar el núcleo:

```bash
pnpm install
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Las pruebas de PostgreSQL y MySQL se saltan si no hay servidor. Para correrlas:

```bash
docker run -d --rm --name gridl-pg -e POSTGRES_PASSWORD=gridl -e POSTGRES_DB=gridl -p 35432:5432 postgres:17
docker run -d --rm --name gridl-mysql -e MYSQL_ROOT_PASSWORD=gridl -e MYSQL_DATABASE=gridl -p 33306:3306 mysql:8.4
GRIDL_TEST_PG=postgres:gridl@127.0.0.1:35432/gridl \
GRIDL_TEST_MYSQL=root:gridl@127.0.0.1:33306/gridl \
cargo test --workspace
```

Arrancar la aplicación de escritorio (la primera compilación de Tauri tarda varios minutos):

```bash
pnpm dev
```

El binario de release se genera con:

```bash
pnpm build
```

## Layout

```text
Cargo.toml                 workspace
crates/gridl-core/         trait DatabaseDriver, tipos, SQLite, PostgreSQL y MySQL
crates/gridl-desktop/      binario Tauri y comandos IPC
frontend/                  UI
```

## Añadir un motor

1. Implementa `DatabaseDriver` en `crates/gridl-core`.
2. Registra el valor nuevo de `DatabaseEngine` en el shell (`AppState::driver`).
3. No acumules el result set: llama a `ChunkSink::on_chunk` por cada bloque.
4. Usa una conexión fija por sesión para `query` y una transacción del pool para `execute_batch`.

El comando que hace streaming es `execute_query` en `crates/gridl-desktop/src/commands.rs`. Recibe un `Channel<RowChunk>` y devuelve `QueryResult` cuando el último bloque ya se envió.
