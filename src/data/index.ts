// 전 도메인 데이터 병합 레지스트리. 서버는 여기서만 import.
import type { Procedure, Checklist, FormTemplate, Statute, Precedent, Category } from "./types.js";
import * as labor from "./labor.js";
import * as housing from "./housing.js";
import * as money from "./money.js";
import * as consumer from "./consumer.js";
import * as traffic from "./traffic.js";
import * as criminal from "./criminal.js";
import * as civil from "./civil.js";
import * as civilAdvanced from "./civil_advanced.js";
import * as sexualViolence from "./sexual_violence.js";
import * as domesticViolence from "./domestic_violence.js";
import * as stalking from "./stalking.js";
import * as digitalSexCrime from "./digital_sex_crime.js";
import * as violence from "./violence.js";
import * as defamation from "./defamation.js";
import * as family from "./family.js";
import * as inheritance from "./inheritance.js";
import * as debtRelief from "./debt_relief.js";
import * as voicePhishing from "./voice_phishing.js";
import * as schoolViolence from "./school_violence.js";
import * as industrialAccident from "./industrial_accident.js";
import * as administrative from "./administrative.js";
import * as medicalTax from "./medical_tax.js";
import * as housingRepair from "./housing_repair.js";
import * as contract from "./contract.js";
import * as realestate from "./realestate.js";
import * as immigration from "./immigration.js";

export type { Procedure, Checklist, FormTemplate, Statute, Precedent, Category } from "./types.js";

const domains = [
  labor,
  housing,
  money,
  consumer,
  traffic,
  criminal,
  civil,
  civilAdvanced,
  sexualViolence,
  domesticViolence,
  stalking,
  digitalSexCrime,
  violence,
  defamation,
  family,
  inheritance,
  debtRelief,
  voicePhishing,
  schoolViolence,
  industrialAccident,
  administrative,
  medicalTax,
  housingRepair,
  contract,
  realestate,
  immigration,
];

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
  "민사절차",
  "형사절차",
  "폭력·협박",
  "가정폭력",
  "성폭력피해자",
  "스토킹",
  "디지털성범죄",
  "명예훼손·모욕",
  "가사·가족",
  "상속",
  "채무자구제",
  "금융사기",
  "학교폭력",
  "산업재해",
  "행정",
  "의료분쟁",
  "조세",
  "계약",
  "부동산매매",
  "출입국",
];
