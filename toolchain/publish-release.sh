#!/usr/bin/env bash
# Upload public/toolchain/ as a GitHub Release and point the site at it
# (toolchain/RELEASE), for .github/workflows/pages.yml.
#
#   toolchain/publish-release.sh            # after toolchain/build-all.sh
#
# Needs the GitHub CLI, logged in: brew install gh && gh auth login
# Then commit and push toolchain/RELEASE to deploy the site with it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/../public/toolchain"
command -v gh >/dev/null || { echo "Needs the GitHub CLI: brew install gh && gh auth login" >&2; exit 1; }
[[ -f "$DIR/manifest.json" ]] || { echo "No toolchain in $DIR; run toolchain/build-all.sh first" >&2; exit 1; }

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DIR/manifest.json")"
TAG="toolchain-$VERSION"
FILES=(llvm.wasm ld.wasm sysroot.tar.gz sysroot-usb.tar.gz bootloader.bin partition-table.bin manifest.json examples.json builtin-libraries.json)
for f in "${FILES[@]}"; do [[ -f "$DIR/$f" ]] || { echo "Missing $DIR/$f" >&2; exit 1; }; done

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG exists; replacing its files."
  (cd "$DIR" && gh release upload "$TAG" "${FILES[@]}" --clobber)
else
  (cd "$DIR" && gh release create "$TAG" "${FILES[@]}" \
    --title "Toolchain $VERSION" \
    --notes "Browser toolchain for esp-wasm (clang + GNU ld as WebAssembly, precompiled ESP-IDF + Arduino). Built with toolchain/build-all.sh.")
fi
echo "$TAG" > "$HERE/RELEASE"
echo "Published $TAG. Commit and push toolchain/RELEASE to deploy the site with it."
