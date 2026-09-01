#!/usr/bin/env bash
# 서식 121종을 한 장씩 PNG로 뽑는다. 눈으로 훑을 때 브라우저를 121번 여는 대신
# 이미지 폴더를 넘기면서 겹침·잘림·빈칸 누락만 빠르게 본다.
#   사용법:  bash scripts/capture-forms.sh [출력폴더]
set -euo pipefail
OUT="${1:-$HOME/Downloads/서식리뷰_$(date +%m%d)}"
PORT=4321
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "크롬을 찾을 수 없습니다: $CHROME"; exit 1; }

mkdir -p "$OUT"
npm run build >/dev/null 2>&1
WIDGETS=on PORT=$PORT node dist/server.js >/tmp/capture-forms.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -s -m 2 "http://localhost:$PORT/mcp" -o /dev/null && break; sleep 1; done

KEYS=$(node -e 'import("./dist/data/index.js").then(m=>console.log(m.FORM_KEYS.join("\n")))')
TOTAL=$(echo "$KEYS" | wc -l | tr -d ' ')
n=0
while IFS= read -r key; do
  n=$((n+1))
  safe=$(printf '%s' "$key" | tr '/' '_')
  url="http://localhost:$PORT/forms/$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$key")"
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=900,2400 \
    --screenshot="$OUT/$(printf '%03d' $n)_$safe.png" "$url" >/dev/null 2>&1 || echo "  ⚠️ 실패: $key"
  printf "\r  %3d/%s  %s" "$n" "$TOTAL" "$key                    "
done <<< "$KEYS"
echo ""
echo "완료 → $OUT ($(ls "$OUT" | wc -l | tr -d ' ')장)"
