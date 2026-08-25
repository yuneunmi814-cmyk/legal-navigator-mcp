import asyncio
import json
import re
import sys
import webbrowser
from pathlib import Path
from playwright.async_api import async_playwright

STORAGE_STATE = "naver_login_state.json"  # 기존 collect_ccrs5500_top.py와 동일한 로그인 세션 재사용
CLUBID = "20135031"
BOARDS = [
    ("192", "전세사기 / 일반형사 1:1 문의"),
    ("118", "반환보증 Q&A"),
    ("119", "전세피해 Q&A"),
]
MAX_PAGES = 10
TOP_N = 30
OUT_JSON = Path("cafe20135031_top_engagement.json")
OUT_HTML = Path("cafe20135031_top_engagement.html")


def parse_stats(row_text: str):
    """collect_ccrs5500_top.py와 동일한 휴리스틱: 만 단위·콤마 댓글수 정규화 후
    행 끝 숫자 2개(조회수, 좋아요) 사용 — 최댓값이 글 번호일 수 있어 최댓값 방식은 쓰지 않음."""
    comments = 0
    cm = re.search(r'\[([\d,]+)\]', row_text)
    if cm:
        comments = int(cm.group(1).replace(',', ''))

    def expand_man(m):
        return str(int(float(m.group(1)) * 10000))

    normalized = re.sub(r'(\d+(?:\.\d+)?)만', expand_man, row_text.replace(',', ''))
    numbers = re.findall(r'\d+', normalized)
    views = int(numbers[-2]) if len(numbers) >= 2 else 0
    likes = int(numbers[-1]) if numbers else 0
    return views, comments, likes


async def collect_board(context, menu_id, label, top_n):
    page = await context.new_page()
    results = []
    seen_ids = set()
    page_num = 1
    while page_num <= MAX_PAGES and len(results) < top_n:
        url = (
            f"https://cafe.naver.com/f-e/cafes/{CLUBID}/menus/{menu_id}"
            f"?viewType=L&page={page_num}&sortBy=LIKE"
        )
        await page.goto(url, wait_until="load", timeout=30000)
        await asyncio.sleep(1.5)

        rows = await page.evaluate("""
            () => {
                const anchors = document.querySelectorAll('a[href*="/articles/"]');
                const result = [];
                for (const a of anchors) {
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/\\/articles\\/(\\d+)/);
                    if (!m) continue;
                    const title = a.textContent.trim();
                    if (!title) continue;
                    const row = a.closest('tr') || a.closest('li') || a.parentElement;
                    result.push({ articleId: m[1], title, rowText: row ? row.innerText : '' });
                }
                return result;
            }
        """)

        before = len(seen_ids)
        for row in rows:
            if row['articleId'] in seen_ids:
                continue
            seen_ids.add(row['articleId'])
            # 공지/필독 고정글은 행이 글 번호 대신 라벨로 시작 -> 스킵
            if not row['rowText'].lstrip().startswith(row['articleId']):
                continue
            if len(results) >= top_n:
                continue
            views, comments, likes = parse_stats(row['rowText'])
            results.append({
                "board": label,
                "article_id": row['articleId'],
                "title": row['title'],
                "likes": likes,
                "views": views,
                "comments": comments,
                "url": f"https://cafe.naver.com/f-e/cafes/{CLUBID}/articles/{row['articleId']}?menuid={menu_id}",
                "raw_row_text": row['rowText'],
            })
        if len(seen_ids) == before:
            print(f"  -> {page_num}페이지에 새 글이 없어 '{label}' 수집을 종료합니다.")
            break
        page_num += 1

    await page.close()
    return results


def write_html(results):
    OUT_HTML.write_text(f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>cafe {CLUBID} 참여도 상위 글</title>
<style>
  body {{ font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 24px; background: #f7f7f8; color: #222; }}
  h1 {{ font-size: 18px; }}
  table {{ border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); }}
  th, td {{ border-bottom: 1px solid #eee; padding: 8px 10px; text-align: left; font-size: 14px; vertical-align: top; }}
  th {{ background: #fafafa; position: sticky; top: 0; }}
  td.num {{ text-align: right; white-space: nowrap; }}
  a {{ color: #06c; text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  .board {{ color: #888; font-size: 12px; }}
</style>
</head>
<body>
<h1>cafe.naver.com/f-e/cafes/{CLUBID} — 게시판별 좋아요순 상위 글 (공지 제외)</h1>
<table id="t">
<thead><tr><th>#</th><th>게시판</th><th>제목</th><th class="num">좋아요</th><th class="num">조회수</th><th class="num">댓글수</th></tr></thead>
<tbody></tbody>
</table>
<script>
const data = {json.dumps(results, ensure_ascii=False)};
const tbody = document.querySelector('#t tbody');
data.forEach((r, i) => {{
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${{i + 1}}</td>
    <td class="board">${{r.board}}</td>
    <td><a href="${{r.url}}" target="_blank" rel="noopener">${{r.title}}</a></td>
    <td class="num">${{r.likes.toLocaleString()}}</td>
    <td class="num">${{r.views.toLocaleString()}}</td>
    <td class="num">${{r.comments.toLocaleString()}}</td>
  `;
  tbody.appendChild(tr);
}});
</script>
</body>
</html>
""", encoding="utf-8")


async def main(top_n: int):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)

        if Path(STORAGE_STATE).exists():
            context = await browser.new_context(storage_state=STORAGE_STATE)
        else:
            context = await browser.new_context()
            login_page = await context.new_page()
            await login_page.goto(f"https://cafe.naver.com/f-e/cafes/{CLUBID}/menus/{BOARDS[0][0]}")
            input("브라우저에서 네이버 로그인 + 카페 가입 확인 후 Enter를 눌러주세요...")
            await context.storage_state(path=STORAGE_STATE)
            await login_page.close()

        print(f"클럽ID: {CLUBID}, 게시판 {len(BOARDS)}개, 게시판당 좋아요순 상위 {top_n}개 수집 중...")
        results = []
        for menu_id, label in BOARDS:
            print(f"▶ '{label}' 수집 중...")
            results.extend(await collect_board(context, menu_id, label, top_n))

        OUT_JSON.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        write_html(results)

        print(f"🎉 {len(results)}개를 '{OUT_JSON}' / '{OUT_HTML}'에 저장했습니다.")
        await browser.close()

    webbrowser.open(OUT_HTML.resolve().as_uri())


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else TOP_N
    asyncio.run(main(n))
