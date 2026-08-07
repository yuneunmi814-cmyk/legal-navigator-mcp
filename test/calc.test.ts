// 순수 계산 함수 결정성·경계 테스트(서버 부팅 불필요).
import { describe, it, expect } from "vitest";
import { calcCourtCost, calcDeadline, calcUnpaidWages, calcSeverance, calcSelfCancelRegistryCost, calcInheritanceRegistryCost } from "../src/calc.js";

describe("calcCourtCost (인지대·송달료)", () => {
  it("소가 1억·단독·전자소송 → 인지대 409,500원(구간식×0.9, 끝수 절사)", () => {
    expect(calcCourtCost(100_000_000, 2, "단독", true).결과).toContain("인지대 409,500원");
  });
  it("소액 소가는 최소 인지액 1,000원 하한", () => {
    expect(calcCourtCost(10_000, 2, "소액", false).결과).toContain("인지대 1,000원");
  });
  it("동일 입력 → 동일 출력(결정성)", () => {
    expect(calcCourtCost(50_000_000, 3, "합의", false)).toEqual(calcCourtCost(50_000_000, 3, "합의", false));
  });
});

describe("calcDeadline (기한·날짜 검증)", () => {
  it("정상 날짜 + 14일", () => {
    expect(calcDeadline("2026-06-10", { 일: 14 })?.마감일).toBe("2026-06-24");
  });
  it("정상 날짜 + 3개월", () => {
    expect(calcDeadline("2026-01-15", { 월: 3 })?.마감일).toBe("2026-04-15");
  });
  it("불가능한 날짜(2026-02-31)는 롤오버 없이 null", () => {
    expect(calcDeadline("2026-02-31", { 월: 3 })).toBeNull();
  });
  it("형식 오류는 null", () => {
    expect(calcDeadline("2026/06/10", { 일: 14 })).toBeNull();
    expect(calcDeadline("abc", { 일: 14 })).toBeNull();
    expect(calcDeadline("2026-13-01", { 일: 1 })).toBeNull();
  });
});

describe("calcSelfCancelRegistryCost (셀프등기 절감액 — 근저당 말소)", () => {
  it("집합건물 1건·방문 → 실비 10,200원 (7,200+3,000)", () => {
    const r = calcSelfCancelRegistryCost(1, false);
    expect(r.결과).toContain("10,200원");
    expect(r.결과).toContain("절감");
  });
  it("단독주택 토지+건물 2건·전자신청 → 실비 18,400원 (7,200×2 + 2,000×2)", () => {
    expect(calcSelfCancelRegistryCost(2, true).결과).toContain("18,400원");
  });
  it("동일 입력 동일 출력", () => {
    expect(calcSelfCancelRegistryCost(1, true)).toEqual(calcSelfCancelRegistryCost(1, true));
  });
});

describe("calcInheritanceRegistryCost (셀프 상속등기 비용)", () => {
  it("공시가 3억·주택 1건·서면 → 취득세 8,400,000 + 교육세 480,000 + 수수료 15,000 = 8,895,000원", () => {
    const r = calcInheritanceRegistryCost(300_000_000, 1, false, false);
    expect(r.결과).toContain("8,895,000원");
    expect(r.결과).toContain("법무사 보수");
  });
  it("농지는 2.3%·교육세 0.06% — 공시가 1억·e-Form → 2,300,000 + 60,000 + 13,000", () => {
    expect(calcInheritanceRegistryCost(100_000_000, 1, true, true).결과).toContain("2,373,000원");
  });
  it("동일 입력 동일 출력", () => {
    expect(calcInheritanceRegistryCost(300_000_000, 2, false, true)).toEqual(calcInheritanceRegistryCost(300_000_000, 2, false, true));
  });
});

describe("임금 계산 결정성", () => {
  it("체불임금 = 월급×개월+기타", () => {
    expect(calcUnpaidWages(3_000_000, 3, 500_000).결과).toBe("9,500,000원");
  });
  it("동일 입력 동일 출력", () => {
    expect(calcSeverance(100_000, 730).결과).toBe(calcSeverance(100_000, 730).결과);
  });
});
