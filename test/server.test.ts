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
});

describe("회귀: 인용 검증 오탐·미가동", () => {
  it("[높음] 주택임대차보호법 질의에 상가건물 임대차보호법이 붙지 않는다", async () => {
    const t = await callText("verify_citation", { citation: "주택임대차보호법 제10조" });
    expect(t).not.toContain("상가건물");
    expect(t).toContain("확인되지 않");
  });

  it("[높음] 모법 질의에 시행규칙의 같은 조문이 붙지 않는다", async () => {
    // 저장소엔 '출입국관리법 시행규칙 제70조의2'만 있고 모법엔 그 조문이 없다.
    const t = await callText("verify_citation", { citation: "출입국관리법 제70조의2" });
    expect(t).not.toContain("수록확인");
  });

  it("[높음] 연도만 인용하면 그 해 판례가 전부 확인되지 않는다", async () => {
    const t = await callText("verify_citation", { citation: "2020" });
    expect(t).not.toContain("수록확인");
  });

  it("'제' 없는 일상 표기도 검증에 진입한다(도구 트리거 예시)", async () => {
    const t = await callText("verify_citation", { citation: "민법 623조가 맞는 조문인지 확인해줘" });
    expect(t).toContain("수록확인");
    expect(t).toContain("민법 제623조");
  });

  it("낫표 표기에서 법령명을 놓치지 않는다", async () => {
    const t = await callText("verify_citation", { citation: "「민법」 제759조" });
    expect(t).toContain("수록확인");
  });

  it("법령명이 없으면 '확인'이 아니라 후보로만 제시한다", async () => {
    const t = await callText("verify_citation", { citation: "제9조" });
    expect(t).not.toContain("수록확인");
    expect(t).toContain("법령명을 특정할 수 없어");
  });

  it("정식 제명으로 인용해도 약칭 저장분과 대조된다", async () => {
    const t = await callText("verify_citation", { citation: "성폭력범죄의 처벌 등에 관한 특례법 제14조" });
    expect(t).toContain("수록확인");
  });

  it("판례 인용은 유효성 주의까지 함께 나온다", async () => {
    const t = await callText("verify_citation", { citation: "대법원 2012다89399" });
    expect(t).toContain("유효성");
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
  it("calculate_amount — 셀프등기절감액(근저당 말소): 기본값 1건·방문 = 실비 10,200원", async () => {
    const t = await callText("calculate_amount", { item: "셀프등기절감액" });
    expect(t).toContain("10,200원");
    expect(t).toContain("절감");
  });
  it("calculate_amount — 상속등기비용: 공시가 3억 주택 = 8,895,000원, 시가표준액 없으면 거부", async () => {
    const t = await callText("calculate_amount", { item: "상속등기비용", assessed_value: 300_000_000 });
    expect(t).toContain("8,895,000원");
    const miss = await callText("calculate_amount", { item: "상속등기비용" });
    expect(miss).toContain("입력값이 부족");
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
  it("triage 텍스트 응답에 접수처·근거 법령이 함께 나온다 (문제 상황 → 관련 법 + 제출 방법)", async () => {
    const t = await callText("triage", { situation: "임금체불 3개월" });
    expect(t).toContain("접수·도움받을 곳");
    expect(t).toContain("근거 법령");
  });
  it("모든 응답에 면책 고지가 붙는다", async () => {
    const t = await callText("get_procedure", { topic: TOPIC_KEYS[0] });
    expect(t).toContain("개별 법률 자문이 아닙니다");
  });
  it("get_form_template에 미리보기·다운로드 링크 + /forms 다운로드 200", async () => {
    const t = await callText("get_form_template", { form: FORM_KEYS[0] });
    expect(t).toContain("빈칸 바로 채우기");
    expect(t).toContain("텍스트 파일로 저장");
    const res = await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
  it("get_form_template에 어시스턴트 작성 보조 지침(대화 사실로 초안·사실 창작 금지·본인 최종 확인)", async () => {
    const t = await callText("get_form_template", { form: "금전소비대차계약서" });
    expect(t).toContain("어시스턴트 작성 보조 지침");
    expect(t).toContain("이미 말한 사실");
    expect(t).toContain("지어내거나");
    expect(t).toContain("채울 항목"); // 본문 [빈칸]에서 추출된 항목 목록
    expect(t).toContain("성명"); // 줄머리 섹션 라벨이 아닌 실제 입력 칸
  });
  it("서식 시각화 미리보기 /forms/:key → 200 text/html · 빈칸/체크박스 렌더", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('contenteditable="true"'); // [빈칸] → 입력 필드
    expect(html).toContain("인쇄 · PDF로 저장");
    expect(html).toContain("개별 법률 자문이 아닙니다"); // 면책 유지
  });
  it("○○ 자리(○○지방법원 등)가 입력 필드로 렌더 — 대괄호 안의 ○는 예시라 그대로 둔다", async () => {
    // 임차권등기명령신청서 본문: "… ○○지방법원 귀중"(대괄호 밖 → 필드)
    const html = await (await fetch(`${base}/forms/${encodeURIComponent("임차권등기명령신청서")}`)).text();
    expect(html).toContain('data-ph="○○"');
    expect(html).not.toContain("○○지방법원 귀중"); // 원문 그대로 남아 있으면 안 됨
    expect(html).toContain("지방법원 귀중"); // ○○만 필드로 바뀌고 뒷말은 유지

    // 채권압류추심_신청서: "[○○은행 등]"·"[○○지방법원 20○○가소○○○○ …]" → 대괄호 통째로 빈칸 하나,
    // 안의 ○는 쓰는 법을 보여주는 예시이므로 쪼개지 않는다(속성값 안에 그대로 들어간다).
    const b = await (await fetch(`${base}/forms/${encodeURIComponent("채권압류추심_신청서")}`)).text();
    expect(b).toContain('data-ph="○○은행 등"');
    expect(b).not.toMatch(/data-ph="○○"[^>]*><\/span>은행/); // 대괄호 안이 쪼개지지 않았음
  });
  it("○○ 자리가 작성 보조 지침의 '채울 항목'에 집계된다", async () => {
    const t = await callText("get_form_template", { form: "임차권등기명령신청서" });
    expect(t).toMatch(/○○ = 법원·기관 이름 \d+곳/);
  });
  it("대괄호 안이 선택지 묶음이면([☐정기신청 ☐기한 후 신청]) 체크박스로 남고 빈칸이 되지 않는다", async () => {
    const html = await (await fetch(`${base}/forms/${encodeURIComponent("근로자녀장려금_신청서")}`)).text();
    expect(html).not.toMatch(/data-ph="[^"]*[<>]/); // 속성값에 마크업이 새어 들어가지 않음
    expect(html).toContain("정기신청");
    expect(html).toContain('role="checkbox"');
  });
  it("어느 서식도 data-ph 속성에 마크업이 새어 들어가지 않는다(전수)", async () => {
    for (const k of FORM_KEYS) {
      const html = await (await fetch(`${base}/forms/${encodeURIComponent(k)}`)).text();
      expect(html, k).not.toMatch(/data-ph="[^"]*[<>]/);
      const open = (html.match(/<span\b/g) || []).length;
      const close = (html.match(/<\/span>/g) || []).length;
      expect(open, k).toBe(close);
    }
  });
  it("서식 미리보기는 사용자 입력값을 서버에 저장하지 않는다(무상태·정적)", async () => {
    const a = await (await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}`)).text();
    const b = await (await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}`)).text();
    expect(a).toBe(b); // 동일 요청 → 동일 응답(상태 없음)
  });
  it("없는 서식: .txt→404, 미리보기→404 html", async () => {
    const txt = await fetch(`${base}/forms/없는서식키.txt`);
    expect(txt.status).toBe(404);
    const html = await fetch(`${base}/forms/없는서식키`);
    expect(html.status).toBe(404);
    expect(html.headers.get("content-type")).toContain("text/html");
  });
  it("healthz OK", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("가족·지인 간 차용증 없는 대여('떼인 돈')", () => {
  it("서식 페이지: 긴 서술형은 블록 입력칸(.fld.big), 밑줄도 입력 가능 (8/11 회의 결정 ②)", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent("임금체불진정서")}`);
    const html = await res.text();
    expect(html).toContain('class="fld big"');
    // 긴 서술형(경위)은 .big으로, 짧은 항목(성명)은 인라인 유지
    expect(html).toMatch(/class="fld big"[^>]*data-ph="언제부터/);
    expect(html).toMatch(/class="fld"[^>]*data-ph="성명"/);
    // 블록칸 CSS·인쇄 규칙 존재
    expect(html).toContain(".fld.big{display:block");
    const res2 = await fetch(`${base}/forms/${encodeURIComponent("소송구조신청서")}`);
    const html2 = await res2.text();
    expect(html2).not.toMatch(/____/); // 대괄호 밖 밑줄도 입력칸으로 변환됨
  });

  it("get_form_template 텍스트 응답에 접수처(관할·온라인접수) 포함", async () => {
    const t = await callText("get_form_template", { form: "임금체불진정서" });
    expect(t).toContain("어디에 내나요(접수처)");
    expect(t).toMatch(/고용노동|노동/);
  });
  it("서식 카드 위젯에 접수처 바로가기 버튼 포함 (8/11 회의 결정)", async () => {
    const { buildFormWidget } = await import("../src/widgets.js");
    const w = buildFormWidget("임금체불진정서", { 제목: "진정서", 용도: "테스트" }, "https://x.test", { url: "https://labor.moel.go.kr", 관할: "고용노동부" });
    const s = JSON.stringify(w);
    expect(s).toContain("접수처 바로가기");
    expect(s).toContain("labor.moel.go.kr");
    expect(w.copy_text).toContain("제출처: 고용노동부");
    // 접수처 없는 서식은 버튼 미표시
    const w2 = buildFormWidget("금전소비대차계약서", { 제목: "차용증", 용도: "테스트" }, "https://x.test");
    expect(JSON.stringify(w2)).not.toContain("접수처 바로가기");
    // URL 없는 방문 접수: 버튼은 없고 제출처 캡션만
    const w3 = buildFormWidget("폭행상해_고소장", { 제목: "고소장", 용도: "테스트" }, "https://x.test", { url: null, 관할: "관할 경찰서" });
    const s3 = JSON.stringify(w3);
    expect(s3).not.toContain("접수처 바로가기");
    expect(s3).toContain("제출: 관할 경찰서");
  });

  it("check_elements 스토킹 → 성립요건·양면 동선·단정 금지 문구", async () => {
    const t = await callText("check_elements", { issue: "스토킹" });
    expect(t).toContain("법률상 성립요건");
    expect(t).toContain("지속적·반복적");
    expect(t).toContain("신고·대응을 고민하는 쪽이라면");
    expect(t).toContain("신고당했거나 걱정되는 쪽이라면");
    expect(t).toContain("최종 판단은 수사기관·법원");
  });
  it("check_elements perspective=피신고측 → 피해측 동선 생략", async () => {
    const t = await callText("check_elements", { issue: "사기", perspective: "피신고측" });
    expect(t).toContain("신고당했거나 걱정되는 쪽이라면");
    expect(t).not.toContain("신고·대응을 고민하는 쪽이라면");
    expect(t).toContain("단순 채무불이행은 사기죄가 아니라 민사");
  });
  it("search_topics query 없이 호출 → 전체 주제 목록 (구 list_topics 통합)", async () => {
    const t = await callText("search_topics", {});
    expect(t).toContain("주제 목록");
    expect(t).toContain("### 노동");
  });
  it("search_topics category 필터만 → 해당 분야 목록", async () => {
    const t = await callText("search_topics", { category: "노동" });
    expect(t).toContain("### 노동");
    expect(t).not.toContain("### 주택임대차");
  });
  it("search_topics '가족한테 빌려준 돈 떼였어요' → 대여 주제로 진단", async () => {
    const t = await callText("search_topics", { query: "가족한테 빌려준 돈 떼였어요" });
    expect(t).toMatch(/대여금미반환|차용증없음입증/);
  });
  it("search_topics '떼인 돈' → 대여 주제로 진단", async () => {
    const t = await callText("search_topics", { query: "떼인 돈 어떻게 받아요" });
    expect(t).toMatch(/대여금미반환|차용증없음입증/);
  });
  it("get_procedure 차용증없음입증 → 가족 증여추정·채무승인 안내", async () => {
    const t = await callText("get_procedure", { topic: "차용증없음입증" });
    expect(t).toContain("증여"); // 가족 간 증여로 볼 여지 경고
    expect(t).toContain("채무"); // 채무승인 → 시효중단
  });
  it("get_form_template 금전소비대차계약서(차용증) → 이자제한법 안내 + 빈칸", async () => {
    const t = await callText("get_form_template", { form: "금전소비대차계약서" });
    expect(t).toContain("이자제한법");
    expect(t).toContain("[성명]");
  });
  it("get_form_template 채무변제확인서(사후 차용증) → 민법 제168조 채무승인", async () => {
    const t = await callText("get_form_template", { form: "채무변제확인서" });
    expect(t).toContain("제168조");
  });
  it("신규 서식 시각화 미리보기 200 · 체크박스/빈칸 렌더", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent("채무변제확인서")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="checkbox"'); // ☐ 렌더
    expect(html).toContain('contenteditable="true"'); // [빈칸] 렌더
  });
});

describe("위젯 응답 모드 (WIDGETS=on — 카카오 툴즈 본선)", () => {
  beforeAll(() => { process.env.WIDGETS = "on"; });
  afterAll(() => { delete process.env.WIDGETS; });

  it("get_form_template → {widget, copy_text, name} JSON 카드", async () => {
    const t = await callText("get_form_template", { form: "금전소비대차계약서" });
    const j = JSON.parse(t);
    expect(j.widget.type).toBe("Card");
    expect(j.name).toBe("get_form_template");
    expect(j.copy_text).toContain("금전소비대차계약서");
    const btn = j.widget.children.find((c: any) => c.type === "Button");
    expect(btn.onClickAction.payload.target.url).toContain("/forms/");
    expect(t).not.toContain('"status"'); // 카카오 전용 프로퍼티 미사용
  });
  it("get_form_template 위젯 응답에 for_assistant(지침+서식 본문) 동봉 — 카드만으론 초안 불가하므로", async () => {
    const t = await callText("get_form_template", { form: "금전소비대차계약서" });
    const j = JSON.parse(t);
    expect(j.for_assistant).toContain("어시스턴트 작성 보조 지침");
    expect(j.for_assistant).toContain("서식 본문"); // 호스트 AI가 초안을 만들 원문
    expect(j.for_assistant).toContain("[성명]");
    expect(j.widget.type).toBe("Card"); // 봉투 구조는 그대로
  });
  it("triage → 진단 카드(기한 배지·name)", async () => {
    const t = await callText("triage", { situation: "임금체불 3개월" });
    const j = JSON.parse(t);
    expect(j.name).toBe("triage");
    expect(JSON.stringify(j.widget)).toContain("⏰");
    expect(j.copy_text).toContain("132");
    expect(j.copy_text).toContain("⚖️");
  });
  it("calculate_amount → 계산 카드", async () => {
    const t = await callText("calculate_amount", { item: "퇴직금", daily_avg_wage: 100000, tenure_days: 1095 });
    const j = JSON.parse(t);
    expect(j.name).toBe("calculate_amount");
    expect(j.widget.type).toBe("Card");
  });
  it("calculate_deadline → 기한 카드(D-day 포함)", async () => {
    const t = await callText("calculate_deadline", { start_date: "2026-06-23", deadline_type: "상속포기_한정승인" });
    const j = JSON.parse(t);
    expect(j.name).toBe("calculate_deadline");
    expect(JSON.stringify(j.widget)).toMatch(/D-|기한 경과|마감일/);
  });
  it("위젯 비대상 툴(get_procedure)은 그대로 마크다운", async () => {
    const t = await callText("get_procedure", { topic: "임금체불" });
    expect(() => JSON.parse(t)).toThrow(); // JSON 아님 = 텍스트 유지
    expect(t).toContain("개별 법률 자문이 아닙니다");
  });
  it("[회귀] 프록시가 x-forwarded-proto:http를 보내도 배포 도메인 버튼 URL은 https", async () => {
    // kakaocloud 프록시 내부 홉 재현: 비로컬 호스트 + http 프로토 헤더 → 그래도 https여야 함(80포트 무응답·혼합콘텐츠)
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, "x-forwarded-proto": "http", "x-forwarded-host": "legal-navigator-kakaotools.playmcp-endpoint.kakaocloud.io" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_form_template", arguments: { form: "금전소비대차계약서" } } }),
    });
    const t = (await res.json()).result.content[0].text;
    const j = JSON.parse(t);
    const btn = j.widget.children.find((c: any) => c.type === "Button");
    expect(btn.onClickAction.payload.target.url).toMatch(/^https:\/\/legal-navigator-kakaotools/);
  });
});

describe("위젯 프로토타입 (ChatKit 스펙·미리보기)", () => {
  it("위젯 JSON: /widgets/form?json=1 → Card 루트·버튼 URL·copy_text", async () => {
    const res = await fetch(`${base}/widgets/form?key=${encodeURIComponent("금전소비대차계약서")}&json=1`);
    expect(res.status).toBe(200);
    const w = await res.json();
    expect(w.widget.type).toBe("Card");
    const buttons = w.widget.children.filter((c: any) => c.type === "Button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons[0].onClickAction.payload.target.url).toContain("/forms/"); // 카카오 확정 스펙: payload.target.url
    expect(w.copy_text).toContain("금전소비대차계약서");
  });
  it("위젯 JSON: /widgets/triage → 기한 Badge 포함", async () => {
    const res = await fetch(`${base}/widgets/triage?q=${encodeURIComponent("월급을 3개월째 못 받았어요")}&json=1`);
    const w = await res.json();
    const flat = JSON.stringify(w.widget);
    expect(flat).toContain("Badge");
    expect(flat).toContain("⏰");
  });
  it("위젯 미리보기 HTML: /widgets/calc → 200 text/html·카드 렌더", async () => {
    const res = await fetch(`${base}/widgets/calc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("w-card");
    expect(html).toContain("퇴직금");
  });
  it("없는 종류·없는 서식은 404", async () => {
    expect((await fetch(`${base}/widgets/nope`)).status).toBe(404);
    expect((await fetch(`${base}/widgets/form?key=없는서식`)).status).toBe(404);
  });
});

describe("나홀로 송무·법무 패키지 (피고 대응·셀프 법무)", () => {
  it("search_topics '법원에서 서류가 왔어요' → 소장받았을때 매칭", async () => {
    const t = await callText("search_topics", { query: "법원에서 서류가 왔어요" });
    expect(t).toMatch(/소장받았을때|지급명령받았을때/);
  });
  it("get_procedure 소장받았을때 → 30일·무변론 경고", async () => {
    const t = await callText("get_procedure", { topic: "소장받았을때" });
    expect(t).toContain("30일");
    expect(t).toContain("무변론");
  });
  it("get_procedure 지급명령받았을때 → 2주·확정 경고", async () => {
    const t = await callText("get_procedure", { topic: "지급명령받았을때" });
    expect(t).toContain("2주");
    expect(t).toContain("확정");
  });
  it("calculate_deadline 민사_답변서 → 30일 D-day", async () => {
    const t = await callText("calculate_deadline", { start_date: "2026-08-01", deadline_type: "민사_답변서" });
    expect(t).toContain("2026-08-31");
  });
  it("get_form_template 민사_답변서 → 무변론 경고·을호증 안내", async () => {
    const t = await callText("get_form_template", { form: "민사_답변서" });
    expect(t).toContain("무변론");
    expect(t).toContain("을 제1호증");
  });
  it("임차인 경매 대응 → 배당요구 종기 경고", async () => {
    const t = await callText("get_procedure", { topic: "임차인경매대응" });
    expect(t).toContain("배당요구");
    expect(t).toContain("종기");
  });
  it("신규 서식 시각화 미리보기 200 (지급명령 이의신청서)", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent("지급명령_이의신청서")}`);
    expect(res.status).toBe(200);
    expect((await res.text())).toContain('contenteditable="true"');
  });
  it("[Tier2] 약식명령받았을때 → 7일·형종 상향 금지", async () => {
    const t = await callText("get_procedure", { topic: "약식명령받았을때" });
    expect(t).toContain("7일");
    expect(t).toContain("형종 상향");
  });
  it("[Tier2] calculate_deadline 약식명령_정식재판청구 → 7일 D-day", async () => {
    const t = await callText("calculate_deadline", { start_date: "2026-08-01", deadline_type: "약식명령_정식재판청구" });
    expect(t).toContain("2026-08-08");
  });
  it("[Tier2] 상속등기 → 취득세 6개월·단독 신청", async () => {
    const t = await callText("get_procedure", { topic: "상속등기" });
    expect(t).toContain("6개월");
    expect(t).toContain("단독");
  });
  it("[Tier2] search_topics '벌금이 나왔어요' → 약식명령받았을때", async () => {
    const t = await callText("search_topics", { query: "벌금이 나왔어요" });
    expect(t).toContain("약식명령받았을때");
  });
  it("[Tier2] 국선변호인 서식 → 33조·수급자 소명", async () => {
    const t = await callText("get_form_template", { form: "국선변호인선정청구서" });
    expect(t).toContain("제33조");
    expect(t).toContain("수급자");
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

describe("피해·위기(범죄피해자·자살·재난) 주제·연결", () => {
  it("자살위기 → 위기번호(109·112·119)·정보지원만", async () => {
    const t = await callText("get_procedure", { topic: "자살위기_도움받기" });
    expect(t).toContain("109");
    expect(t).toContain("112");
  });
  it("자살유족 → 상속포기/한정승인 연계·보험 단정 안 함", async () => {
    const t = await callText("get_procedure", { topic: "자살유족_지원" });
    expect(t).toContain("상속포기");
    expect(t).toContain("약관");
  });
  it("범죄피해자 지원 → 스마일센터·구조금 별도", async () => {
    const t = await callText("get_procedure", { topic: "범죄피해자_지원" });
    expect(t).toContain("스마일센터");
  });
  it("재난 → 풍수해≠시민안전≠농작물 보험 구분", async () => {
    const t = await callText("get_procedure", { topic: "풍수해_시민안전보험" });
    expect(t).toContain("시민안전보험");
    expect(t).toContain("농작물재해보험");
  });
  it("find_legal_aid '자살' → 위기상담 라우팅", async () => {
    const t = await callText("find_legal_aid", { keyword: "자살" });
    expect(t).toContain("자살예방");
  });
});
