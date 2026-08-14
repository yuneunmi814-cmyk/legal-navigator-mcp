// 인용 검증 파싱·대조 단위 테스트.
// 회귀 대상은 전부 "확인해주면 안 되는 걸 확인해준" 또는 "검증이 조용히 미가동된" 사례다.
import { describe, it, expect } from "vitest";
import {
  normalizeLawName,
  splitTier,
  matchLawName,
  extractLawName,
  parseArticle,
  extractCaseNumbers,
  matchCaseNumber,
  caseCore,
} from "../src/citation.js";
import { STATUTES } from "../src/data/index.js";

describe("법령명 정규화", () => {
  it("낫표·공백을 벗긴다", () => {
    expect(normalizeLawName("「주택임대차보호법」")).toBe("주택임대차보호법");
    expect(normalizeLawName("상가건물 임대차보호법")).toBe("상가건물임대차보호법");
  });

  it("가운뎃점 5종을 하나로 모은다(법제처 ㆍ vs 실무 ·)", () => {
    const forms = ["남녀고용평등과 일·가정 양립 지원에 관한 법률", "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률", "남녀고용평등과 일‧가정 양립 지원에 관한 법률"];
    const [a, ...rest] = forms.map(normalizeLawName);
    for (const r of rest) expect(r).toBe(a);
  });

  it("시행령·시행규칙을 모법과 분리한다", () => {
    expect(splitTier("공동주택관리법 시행령")).toEqual({ base: "공동주택관리법", tier: "시행령" });
    expect(splitTier("공동주택관리법")).toEqual({ base: "공동주택관리법", tier: "" });
  });
});

describe("법령명 대조", () => {
  it("🔴 회귀: 주택임대차보호법 질의에 상가건물 임대차보호법이 붙지 않는다", () => {
    expect(matchLawName("주택임대차보호법", "상가건물 임대차보호법")).toBe(false);
    expect(matchLawName("상가건물 임대차보호법", "주택임대차보호법")).toBe(false);
  });

  it("모법과 시행령·시행규칙을 같은 법으로 보지 않는다", () => {
    expect(matchLawName("공동주택관리법", "공동주택관리법 시행령")).toBe(false);
    expect(matchLawName("출입국관리법", "출입국관리법 시행규칙")).toBe(false);
    expect(matchLawName("출입국관리법 시행규칙", "출입국관리법 시행규칙")).toBe(true);
  });

  it("정식 제명과 통용 약칭을 잇는다(양방향)", () => {
    expect(matchLawName("전자상거래 등에서의 소비자보호에 관한 법률", "전자상거래법")).toBe(true);
    expect(matchLawName("성폭력처벌법", "성폭력범죄의 처벌 등에 관한 특례법")).toBe(true);
    expect(matchLawName("부동산실명법", "부동산 실권리자명의 등기에 관한 법률")).toBe(true);
  });

  it("비슷한 이름의 다른 법을 구분한다", () => {
    expect(matchLawName("성폭력처벌법", "성폭력방지법")).toBe(false);
    expect(matchLawName("가정폭력처벌법", "가정폭력방지법")).toBe(false);
    expect(matchLawName("민법", "국민건강보험법")).toBe(false);
    expect(matchLawName("형법", "형사소송법")).toBe(false);
  });

  it("표기 흔들림(낫표·가운뎃점·공백)은 흡수한다", () => {
    expect(matchLawName("「민법」", "민법")).toBe(true);
    expect(matchLawName("남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률", "남녀고용평등과 일·가정 양립 지원에 관한 법률")).toBe(true);
  });

  it("불변식: 저장된 서로 다른 법령명끼리는 매칭되지 않는다", () => {
    const names = [...new Set(STATUTES.map((s) => s.법령))];
    const collisions: string[] = [];
    for (const a of names) {
      for (const b of names) {
        if (a !== b && matchLawName(a, b)) collisions.push(`${a} ↔ ${b}`);
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe("조문 파싱", () => {
  it("'제'가 없는 일상 표기도 받는다(도구 트리거 예시: '민법 623조')", () => {
    expect(parseArticle("민법 623조가 맞는 조문인지 확인해줘")).toEqual({ display: "제623조", lawName: "민법" });
  });

  it("낫표 표기에서 법령명을 놓치지 않는다(놓치면 검증이 조용히 미가동)", () => {
    expect(parseArticle("「주택임대차보호법」 제10조")?.lawName).toBe("주택임대차보호법");
  });

  it("가지조문(제10조의4)을 구분한다", () => {
    expect(parseArticle("상가건물 임대차보호법 제10조의4")).toEqual({ display: "제10조의4", lawName: "상가건물 임대차보호법" });
  });

  it("법령명 앞 수식어를 떼어낸다", () => {
    expect(parseArticle("또한 상법 제64조")?.lawName).toBe("상법");
  });

  it("법령명이 없으면 특정하지 않는다(접미사만 남는 경우 포함)", () => {
    expect(parseArticle("제750조")?.lawName).toBeUndefined();
    expect(extractLawName("같은 법 시행규칙 ")).toBeUndefined();
  });
});

describe("사건번호 파싱", () => {
  it("연도 2·4자리와 부기를 모두 받는다", () => {
    expect(extractCaseNumbers("대법원 2020다247190")).toEqual(["2020다247190"]);
    expect(extractCaseNumbers("97다9260")).toEqual(["97다9260"]);
    expect(extractCaseNumbers("2017도16593-1")).toEqual(["2017도16593-1"]);
  });

  it("🔴 회귀: 조문 인용을 사건번호로 오인하지 않는다", () => {
    expect(extractCaseNumbers("상가건물 임대차보호법 제10조의4")).toEqual([]);
  });

  it("병합·전원합의체 표기 차이를 흡수한다", () => {
    expect(matchCaseNumber("2017다290613", "2017다290613,290620")).toBe(true);
    expect(matchCaseNumber("2020다247190", "2020다247190(전원합의체)")).toBe(true);
    expect(caseCore("2010므4071,4088")).toBe("2010므4071");
  });

  it("🔴 회귀: 연도만으로는 그 해 판례가 전부 확인되지 않는다", () => {
    expect(matchCaseNumber("2020", "2020다247190")).toBe(false);
  });
});
