# Contribuir a Gridl

El núcleo de datos vive en `crates/gridl-core` y no depende de Tauri. El shell de escritorio, en `crates/gridl-desktop`, solo adapta IPC y el llavero del sistema. Un motor nuevo implementa el trait `DatabaseDriver`.

Antes de abrir un cambio:

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm install
pnpm lint
pnpm --dir frontend exec tsc --noEmit
```

No guardes contraseñas en `ConnectionConfig`, en logs ni en el JSON de perfiles. El secreto entra al llavero del sistema o vive en memoria solo durante la sesión.
