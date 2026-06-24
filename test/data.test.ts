// 데이터 정합성 불변식. index.ts import 자체가 mergeStrict(키 충돌 시 throw)를 실행 → 충돌 시 이 파일이 실패.
import { describe, it, expect } from "vitest";
import {
  CHECKLISTS,
  FORM_KEYS,
  TOPIC_KEYS,
  PRECEDENTS,
  STATUTES,
  GLOSSARY,
  CATEGORIES,
  TOPICS,
} from "../src/data/index.js";

describe("데이터 정합성", () => {
  it("모든 주제에 체크리스트가 있다", () => {
    expect(TOPIC_KEYS.filter((k) => !CHECKLISTS[k])).toEqual([]);
  });

  it("모든 주제의 카테고리가 유효하다", () => {
    const cats = new Set<string>(CATEGORIES);
    expect(TOPICS.filter((t) => !cats.has(t.category)).map((t) => t.key)).toEqual([]);
  });

  it("고아 판례 키(주제가 아닌 키)가 없다", () => {
    const orphan = Object.keys(PRECEDENTS).filter((k) => PRECEDENTS[k].length > 0 && !TOPIC_KEYS.includes(k));
    expect(orphan).toEqual([]);
  });

  it("같은 주제 키 안에 사건번호 중복이 없다(concat 병합 무결성)", () => {
    const dups: string[] = [];
    for (const [k, arr] of Object.entries(PRECEDENTS)) {
      const seen = new Set<string>();
      for (const p of arr) {
        if (seen.has(p.사건번호)) dups.push(`${k}:${p.사건번호}`);
        seen.add(p.사건번호);
      }
    }
    expect(dups).toEqual([]);
  });

  it("용어사전에 중복 용어가 없다", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const g of GLOSSARY) {
      if (seen.has(g.용어)) dup.push(g.용어);
      seen.add(g.용어);
    }
    expect(dup).toEqual([]);
  });

  it("할루시네이션 검증에서 제거된 사건번호가 다시 들어오지 않는다", () => {
    const all = Object.values(PRECEDENTS).flat().map((p) => p.사건번호);
    for (const bad of ["99다41618", "2013므2243", "2024다33556", "분쟁조정 결정사례(공개 사례)"]) {
      expect(all).not.toContain(bad);
    }
  });

  it("모든 판례 사건번호가 형식상 유효(법원 부호 포함)", () => {
    const all = Object.values(PRECEDENTS).flat();
    // 한국 사건번호: 연도(2~4자리) + 부호(가~힣) + 번호. 헌재는 'YYYY헌X' 형태.
    const valid = /(\d{2,4}\s?[가-힣]{1,3}\s?\d|헌[가-힣])/;
    const bad = all.filter((p) => !valid.test(p.사건번호));
    expect(bad.map((p) => p.사건번호)).toEqual([]);
  });

  it("모든 법령 조문이 '제N조' 형식이다(라벨 표기 금지)", () => {
    const bad = STATUTES.filter((s) => !/^제\d+조/.test(s.조문));
    expect(bad.map((s) => `${s.법령} ${s.조문}`)).toEqual([]);
  });

  it("신규 취약·위기 주제·서식·분야가 등록되어 있다(신청 절차+신청서 한 동선)", () => {
    for (const k of ["소상공인_폐업재기", "노란우산공제_폐업", "출소자_갱생보호", "위기임신_보호출산"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["노란우산_공제금청구서", "갱생보호_신청서", "행정심판_청구서", "정보공개_청구서", "의료분쟁_조정신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    for (const c of ["소상공인", "출소자·갱생보호", "위기임신·보호출산"] as const) {
      expect(CATEGORIES).toContain(c);
    }
  });

  it("사회보장 급여 신청 주제·서식·분야가 등록되어 있다(혼자 신청하기)", () => {
    for (const k of ["장애인_등록활동지원", "국민연금_유족장애연금", "근로자녀장려금", "재난적의료비_본인부담상한"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["장애인등록_신청서", "국민연금_급여청구서", "근로자녀장려금_신청서", "재난적의료비_지원신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    expect(CATEGORIES).toContain("공적연금·사회보험");
  });

  it("생활밀착 급여·민원 주제·서식·분야가 등록되어 있다", () => {
    for (const k of ["국민취업지원제도", "노인장기요양_등급신청", "개명_성본변경", "주거급여_공공임대", "아동수당_부모급여"]) {
      expect(TOPIC_KEYS).toContain(k);
      expect(CHECKLISTS[k]).toBeTruthy();
    }
    for (const f of ["육아휴직_급여신청서", "구직급여_수급자격신청서", "장기요양인정_신청서", "개명허가_신청서"]) {
      expect(FORM_KEYS).toContain(f);
    }
    for (const c of ["육아·보육", "주거복지"] as const) {
      expect(CATEGORIES).toContain(c);
    }
  });

  it("규모 스냅샷(회귀 감지)", () => {
    expect(TOPIC_KEYS.length).toBe(216);
    expect(CATEGORIES.length).toBe(55);
    expect(FORM_KEYS.length).toBe(90);
    expect(GLOSSARY.length).toBe(125);
    expect(Object.values(PRECEDENTS).flat().length).toBe(194);
  });
});
