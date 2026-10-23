# Contribuir a Gridl

El núcleo de datos vive en `crates/gridl-core` y no depende de Tauri. El shell de escritorio, en `crates/gridl-desktop`, solo adapta IPC y el llavero del sistema. Un motor nuevo implementa el trait `DatabaseDriver`.

## Ramas

- `master`: versión estable. De aquí salen las releases. Solo acepta pull requests desde `develop` (o un `hotfix/…` urgente), con la CI en verde.
- `develop`: integración y pruebas. Las ramas de trabajo se unen aquí por pull request.
- Ramas de trabajo, siempre desde `develop`: `feat/…` para funciones, `fix/…` para errores, `chore/…` para mantenimiento, `docs/…` para documentación.

```bash
git switch develop && git pull
git switch -c feat/importar-excel
# … commits …
git push -u origin feat/importar-excel
gh pr create --base develop
```

Nadie hace push directo a `master` ni a `develop`, y ninguna de las dos se puede borrar ni reescribir.

## Publicar

1. Abre un PR de `develop` a `master` con el número de versión ya subido (ver [Publicar una versión](README.md#publicar-una-versión)).
2. Cuando la CI pasa y se une, crea la etiqueta `vX.Y.Z` sobre `master`. Solo los administradores pueden crear etiquetas `v*`.

## Antes de abrir un pull request

```bash
pnpm install
cargo fmt --all
pnpm check
```

`pnpm check` corre formato, clippy, las pruebas de Rust, lint, las pruebas del frontend (Vitest) y TypeScript. Para las pruebas contra PostgreSQL y MySQL reales, mira la sección [Pruebas](README.md#pruebas) del README.

Las reglas de seguridad por ambiente (`crates/gridl-core/src/guard.rs`) se aplican en el backend. Cualquier comando nuevo que ejecute SQL del usuario tiene que pasar por `guard()` en `crates/gridl-desktop/src/commands.rs`.

No guardes contraseñas en `ConnectionConfig`, en logs ni en el JSON de perfiles. El secreto entra al llavero del sistema o vive en memoria solo durante la sesión.
