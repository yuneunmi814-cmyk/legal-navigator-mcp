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
