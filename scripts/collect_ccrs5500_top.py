import asyncio
import json
import re
import sys
from pathlib import Path
from playwright.async_api import async_playwright

STORAGE_STATE = "naver_login_state.json"  # 기존 스크립트와 동일한 로그인 세션 재사용
CAFE_URL_PATH = "ccrs5500"
BOARD_KEYWORDS = [
    "채무고민 상담",
    "연체전",
    "이자율",
    "채무조정",
    "개인회생",
    "개인파산",
    "채무관련",
]
MAX_PAGES_PER_BOARD = 10
TOP_N_PER_BOARD = 30
OUT_PATH = Path("ccrs5500_top_engagement.json")


async def discover_cafe(page):
    await page.goto(f"https://cafe.naver.com/{CAFE_URL_PATH}", wait_until="load", timeout=30000)
    await asyncio.sleep(2)
    html = await page.content()
    m = re.search(r'clubid=(\d+)', html) or re.search(r'"clubId"\s*:\s*"?(\d+)"?', html)
    if not m:
        raise RuntimeError("clubid를 찾지 못했습니다. 카페 페이지 구조를 확인하세요.")
    clubid = m.group(1)

    menus = []
    for frame in page.frames:
        try:
            fmenus = await frame.evaluate("""
                () => {
                    const links = document.querySelectorAll('a[href*="menuid="]');
                    const seen = new Set();
                    const result = [];
                    for (const a of links) {
                        const href = a.getAttribute('href') || '';
                        const m = href.match(/menuid=(\\d+)/);
                        if (!m) continue;
                        const title = a.textContent.trim();
                        if (!title || seen.has(m[1]+title)) continue;
                        seen.add(m[1]+title);
                        result.push({menuid: m[1], title});
                    }
                    return result;
                }
            """)
            menus.extend(fmenus)
        except Exception:
            pass
    return clubid, menus


def parse_stats(row_text: str):
    """목록 행 텍스트에서 조회수/댓글수/좋아요 추출.
    ponytail: 카페 스킨마다 DOM이 달라 정확한 컬럼 매칭 대신 휴리스틱을 씀 —
    행이 항상 "...날짜 조회수 좋아요" 순서로 끝나는 것에 기대어 마지막 두 숫자를 사용.
    "5.8만" 같은 만 단위 표기와 "[1,502]" 같은 콤마 포함 댓글수도 정규화해서 처리.
    상위 결과가 이상하면 raw_row_text를 보고 정규식을 카페 실제 구조에 맞게 조정할 것.
    """
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


async def collect_board(context, clubid, menu_id, label, top_n, results, seen_ids):
    page = await context.new_page()
    page_num = 1
    collected = 0
    while page_num <= MAX_PAGES_PER_BOARD and collected < top_n:
        url = (
            f"https://cafe.naver.com/f-e/cafes/{clubid}/menus/{menu_id}"
            f"?viewType=L&page={page_num}&sortBy=LIKE"
        )
        try:
            await page.goto(url, wait_until="load", timeout=30000)
            await asyncio.sleep(1.5)
        except Exception as e:
            print(f"  ⚠️ {label} {page_num}페이지 로딩 오류: {e}")
            break

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
                    const rowText = row ? row.innerText : '';
                    result.push({ articleId: m[1], title, rowText });
                }
                return result;
            }
        """)

        before = len(seen_ids)
        for row in rows:
            if row['articleId'] in seen_ids:
                continue
            seen_ids.add(row['articleId'])
            # 공지/필독 고정글은 목록 행이 글 번호 대신 "공지"/"필독" 라벨로 시작함 -> 정렬과 무관하게 항상 상단 고정이라 제외
            if not row['rowText'].lstrip().startswith(row['articleId']):
                continue
            if collected >= top_n:
                continue
            views, comments, likes = parse_stats(row['rowText'])
            results.append({
                "board": label,
                "article_id": row['articleId'],
                "title": row['title'],
                "likes": likes,
                "views": views,
                "comments": comments,
                "url": f"https://cafe.naver.com/{CAFE_URL_PATH}/{row['articleId']}",
                "raw_row_text": row['rowText'],
            })
            collected += 1
        if len(seen_ids) == before:
            print(f"  -> {page_num}페이지에 새 글이 없어 '{label}' 수집을 종료합니다.")
            break
        page_num += 1

    await page.close()


async def main(top_n_per_board: int):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)

        if Path(STORAGE_STATE).exists():
            context = await browser.new_context(storage_state=STORAGE_STATE)
        else:
            context = await browser.new_context()
            login_page = await context.new_page()
            await login_page.goto(f"https://cafe.naver.com/{CAFE_URL_PATH}")
            input("브라우저에서 네이버 로그인 + 카페 가입 확인 후 Enter를 눌러주세요...")
            await context.storage_state(path=STORAGE_STATE)
            await login_page.close()

        page = await context.new_page()
        clubid, menus = await discover_cafe(page)
        await page.close()

        target_menus = [m for m in menus if any(k in m['title'] for k in BOARD_KEYWORDS)]
        if not target_menus:
            print("⚠️ 지정한 키워드와 일치하는 게시판을 찾지 못했습니다. 카페 전체 메뉴 목록:")
            for m in menus:
                print(m)
            await browser.close()
            return

        print(f"클럽ID: {clubid}")
        print("대상 게시판:")
        for m in target_menus:
            print(f"  - {m['title']} (menuid={m['menuid']})")

        results = []
        seen_ids = set()
        for m in target_menus:
            print(f"\n▶ '{m['title']}' 좋아요순 상위 {top_n_per_board}개 수집 중...")
            await collect_board(context, clubid, m['menuid'], m['title'], top_n_per_board, results, seen_ids)

        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

        print(f"\n🎉 게시판 {len(target_menus)}개 x 최대 {top_n_per_board}개 = 총 {len(results)}개를 '{OUT_PATH}'에 저장했습니다.")
        await browser.close()


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else TOP_N_PER_BOARD
    asyncio.run(main(n))
