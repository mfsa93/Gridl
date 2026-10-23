# Contribuir a Gridl

El núcleo de datos vive en `crates/gridl-core` y no depende de Tauri. El shell de escritorio, en `crates/gridl-desktop`, solo adapta IPC y el llavero del sistema. Un motor nuevo implementa el trait `DatabaseDriver`.

Antes de abrir un cambio:

```bash
pnpm install
cargo fmt --all
pnpm check
```

`pnpm check` corre formato, clippy, las pruebas de Rust, lint, las pruebas del frontend (Vitest) y TypeScript. Para las pruebas contra PostgreSQL y MySQL reales, mira la sección [Pruebas](README.md#pruebas) del README.

Las reglas de seguridad por ambiente (`crates/gridl-core/src/guard.rs`) se aplican en el backend. Cualquier comando nuevo que ejecute SQL del usuario tiene que pasar por `guard()` en `crates/gridl-desktop/src/commands.rs`.

No guardes contraseñas en `ConnectionConfig`, en logs ni en el JSON de perfiles. El secreto entra al llavero del sistema o vive en memoria solo durante la sesión.
