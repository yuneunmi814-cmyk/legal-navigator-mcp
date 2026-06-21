// 전 도메인 데이터 병합 레지스트리. 서버는 여기서만 import.
import type { Procedure, Checklist, FormTemplate, Statute, Precedent, Category } from "./types.js";
import * as labor from "./labor.js";
import * as housing from "./housing.js";
import * as money from "./money.js";
import * as consumer from "./consumer.js";
import * as traffic from "./traffic.js";
import * as criminal from "./criminal.js";
import * as civil from "./civil.js";

export type { Procedure, Checklist, FormTemplate, Statute, Precedent, Category } from "./types.js";

const domains = [labor, housing, money, consumer, traffic, criminal, civil];

export const PROCEDURES: Record<string, Procedure> = Object.assign({}, ...domains.map((d) => d.procedures));
export const CHECKLISTS: Record<string, Checklist> = Object.assign({}, ...domains.map((d) => d.checklists));
export const FORMS: Record<string, FormTemplate> = Object.assign({}, ...domains.map((d) => d.forms));
export const PRECEDENTS: Record<string, Precedent[]> = Object.assign({}, ...domains.map((d) => d.precedents));

// 법령 요지 — 법령+조문 기준 중복 제거
const statuteSeen = new Set<string>();
export const STATUTES: Statute[] = domains
  .flatMap((d) => d.statutes)
  .filter((s) => {
    const k = `${s.법령} ${s.조문}`;
    if (statuteSeen.has(k)) return false;
    statuteSeen.add(k);
    return true;
  });

// 도구 enum용 키 배열 (zod enum은 비어있지 않은 튜플 필요)
export const TOPIC_KEYS = Object.keys(PROCEDURES) as [string, ...string[]];
export const FORM_KEYS = Object.keys(FORMS) as [string, ...string[]];

// 주제 목록(카테고리·제목) — list_topics 도구용
export interface TopicMeta {
  key: string;
  category: Category;
  제목: string;
}
export const TOPICS: TopicMeta[] = TOPIC_KEYS.map((k) => ({
  key: k,
  category: PROCEDURES[k].category,
  제목: PROCEDURES[k].제목,
}));

export const CATEGORIES: Category[] = [
  "노동",
  "주택임대차",
  "돈거래",
  "소비자",
  "교통사고",
  "형사",
  "민사절차",
];
