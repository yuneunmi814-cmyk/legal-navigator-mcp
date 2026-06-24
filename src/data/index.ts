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
import * as insurance from "./insurance.js";
import * as ip from "./ip.js";
import * as abuse from "./abuse.js";
import * as employmentInsurance from "./employment_insurance.js";
import * as apartment from "./apartment.js";
import * as commercialLease from "./commercial_lease.js";
import * as telecomPrivacy from "./telecom_privacy.js";
import * as military from "./military.js";
import * as election from "./election.js";
import * as environment from "./environment.js";
import * as companionAnimal from "./companion_animal.js";
import * as migrant from "./migrant.js";
import * as vulnerable from "./vulnerable.js";
import * as welfare from "./welfare.js";
import * as crisis from "./crisis.js";
import * as applyForms from "./apply_forms.js";

export type { Procedure, Checklist, FormTemplate, Statute, Precedent, Category } from "./types.js";
export { CITATION_STATUS, LAW_TIMELINE, SEARCH_SYNONYMS } from "./legal_updates.js";
export type { CitationNote, LawChange, SynonymEntry } from "./legal_updates.js";
export { DEADLINES, SUPPORT_PROGRAMS, HOTLINES, APPLICATION_GUIDE } from "./selfhelp.js";
export type { DeadlineRule, SupportProgram, ApplyGuide } from "./selfhelp.js";
export { DOCUMENT_GUIDE, DOC_TIPS } from "./documents.js";
export type { DocGuide } from "./documents.js";
export { GLOSSARY } from "./glossary.js";
export type { TermEntry } from "./glossary.js";

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
  insurance,
  ip,
  abuse,
  employmentInsurance,
  apartment,
  commercialLease,
  telecomPrivacy,
  military,
  election,
  environment,
  companionAnimal,
  migrant,
  vulnerable,
  welfare,
  crisis,
  applyForms,
];

// 38개 도메인 모듈 병합 시 키가 겹치면 한 주제가 조용히 사라지므로, 충돌을 즉시 throw로 드러낸다(부팅 실패=조기 발견).
function mergeStrict<T>(maps: Record<string, T>[], label: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const m of maps) {
    for (const k of Object.keys(m)) {
      if (k in out) throw new Error(`[index] ${label} 중복 키 '${k}' — 도메인 간 키 충돌은 데이터를 덮어써 사라지게 합니다.`);
      out[k] = m[k];
    }
  }
  return out;
}
export const PROCEDURES: Record<string, Procedure> = mergeStrict(domains.map((d) => d.procedures), "PROCEDURES");
export const CHECKLISTS: Record<string, Checklist> = mergeStrict(domains.map((d) => d.checklists), "CHECKLISTS");
export const FORMS: Record<string, FormTemplate> = mergeStrict(domains.map((d) => d.forms), "FORMS");
// 판례는 같은 주제 키에 여러 도메인이 기여할 수 있어 충돌 시 배열을 합친다(덮어쓰기 대신 concat).
export const PRECEDENTS: Record<string, Precedent[]> = (() => {
  const out: Record<string, Precedent[]> = {};
  for (const d of domains) for (const [k, arr] of Object.entries(d.precedents)) out[k] = (out[k] ?? []).concat(arr);
  return out;
})();

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
  "보험",
  "지식재산",
  "아동·노인학대",
  "고용보험",
  "공동주택",
  "상가임대차",
  "통신·개인정보",
  "군·병역",
  "선거",
  "환경",
  "반려동물",
  "외국인·이주민",
  "청소년·미성년",
  "장애인",
  "북한이탈주민",
  "플랫폼·특수고용",
  "국가유공자·보훈",
  "복지·취약가구",
  "농어업인",
  "노인·고령",
  "정신건강",
  "범죄피해자",
  "자살예방·유족",
  "재난·안전",
];
