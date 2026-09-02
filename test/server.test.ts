// 통합 테스트 — app을 임의 포트로 직접 띄워 MCP JSON-RPC를 호출(NODE_ENV=test면 server.ts가 자동 listen하지 않음).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app, SERVER_INSTRUCTIONS } from "../src/server.js";
import { clearLogs } from "../src/debugLog.js";
import { TOPIC_KEYS, FORM_KEYS, FORMS, PROCEDURES } from "../src/data/index.js";

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
  it("16개 도구 · description ≤1024 · annotations 5종(값까지) · 이름규칙 · kakao 없음", async () => {
    const tools = (await rpc("tools/list", {})).result.tools;
    expect(tools.length).toBe(16);
    for (const t of tools) {
      expect(t.description.length).toBeLessThanOrEqual(1024);
      // annotations 5종: title + hint 4개. property 존재만이 아니라 실제 기대값까지 검증한다 —
      // 전부 읽기 전용·비파괴 정보 제공 도구이므로 read/idempotent=true, destructive/openWorld=false가 맞다.
      expect(typeof t.annotations?.title).toBe("string");
      expect(t.annotations.title.trim().length).toBeGreaterThan(0);
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
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
  // 8/9 결정 "문제 상황 → 관련 법 + 제출 방법"은 그대로다. 다만 섹션 제목 문자열을 확인하던 것을
  // 실제 데이터가 실렸는지로 바꿨다 — 제목 문구가 바뀌어도 내용이 빠지면 잡아야 하기 때문.
  it("triage 텍스트 응답에 접수처·근거 법령이 함께 나온다 (문제 상황 → 관련 법 + 제출 방법)", async () => {
    const t = await callText("triage", { situation: "임금체불 3개월" });
    const p = PROCEDURES["임금체불"];
    expect(t).toContain(p.온라인접수);
    expect(t).toContain(p.근거법[0]);
  });
  it("triage는 확인 질문 하나로 끝난다 (선택지 + 직접 입력)", async () => {
    const t = await callText("triage", { situation: "임금체불 3개월" });
    expect(t).toContain("①");
    expect(t).toContain("직접 입력");
    // 한 번에 다 쏟지 않는다 — 사용자에게 보이는 본문은 짧게 유지한다.
    expect(t.split("<!--")[0].length).toBeLessThan(900);
  });
  it("triage 진행 지침에 그 주제의 서식 키가 실린다 (모델이 서식 위젯을 띄울 수 있게)", async () => {
    const t = await callText("triage", { situation: "임금체불 3개월" });
    const hint = t.split("<!--")[1] ?? "";
    expect(hint).toContain("임금체불진정서");
    expect(hint).toContain("get_form_template");
  });
  it("모든 응답에 면책 고지가 붙는다", async () => {
    const t = await callText("get_procedure", { topic: TOPIC_KEYS[0] });
    expect(t).toContain("개별 법률 자문이 아닙니다");
  });
  it("get_form_template에 미리보기·다운로드 링크 + /forms 다운로드 200", async () => {
    const t = await callText("get_form_template", { form: FORM_KEYS[0] });
    expect(t).toContain("빈칸 바로 채우기");
    expect(t).toContain("서식 다운로드");
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
  it("중첩 대괄호·선택 표시가 깨진 마크업으로 남지 않는다", async () => {
    for (const k of ["계약해제_내용증명", "부동산매매_해제_내용증명", "소년보호_보조인선임서"]) {
      const html = await (await fetch(`${base}/forms/${encodeURIComponent(k)}`)).text();
      const docHtml = html.match(/<div class="doc" id="doc">([\s\S]*?)<\/div>\s*<div class="tips">/)?.[1] ?? "";
      expect(docHtml, k).not.toMatch(/[\[\]]/);
    }
    for (const k of ["행정심판_청구서", "국가장학금_신청서"]) {
      expect(FORMS[k].본문, k).not.toMatch(/\[\s\]/);
      const html = await (await fetch(`${base}/forms/${encodeURIComponent(k)}`)).text();
      const docHtml = html.match(/<div class="doc" id="doc">([\s\S]*?)<\/div>\s*<div class="tips">/)?.[1] ?? "";
      expect(docHtml.match(/role="checkbox"/g) ?? [], k).toHaveLength(7);
    }
  });
  it("공식양식 유무에 따라 HTML·TXT 제출 안내를 구분한다", async () => {
    const officialHtml = await (await fetch(`${base}/forms/${encodeURIComponent("소송구조신청서")}`)).text();
    const officialTxt = await (await fetch(`${base}/forms/${encodeURIComponent("소송구조신청서")}.txt`)).text();
    expect(officialHtml).toContain("위 ‘공식 양식 받는 곳’에서 정식 서식을 받아 작성하세요");
    expect(officialTxt).toContain("위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성하세요");

    const exampleHtml = await (await fetch(`${base}/forms/${encodeURIComponent("금전소비대차계약서")}`)).text();
    const exampleTxt = await (await fetch(`${base}/forms/${encodeURIComponent("금전소비대차계약서")}.txt`)).text();
    expect(exampleHtml).toContain("제출 전 해당 기관의 최신 서식과 접수요건을 확인하세요");
    expect(exampleHtml).not.toContain("위 ‘공식 양식 받는 곳’에서 정식 서식을 받아 작성하세요");
    expect(exampleTxt).toContain("제출 전 해당 기관의 최신 서식과 접수요건을 확인하세요");
  });
  it("입력값은 탭 세션에만 복원되고 장기 localStorage에는 남기지 않는다", async () => {
    const html = await (await fetch(`${base}/forms/${encodeURIComponent("채무변제확인서")}`)).text();
    expect(html).toContain("sessionStorage.setItem");
    expect(html).toContain("sessionStorage.getItem");
    expect(html).not.toContain("localStorage");
  });
  it("서식 미리보기는 사용자 입력값을 서버에 저장하지 않는다(무상태·정적)", async () => {
    const a = await (await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}`)).text();
    const b = await (await fetch(`${base}/forms/${encodeURIComponent(FORM_KEYS[0])}`)).text();
    expect(a).toBe(b); // 동일 요청 → 동일 응답(상태 없음)
    expect(a).toContain("입력한 내용은 이 탭에만 임시 저장되고 채팅·서버로 전송되지 않습니다");
    expect(a).toContain("민감번호는 카카오톡 대화에 쓰지 말고");
  });
  // 위젯의 "한글 서식 바로 받기"가 이 경로를 부른다. 여기가 죽으면 카톡에서
  // 버튼을 눌러도 아무 일이 안 일어난다 — 사용자는 이유를 알 수 없다.
  it("서식 파일이 서버에서 바로 떨어진다 (.hwpx/.docx)", async () => {
    for (const [ext, magicMime] of [
      ["hwpx", "hancom"],
      ["docx", "wordprocessingml"],
    ] as const) {
      const res = await fetch(`${base}/forms/${encodeURIComponent("임금체불진정서")}.${ext}`);
      expect(res.status, ext).toBe(200);
      expect(res.headers.get("content-type") ?? "", ext).toContain(magicMime);
      // 브라우저가 페이지로 열지 않고 파일로 받게 하는 헤더
      const cd = res.headers.get("content-disposition") ?? "";
      expect(cd, ext).toContain("attachment");
      // 한글 파일명이 깨지지 않게 UTF-8로도 같이 적는다
      expect(cd, ext).toContain("filename*=UTF-8''");
      const buf = new Uint8Array(await res.arrayBuffer());
      // 서버는 압축해서 보내므로(브라우저 쪽은 무압축) 크기가 작다. 빈 껍데기만 아니면 된다.
      expect(buf.length, ext).toBeGreaterThan(800);
      expect([buf[0], buf[1]], `${ext}: ZIP이 아니다`).toEqual([0x50, 0x4b]);
    }
  });

  it("hwpx의 첫 항목은 무압축 mimetype이어야 한다 (한글이 안 열리는 첫째 이유)", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent("임금체불진정서")}.hwpx`);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[8] | (buf[9] << 8), "첫 항목이 압축돼 있다").toBe(0);
    const nameLen = buf[26] | (buf[27] << 8);
    expect(new TextDecoder().decode(buf.slice(30, 30 + nameLen))).toBe("mimetype");
    expect(new TextDecoder().decode(buf.slice(30 + nameLen, 30 + nameLen + 19))).toBe("application/hwp+zip");
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
    const j: any = await res.json();
    expect(j.status).toBe("ok");
    // scale은 배포 확인용으로 함께 나간다(아래 별도 검사). 봉투를 못 박지 않는다.
  });
});

describe("가족·지인 간 차용증 없는 대여('떼인 돈')", () => {
  it("서식 페이지: 한글·워드 내보내기 버튼 + A4 인쇄 규격", async () => {
    const res = await fetch(`${base}/forms/${encodeURIComponent("임금체불진정서")}`);
    const html = await res.text();
    // 내보내기는 드롭다운 한 개로 모았다 — 형식마다 버튼을 늘어놓으면 바가 길어진다(8/21)
    expect(html).toContain('id="saveMenu"');
    for (const fmt of ["hwpx", "docx", "md", "txt"]) {
      expect(html, `${fmt} 항목이 메뉴에 없다`).toContain(`data-fmt="${fmt}"`);
    }
    // 한글·워드를 따로 받을 수 있어야 한다 (2026-08-20 회의 지적 → 8/21 .hwpx 추가)
    expect(html).toContain("서식 다운로드");
    // 어떤 확장자로 떨어지는지 화면에서 밝히고 있는지
    expect(html).toContain(".hwpx");
    expect(html).toContain(".docx");
    expect(html).toContain("@page{size:A4");
    // 내보내기는 브라우저 안에서만 — 채운 값을 서버로 보내는 코드가 있으면 안 된다.
    // 개인정보를 0건 수집한다는 말이 사실이려면 이 구간에 fetch/XHR이 없어야 한다.
    const exportCode = html.slice(html.indexOf("function hwpxFiles(title,paras)"), html.indexOf('getElementById("resetBtn")'));
    expect(exportCode.length).toBeGreaterThan(500);
    expect(exportCode).toContain("wordprocessingml");
    expect(exportCode).toContain("hancom.hwpx");
    expect(exportCode).not.toMatch(/fetch\(|XMLHttpRequest|navigator\.sendBeacon/);
    // hidden 속성이 display 지정에 밀리면 메뉴가 열린 채로 뜬다 — 8/21에 실제로 그랬다
    expect(html).toMatch(/\[hidden\]\{display:none!important\}/);
    // 위젯의 '서식 다운로드'는 #save로 들어온다. 받는 쪽이 없으면 '빈칸 채우기'와
    // 똑같은 화면이 떠서 버튼이 두 개인 의미가 없어진다(8/22 지적).
    expect(html).toContain('location.hash==="#save"');
  });

  // 빈칸이 글자보다 위로 떠서 좁은 화면에서 "글자에 올라탄" 것처럼 보였다
  // (8/24 예은님 폰 제보 — 320px에서 22곳 재현). vertical-align이 top이면
  // 칸은 줄 맨 위에, 글자는 기준선에 앉아 세로가 어긋난다.
  // 밑줄 길이에 맞춰 min-width를 인라인으로 박는데(최대 28ch≈286px), 폰 문서 폭이 260px이라
  // 앞 글자 뒤에 붙는 순간 화면 밖으로 나가 가로 스크롤이 생겼다(320px 전수 검사에서 3종 적발).
  // 넓은 칸은 좁은 화면에서 제 줄을 차지하게 한다.
  it("넓은 빈칸은 좁은 화면에서 제 줄을 차지한다", async () => {
    const html = await (await fetch(`${base}/forms/${encodeURIComponent("금융분쟁조정_신청서")}`)).text();
    expect(html, "넓은 칸에 wide 표시가 없다").toContain('class="fld wide"');
    const rule = /\.doc \.fld\.wide\{[^}]*\}/.exec(html)?.[0] ?? "";
    expect(rule, "wide 규칙을 못 찾았다").toContain("display:block");
    // 인라인 min-width는 스타일시트로 못 이긴다 — !important가 빠지면 다시 밖으로 밀린다
    expect(rule, "인라인 min-width를 못 덮는다").toContain("min-width:0!important");
  });

  it("입력칸은 글자 기준선에 맞춰 앉는다 (좁은 화면에서 겹쳐 보이지 않게)", async () => {
    const html = await (await fetch(`${base}/forms/${encodeURIComponent("금전소비대차계약서")}`)).text();
    const fld = /\.fld\{[^}]*\}/.exec(html)?.[0] ?? "";
    expect(fld, ".fld 규칙을 못 찾았다").toContain("display:inline-block");
    expect(fld, "칸이 줄 맨 위에 붙으면 글자와 어긋난다").toContain("vertical-align:baseline");
    expect(fld, "좌우 여백이 1px이면 앞 글자와 한 덩어리로 읽힌다").not.toMatch(/margin:0 1px/);
  });

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
  it("check_elements 보이스피싱 — 실사용 발화 '이거 보이스피싱인가요?' 대응 (8/16 추가)", async () => {
    const t = await callText("check_elements", { issue: "보이스피싱" });
    expect(t).toContain("안전계좌");
    expect(t).toContain("즉시계좌지급정지");
    expect(t).toContain("전달책"); // 피신고측: 대포통장·전달책 경고
    expect(t).toContain("최종 판단은 수사기관·법원");
  });
  it("check_elements perspective=피신고측 → 피해측 동선 생략", async () => {
    const t = await callText("check_elements", { issue: "사기", perspective: "피신고측" });
    expect(t).toContain("신고당했거나 걱정되는 쪽이라면");
    expect(t).not.toContain("신고·대응을 고민하는 쪽이라면");
    expect(t).toContain("단순 채무불이행은 사기죄가 아니라 민사");
  });
  it("search_topics query 없이 호출 → 짧은 분야 색인 (결과 최소화)", async () => {
    const t = await callText("search_topics", {});
    expect(t).toContain("어떤 분야를 찾으세요?");
    expect(t).toContain("**노동**");
    expect(t).not.toContain("`임금체불`");

    const labor = await callText("search_topics", { category: "노동" });
    expect(labor).toContain("노동 주제");
    expect(labor).toContain("`임금체불`");
  });
  // 동의어가 낱말 사이에 말이 끼면 안 걸리던 문제. "계속 찾아"는 "계속 집 앞에 찾아와요"도
  // 잡으라고 적어둔 말인데 붙어 있을 때만 재고 있었다 — 스토킹 신고의 가장 전형적인 문장이
  // 라이브에서 0건이었다(2026-08-23). 폭력 사안에서 놓치면 그 사람은 그냥 돌아간다.
  it("스토킹: 사이에 말이 끼어도 잡는다", async () => {
    for (const q of [
      "헤어진 사람이 계속 집 앞에 찾아와요",
      "전 남자친구가 계속 찾아와요",
      "계속 친한 척 연락함",
      "자꾸 연락이 와요 무서워요",
    ]) {
      const t = await callText("search_topics", { query: q });
      expect(t, `'${q}' 가 0건이다`).toContain("스토킹");
    }
  });

  // 느슨하게 잡으면 엉뚱한 데로 간다 — 8/19에 "업무누락 반복하는 실장급 직원"이
  // 검찰 사칭 보이스피싱으로 갔다. 넓히는 변경마다 이쪽도 같이 본다.
  it("스토킹이 아닌 것은 스토킹으로 가지 않는다", async () => {
    for (const q of [
      "업무누락 반복하는 실장급 직원",
      "집주인이 찾아와서 나가라고 해요",
      "동사무소에 계속 찾아갔는데 서류를 안 줘요",
      "보일러가 고장났는데 집주인이 수리비를 부담하래",
      "월급을 두 달째 못 받고 있어요",
    ]) {
      const t = await callText("search_topics", { query: q });
      const 첫줄 = (t.split("\n").find((l) => l.trim().startsWith("- `")) ?? "").trim();
      expect(첫줄, `'${q}' 의 1순위가 스토킹이다`).not.toContain("스토킹");
    }
  });

  // 상담창 시작 화면의 예시 문장은 하나라도 0건이면 첫인상이 무너진다.
  // "중고거래로 사기를 당했어요"가 실제로 0건이었다(2026-08-24, 은미님 폰에서 발견).
  it("상담창 예시 문장이 전부 주제를 찾는다", async () => {
    for (const q of [
      "월급을 두 달째 못 받고 있어요",
      "전세 보증금을 안 돌려줘요",
      "헤어진 사람이 계속 집 앞에 찾아와요",
      "법원에서 지급명령이 왔어요",
      "중고거래로 사기를 당했어요",
    ]) {
      const t = await callText("search_topics", { query: q });
      expect(t, `'${q}' 가 0건이다`).not.toContain("찾지 못했습니다");
    }
  });

  // "사기 당했어요"는 흔한 첫마디다. 유형이 여럿이라 하나로 못 좁히니 후보를 보여준다.
  it("사기: 유형을 모를 때 후보를 늘어놓는다", async () => {
    const t = await callText("search_topics", { query: "사기를 당했어요" });
    expect(t).not.toContain("찾지 못했습니다");
    expect((t.match(/^-\s+`/gm) ?? []).length).toBeGreaterThan(1);
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
  it("수리비 부담 질문이 보증금반환으로 새지 않는다 — '집주인'이 양쪽 동의어라 갈림 (8/16 실측)", async () => {
    for (const q of ["보일러가 고장났는데 집주인이 수리비를 부담하래 이게 맞아?", "집주인이 보일러를 안 고쳐줘요", "에어컨이 안 되는데 집주인이 알아서 하래요"]) {
      const t = await callText("search_topics", { query: q });
      expect((t.match(/- `([^`]+)`/) ?? [])[1], q).toBe("임대인수선의무");
    }
    // 보증금·갱신 경로는 그대로 유지되어야 한다
    for (const [q, want] of [["집주인이 전세금을 안 돌려줘요", "전세보증금반환"], ["계약 갱신 거절당했어요", "계약갱신차임증액분쟁"]] as const) {
      const t = await callText("search_topics", { query: q });
      expect((t.match(/- `([^`]+)`/) ?? [])[1], q).toBe(want);
    }
  });
  it("실사용 발화(지식iN 원문) — 일반 사기·중고사기가 전세사기로 오매칭되지 않는다 (8/16 628건 분석 반영)", async () => {
    // 수정 전: '사기 피해' 20건 중 8건이 전세사기대응으로 갔음
    for (const q of ["코인투자 사기 피해", "사기 피해 구제를 하려면 어떻게 하나요?", "4천원 사기 당했어요 신고 가능한가요"]) {
      const t = await callText("search_topics", { query: q });
      const top = (t.match(/- `([^`]+)`/) ?? [])[1] ?? "";
      expect(top, q).not.toBe("전세사기대응");
      expect(top, q).toMatch(/거래투자사기|즉시계좌지급정지|피해금환급절차/);
    }
    for (const q of ["중고사기 피해금액 돌려받을 수 있나요?", "중고 사기 당했습니다 도와주세요", "중고사기 카드깡 의심"]) {
      const t = await callText("search_topics", { query: q });
      expect((t.match(/- `([^`]+)`/) ?? [])[1], q).toBe("중고거래사기");
    }
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
    expect(t).toContain("2023다240299");
    expect(t).toContain("최고 연 20%");
    expect(t).toContain("이 확인서만으로 바로 강제집행할 수 있는 것은 아니며");
  });
  it("대여금 반환 내용증명은 최고 후 6개월 내 후속조치 필요를 정확히 안내", async () => {
    const t = await callText("get_form_template", { form: "대여금반환_내용증명" });
    expect(t).toContain("민법 제174조");
    expect(t).toContain("최고 시점으로 소급한 시효중단 효과");
    expect(t).toContain("이미 완성된 시효가 내용증명만으로 되살아나는 것은 아닙니다");
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

  // ListView 검증용(프리뷰 확인 전까지 find_legal_aid만). 스펙에서 벗어나면
  // 카카오가 위젯을 통째로 버리므로, 형태만이라도 테스트로 붙잡아 둔다.
  it("find_legal_aid ListView — 루트가 ListView이고 항목마다 tel:이 걸린다", async () => {
    process.env.LISTVIEW = "on";
    try {
      const w = JSON.parse(await callText("find_legal_aid", { keyword: "체불" }));
      expect(w.widget.type).toBe("ListView");
      expect(w.widget.children.length).toBeGreaterThan(0);
      for (const it of w.widget.children) expect(it.type).toBe("ListViewItem");
      const tels = w.widget.children
        .map((it: any) => it.onClickAction?.payload?.target?.url)
        .filter(Boolean);
      expect(tels.length).toBeGreaterThan(0);
      for (const u of tels) expect(String(u)).toMatch(/^tel:\d+$/);
      expect(JSON.stringify(w.widget)).not.toContain('"status"');
      expect(w.copy_text).toBeTruthy();
    } finally {
      delete process.env.LISTVIEW;
    }
  });

  // 실기기(카카오톡) 캡처에서 "5명 이상이면"이 "• 명 이상이면"으로 나왔다(2026-09-01).
  // 목록 번호를 벗기는 정규식이 구두점을 선택사항(`[)\-]?`)으로 둬서 `^\d+`만으로도 걸렸고,
  // 숫자로 시작하는 본문의 앞 숫자를 통째로 먹었다. 같은 방식으로 "30일 전"·"2주 안에" 같은
  // 기한 숫자도 사라진다 — 법률 안내에서 숫자가 조용히 없어지는 건 틀린 안내와 같다.
  // 텍스트 모드에는 이 처리가 없으므로 반드시 위젯 모드에서 검사해야 한다.
  it("본문 앞 숫자를 목록 번호로 오인해 지우지 않는다", async () => {
    // for_assistant에는 절차 원문이 그대로 들어가므로, 화면에 그려지는 widget만 본다.
    const 카드 = async (topic: string) =>
      JSON.stringify(JSON.parse(await callText("get_procedure", { topic })).widget);
    const w = await 카드("오인미만사업장");
    expect(w).toContain("5명 이상이면");
    expect(w).toContain("4명 이하라면");
    // 앞의 숫자가 잘리면 "• 명 이상이면" / "2. 명 이상이면" 꼴이 된다
    expect(w).not.toMatch(/(•|\d+\.)\s*명 이상이면/);
    // (프리랜서근로자성의 같은 형태는 6번째 단계라 카드에서 잘려 나가 검사 대상이 아니다)
    // 진짜 목록 번호("1) ")는 그대로 벗겨져야 한다
    const g = await 카드("교통사고후속절차");
    expect(g).not.toContain("1) 현장 안전");
    expect(g).toContain("현장 안전");
  });

  it("find_legal_aid는 Preview 검증 전까지 기본 Card로 내보낸다", async () => {
    delete process.env.LISTVIEW;
    const w = JSON.parse(await callText("find_legal_aid", { keyword: "체불" }));
    expect(w.widget.type).toBe("Card");
  });

  // 판례 배지는 '판단이 있다'는 신호까지만 준다. 요지를 실으면 "나도 이기겠네"로 읽히고,
  // 이 서비스는 사건의 결론을 단정하지 않기로 되어 있다.
  it("판례 배지 — 법원 종류를 정확히 구분하고 요지는 싣지 않는다", async () => {
    const 기대: [string, RegExp][] = [
      ["임금체불", /대법원 \d+건/],
      ["직장내괴롭힘", /하급심 \d+건/],     // 서울남부지법만 수록 — 대법원이라고 하면 거짓말이다
      ["검사불기소항고", /헌법재판소 \d+건/], // 헌재는 하급심이 아니다
    ];
    for (const [topic, re] of 기대) {
      const w = JSON.parse(await callText("get_procedure", { topic }));
      expect(JSON.stringify(w.widget), topic).toMatch(re);
    }
    // 판례가 없는 주제엔 배지가 붙지 않는다
    const 없음 = JSON.parse(await callText("get_procedure", { topic: "허위조작정보피해" }));
    expect(JSON.stringify(없음.widget)).not.toContain("⚖️");
  });

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
  it("위젯 봉투는 카카오 확정 필드만 보낸다", async () => {
    const t = await callText("get_form_template", { form: "금전소비대차계약서" });
    const j = JSON.parse(t);
    // 카카오 공식 3종(widget·copy_text·name) + for_assistant.
    // for_assistant는 가이드에 없는 확장이지만 2026-08-26 카카오 툴즈 프리뷰에서
    // 카드가 정상 렌더되는 것을 실제 화면으로 확인했다. 이게 빠지면 카드는 떠도
    // 호스트 AI가 서식 본문을 몰라 초안을 지어낸다.
    expect(Object.keys(j).sort()).toEqual(["copy_text", "for_assistant", "name", "widget"]);
    expect(j.widget.type).toBe("Card");
    expect(t).toContain("민감번호는 채팅에 쓰지 말고");
  });
  it("모든 위젯 응답에 미지원 최상위 필드가 없다", async () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ["triage", { situation: "임금체불 3개월" }],
      ["find_legal_aid", { keyword: "체불" }],
      ["get_procedure", { topic: "임금체불" }],
      ["get_checklist", { topic: "임금체불" }],
      ["calculate_amount", { item: "퇴직금", daily_avg_wage: 100000, tenure_days: 1095 }],
      ["calculate_court_cost", { claim_amount: 10000000, parties: 2, track: "소액" }],
      ["calculate_deadline", { start_date: "2026-06-23", deadline_type: "상속포기_한정승인" }],
    ];
    for (const [name, args] of samples) {
      const j = JSON.parse(await callText(name, args));
      expect(Object.keys(j).sort(), name).toEqual(["copy_text", "for_assistant", "name", "widget"]);
    }
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
  it("get_procedure → 절차 카드(기한 배지 + 단계 번호)", async () => {
    const t = await callText("get_procedure", { topic: "임금체불" });
    const j = JSON.parse(t);
    expect(j.name).toBe("get_procedure");
    expect(j.widget.type).toBe("Card");
    // 기한을 맨 위 배지로 — 놓치면 권리가 사라지는 정보라 본문에 묻으면 안 된다.
    expect(JSON.stringify(j.widget)).toContain("⏰");
    expect(JSON.stringify(j.widget)).toMatch(/"1\. /);
    // 가이드에 없는 최상위 필드를 추가하지 않는다.
    expect(Object.keys(j).sort()).toEqual(["copy_text", "for_assistant", "name", "widget"]);
  });

  it("get_checklist → 체크리스트 카드(증거·서류 두 묶음)", async () => {
    const t = await callText("get_checklist", { topic: "임금체불" });
    const j = JSON.parse(t);
    expect(j.name).toBe("get_checklist");
    expect(j.widget.type).toBe("Card");
    const w = JSON.stringify(j.widget);
    expect(w).toContain("모아둘 증거");
    expect(w).toContain("접수용 서류");
    expect(w).toContain("☐");
  });

  it("find_legal_aid → 전화 버튼이 tel: 스킴으로 나간다", async () => {
    const t = await callText("find_legal_aid", { keyword: "체불" });
    const j = JSON.parse(t);
    expect(j.name).toBe("find_legal_aid");
    const w = JSON.stringify(j.widget);
    // 카카오 가이드 §3.3 — onClickAction.payload.target.url은 AppScheme도 받는다.
    // 이 서비스 사용자가 제일 자주 막히는 "어디에 물어보나"를 한 번 눌러 해결한다.
    expect(w).toContain("tel:");
    expect(w).toContain("132");
  });

  it("[회귀] 기한 카드는 남은 일수를 제목 자리에 크게 둔다", async () => {
    const t = await callText("calculate_deadline", { start_date: "2099-01-01", deadline_type: "상속포기_한정승인" });
    const j = JSON.parse(t);
    const title = j.widget.children.find((c: { type: string }) => c.type === "Title");
    expect(title.size).toBe("lg");
    expect(String(title.value)).toMatch(/^D-\d+$/);
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
    expect(t).toContain("서식 다운로드");
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

  it("서식 페이지의 클라이언트 스크립트가 문법적으로 살아있다", async () => {
    // 2026-08-16, 그리고 2026-08-19에 또 — 템플릿 리터럴 안의 클라이언트 JS에서
    // 줄바꿈을 "\\n" 이 아니라 "\n" 으로 쓰면 실제 줄바꿈으로 치환돼 문자열이 끊긴다.
    // SyntaxError 하나로 페이지 스크립트 전체가 죽는다(인쇄·자동저장·체크박스·
    // 내보내기 전부). 문서에 적어두는 것만으로는 두 번 다 못 막았다.
    for (const key of FORM_KEYS.slice(0, 6)) {
      const res = await fetch(`${base}/forms/${encodeURIComponent(key)}`);
      const html = await res.text();
      const scripts = [...html.matchAll(/<script(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const src of scripts) {
        try {
          new Function(src);
        } catch (e) {
          throw new Error(`${key}: 서식 페이지 스크립트 문법 오류 — ${(e as Error).message}`);
        }
      }
    }
  });
});

// 이 서비스는 가정폭력·성폭력·스토킹 상담을 다룬다. triage의 situation에는 "남편이 때려요" 같은
// 사용자 원문이 들어온다. 그래서 로그가 "무엇을 남기는지"보다 "무엇을 안 남기는지"를 못 박아 둔다.
// 이 세 가지가 깨지면 피해 사실이 적힌 문장이 관리자 화면에 그대로 뜬다.
describe("도구 호출 디버그 로그 (/admin/logs)", () => {
  const ADMIN_PW = "테스트용비밀번호";
  const 이전DEBUG = process.env.DEBUG_LOG;
  const 이전PASS = process.env.ADMIN_PASS;
  let cookie = "";

  beforeAll(async () => {
    process.env.ADMIN_PASS = ADMIN_PW;
    const res = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pw: ADMIN_PW }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^admin=/);
  });

  afterAll(() => {
    if (이전DEBUG === undefined) delete process.env.DEBUG_LOG;
    else process.env.DEBUG_LOG = 이전DEBUG;
    if (이전PASS === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = 이전PASS;
    clearLogs();
  });

  async function logsJson(): Promise<any> {
    const res = await fetch(`${base}/admin/logs?format=json`, { headers: { Cookie: cookie } });
    return res.json();
  }
  async function logsHtml(): Promise<string> {
    const res = await fetch(`${base}/admin/logs`, { headers: { Cookie: cookie } });
    return res.text();
  }

  it("DEBUG_LOG가 꺼져 있으면(기본값) 수집도 조회도 하지 않는다", async () => {
    delete process.env.DEBUG_LOG;
    clearLogs();
    await callText("triage", { situation: "월급을 3개월째 못 받았어요" });

    expect(await logsJson()).toEqual({ enabled: false, entries: [] });
    expect(await logsHtml()).toContain("꺼져 있습니다");

    // 조회만 막는 게 아니라 애초에 쌓이지 않았는지 — 켠 뒤에 봐도 비어 있어야 한다.
    process.env.DEBUG_LOG = "on";
    expect((await logsJson()).entries).toEqual([]);
    delete process.env.DEBUG_LOG;
  });

  it("로그인하지 않으면 /admin/logs·/forms 둘 다 비밀번호를 묻는다", async () => {
    for (const path of ["/admin/logs", "/forms"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("비밀번호를 입력하세요");
    }
    // 틀린 비밀번호로는 쿠키를 받지 못한다
    const bad = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pw: "틀린비밀번호" }).toString(),
      redirect: "manual",
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("ADMIN_PASS가 없으면 소스에 없는 임시 비밀번호를 만들어 쓴다 — 알려진 값으로는 못 들어온다", async () => {
    // 저장소가 공개라 소스에 기본 비밀번호를 둘 수 없다. 그렇다고 문을 아예 닫으면
    // 환경변수를 못 주는 배포 환경(PlayMCP in KC는 서버 생성 시에만 환경변수를 받는다)에서
    // 관리자 화면을 영영 못 연다. 그래서 시작할 때 무작위로 만들고 서버 로그에만 찍는다.
    // 콘솔 로그를 볼 수 있는 사람 = 환경변수를 넣을 수 있는 사람이라 보호 수준은 같다.
    delete process.env.ADMIN_PASS;
    try {
      for (const path of ["/admin/logs", "/forms"]) {
        // 다른 비밀번호로 받아 둔 쿠키는 통하지 않는다 — 로그인 화면이 뜬다.
        const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(401);
        const html = await res.text();
        expect(html).toContain("비밀번호를 입력하세요");
      }
      // 옛 기본값·빈 값·아무 문자열 어느 것으로도 로그인되지 않는다.
      // (임시 비밀번호는 서버 로그에만 있고 소스·응답 어디에도 없다.)
      for (const pw of ["", "세일러문", "아무거나"]) {
        const res = await fetch(`${base}/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ pw }).toString(),
          redirect: "manual",
        });
        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    } finally {
      process.env.ADMIN_PASS = ADMIN_PW;
    }
  });
  it("정상 호출은 인자의 값을 남기지 않는다 — 키 이름만", async () => {
    process.env.DEBUG_LOG = "on";
    clearLogs();
    const 원문 = "월급을 3개월째 못 받았어요";
    const 응답 = await callText("triage", { situation: 원문 });
    expect(응답).not.toContain("찾지 못했습니다"); // 매칭에 성공한 = 정상 호출

    const { enabled, entries } = await logsJson();
    expect(enabled).toBe(true);
    const [최근] = entries;
    expect(최근.tool).toBe("triage");
    expect(최근.ok).toBe(true);
    expect(최근.flag).toBeUndefined();
    expect(최근.argKeys).toEqual(["situation"]); // 키 이름은 남고
    expect(최근.args).toBeUndefined(); // 값은 남지 않는다
    // 로그 어디에도(관리자 화면 HTML 포함) 사용자 문장이 보이면 안 된다.
    expect(JSON.stringify(entries)).not.toContain("월급");
    expect(await logsHtml()).not.toContain(원문);

    delete process.env.DEBUG_LOG;
  });

  it("매칭 실패(no_match)여도 사용자 원문을 남기지 않는다", async () => {
    process.env.DEBUG_LOG = "on";
    clearLogs();
    const 원문 = "즐거운 캠핑 장비 추천 부탁 010-1234-5678 me@example.com";
    const 응답 = await callText("triage", { situation: 원문 });
    expect(응답).toContain("찾지 못했습니다");

    const [최근] = (await logsJson()).entries;
    expect(최근.flag).toBe("no_match");
    expect(최근.argKeys).toEqual(["situation"]);
    expect(최근.args).toBeUndefined();
    expect(JSON.stringify(최근)).not.toContain("캠핑 장비");
    expect(JSON.stringify(최근)).not.toContain("1234-5678");
    expect(await logsHtml()).toContain("입력값 미저장");

    delete process.env.DEBUG_LOG;
  });

  // 카카오 개발가이드 §5.3 — 주민등록번호 등 6종을 '요구'하지 않는다.
  // 서식 본문의 [______] 빈칸은 종이에 직접 적는 칸이지, 채팅에서 받아낼 값이 아니다.
  it("서식 응답은 민감번호를 묻지 말라고 어시스턴트에게 지시한다", async () => {
    for (const form of ["개명허가_신청서", "상속포기심판청구서"]) {
      const text = await callText("get_form_template", { form });
      expect(text, form).toContain("주민등록번호·운전면허번호·여권번호");
      expect(text, form).toContain("묻지도, 받아 적지도");
    }
  });

  // 2026-07-07 시행 정보통신망법(허위조작정보)·경찰 교제폭력 용어. 라이브에서 셋 다 매칭 실패했었다.
  it("최신 법률 용어가 매칭된다 — 가짜뉴스·허위조작정보·교제폭력 (8/26 구멍 메움)", async () => {
    // "허위사실 유포"처럼 두 낱말을 붙여 넣으면 조사가 낀 문장에 안 걸린다 —
    // 마지막 항목이 실제로 라이브에서 실패했던 문장이다.
    for (const q of ["누가 나에 대해 가짜뉴스를 퍼뜨렸어요", "허위조작정보로 피해를 봤어요",
                     "인터넷에 저에 대한 허위사실이 퍼졌어요", "저에 대해 사실이 아닌 얘기가 돌아요"]) {
      const t = await callText("search_topics", { query: q });
      expect(t, q).not.toContain("찾지 못했습니다");
      expect(t, q).toContain("허위조작정보피해");
    }
    for (const q of ["교제폭력을 당하고 있어요", "데이트폭력 신고하고 싶어요"]) {
      const t = await callText("search_topics", { query: q });
      expect(t, q).not.toContain("찾지 못했습니다");
      expect(t, q).toMatch(/스토킹|폭행|협박|가정폭력/);
    }
  });

  it("허위조작정보 주제는 법정 요건과 기한을 그대로 전한다", async () => {
    const t = await callText("get_procedure", { topic: "허위조작정보피해" });
    // 5배 가중배상은 요건 3개를 다 갖춘 '업으로 하는 게재자'에게만 — 일반 이용자에게 겁주면 안 된다.
    expect(t).toContain("5배");
    expect(t).toContain("6개월");
    expect(t).toContain("풍자");
  });


  // 근로기준법 시행령 별표 1: 상시 4명 이하 사업장에는 제23조가 "제2항"만 적용되고
  // 제28조(노동위 구제신청)는 목록에 없다. 5인 미만인데 부당해고 구제를 안내하면
  // 그 사람은 노동위에 갔다가 각하된다 — 못 찾는 것보다 나쁜 오안내다.
  it("5인 미만 신호가 있으면 부당해고가 아니라 규모 주제로 간다", async () => {
    for (const q of [
      "5인 미만 사업장인데 부당해고 당했어요",
      "직원이 나 혼자인 가게에서 잘렸어요",
      "상시 근로자 4명인데 해고됐어요",
      // 2026-09-01 라이브 발화 점검에서 실제로 실패했던 넷. 앞의 셋은 부당해고 구제로 갔고
      // (=노동위 각하 경로) "나 포함 세 명"은 어느 주제에도 닿지 못했다.
      // 사람이 규모를 말하는 방식은 '5인 미만'이라는 법률 용어와 거리가 멀다.
      "직원이 나 포함 세 명인데 갑자기 나오지 말래요",
      "작은 가게라 직원이 저 혼자인데 잘렸어요",
      "사장님이랑 저밖에 없는 회사인데 그만두래요",
      "직원 3명인 회사에서 해고됐어요",
      "저밖에 직원이 없는데 해고 통보를 받았어요",
      // 가산수당·연차는 별표 1에 없어 5인 미만에는 아예 적용되지 않는다 — 해고와 같은 무게다.
      "직원 3명인데 연차를 안 줘요",
      "직원이 저 포함 네 명인데 야근수당을 안 줘요",
    ]) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain("5인 미만 사업장");
    }
    // 규모 신호가 없으면 기존 부당해고 경로가 그대로여야 한다(과잉 적용 방지)
    for (const q of ["부당해고 당했어요", "회사에서 갑자기 해고 통보를 받았어요", "회사에서 부당하게 해고당했어요"]) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain("부당해고 구제");
      expect(t, q).not.toContain("5인 미만 사업장 —");
    }
  });

  // 2026-09-01 라이브 발화 점검(48개) 회귀 고정. 동의어가 '글자 그대로' 일치할 때만
  // 걸리는 구조라, 활용형·표기 하나가 어긋나면 통째로 0건이 됐다.
  // 실기기에서 "경찰에서 나를 응급입원 시켰어 이거 인권침해아니야?"가 '인권침해'라는 낱말 때문에
  // 「군 내 인권침해·고충 진정(군인권보호관)」으로, "경찰 응급입원 적법한 절차인지"가
  // '경찰·긴급' 때문에 「경찰의 긴급응급조치(스토킹)」로 갔다(2026-09-01). 둘 다 완전히 다른 절차다.
  // 주제는 있었는데 동의어가 하나도 없어 발화가 닿지 못한 것이었다.
  // initialize의 instructions 첫 문단이 호스트 LLM의 "이 서버를 부를까" 판단 지점이다.
  // 여기에 없는 영역은 주제가 있어도 신호가 가지 않는다 — 실기기에서 "경찰이 응급입원
  // 시켰어"에 우리 툴이 호출되지 않았고, 분야 목록에 경찰·입원·체포가 통째로 빠져 있었다.
  // ⛔ 주제를 새로 만들면 이 목록에도 반드시 넣을 것. 이 검사가 그걸 붙잡는다.
  // 재배포가 안 올라갔는데 콘솔은 계속 Active였고 빌드 로그를 볼 화면도 없었다(9/1).
  // 어느 커밋이 라이브인지 서식 본문을 뒤져 추측하던 것을 한 번에 보게 만든 필드다.
  // 실기기에서 이름·금액을 다 말했는데도 모델이 "제가 임의로 채워서 제공하기보다는"이라며
  // 초안을 거절하고 값을 목록으로만 나열했다(2026-09-02). declaw의 "채우는 수준까지만"이
  // 브레이크로 읽힌 것으로 보여, 채우는 것 자체는 '하라'고 뒤집어 적었다.
  // ⛔ 이 문구를 되돌리지 말 것 — 되돌리면 서식 초안 기능이 다시 죽는다.
  it("서식 초안을 거절하지 못하게 못 박는다", async () => {
    // 이 describe는 텍스트 모드라 지침이 마크다운 본문에 그대로 실려 나온다
    const fa = await callText("get_form_template", { form: "임금체불진정서" });
    expect(fa).toContain("초안 작성을 거절하지 마세요");
    expect(fa).toContain("서식 모양 그대로");
    // 민감번호 금지선은 그대로 살아 있어야 한다
    expect(fa).toContain("주민등록번호");
    expect(fa).toContain("종이에 직접");
    // 서버 안내문 쪽도 '채우는 것은 할 일'로 바뀌었는지
    expect(SERVER_INSTRUCTIONS).toContain("거절하지 마세요");
    expect(SERVER_INSTRUCTIONS).not.toContain("채우는 수준까지만");
  });

  it("/healthz가 규모를 함께 돌려준다 — 라이브가 어느 빌드인지 한 번에 본다", async () => {
    const r = await fetch(`${base}/healthz`);
    const j: any = await r.json();
    expect(j.status).toBe("ok");
    expect(j.scale.topics).toBe(TOPIC_KEYS.length);
    expect(j.scale.forms).toBe(FORM_KEYS.length);
    expect(j.scale.statutes).toBeGreaterThan(300);
  });

  it("서버 안내문의 분야 목록이 실제 주제를 따라간다", () => {
    const ins = SERVER_INSTRUCTIONS;
    for (const 영역 of [
      "5인 미만", "전동킥보드", "현행범", "임의동행", "보호조치",
      "압수수색", "형사보상", "국가배상", "공무원 불친절", "응급입원",
    ]) {
      expect(ins, 영역).toContain(영역);
    }
    expect(ins).toContain(String(TOPIC_KEYS.length));
  });

  it("비자의입원·응급입원 발화가 제 주제로 간다", async () => {
    for (const q of [
      "경찰에서 나를 응급입원 시켰어 이거 인권침해아니야?",
      "경찰 응급입원 적법한 절차인지 따지고 싶어",
      "강제로 정신병원에 입원당했어요",
      "보호입원 됐는데 퇴원하고 싶어요",
    ]) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain("입원");
      expect(t, q).not.toContain("군인권보호관");
      expect(t, q).not.toContain("스토킹");
    }
    // 응급입원의 적법성을 따질 근거가 실제로 실려 있어야 한다(제50조 요건)
    const p = await callText("get_procedure", { topic: "정신질환_비자의입원_심사" });
    expect(p).toContain("의사와 경찰관");
    expect(p).toContain("3일(공휴일 제외)");
    // 뺏기면 안 되는 것
    const 군 = await callText("triage", { situation: "군대에서 인권침해를 당했어요" });
    expect(군).toContain("군인권");
    const 스 = await callText("triage", { situation: "스토킹 당하고 있어요" });
    expect(스).toContain("스토킹");
  });

  // 공권력 행사(체포·비자의입원)의 적법성을 따지고 사후 구제로 가는 경로가 통째로 없었다.
  // "가정폭력이든 뭐든 현행범으로 입건할 때 그 절차가 적법한지"에 답할 주제가 아예 없었고,
  // 위법으로 판명된 뒤의 손해배상·징계 경로도 응급입원 주제에서 이어지지 않았다(2026-09-01).
  // 2026-09-01 커버리지 확대 — 공권력 계열에서 체포 '이전'(임의동행·보호조치),
  // '이후'(형사보상·압수 다툼), 그리고 일상 접점(공무원 불친절)이 통째로 비어 있었다.
  it("공권력 계열 신규 4주제가 제 발화에 닿는다", async () => {
    const pairs: [string, string][] = [
      ["경찰이 같이 가자고 해서 파출소에 갔어요", "임의동행"],
      ["술 취했다고 경찰서에 하루 넘게 잡아놨어요", "임의동행"],
      ["무죄 받았는데 갇혀 있던 기간 보상받을 수 있나요", "형사보상"],
      ["불기소 처분 받았는데 구금됐던 건 보상 안 되나요", "형사보상"],
      ["경찰이 휴대폰을 그냥 달라고 해서 줬어요", "압수·수색"],
      ["압수한 물건을 돌려받고 싶어요", "압수·수색"],
      ["주민센터 공무원이 너무 불친절해요", "불친절"],
      ["사람 봐가면서 친절하던데 신고할 수 있나요", "불친절"],
    ];
    for (const [q, 기대] of pairs) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain(기대);
    }
    // 각 주제에 핵심 숫자·요건이 실려 있어야 한다
    const 동행 = await callText("get_procedure", { topic: "임의동행보호조치" });
    expect(동행).toContain("거절할 수 있");   // 경직법 제3조② 후단
    expect(동행).toContain("6시간");
    expect(동행).toContain("24시간");
    const 보상 = await callText("get_procedure", { topic: "형사보상청구" });
    expect(보상).toContain("피의자보상");
    expect(보상).toContain("3년");
    const 압수 = await callText("get_procedure", { topic: "압수수색적법성" });
    expect(압수).toContain("임의제출");
    expect(압수).toContain("준항고");
    const 공무원 = await callText("get_procedure", { topic: "공무원불친절부당대우" });
    expect(공무원).toContain("친절");
    expect(공무원).toContain("고충민원");
    // 과장하지 않는다 — 민원인이 직접 징계를 시킬 수는 없다는 한계를 밝혀야 한다
    expect(공무원).toContain("소속기관장");
    // 뺏기면 안 되는 것
    const 유지: [string, string][] = [
      ["행정처분에 불복하고 싶어요", "행정심판"],
      ["국가배상 신청하려면 어떻게 하나요", "국가배상"],
      ["고소를 하고 싶어요", "고소"],
      ["국선변호인 신청하고 싶어요", "국선변호인"],
    ];
    for (const [q, 기대] of 유지) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain(기대);
    }
  });

  it("체포 적법성·사후 구제 발화가 제 주제로 간다", async () => {
    for (const q of [
      "가정폭력으로 현행범 체포됐는데 절차가 적법했는지 알고 싶어요",
      "경찰이 영장도 없이 저를 체포했어요",
      "체포가 부당했는데 어떻게 다투나요",
      "체포할 때 아무 설명도 안 해줬어요",
    ]) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain("체포");
    }
    // 요건이 실제로 실려 있어야 한다
    const p = await callText("get_procedure", { topic: "체포적법성확인구제" });
    expect(p).toContain("48시간");
    expect(p).toContain("변명할 기회");
    expect(p).toContain("50만원");          // 제214조 경미사건 제한
    expect(p).toContain("적부심사");
    // 위법으로 판명된 뒤의 구제 — 응급입원 주제에서도 이어져야 한다
    const 입원 = await callText("get_procedure", { topic: "정신질환_비자의입원_심사" });
    expect(입원).toContain("국가배상");
    expect(입원).toContain("징계");
    // 뺏기면 안 되는 것
    expect(await callText("triage", { situation: "가정폭력을 당하고 있어요" })).toContain("가정폭력");
    expect(await callText("triage", { situation: "고소를 하고 싶어요" })).toContain("고소");
  });

  it("표현이 달라도 같은 주제에 닿는다 — 9/1 발화 점검분", async () => {
    const pairs: [string, string][] = [
      // 아라비아 숫자·1인칭 '저'·중간 삽입형 (전부 노동위 각하 경로로 가고 있었다)
      ["저 포함 네 명 일하는데 부당해고 당했어요", "5인 미만 사업장"],
      // '계약서'라는 말 대신 '서류'라고만 하는 사람
      ["입사할 때 아무 서류도 안 썼어요", "근로계약서"],
      // 주휴수당을 못 받는 사람일수록 '주휴'라는 말을 모른다
      ["카페에서 일하는데 주말에 일한 돈을 안 챙겨줘요", "주휴수당"],
      // "개인사업자로 계약"만 있고 "등록"이 없어 한 글자 차이로 갈렸다
      ["개인사업자로 등록했는데 회사 지시대로만 일했어요", "근로자로 인정"],
      // "보증 서줬"이 빠져 가장 흔한 표현 하나가 0건이었다
      ["친구 대출에 보증 서줬는데 은행에서 저한테 갚으래요", "연대보증"],
      // 근로자성이 먼저다 — 건너뛰고 퇴직금 진정을 넣으면 '근로자가 아니다'에서 막힌다
      ["프리랜서인데 4대보험도 안 되고 퇴직금도 못 받나요", "근로자로 인정"],
      // 사고가 막 난 사람에게 필요한 건 신고·진단서이지 과실비율 심의가 아니다
      ["교통사고가 났어요", "교통사고 직후 처리"],
    ];
    for (const [q, 기대] of pairs) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain(기대);
    }
    // 과잉 적용 방지 — 종전 주제가 그대로여야 하는 것들
    const 유지: [string, string][] = [
      ["퇴직금을 못 받았어요", "퇴직금 미지급"],
      ["월급을 3개월째 못 받았어요", "임금체불"],
      ["차 사고가 나서 상대방이랑 과실을 다투고 있어요", "과실비율"],
      ["부당해고 당했어요", "부당해고 구제"],
    ];
    for (const [q, 기대] of 유지) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain(기대);
    }
  });

  it("근로계약서·주휴수당 발화가 새 주제로 도달한다", async () => {
    const pairs: [string, string][] = [
      ["근로계약서를 안 썼어요", "근로계약서"],
      ["계약서를 못 받았어요", "근로계약서"],
      ["주휴수당을 안 줘요", "주휴수당"],
      ["주휴 안 주는데요", "주휴수당"],
    ];
    for (const [q, 기대] of pairs) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain(기대);
    }
  });

  // GAP_ANALYSIS.md 보완 우선순위 6개 — 팀이 정리한 구멍이 실제로 메워졌는지.
  it("[GAP] 팀이 지목한 구멍 6개 발화가 전부 제 주제로 간다", async () => {
    const 표: [string, string][] = [
      ["근로계약서를 안 썼어요", "근로계약서"],
      ["5인 미만 사업장인데 부당해고 당했어요", "5인 미만 사업장"],
      ["프리랜서인데 근로자로 인정받을 수 있나요", "근로자로 인정"],
      ["킥보드 타다가 사고 났어요", "개인형 이동장치"],
      ["연대보증 섰다가 빚을 떠안게 됐어요", "연대보증"],
      ["주휴수당을 안 줘요", "주휴수당"],
    ];
    for (const [q, 기대] of 표) {
      const t = await callText("triage", { situation: q });
      expect(t, q).not.toContain("찾지 못했습니다");
      expect(t, q).toContain(기대);
    }
  });

  // 새 주제가 기존 경로를 뺏으면 그게 더 큰 사고다.
  it("[GAP] 새 주제가 기존 주제를 뺏지 않는다", async () => {
    const 표: [string, string][] = [
      ["월급을 3개월째 못 받았어요", "임금체불"],
      ["부당해고 당했어요", "부당해고 구제"],
      ["교통사고가 났어요", "교통사고"],
      ["빌려준 돈을 못 받고 있어요", "대여금"],
      ["퇴직금을 못 받았어요", "퇴직금"],
    ];
    for (const [q, 기대] of 표) {
      const t = await callText("triage", { situation: q });
      expect(t, q).toContain(기대);
    }
  });

});
