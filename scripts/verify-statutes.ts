/**
 * 저장소 전수 대조 — 법제처 국가법령정보 Open API로 STATUTES·PRECEDENTS의 실존을 확인한다.
 *
 *   npx tsx scripts/verify-statutes.ts            # 전체
 *   npx tsx scripts/verify-statutes.ts --statutes # 법령만
 *   npx tsx scripts/verify-statutes.ts --precedents
 *   LAW_OC=내OC npx tsx scripts/verify-statutes.ts --no-cache
 *
 * ⚠️ 오프라인 감사 전용이다. 도구 핫패스에서 부르지 말 것(카카오 응답속도 요건).
 *
 * 판정 원칙 — 미확인을 '없음'으로 낙인하지 않는다:
 *   ✗ 는 "법령은 실존하는데 그 조문이 없다"처럼 **원천에서 부재가 확인된** 경우에만 붙인다.
 *   법제처 판례 DB는 하급심 수록률이 낮으므로, 판례 미검색은 ✗가 아니라 ⚠(미확인)이다.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATUTES, PRECEDENTS } from "../src/data/index.js";
import { ALIAS_GROUPS, caseCore, matchCaseNumber, normalizeLawName } from "../src/citation.js";

const OC = process.env.LAW_OC || "test"; // OC=test는 인증 없이 열리는 공개 테스트 계정
const BASE = "https://www.law.go.kr/DRF";
const CACHE_DIR = ".lawcache";
const USE_CACHE = !process.argv.includes("--no-cache");
const DELAY_MS = 250; // 공공 API 배려 — 258건 기준 약 1분
const OUT_DIR = "audit";

type Verdict = "OK" | "ARTICLE_NOT_FOUND" | "LAW_NOT_FOUND" | "MISMATCH" | "UNVERIFIED" | "API_ERROR";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cacheKey(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return join(CACHE_DIR, `${(h >>> 0).toString(36)}.json`);
}

async function fetchJson(url: string): Promise<any> {
  const path = cacheKey(url);
  if (USE_CACHE && existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(json));
      await sleep(DELAY_MS);
      return json;
    } catch (e) {
      last = e;
      await sleep(800);
    }
  }
  throw last;
}

// ── 법령 조문 ────────────────────────────────────────────────

/** "제10조의4" → "001004" (조 4자리 + 가지 2자리) */
function buildJO(article: string): string | undefined {
  const m = normalizeLawName(article).match(/^제(\d+)조(?:의(\d+))?$/);
  if (!m) return undefined;
  return String(m[1]).padStart(4, "0") + String(m[2] ?? 0).padStart(2, "0");
}

/** 저장 법령명 + 별칭들. 우리는 통용 약칭으로 적어둔 게 많은데 API는 정식 제명만 받는다. */
function nameCandidates(stored: string): string[] {
  const base = normalizeLawName(stored);
  const group = ALIAS_GROUPS.find((g) => g.some((n) => normalizeLawName(n) === base));
  return [...new Set([stored, ...(group ?? [])])];
}

interface StatuteResult {
  법령: string;
  조문: string;
  verdict: Verdict;
  정식제명?: string;
  조문제목?: string;
  시행일?: string;
  note?: string;
}

async function checkStatute(s: { 법령: string; 조문: string; 요지: string }): Promise<StatuteResult> {
  const jo = buildJO(s.조문);
  if (!jo) return { 법령: s.법령, 조문: s.조문, verdict: "MISMATCH", note: "조문 표기를 파싱하지 못함" };

  let lawSeen = false;
  for (const name of nameCandidates(s.법령)) {
    const url = `${BASE}/lawService.do?OC=${OC}&target=law&type=JSON&LM=${encodeURIComponent(name)}&JO=${jo}`;
    let data: any;
    try {
      data = await fetchJson(url);
    } catch (e) {
      return { 법령: s.법령, 조문: s.조문, verdict: "API_ERROR", note: String(e) };
    }
    const law = data?.법령;
    if (!law) continue; // "일치하는 법령이 없습니다" → 다음 별칭
    lawSeen = true;

    const 정식제명 = law.기본정보?.법령명_한글;
    const raw = law.조문?.조문단위;
    if (!raw) {
      return { 법령: s.법령, 조문: s.조문, verdict: "ARTICLE_NOT_FOUND", 정식제명, note: "법령은 실존하나 해당 조문이 없음" };
    }
    // 응답 배열의 첫 단위는 장·절 제목(조문여부="전문")이 오는 일이 잦다 — 실제 조문만 남긴다.
    const units: any[] = (Array.isArray(raw) ? raw : [raw]).filter((u) => u?.조문여부 !== "전문");
    if (!units.length) {
      return { 법령: s.법령, 조문: s.조문, verdict: "ARTICLE_NOT_FOUND", 정식제명, note: "장·절 제목만 반환됨(해당 조문 없음)" };
    }
    // 가지조문 오조회 방지 — 돌아온 본문이 정말 그 조문인지 표기로 재확인
    const expected = normalizeLawName(s.조문);
    const one = units.find((u) => normalizeLawName(u.조문내용 ?? "").startsWith(expected));
    if (!one) {
      const body = String(units[0].조문내용 ?? "").trim();
      return { 법령: s.법령, 조문: s.조문, verdict: "MISMATCH", 정식제명, note: `응답 본문이 다른 조문: ${body.slice(0, 40)}` };
    }
    return { 법령: s.법령, 조문: s.조문, verdict: "OK", 정식제명, 조문제목: one.조문제목, 시행일: one.조문시행일자 };
  }
  return {
    법령: s.법령,
    조문: s.조문,
    verdict: lawSeen ? "ARTICLE_NOT_FOUND" : "LAW_NOT_FOUND",
    note: lawSeen ? undefined : "법령명으로 조회되지 않음 — 약칭이면 citation.ts의 ALIAS_GROUPS에 정식 제명을 추가",
  };
}

// ── 판례 ─────────────────────────────────────────────────────

interface PrecResult {
  사건번호: string;
  주제: string;
  저장법원: string;
  verdict: Verdict;
  법원?: string;
  선고일?: string;
  사건명?: string;
  note?: string;
}

async function checkPrecedent(no: string, 주제: string, 저장법원: string): Promise<PrecResult> {
  const core = caseCore(no);
  // 헌재 결정례는 판례(prec)가 아니라 별도 타깃(detc)에 있다 — 여기서 갈라주지 않으면
  // 실존하는 헌재 결정이 전부 '미확인'으로 떨어진다.
  const 헌재 = /헌[가나다라마바사아자차카타파하]/.test(core);
  const target = 헌재 ? "detc" : "prec";
  // nb=는 사건번호 전용 검색이라 정확하다. query=는 자유문 검색이라 본문에 번호가 언급된
  // 무관한 판례만 잔뜩 물어오고 정작 그 사건은 놓치는 일이 있다(97도597이 그랬다).
  // nb로 못 찾으면 query로 한 번 더 — '본문 인용만 있음'과 '아예 없음'을 구분하기 위함.
  const urls = [
    `${BASE}/lawSearch.do?OC=${OC}&target=${target}&type=JSON&nb=${encodeURIComponent(core)}&display=100`,
    `${BASE}/lawSearch.do?OC=${OC}&target=${target}&type=JSON&query=${encodeURIComponent(core)}&display=100`,
  ];
  const items: any[] = [];
  for (const url of urls) {
    let data: any;
    try {
      data = await fetchJson(url);
    } catch (e) {
      return { 사건번호: no, 주제, 저장법원, verdict: "API_ERROR", note: String(e) };
    }
    const raw = (헌재 ? data?.DetcSearch?.Detc : data?.PrecSearch?.prec) ?? [];
    items.push(...(Array.isArray(raw) ? raw : [raw]));
    if (items.some((p) => p?.사건번호 && matchCaseNumber(core, String(p.사건번호)))) break;
  }
  // 검색은 본문에 사건번호가 언급된 판례까지 물어온다 — 사건번호가 실제로 일치하는 건만 채택.
  const hit = items.find((p) => p?.사건번호 && matchCaseNumber(core, String(p.사건번호)));
  if (!hit) {
    return {
      사건번호: no,
      주제,
      저장법원,
      verdict: "UNVERIFIED",
      note: items.length ? "본문 인용만 검색됨(해당 판례 자체는 미수록)" : "법제처 판례DB에서 미검색 — 하급심은 수록률이 낮아 '없음'을 뜻하지 않음",
    };
  }
  const 법원 = 헌재 ? "헌법재판소" : String(hit.법원명 ?? "");
  const mismatch = !!법원 && !!저장법원 && !저장법원.includes(법원) && !법원.includes(저장법원.replace(/\s/g, ""));
  return {
    사건번호: no,
    주제,
    저장법원,
    verdict: mismatch ? "MISMATCH" : "OK",
    법원,
    선고일: hit.선고일자 ?? hit.종국일자,
    사건명: hit.사건명,
    note: mismatch ? `법원명 불일치 — 저장 '${저장법원}' vs 법제처 '${법원}'` : undefined,
  };
}

// ── 실행 ─────────────────────────────────────────────────────

const ICON: Record<Verdict, string> = {
  OK: "✅",
  ARTICLE_NOT_FOUND: "❌",
  LAW_NOT_FOUND: "❌",
  MISMATCH: "🟠",
  UNVERIFIED: "⚠️",
  API_ERROR: "🔌",
};

function tally<T extends { verdict: Verdict }>(rows: T[]) {
  const t = {} as Record<Verdict, number>;
  for (const r of rows) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
  return t;
}

async function main() {
  const only = process.argv.find((a) => a === "--statutes" || a === "--precedents");
  const doStatutes = only !== "--precedents";
  const doPrecedents = only !== "--statutes";
  const out: string[] = ["# 저장소 전수 대조 (법제처 Open API)", ""];
  let failed = 0;

  if (doStatutes) {
    process.stderr.write(`법령 조문 ${STATUTES.length}건 대조 중…\n`);
    const rows: StatuteResult[] = [];
    for (const [i, s] of STATUTES.entries()) {
      const r = await checkStatute(s);
      rows.push(r);
      process.stderr.write(`\r  ${i + 1}/${STATUTES.length} ${ICON[r.verdict]} ${r.법령} ${r.조문}          `);
    }
    process.stderr.write("\n");
    const t = tally(rows);
    failed += (t.ARTICLE_NOT_FOUND ?? 0) + (t.LAW_NOT_FOUND ?? 0) + (t.MISMATCH ?? 0);
    out.push(`## 법령 조문 ${rows.length}건`, "", `- ✅ 실존확인 ${t.OK ?? 0} · ❌ 부재 ${(t.ARTICLE_NOT_FOUND ?? 0) + (t.LAW_NOT_FOUND ?? 0)} · 🟠 불일치 ${t.MISMATCH ?? 0} · 🔌 조회실패 ${t.API_ERROR ?? 0}`, "");
    const bad = rows.filter((r) => r.verdict !== "OK");
    if (bad.length) {
      out.push("### 확인 필요", "", "| 저장 법령 | 조문 | 판정 | 비고 |", "|---|---|---|---|");
      for (const r of bad) out.push(`| ${r.법령} | ${r.조문} | ${ICON[r.verdict]} ${r.verdict} | ${r.note ?? ""} |`);
      out.push("");
    }
    // 법제처 기본 조회는 '최신 공포본'을 준다. 조문시행일자가 미래면 그 법령에 시행예정 개정이
    // 걸려 있다는 뜻이다(그 조문 자체가 바뀐다는 뜻은 아니다). law_updates에 넣을 재료.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const pending = [...new Map(rows.filter((r) => r.시행일 && r.시행일 > today).map((r) => [r.법령, r.시행일!])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (pending.length) {
      out.push(
        "### 시행예정 개정을 안고 있는 법령 (오늘 기준)",
        "",
        "> 법제처 기본 조회 = 최신 공포본. 아래 법령은 공포됐지만 아직 시행 전인 개정이 걸려 있다.",
        "> 해당 조문 자체의 개정 여부는 조문별로 확인할 것.",
        "",
        ...pending.map(([law, d]) => `- ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)} 시행 — **${law}**`),
        "",
      );
    }
    const 별칭필요 = rows.filter((r) => r.verdict === "OK" && r.정식제명 && normalizeLawName(r.정식제명) !== normalizeLawName(r.법령));
    if (별칭필요.length) {
      const uniq = [...new Map(별칭필요.map((r) => [r.법령, r.정식제명!])).entries()];
      out.push("### 약칭으로 저장된 법령 (정식 제명 병기 후보)", "", ...uniq.map(([a, b]) => `- \`${a}\` → ${b}`), "");
    }
    writeFileSync(join(OUT_DIR, "statutes.json"), JSON.stringify(rows, null, 1));
  }

  if (doPrecedents) {
    const entries: Array<[string, string, string]> = [];
    const seen = new Set<string>();
    for (const [k, arr] of Object.entries(PRECEDENTS)) {
      for (const p of arr) {
        if (seen.has(p.사건번호)) continue;
        seen.add(p.사건번호);
        entries.push([p.사건번호, k, p.법원]);
      }
    }
    process.stderr.write(`판례 ${entries.length}건 대조 중…\n`);
    const rows: PrecResult[] = [];
    for (const [i, [no, k, court]] of entries.entries()) {
      const r = await checkPrecedent(no, k, court);
      rows.push(r);
      process.stderr.write(`\r  ${i + 1}/${entries.length} ${ICON[r.verdict]} ${no}          `);
    }
    process.stderr.write("\n");
    const t = tally(rows);
    failed += t.MISMATCH ?? 0; // UNVERIFIED는 실패가 아니다 — 법제처 DB 수록률 문제
    out.push(`## 판례 ${rows.length}건`, "", `- ✅ 실존확인 ${t.OK ?? 0} · 🟠 법원명 불일치 ${t.MISMATCH ?? 0} · ⚠️ 미확인 ${t.UNVERIFIED ?? 0} · 🔌 조회실패 ${t.API_ERROR ?? 0}`, "", "> ⚠️ 미확인 = 법제처 판례DB 미수록. 하급심·비공개 판결은 원래 수록률이 낮으므로 '존재하지 않음'이 아니다.", "");
    const bad = rows.filter((r) => r.verdict !== "OK");
    if (bad.length) {
      out.push("### 확인 필요", "", "| 사건번호 | 주제 | 판정 | 비고 |", "|---|---|---|---|");
      for (const r of bad) out.push(`| ${r.사건번호} | ${r.주제} | ${ICON[r.verdict]} ${r.verdict} | ${r.note ?? ""} |`);
      out.push("");
    }
    writeFileSync(join(OUT_DIR, "precedents.json"), JSON.stringify(rows, null, 1));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "REPORT.md"), out.join("\n"));
  process.stderr.write(`\n리포트: ${join(OUT_DIR, "REPORT.md")}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

mkdirSync(OUT_DIR, { recursive: true });
main();
