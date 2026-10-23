#!/bin/sh
# Installs or updates Gridl on macOS from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/mfsa93/Gridl/master/install.sh | sh
#
# GRIDL_VERSION=v0.2.0 installs a specific release instead of the latest one.
# GRIDL_TARGET=~/Applications installs somewhere else (no admin rights needed).
# GRIDL_NO_OPEN=1 skips opening Gridl at the end.
set -eu

repo="mfsa93/Gridl"
app="Gridl.app"
target="${GRIDL_TARGET:-/Applications}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Gridl por ahora solo se instala en macOS."

if [ -n "${GRIDL_VERSION:-}" ]; then
  api="https://api.github.com/repos/${repo}/releases/tags/${GRIDL_VERSION}"
else
  api="https://api.github.com/repos/${repo}/releases/latest"
fi

say "Buscando la versión de Gridl…"
release=$(curl -fsSL "${api}") || fail "No encontré la release en GitHub (${api})."
version=$(printf '%s' "${release}" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
dmg_url=$(printf '%s' "${release}" | sed -n 's/.*"browser_download_url": *"\([^"]*\.dmg\)".*/\1/p' | head -n 1)
[ -n "${dmg_url}" ] || fail "La release ${version:-} no tiene un .dmg todavía. Si se acaba de publicar, espera a que termine de compilarse."

work=$(mktemp -d)
mount="${work}/volume"
cleanup() {
  hdiutil detach "${mount}" -quiet >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT INT TERM

say "Descargando Gridl ${version}…"
curl -fL --progress-bar "${dmg_url}" -o "${work}/Gridl.dmg"

mkdir -p "${mount}"
hdiutil attach "${work}/Gridl.dmg" -nobrowse -readonly -mountpoint "${mount}" -quiet
[ -d "${mount}/${app}" ] || fail "El .dmg no contiene ${app}."

# Close only the copy being replaced, not a Gridl running from somewhere else.
running="${target}/${app}/Contents/MacOS/"
if pgrep -f "${running}" >/dev/null 2>&1; then
  say "Cerrando Gridl para reemplazarlo…"
  pkill -TERM -f "${running}" || true
  sleep 2
fi

say "Instalando en ${target}…"
mkdir -p "${target}" 2>/dev/null || true
if [ -w "${target}" ]; then
  rm -rf "${target:?}/${app}"
  ditto "${mount}/${app}" "${target}/${app}"
else
  sudo rm -rf "${target:?}/${app}"
  sudo ditto "${mount}/${app}" "${target}/${app}"
fi
# Downloads through curl are not quarantined, but clear the flag in case a browser copy was there before.
xattr -dr com.apple.quarantine "${target}/${app}" 2>/dev/null || true

say "Listo: Gridl ${version} está en ${target}. Las próximas versiones se instalan desde la propia app."
[ -n "${GRIDL_NO_OPEN:-}" ] || open "${target}/${app}"
