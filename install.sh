#!/bin/bash
set -e

PLUGIN_DIR="$HOME/.local/share/cockpit/openshift-overview"
REPO="https://github.com/samjage/cockpit-openshift-overview.git"

mkdir -p "$PLUGIN_DIR"
TMPDIR=$(mktemp -d)
git clone --depth 1 "$REPO" "$TMPDIR/repo"
cp "$TMPDIR/repo/manifest.json" "$TMPDIR/repo/index.html" \
   "$TMPDIR/repo/app.js" "$TMPDIR/repo/style.css" "$PLUGIN_DIR/"
rm -rf "$TMPDIR"

echo "Installed to $PLUGIN_DIR"
echo "Reload Cockpit in your browser (Ctrl+Shift+R)."
