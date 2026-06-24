// 데이터 정합성 불변식. index.ts import 자체가 mergeStrict(키 충돌 시 throw)를 실행 → 충돌 시 이 파일이 실패.
import { describe, it, expect } from "vitest";
import {
  CHECKLISTS,
  FORM_KEYS,
  TOPIC_KEYS,
  PRECEDENTS,
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

  it("규모 스냅샷(회귀 감지)", () => {
    expect(TOPIC_KEYS.length).toBe(197);
    expect(CATEGORIES.length).toBe(46);
    expect(FORM_KEYS.length).toBe(77);
    expect(GLOSSARY.length).toBe(125);
    expect(Object.values(PRECEDENTS).flat().length).toBe(197);
  });
});
