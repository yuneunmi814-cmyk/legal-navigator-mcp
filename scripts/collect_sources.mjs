#!/usr/bin/env node
/**
 * 공식 소스 수집기 — 찾기쉬운 생활법령정보(easylaw.go.kr) 중심.
 *
 * 목적: 전세사기·개인회생·경매 주제의 절차·요건·서류 정보를 data-raw/ 에 모아
 *       SEARCH_SYNONYMS 보강 / 체크리스트 항목 후보 추출의 원본으로 삼는다.
 *
 * 설계 원칙
 *  - 수집물은 data-raw/ (gitignore) 에만 쓰고 레포에 커밋하지 않는다.
 *  - 요청 사이 딜레이를 둬서 대상 서버에 부담을 주지 않는다.
 *  - robots.txt 를 존중하는 대상만 목록에 넣는다(easylaw/HUG: * 허용, ccrs: robots 없음).
 *
 * 사용법:
 *   node scripts/collect_sources.mjs            # 전체 수집
 *   node scripts/collect_sources.mjs 1286       # 특정 csmSeq 만
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data-raw");

/** 수집 대상 — easylaw 책자형 콘텐츠 (csmSeq 단위로 하위 페이지 전체를 자동 탐색) */
const BOOKS = [
  { csmSeq: 1972, topic: "jeonse", name: "전세사기 피해자 지원" },
  { csmSeq: 1286, topic: "rehab", name: "개인회생절차" },
  { csmSeq: 306, topic: "auction", name: "부동산 경매" },
  { csmSeq: 629, topic: "lease", name: "주택임대차" },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DELAY_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return await res.text();
}

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&middot;": "·",
};

/** HTML 조각 → 읽을 수 있는 평문. 표는 ` | ` 구분으로 살린다. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<label class="labelnone">[\s\S]*?<\/label>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(?:div|p|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l.length > 0 && !BOILERPLATE.some((re) => re.test(l)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** 모든 페이지 하단에 붙는 고지문 — 신호가 아니라 잡음이다 */
const BOILERPLATE = [
  /^-+$/,
  /^이 정보는 .*기준으로 작성된 것입니다/,
  /^생활법령정보는 법적 효력/,
  /^구체적인 법령에 대한 질의는/,
  /^위 내용에 대한 홈페이지 개선의견은/,
];

/** 실제 문답이 들어있는지 — 고지문만 남은 껍데기를 걸러낸다 */
const hasQna = (t) => /(?:^|\n)\s*Q[.\s]/.test(t) || t.includes("?");

/**
 * id 로 지정한 div 의 내용만 잘라낸다 (여는/닫는 태그 수를 세어 정확히 매칭).
 * 본문은 #ovDiv, 백문백답은 #onhunqnaDiv 에 들어있다.
 */
function extractBody(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at === -1) return null;
  const from = html.indexOf(">", at) + 1;

  const tag = /<(\/?)div\b/gi;
  tag.lastIndex = from;
  let depth = 1;
  for (let m; (m = tag.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

/** 좌측 목차에서 같은 csmSeq 의 하위 페이지 URL 을 모두 뽑는다 */
function discoverPages(html, csmSeq) {
  const re = new RegExp(
    `CnpClsMain\\.laf\\?popMenu=ov&(?:amp;)?csmSeq=${csmSeq}` +
      `&(?:amp;)?ccfNo=(\\d+)&(?:amp;)?cciNo=(\\d+)&(?:amp;)?cnpClsNo=(\\d+)`,
    "g",
  );
  const seen = new Map();
  for (const m of html.matchAll(re)) {
    const key = `${m[1]}_${m[2]}_${m[3]}`;
    if (!seen.has(key)) {
      seen.set(key, { ccfNo: m[1], cciNo: m[2], cnpClsNo: m[3] });
    }
  }
  return [...seen.values()];
}

const pageUrl = (csmSeq, p) =>
  `https://www.easylaw.go.kr/CSP/CnpClsMain.laf?popMenu=ov&csmSeq=${csmSeq}` +
  `&ccfNo=${p.ccfNo}&cciNo=${p.cciNo}&cnpClsNo=${p.cnpClsNo}`;

async function collectBook(book, manifest) {
  const seedUrl = pageUrl(book.csmSeq, { ccfNo: 1, cciNo: 1, cnpClsNo: 1 });
  process.stdout.write(`\n[${book.name}] 목차 탐색… `);
  const seed = await get(seedUrl);
  const pages = discoverPages(seed, book.csmSeq);
  console.log(`${pages.length}개 페이지`);

  const dir = join(OUT, book.topic);
  await mkdir(dir, { recursive: true });

  const save = async (slug, kind, title, url, text) => {
    const front = [
      "---",
      `title: ${title}`,
      `kind: ${kind}`,
      `book: ${book.name}`,
      `topic: ${book.topic}`,
      `url: ${url}`,
      `fetched: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n");
    const file = `${slug}${kind === "qna" ? "_qna" : ""}.md`;
    await writeFile(join(dir, file), front + text, "utf8");
    manifest.push({
      topic: book.topic,
      book: book.name,
      kind,
      title,
      url,
      file: `${book.topic}/${file}`,
      chars: text.length,
    });
  };

  let ok = 0;
  for (const [i, p] of pages.entries()) {
    const url = pageUrl(book.csmSeq, p);
    const slug = `${book.csmSeq}_${p.ccfNo}_${p.cciNo}_${p.cnpClsNo}`;
    try {
      const html = i === 0 ? seed : await get(url);
      const body = extractBody(html, "ovDiv");
      if (!body) {
        console.log(`  ! ${slug} 본문 없음 (건너뜀)`);
        continue;
      }
      const text = htmlToText(body);
      // 본문 첫 줄이 곧 소제목이다 (예: "개인회생절차 개념 및 신청자격")
      const title = text.split("\n", 1)[0].slice(0, 80) || slug;
      await save(slug, "body", title, url, text);
      ok++;
      process.stdout.write(`  ✓ ${title}`);

      // 백문백답 — 실제로 사람들이 묻는 질문. 있는 페이지에만 붙어 있다.
      await sleep(DELAY_MS);
      const qnaUrl = `${url}&menuType=onhunqna`;
      const qnaBody = extractBody(await get(qnaUrl), "onhunqnaDiv");
      const qna = qnaBody ? htmlToText(qnaBody) : "";
      if (qna.length > 200 && hasQna(qna)) {
        await save(slug, "qna", title, qnaUrl, qna);
        ok++;
        process.stdout.write(`  + 백문백답 ${(qna.length / 1024).toFixed(1)}KB`);
      }
      process.stdout.write("\n");
    } catch (e) {
      console.log(`  ✗ ${slug} — ${e.message}`);
    }
    if (i < pages.length - 1) await sleep(DELAY_MS);
  }
  return ok;
}

async function main() {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const books = only.length
    ? BOOKS.filter((b) => only.includes(b.csmSeq))
    : BOOKS;

  await mkdir(OUT, { recursive: true });
  const manifest = [];
  let total = 0;
  const started = Date.now();

  for (const book of books) {
    try {
      total += await collectBook(book, manifest);
    } catch (e) {
      console.error(`[${book.name}] 실패 — ${e.message}`);
    }
  }

  await writeFile(
    join(OUT, "index.json"),
    JSON.stringify(
      { collected: new Date().toISOString(), count: manifest.length, items: manifest },
      null,
      2,
    ),
    "utf8",
  );

  const bytes = manifest.reduce((s, m) => s + m.chars, 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n완료 — ${total}개 페이지, 본문 ${(bytes / 1024).toFixed(0)}KB, ${secs}초`,
  );
  console.log(`목록: data-raw/index.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
