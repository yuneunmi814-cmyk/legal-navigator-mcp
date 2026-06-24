// 통합 테스트 — app을 임의 포트로 직접 띄워 MCP JSON-RPC를 호출(NODE_ENV=test면 server.ts가 자동 listen하지 않음).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { TOPIC_KEYS, FORM_KEYS } from "../src/data/index.js";

let base = "";
let server: Server;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return res.json();
}
async function callText(name: string, args: unknown): Promise<string> {
  const j = await rpc("tools/call", { name, arguments: args });
  return j.result?.content?.[0]?.text ?? JSON.stringify(j);
}
// JSON.stringify는 Infinity를 null로 바꾸므로, Infinity 경로는 raw 바디로 보낸다.
async function rawCallText(body: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: HEADERS, body });
  const j = await res.json();
  return j.result?.content?.[0]?.text ?? JSON.stringify(j);
}

describe("도구 목록·PlayMCP 규격", () => {
  it("16개 도구 · description ≤1024 · annotations 5종 · 이름규칙 · kakao 없음", async () => {
    const tools = (await rpc("tools/list", {})).result.tools;
    expect(tools.length).toBe(16);
    for (const t of tools) {
      expect(t.description.length).toBeLessThanOrEqual(1024);
      for (const a of ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"]) expect(t.annotations).toHaveProperty(a);
      expect(t.name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.name).not.toMatch(/kakao/i);
    }
  });
});

describe("회귀: 2차 코드리뷰가 잡은 버그", () => {
  it("[높음] verify_citation — 형법 제759조는 거짓 '수록확인' 안 됨", async () => {
    const t = await callText("verify_citation", { citation: "형법 제759조" });
    expect(t).not.toContain("민법 제759조");
    expect(t).toContain("확인되지 않");
  });
  it("verify_citation — 민법 제759조는 정상 확인(positive 유지)", async () => {
    const t = await callText("verify_citation", { citation: "민법 제759조" });
    expect(t).toContain("수록확인");
  });
  it("[중간] calculate_deadline — 불가능한 날짜(2026-02-31) 거부", async () => {
    const t = await callText("calculate_deadline", { start_date: "2026-02-31", deadline_type: "상속포기_한정승인" });
    expect(t).toContain("올바르지 않");
  });
  it("[중간] calculate_court_cost — Infinity는 ∞ 노출 없이 거부", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"calculate_court_cost","arguments":{"claim_amount":1e999,"parties":2,"track":"단독"}}}';
    const t = await rawCallText(body);
    expect(t).not.toContain("∞");
  });
  it("[중간] calculate_amount — 음수 임금 거부", async () => {
    const t = await callText("calculate_amount", { item: "체불임금", monthly_wage: -100, unpaid_months: 1 });
    expect(t.toLowerCase()).toContain("invalid");
  });
  it("[낮음] explain_term — '대법원'이 '상고'로 오매칭되지 않음", async () => {
    const t = await callText("explain_term", { term: "대법원" });
    expect(t).not.toContain("📖 상고");
  });
  it("explain_term — '각하' 정상(기각과 구별 포함)", async () => {
    const t = await callText("explain_term", { term: "각하" });
    expect(t).toContain("각하");
    expect(t).toContain("기각");
  });
  it("explain_term — 1글자는 안내 메시지", async () => {
    const t = await callText("explain_term", { term: "법" });
    expect(t).toContain("두 글자 이상");
  });
});

describe("핵심 동작", () => {
  it("모든 응답에 면책 고지가 붙는다", async () => {
    const t = await callText("get_procedure", { topic: TOPIC_KEYS[0] });
    expect(t).toContain("개별 법률 자문이 아닙니다");
  });
  it("get_form_template에 공식양식·다운로드 링크 + /forms 다운로드 200", async () => {
    const t = await callText("get_form_template", { form: FORM_KEYS[0] });
    expect(t).toContain("파일로 저장·공유");
    const res = await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
  it("없는 서식 다운로드는 404", async () => {
    const res = await fetch(`${base}/forms/없는서식키.txt`);
    expect(res.status).toBe(404);
  });
  it("healthz OK", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("외국인·이주민(취약계층) 주제·연결", () => {
  it("find_legal_aid '이주여성' → 다누리콜센터 1577-1366", async () => {
    const t = await callText("find_legal_aid", { keyword: "이주여성" });
    expect(t).toContain("다누리콜센터");
    expect(t).toContain("1577-1366");
  });
  it("get_procedure 외국인 산재 → 미등록 포함·근로복지공단", async () => {
    const t = await callText("get_procedure", { topic: "외국인근로자_산업재해" });
    expect(t).toContain("미등록");
    expect(t).toContain("근로복지공단");
  });
  it("get_procedure 외국인 임금체불 → 통보의무 면제 안내", async () => {
    const t = await callText("get_procedure", { topic: "외국인근로자_임금체불" });
    expect(t).toContain("통보의무");
  });
});

describe("취약계층(청소년·장애인·북한이탈주민) 주제·연결", () => {
  it("청소년 알바 → 정정값 '가족관계기록사항' + 야간 동의/인가", async () => {
    const t = await callText("get_procedure", { topic: "청소년_아르바이트" });
    expect(t).toContain("가족관계기록사항");
    expect(t).toContain("인가");
  });
  it("미성년자 계약취소 → '현존이익'만 반환", async () => {
    const t = await callText("get_procedure", { topic: "미성년자_계약취소" });
    expect(t).toContain("현존이익");
  });
  it("장애인 차별구제 → 3단계(인권위→법무부→법원)", async () => {
    const t = await callText("get_procedure", { topic: "장애인_차별구제" });
    expect(t).toContain("국가인권위");
    expect(t).toContain("법무부");
  });
  it("장애인 고용차별 → '3배 배상' 오정보 정정(현행법에 없음) + 형사처벌 명시", async () => {
    const t = await callText("get_procedure", { topic: "장애인_고용차별" });
    expect(t).toContain("형사처벌");
    expect(t).toContain("현행법에 없"); // '손해 3배 징벌배상 조항은 현행법에 없음' 정정
  });
  it("find_legal_aid '탈북' → 남북하나재단", async () => {
    const t = await callText("find_legal_aid", { keyword: "탈북" });
    expect(t).toContain("남북하나재단");
  });
});

describe("취약직군(플랫폼·자립준비청년·보훈) 주제·연결", () => {
  it("플랫폼 산재 → 전속성 폐지·근로복지공단", async () => {
    const t = await callText("get_procedure", { topic: "플랫폼특수고용_산재" });
    expect(t).toContain("전속성");
    expect(t).toContain("근로복지공단");
  });
  it("플랫폼 보수·계약 → 근로자성 인정 전제(과잉 단정 방지)", async () => {
    const t = await callText("get_procedure", { topic: "플랫폼특수고용_보수계약" });
    expect(t).toContain("근로자성");
  });
  it("자립준비청년 → 24/25세 정직 표기", async () => {
    const t = await callText("get_procedure", { topic: "자립준비청년_자립지원" });
    expect(t).toContain("25세");
  });
  it("국가유공자 → 보훈심사위원회 단계", async () => {
    const t = await callText("get_procedure", { topic: "국가유공자_등록보훈" });
    expect(t).toContain("보훈심사위원회");
  });
  it("get_precedent '타다' → 대법원 2024두32973", async () => {
    const t = await callText("get_precedent", { keyword: "타다" });
    expect(t).toContain("2024두32973");
  });
  it("find_legal_aid '배달' → 플랫폼·특수고용 노동상담", async () => {
    const t = await callText("find_legal_aid", { keyword: "배달" });
    expect(t).toContain("플랫폼·특수고용 노동상담");
  });
});

describe("복지·취약가구·농어업인 주제·신청서", () => {
  it("기초생활 → 생계급여 부양의무자 2021 폐지", async () => {
    const t = await callText("get_procedure", { topic: "기초생활보장_수급신청" });
    expect(t).toContain("부양의무자");
    expect(t).toContain("2021");
  });
  it("긴급복지 → 선지원 후처리", async () => {
    const t = await callText("get_procedure", { topic: "긴급복지지원" });
    expect(t).toContain("선지원");
  });
  it("농지연금 → 포털 fbo.or.kr(정정) + 채무 비소구", async () => {
    const t = await callText("get_procedure", { topic: "농지연금" });
    expect(t).toContain("fbo.or.kr");
    expect(t).toContain("비소구");
  });
  it("농작물재해보험 → 보험≠재난지원 구분", async () => {
    const t = await callText("get_procedure", { topic: "농작물재해보험" });
    expect(t).toContain("재난지원");
  });
  it("신청서: 사회보장급여_신청서 — 현행 명칭 정정 + 다운로드 링크", async () => {
    const t = await callText("get_form_template", { form: "사회보장급여_신청서" });
    expect(t).toContain("사회보장급여 신청(변경)서");
    expect(t).toContain("파일로 저장·공유");
  });
  it("신청서: 외국인_사업장변경신청서 — 1개월 기한·2단계(출입국) 경고", async () => {
    const t = await callText("get_form_template", { form: "외국인_사업장변경신청서" });
    expect(t).toContain("1개월");
    expect(t).toContain("출입국");
  });
  it("신청서 다운로드 /forms/자립수당_지급신청서.txt → 200", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent("자립수당_지급신청서")}.txt`);
    expect(res.status).toBe(200);
  });
});

describe("노인·고령·정신건강 주제·연결", () => {
  it("성년후견 → 후견등기부(≠가족관계등록부) 명시", async () => {
    const t = await callText("get_procedure", { topic: "성년후견" });
    expect(t).toContain("후견등기부");
    expect(t).toContain("가족관계등록부");
  });
  it("기초연금 → 생일 1개월 전·소급 안 됨", async () => {
    const t = await callText("get_procedure", { topic: "기초연금_신청" });
    expect(t).toContain("1개월 전");
    expect(t).toContain("소급");
  });
  it("비자의입원 → 보호의무자 2명 + 입원적합성심사", async () => {
    const t = await callText("get_procedure", { topic: "정신질환_비자의입원_심사" });
    expect(t).toContain("보호의무자");
    expect(t).toContain("입원적합성심사");
  });
  it("정신질환자 권리 → 격리·강박(제75조)·국가인권위", async () => {
    const t = await callText("get_procedure", { topic: "정신질환자_권리" });
    expect(t).toContain("격리");
    expect(t).toContain("국가인권위");
  });
  it("get_precedent '보호입원' → 헌재 2014헌가9", async () => {
    const t = await callText("get_precedent", { keyword: "보호입원" });
    expect(t).toContain("2014헌가9");
  });
});
