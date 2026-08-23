"""
ccrs5500_top_engagement.json(좋아요순 수집 결과)에서 최근 N일 이내 글의 제목을 토큰화해,
legal-navigator-mcp의 src/data/*.ts 전체 텍스트에 아직 없는 고빈도 키워드를 찾는다.

글 내용을 데이터로 넣는 게 아니라 "이런 주제가 자주 나오는데 MCP에 없다"는 신호만 뽑는 용도.
"""
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

RESULT_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ccrs5500_top_engagement.json")
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
MIN_FREQ = int(sys.argv[3]) if len(sys.argv) > 3 else 2

DATA_DIR = Path(__file__).resolve().parent.parent / "src" / "data"

STOPWORDS = {
    "관련", "질문", "문의", "궁금", "궁금해요", "합니다", "했어요", "인가요", "될까요",
    "하는", "대한", "대해", "그리고", "에서", "으로", "부터", "까지", "있나요", "있을까요",
    "정도", "생각", "이런", "저런", "그냥", "혹시", "제가", "저는", "여러분", "감사합니다",
}
TOKEN_RE = re.compile(r"[가-힣]{2,}")


def parse_date(raw_row_text: str):
    m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})\.", raw_row_text)
    if m:
        y, mo, d = map(int, m.groups())
        return datetime(y, mo, d)
    # 날짜 없이 시각만 표시되면(예: "13:45") 오늘 작성된 글
    if re.search(r"\b\d{1,2}:\d{2}\b", raw_row_text):
        return datetime.now()
    return None


def load_known_text() -> str:
    return "".join(f.read_text(encoding="utf-8") for f in DATA_DIR.glob("*.ts"))


def tokenize(title: str):
    return [w for w in TOKEN_RE.findall(title) if w not in STOPWORDS]


def main():
    posts = json.loads(RESULT_PATH.read_text(encoding="utf-8"))
    cutoff = datetime.now() - timedelta(days=DAYS)
    known = load_known_text()

    recent = [p for p in posts if (d := parse_date(p.get("raw_row_text", ""))) and d >= cutoff]
    print(f"전체 {len(posts)}개 중 최근 {DAYS}일 이내 글: {len(recent)}개\n")

    counter = Counter()
    examples = {}
    for p in recent:
        for w in tokenize(p["title"]):
            counter[w] += 1
            examples.setdefault(w, p["title"])

    gaps = sorted(
        ((w, c) for w, c in counter.items() if c >= MIN_FREQ and w not in known),
        key=lambda x: -x[1],
    )

    if not gaps:
        print(f"빈도 {MIN_FREQ}회 이상이면서 MCP 데이터에 없는 키워드가 없습니다.")
        return

    print(f"MCP 데이터에 없는 키워드 (빈도 {MIN_FREQ}회 이상):\n")
    for w, c in gaps:
        print(f"- {w} ({c}회) 예: {examples[w]}")


if __name__ == "__main__":
    main()
