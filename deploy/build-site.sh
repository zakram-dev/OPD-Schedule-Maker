#!/bin/sh
# Builds the production copy of the site into $1 (default: ./dist):
#   - copies index.html, css/, js/
#   - downloads the free reading libraries (Tesseract, PDF.js, SheetJS) into vendor/
#   - points the page at those local copies, so phones never need outside CDNs
# Used by the Dockerfile; you can also run it by hand to test.
set -eu

OUT="${1:-dist}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
CDN="https://cdn.jsdelivr.net/npm"

TESS="5.1.1"        # tesseract.js
TESS_CORE="5.1.1"   # tesseract.js-core (the reading engine)
LANG_DATA="4.0.0_best_int"
PDFJS="3.11.174"
XLSX="0.18.5"

rm -rf "$OUT"
mkdir -p "$OUT/vendor/tesseract-core" "$OUT/vendor/lang"
cp "$SRC/index.html" "$OUT/"
cp -R "$SRC/css" "$SRC/js" "$OUT/"

fetch() { # url dest
  echo "  downloading $(basename "$2")"
  curl -fsSL --retry 3 -o "$2" "$1"
  [ -s "$2" ] || { echo "download failed: $1" >&2; exit 1; }
}

echo "Downloading reading libraries..."
fetch "$CDN/tesseract.js@$TESS/dist/tesseract.min.js" "$OUT/vendor/tesseract.min.js"
fetch "$CDN/tesseract.js@$TESS/dist/worker.min.js" "$OUT/vendor/worker.min.js"
for f in tesseract-core.wasm.js tesseract-core-simd.wasm.js tesseract-core-lstm.wasm.js tesseract-core-simd-lstm.wasm.js; do
  fetch "$CDN/tesseract.js-core@$TESS_CORE/$f" "$OUT/vendor/tesseract-core/$f"
done
fetch "$CDN/@tesseract.js-data/eng/$LANG_DATA/eng.traineddata.gz" "$OUT/vendor/lang/eng.traineddata.gz"
fetch "$CDN/pdfjs-dist@$PDFJS/build/pdf.min.js" "$OUT/vendor/pdf.min.js"
fetch "$CDN/pdfjs-dist@$PDFJS/build/pdf.worker.min.js" "$OUT/vendor/pdf.worker.min.js"
fetch "$CDN/xlsx@$XLSX/dist/xlsx.full.min.js" "$OUT/vendor/xlsx.full.min.js"

echo "Pointing the page at the local copies..."
sed -i.bak \
  -e "s#$CDN/tesseract.js@$TESS/dist/tesseract.min.js#vendor/tesseract.min.js#" \
  -e "s#$CDN/xlsx@$XLSX/dist/xlsx.full.min.js#vendor/xlsx.full.min.js#" \
  -e "s#$CDN/pdfjs-dist@$PDFJS/build/pdf.min.js#vendor/pdf.min.js#" \
  -e "s#<script src=\"js/time.js\"></script>#<script>window.WS_VENDOR = 'vendor/';</script>\n    <script src=\"js/time.js\"></script>#" \
  "$OUT/index.html"
rm -f "$OUT/index.html.bak"

if grep -q "cdn.jsdelivr.net" "$OUT/index.html"; then
  echo "index.html still points at the CDN; update the versions in this script" >&2
  exit 1
fi
echo "Built site in $OUT"
