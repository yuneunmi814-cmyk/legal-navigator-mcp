/**
 * data-raw/ 수집물 → 검색 동의어·체크리스트 항목 후보 추출.
 *
 * 핵심: 다 쓰지 않는다. 백문백답에 붙어있는 **추천수**로 걸러서
 *       실제로 도움이 된다고 평가받은 문답만 신호로 삼는다.
 *
 * 산출물
 *  - data-raw/qna_ranked.json  전체 문답 + 조회수·추천수 (정렬됨)
 *  - data-raw/patterns.md      사람이 읽고 고르는 후보 목록
 *
 * 실행:
 *   npx tsx scripts/extract_patterns.ts            # 추천수 상위 40%
 *   npx tsx scripts/extract_patterns.ts --min 500  # 추천수 500 이상만
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_SYNONYMS } from "../src/data/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data-raw");

type Item = { topic: string; book: string; kind: string; file: string; url: string };
type Qna = {
  topic: string;
  book: string;
  section: string;
  views: number;
  votes: number;
  /** 추천/조회 — 조회수 대비 얼마나 도움이 됐는지 */
  rate: number;
  question: string;
  answer: string;
  url: string;
};

const STOP = new Set([
  "경우", "있습니다", "있는", "없는", "대한", "관한", "따른", "따라", "다음",
  "해당", "통해", "위한", "위해", "그리고", "또는", "등의", "등을", "이하",
  "이상", "때에는", "하는", "되는", "합니다", "됩니다", "것", "바랍니다",
  "참조", "관련", "각각", "모두", "함께", "법률", "법령", "규정", "조항",
  "시행령", "시행규칙", "특별법", "내용", "사항", "정보", "가능", "필요",
  "조회수", "추천수", "그러나", "다만", "이러한", "무엇인가요", "어떻게",
]);

const existing = new Set(
  SEARCH_SYNONYMS.flatMap((s) => s.q).map((p) => p.replace(/\s/g, "")),
);

/** 형태소 분석기 없이 흔한 조사만 떼어낸다. 2글자 미만이 되면 원형 유지 */
function stripJosa(w: string): string {
  const cut = w.replace(
    /(으로|에서|에게|한테|부터|까지|보다|이|가|은|는|을|를|에|의|로|와|과|도|만)$/,
    "",
  );
  return cut.length >= 2 ? cut : w;
}

/** 의문형 어미로 끝나는 토큰은 용어가 아니다 */
const isEnding = (w: string) => /(나요|까요|는지요|가요|습니까|합니다|입니다)$/.test(w);

const tokenize = (s: string) =>
  s
    .replace(/[^가-힣a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .map((w) => stripJosa(w.trim()))
    .filter(
      (w) =>
        w.length >= 2 && w.length <= 12 && !STOP.has(w) && !isEnding(w),
    );

/**
 * 백문백답 파일 하나에서 문답 블록들을 뜯어낸다.
 * 형태:  <섹션명> / 조회수: N건 / 추천수: N건 / <질문> / <답변…>
 */
function parseQna(text: string, meta: Item): Qna[] {
  const lines = text.split("\n");
  const heads: number[] = [];
  lines.forEach((l, i) => {
    if (/^조회수:\s*[\d,]+건/.test(l)) heads.push(i);
  });

  const out: Qna[] = [];
  for (const [n, at] of heads.entries()) {
    const views = Number(lines[at].replace(/[^\d]/g, "")) || 0;
    const voteLine = lines[at + 1] ?? "";
    if (!/^추천수:/.test(voteLine)) continue;
    const votes = Number(voteLine.replace(/[^\d]/g, "")) || 0;

    // 섹션명: 조회수 줄 바로 위, 콜론으로 끝나는 분류줄은 건너뛴다
    let section = "";
    for (let i = at - 1; i >= 0 && i > at - 4; i--) {
      const l = lines[i].trim();
      if (l && !l.endsWith(":")) { section = l; break; }
    }

    const end = n + 1 < heads.length ? heads[n + 1] - 3 : lines.length;
    const bodyLines = lines.slice(at + 2, Math.max(at + 2, end));
    const question = (bodyLines[0] ?? "").trim();
    const answer = bodyLines.slice(1).join("\n").trim();
    if (question.length < 6) continue;

    out.push({
      topic: meta.topic,
      book: meta.book,
      section,
      views,
      votes,
      rate: views > 0 ? votes / views : 0,
      question,
      answer,
      url: meta.url,
    });
  }
  return out;
}

async function main() {
  const argMin = process.argv.indexOf("--min");
  const minVotes = argMin !== -1 ? Number(process.argv[argMin + 1]) : null;

  const index = JSON.parse(
    await readFile(join(RAW, "index.json"), "utf8"),
  ) as { items: Item[] };

  const all: Qna[] = [];
  for (const it of index.items.filter((i) => i.kind === "qna")) {
    const raw = await readFile(join(RAW, it.file), "utf8");
    all.push(...parseQna(raw.replace(/^---[\s\S]*?---\n/, ""), it));
  }
  all.sort((a, b) => b.votes - a.votes);

  // 선별: --min 이 있으면 절대 기준, 없으면 **주제별** 추천수 상위 40%.
  // 전체 기준 하나로 자르면 조회수가 압도적인 주제(경매)가 나머지를 다 밀어낸다.
  const cutByTopic = new Map<string, number>();
  for (const topic of new Set(all.map((q) => q.topic))) {
    const votes = all.filter((q) => q.topic === topic).map((q) => q.votes);
    cutByTopic.set(
      topic,
      minVotes ?? (votes[Math.floor(votes.length * 0.4)] ?? 0),
    );
  }
  const kept = all.filter((q) => q.votes >= (cutByTopic.get(q.topic) ?? 0));

  await writeFile(
    join(RAW, "qna_ranked.json"),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        total: all.length,
        cutByTopic: Object.fromEntries(cutByTopic),
        items: all,
      },
      null,
      2,
    ),
    "utf8",
  );

  // 고빈도 용어는 '선별된' 문답에서만 뽑는다
  const freq = new Map<string, number>();
  for (const q of kept) {
    for (const w of tokenize(`${q.question} ${q.section}`)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const candidates = [...freq.entries()]
    .filter(([w, n]) => n >= 3 && !existing.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120);

  const byTopic = new Map<string, Qna[]>();
  for (const q of kept) byTopic.set(q.topic, [...(byTopic.get(q.topic) ?? []), q]);

  const out: string[] = [
    "# 반응 기준 선별 결과",
    "",
    `- 전체 문답 ${all.length}건 → 주제별 추천수 상위 40% **${kept.length}건** 선별`,
    `- 생성: ${new Date().toISOString()}`,
    "",
    "> 후보 목록임. 사람이 확인하고 고를 것 — 자동 반영 금지.",
    "",
    "## 1. 반응 높은 질문 (주제별, 추천수순)",
    "",
  ];

  for (const [topic, qs] of [...byTopic].sort()) {
    out.push(
      `### ${topic} — ${qs.length}건 (추천수 ${cutByTopic.get(topic)} 이상)`,
      "",
    );
    out.push("| 추천 | 조회 | 질문 |", "| ---: | ---: | --- |");
    for (const q of qs) {
      out.push(`| ${q.votes} | ${q.views} | ${q.question.replace(/\|/g, "／")} |`);
    }
    out.push("");
  }

  out.push(
    "## 2. SEARCH_SYNONYMS 미등록 용어 (선별된 질문에서만)",
    "",
    "| 용어 | 질문 등장수 |",
    "| --- | ---: |",
    ...candidates.map(([w, n]) => `| ${w} | ${n} |`),
    "",
  );

  await writeFile(join(RAW, "patterns.md"), out.join("\n"), "utf8");

  console.log(`문답 ${all.length}건 파싱 → 추천수 ${cut} 이상 ${kept.length}건 선별`);
  console.log(`신규 용어 후보 ${candidates.length}개`);
  console.log("→ data-raw/patterns.md, data-raw/qna_ranked.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
