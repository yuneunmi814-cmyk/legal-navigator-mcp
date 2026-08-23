// 로깅 프라이버시 회귀 테스트 — PR 리뷰(2026-08-24) 반영분.
// 성공 호출은 자유 텍스트(situation 등)를 남기지 않고, 기본은 꺼져 있어야 한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { logCall, recentLogs } from "../src/debugLog.js";

describe("도구 호출 로깅", () => {
  const original = process.env.DEBUG_LOG;
  afterEach(() => {
    if (original === undefined) delete process.env.DEBUG_LOG;
    else process.env.DEBUG_LOG = original;
  });

  it("DEBUG_LOG가 꺼져 있으면(기본값) 아무것도 기록하지 않는다", () => {
    delete process.env.DEBUG_LOG;
    const before = recentLogs(1000).length;
    logCall({ tool: "triage", args: { situation: "남편이 때려요" }, ms: 5, ok: true });
    expect(recentLogs(1000).length).toBe(before);
  });

  it("DEBUG_LOG=on이어도 성공 호출은 args를 남기지 않는다", () => {
    process.env.DEBUG_LOG = "on";
    logCall({ tool: "triage", args: { situation: "남편이 때려요" }, ms: 5, ok: true });
    const [latest] = recentLogs(1);
    expect(latest.tool).toBe("triage");
    expect(latest.ok).toBe(true);
    expect(latest.args).toBeUndefined();
  });

  it("DEBUG_LOG=on이고 주제 매칭 실패(no_match)면 args를 남긴다(마스킹 적용)", () => {
    process.env.DEBUG_LOG = "on";
    logCall({
      tool: "triage",
      args: { situation: "010-1234-5678로 연락주세요" },
      ms: 5,
      ok: true,
      flag: "no_match",
    });
    const [latest] = recentLogs(1);
    expect(latest.flag).toBe("no_match");
    expect(latest.args).toEqual({ situation: "[전화번호]로 연락주세요" });
  });
});
