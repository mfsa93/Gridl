# Gridl

Cliente de bases de datos de escritorio, gratuito y open source, con el estilo de una app de macOS. Trabaja con **PostgreSQL**, **MySQL / MariaDB** y **SQLite**. La interfaz corre en Tauri 2 y el motor de datos es una crate de Rust independiente, sin Electron: la app pesa unos 20 MB y consume una fracción de la memoria de los clientes basados en Electron o Java.

- [Instalar](#instalar)
- [Primeros pasos](#primeros-pasos)
- [Funciones](#funciones)
- [Seguridad por ambiente](#seguridad-por-ambiente)
- [Atajos de teclado](#atajos-de-teclado)
- [Dónde guarda sus datos](#dónde-guarda-sus-datos)
- [Desarrollo](#desarrollo)
- [Publicar una versión](#publicar-una-versión)
- [Arquitectura](#arquitectura)

## Instalar

### macOS (recomendado)

Pega esto en Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mfsa93/Gridl/master/install.sh | sh
```

El script busca la última versión en las [releases de GitHub](https://github.com/mfsa93/Gridl/releases), descarga el `.dmg`, copia Gridl a Aplicaciones y lo abre. La app es universal: funciona en Mac con Apple Silicon y con Intel.

Opciones:

| Variable | Qué hace |
|---|---|
| `GRIDL_TARGET=~/Applications` | Instala en tu carpeta personal, sin pedir contraseña de administrador. |
| `GRIDL_VERSION=v0.2.0` | Instala una versión concreta en lugar de la última. |
| `GRIDL_NO_OPEN=1` | No abre Gridl al terminar. |

Ejemplo: `curl -fsSL https://raw.githubusercontent.com/mfsa93/Gridl/master/install.sh | GRIDL_TARGET=~/Applications sh`

### macOS, a mano

1. Descarga `Gridl_X.Y.Z_universal.dmg` desde las [releases](https://github.com/mfsa93/Gridl/releases).
2. Ábrelo y arrastra Gridl a Aplicaciones.
3. Gridl no está firmado por Apple, así que la primera vez macOS lo bloquea:
   - **macOS 15 (Sequoia) o posterior:** abre Gridl, cierra el aviso, ve a **Ajustes del Sistema → Privacidad y seguridad** y pulsa **Abrir igualmente** junto a Gridl.
   - **macOS 14 o anterior:** clic derecho sobre Gridl → **Abrir** → **Abrir**.
   - O desde Terminal: `xattr -dr com.apple.quarantine /Applications/Gridl.app`

El instalador por Terminal evita este paso porque los archivos que descarga `curl` no quedan marcados por macOS.

### Actualizaciones

Gridl revisa al abrirse si hay una versión nueva, y también desde **Gridl → Buscar actualizaciones…**. Si la hay, muestra las novedades y la instala con **Instalar y reiniciar**. Cada actualización viene firmada y la app rechaza cualquier archivo sin una firma válida. Si tienes cambios sin guardar, te avisa antes de reiniciar.

Volver a ejecutar el script de instalación también actualiza a la última versión.

### Herramientas opcionales

El menú **Respaldo** usa las herramientas de línea de comandos de cada motor. Para PostgreSQL y MySQL instálalas con:

```bash
brew install libpq mysql-client
```

SQLite no necesita nada extra.

### Desinstalar

Borra `/Applications/Gridl.app`. Las conexiones guardadas están en `~/Library/Application Support/app.gridl.desktop/` y las contraseñas en el Llavero de macOS, con el nombre `app.gridl.desktop`.

## Primeros pasos

1. Pulsa **Nueva conexión** (⌘N), elige el motor y completa host, puerto, base de datos y usuario. Para SQLite basta con elegir el archivo.
2. Si quieres, marca **Guardar contraseña en el llavero**. La contraseña nunca se escribe en el archivo de conexiones.
3. En **SSL** y **Túnel** configuras TLS con certificados o un túnel SSH con llave o contraseña.
4. Al final de **General** eliges el **ambiente** (Local, Desarrollo, Staging o Producción) y, en **Reglas de seguridad**, qué puede hacer esa conexión. Ver [Seguridad por ambiente](#seguridad-por-ambiente).
5. **Probar** verifica la conexión sin guardarla; **Conectar** la guarda y la abre.

Con clic derecho sobre una conexión puedes editarla, duplicarla, quitarla o abrirla en una ventana nueva (también con ⌘clic). Cada ventana tiene su propia conexión.

## Funciones

**Editor SQL**
- Autocompletado de tablas y columnas, y resaltado de sintaxis para cada motor.
- Errores subrayados mientras escribes: cada sentencia se prepara en el servidor, sin ejecutarse, y se marca donde está el problema.
- Ejecuta la sentencia del cursor (⌘↵) o el script completo (⇧⌘↵), formatea (⌘I) y cancela una consulta en curso de verdad, en el servidor.
- Historial de consultas con búsqueda y favoritas.
- Los resultados muestran hasta 10.000 filas; si hay más, **Cargar hasta 100.000 filas** trae el resto bajo demanda.
- Las transacciones funcionan como en una terminal: `BEGIN`, `SET` y las tablas temporales se mantienen entre consultas.

**Tablas**
- Paginación, filtros por columna (incluido SQL libre) y orden con clic en la cabecera.
- Las columnas se ajustan solas al contenido; clic derecho en la cabecera para reajustarlas.
- Panel **Fila** con todos los valores y el JSON formateado.
- Clic derecho en una celda: abrir la fila relacionada por clave foránea, copiar, copiar como `INSERT`, filtrar por ese valor, poner NULL o eliminar.
- Selecciona celdas o filas (clic en el número de fila) para copiar (⌘C), pegar (⌘V) o borrar (⌫).

**Editar datos**
- Edita celdas, agrega filas, pega desde Excel o Numbers y marca filas para borrar.
- Nada se escribe hasta que pulsas **Guardar** (⌘S). **SQL** muestra antes las sentencias exactas.
- Todo se aplica en **una sola transacción**: si una fila falla, no se guarda ninguna.
- Los cambios se conservan al cambiar de página, filtrar u ordenar, y se guardan todos juntos. Gridl te avisa antes de salir de la conexión, cerrar una pestaña o cerrar la app si hay algo sin guardar.

**Estructura**
- Agrega, renombra, cambia o quita columnas.
- Relaciones (claves foráneas): verlas, crearlas, quitarlas y saltar a la tabla relacionada.
- **Nueva tabla** con tipo, tamaño, valor predeterminado, clave primaria (también compuesta), no nulo, única y referencia, con vista previa del `CREATE TABLE`.

**Datos de entrada y salida**
- Exporta a CSV, JSON o `INSERT` SQL. En una tabla se exportan todas las filas que cumplen el filtro, directo al archivo y sin cargarlas en memoria.
- Importa CSV con detección del separador, asociación de columnas por nombre y vista previa. Todo entra en una transacción.
- Respalda la base (`pg_dump`, `mysqldump` o una copia del archivo SQLite) y restaura un respaldo.

**Conexiones**
- TLS con verificación de certificado, túnel SSH con verificación de la huella del servidor y contraseñas en el llavero del sistema.
- Modo solo lectura aplicado por el propio servidor, no solo por la interfaz.
- Si se cae la conexión (suspensión, VPN, túnel), **Reconectar** la recupera.
- Modo claro y oscuro según la apariencia del sistema.

## Seguridad por ambiente

Cada conexión tiene un ambiente y unas reglas. Al elegir el ambiente se sugieren estas reglas, y puedes cambiarlas:

| Ambiente | Modificar datos | Cambiar estructura | Tiempo límite |
|---|---|---|---|
| Local / Desarrollo | Permitir | Permitir | Sin límite |
| Staging | Pedir autorización | Pedir autorización | 60 s |
| Producción | Bloquear | Bloquear | 30 s |

- **Modificar datos**: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, llamadas a procedimientos y cualquier sentencia que Gridl no reconozca.
- **Cambiar estructura**: `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`.
- **Pedir autorización** muestra la sentencia antes de ejecutarla. En Producción, y para operaciones destructivas, hay que escribir el nombre de la base para confirmar.
- **Confirmar siempre las operaciones destructivas** (activo por defecto): `DELETE` o `UPDATE` sin `WHERE`, `DROP` y `TRUNCATE` piden confirmación incluso en Local.
- **Tiempo límite**: la consulta se cancela en el servidor al pasar ese tiempo.

Las reglas se aplican en el backend, antes de que la sentencia llegue a la base, y cubren el editor, la grilla, la estructura, la importación y la restauración. Gridl decide por la forma de la sentencia: no puede saber qué hace una función por dentro (`SELECT borrar_todo()` cuenta como lectura). Para un bloqueo total, activa además **Solo lectura**, que lo hace cumplir el servidor.

## Atajos de teclado

| Atajo | Acción |
|---|---|
| ⌘↵ | Ejecutar la sentencia del cursor o la selección |
| ⇧⌘↵ | Ejecutar todo el script |
| ⌘I | Formatear SQL |
| ⌘S | Guardar los cambios de la tabla |
| ⌘Z | Deshacer el último cambio pendiente |
| ⌘R | Recargar los datos (o el explorador, en el editor SQL) |
| ⌘C / ⌘V / ⌫ | Copiar, pegar o borrar la selección de la grilla |
| ⌘N | Nueva conexión |
| ⇧⌘G | Nuevo grupo |
| ⌘W | Cerrar la pestaña |
| ⌘K | Buscar una conexión |
| ⌘clic en una conexión | Abrirla en una ventana nueva |

## Dónde guarda sus datos

| Qué | Dónde |
|---|---|
| Conexiones y grupos | `~/Library/Application Support/app.gridl.desktop/connections.json` |
| Contraseñas | Llavero de macOS, servicio `app.gridl.desktop` |
| Historial, pestañas abiertas y anchos de paneles | Almacenamiento local de la app, por conexión |

El archivo de conexiones nunca contiene contraseñas.

## Desarrollo

### Requisitos

- Rust 1.88 o superior, con `rustfmt` y `clippy` (`rustup component add rustfmt clippy`).
- Node.js 22 y pnpm 10.
- macOS: Xcode Command Line Tools.
- Linux: las dependencias de [Tauri 2](https://v2.tauri.app/start/prerequisites/).
- Windows: WebView2 y las Build Tools de C++.
- Docker, si quieres correr las pruebas contra PostgreSQL y MySQL.

### Arrancar

```bash
git clone https://github.com/mfsa93/Gridl.git gridl
cd gridl
pnpm install
pnpm dev      # la primera compilación de Tauri tarda varios minutos
```

`pnpm dev` recompila el backend y recarga la interfaz al guardar. Con Option + clic derecho se abre el inspector web.

### Pruebas

```bash
pnpm check    # formato, clippy, pruebas de Rust, lint, pruebas del frontend y TypeScript
```

Por partes:

```bash
cargo test --workspace          # núcleo y shell (SQLite siempre; PG y MySQL si hay servidor)
pnpm --dir frontend test        # Vitest: SQL generado, filtros, exportación, errores, cambios pendientes
pnpm lint
pnpm --dir frontend exec tsc --noEmit
```

Las pruebas de PostgreSQL y MySQL se saltan si no hay servidor. Para correrlas con servidores desechables:

```bash
docker run -d --rm --name gridl-pg-test -e POSTGRES_PASSWORD=gridl -e POSTGRES_DB=gridl -p 35432:5432 postgres:17
docker run -d --rm --name gridl-mysql-check -e MYSQL_ROOT_PASSWORD=gridl -e MYSQL_DATABASE=gridl -p 33306:3306 mysql:8.4

GRIDL_TEST_PG=postgres:gridl@127.0.0.1:35432/gridl \
GRIDL_TEST_MYSQL=root:gridl@127.0.0.1:33306/gridl \
cargo test --workspace
```

Las pruebas de respaldo y restauración necesitan además `GRIDL_TEST_BACKUP=1` y `brew install libpq mysql-client`.

La CI de GitHub (`.github/workflows/ci.yml`) corre todo esto en cada push, con PostgreSQL y MySQL como servicios.

### Compilar la app

```bash
pnpm build
```

Deja `Gridl.app` y el `.dmg` en `target/release/bundle/`. Para generar los archivos de actualización firmados hace falta la llave privada en `TAURI_SIGNING_PRIVATE_KEY` (ver abajo).

## Publicar una versión

1. Sube el número de versión en `crates/gridl-desktop/tauri.conf.json` (`"version"`) y en `Cargo.toml` (`[workspace.package] version`). Tiene que ser mayor que la publicada.
2. Haz commit, crea la etiqueta y súbela:

   ```bash
   git commit -am "Gridl 0.2.1"
   git tag -a v0.2.1 -m "Gridl 0.2.1"
   git push origin master v0.2.1
   ```

3. El flujo `.github/workflows/release.yml` compila la app universal, la firma y publica la release con el `.dmg`, el paquete de actualización y `latest.json`. Tarda unos 15 minutos.
4. Las copias instaladas la ofrecen al abrirse o desde **Buscar actualizaciones…**

### Llave de firma de actualizaciones

Las actualizaciones se firman con una llave propia (no es la firma de Apple):

- La llave pública está en `crates/gridl-desktop/tauri.conf.json` (`plugins.updater.pubkey`).
- La llave privada vive fuera del repositorio, en `~/.tauri/gridl.key`, y en los secrets del repositorio `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Guarda una copia de `~/.tauri/gridl.key`.** Si se pierde, las copias instaladas ya no podrán recibir actualizaciones y habrá que reinstalarlas a mano con una llave nueva.

### Firma de Apple (opcional)

Para que Gridl se abra sin ningún aviso hace falta el Apple Developer Program (99 USD al año), un certificado Developer ID y la notarización. `tauri-action` lo soporta agregando los secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (contraseña de aplicación) y `APPLE_TEAM_ID`.

## Arquitectura

```text
frontend/                  React, CodeMirror 6, Glide Data Grid
        |  invoke + Channel<RowChunk>
crates/gridl-desktop/      shell Tauri: comandos IPC, ventanas, perfiles, llavero,
        |                  política de seguridad, exportación, importación y respaldo
        |  DatabaseDriver, CredentialVault
crates/gridl-core/         puertos y drivers (SQLite, PostgreSQL, MySQL/MariaDB)
```

`DatabaseDriver` es el puerto y `SqliteDriver`, `PostgresDriver` y `MysqlDriver` son los adaptadores. El shell no habla SQL: abre una sesión, pide el catálogo y consume bloques de filas. Las contraseñas no forman parte de `ConnectionConfig`; se guardan con el crate `keyring` (Keychain, Credential Manager o Secret Service).

- **Streaming**: las consultas no se materializan enteras. El driver empuja `RowChunk` de 500 filas por un `Channel` de Tauri y la grilla virtualiza el pintado. Topes: 1.000.000 de filas por resultado y 256 KiB por celda.
- **Sesión del editor**: cada conexión mantiene una conexión fija para el editor, así que las transacciones abarcan varias consultas. La verificación de errores mientras escribes usa otra conexión del pool, para no abortar una transacción abierta.
- **Escrituras**: los cambios de la grilla y de la estructura se aplican con `execute_batch` en una transacción del pool.
- **Seguridad**: `gridl-core/src/guard.rs` clasifica cada sentencia (lectura, sesión, datos, estructura) y decide según la política de la conexión. Los comandos de Tauri la aplican antes de llegar al driver.
- **Cancelación**: envía `pg_cancel_backend` o `KILL QUERY` al servidor.
- **Ventanas**: cada ventana es dueña de sus conexiones; al cerrarla se desconectan.

### Estructura del repositorio

```text
Cargo.toml                          workspace
crates/gridl-core/                  DatabaseDriver, tipos, drivers, política, exportación e importación
crates/gridl-core/tests/            pruebas por motor (PG y MySQL contra servidor real)
crates/gridl-desktop/               app Tauri: comandos, ventanas, menú, túnel SSH, respaldo
crates/gridl-desktop/icons/         íconos (source.svg es el original)
frontend/src/App.tsx                espacio de trabajo
frontend/src/workspace/             modelo, grilla, estructura, relaciones, exportación, importación
frontend/src/editor/                editor SQL y diagnósticos
frontend/src/home/                  conexiones, formulario y actualizaciones
frontend/src/__tests__/             pruebas del frontend
install.sh                          instalador para macOS
.github/workflows/                  CI y releases
```

### Añadir un motor

1. Implementa `DatabaseDriver` en `crates/gridl-core`.
2. Registra el valor nuevo de `DatabaseEngine` en el shell (`AppState::driver`).
3. No acumules el resultado: llama a `ChunkSink::on_chunk` por cada bloque.
4. Usa una conexión fija por sesión para `query` y una transacción del pool para `execute_batch`.

## Licencia

[MIT](LICENSE).
