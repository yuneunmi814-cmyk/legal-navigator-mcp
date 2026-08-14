// 인용 파싱·대조 — verify_citation 전용 순수 로직.
//
// 설계 원칙(가장 위험한 실패부터):
//   ① 틀린 법을 "수록확인 ✅"으로 붙여주는 것이 최악이다. 확신이 없으면 확인하지 않는다.
//   ② 법령명을 못 뽑아 검증에 진입조차 못 하는 "조용한 미가동"이 그다음이다. 파싱을 넓게 연다.
//   ③ 저장소에 없다 ≠ 세상에 없다. 미수록은 미수록으로만 말하고 공식 링크로 넘긴다.
//
// 참고: korean-law-mcp(MIT, github.com/chrisryugj/korean-law-mcp)의 verify_citations가
// 실사용 제보로 확인한 실패 유형(닫는 낫표·가운뎃점 표기차·접미사 단독 후보·미수록의 환각 낙인)을
// 참고했다. 그쪽은 법제처 API 라이브 조회, 우리는 큐레이션 저장소라 대조 로직은 새로 구현했다.

// 가운뎃점 5종. 법제처 공식 제명은 한글 가운뎃점 ㆍ(U+318D)인데 실무 문서·판결문·LLM 출력은
// 라틴 중점 ·(U+00B7)를 쓴다. 우리 데이터는 전부 U+00B7이라, 사용자가 법제처에서 복붙하면
// 표기만 다른 같은 법이 불일치로 떨어진다.
const INTERPUNCT = /[·ㆍ‧•・]/g;

// 인용부호·괄호 — 「법령명」 제N조 는 법제처 조문·판결문·관공서 서식의 표준 표기다.
const QUOTES = /[「」『』【】〔〕《》<>]/g;

// 법령명 앞에 붙는 접속사·수식어. "또한 상법 제1조" → "상법"
const STOPWORDS = /^(또한|그리고|따라서|따라|위해|위하여|의한|의하여|따른|해당|관련|이에|아울러|본|이|저|그|또|및|또는|혹은|한편|더불어|즉|결국|실제로|특히|우리|현행)\s+/u;

// 그 자체로는 법령을 특정할 수 없는 접미사. 후보가 이것뿐이면 법령명 불명확으로 떨어뜨린다
// (검색에 넣으면 어떤 문서에서든 무관한 법령을 물어온다).
const SUFFIX_ONLY = new Set(["법", "법률", "시행령", "시행규칙", "규칙", "규정", "조례"]);

// "같은 법 시행규칙"·"동법 제N조" — 법제처 조문·관공서 서식의 표준 표기지만, 이 도구는 인용을
// 한 건씩 받으므로 가리킬 선행 법령명이 없다. 해소할 수 없으면 특정하지 않는다
// (앞뒤 문맥 없이 아무 법이나 갖다 붙이는 것이 더 나쁜 오답이다).
// 선행 `(?:^|[^가-힣])`은 "노동법"의 '동법'을 조응으로 오인하지 않기 위한 경계.
const ANAPHORA = /^(?:같은|동)\s*법(?:률)?(?=\s|$)/;

// 조문 인용. "제623조"뿐 아니라 **"623조"(제 없음)도 받는다** — 일상 표기이고,
// 실제로 이 도구의 트리거 예시("민법 623조가 맞는 조문인지")가 여기서 파싱 실패했다.
const ARTICLE = /(?:제\s*)?(\d+)\s*조(?:\s*의\s*(\d+))?/;
const ARTICLE_G = new RegExp(ARTICLE.source, "g");

// 사건번호. 연도(2·4자리) + 사건부호 + 번호(+병합 -N).
const CASE_NO = /(\d{2}|\d{4})\s*([가-힣]{1,3})\s*(\d+)(-\d+)?/g;

/** 표기 흔들림 흡수 — 낫표 제거, 가운뎃점 통일, 공백 제거. */
export function normalizeLawName(s: string): string {
  return s.replace(QUOTES, "").replace(INTERPUNCT, "·").replace(/\s+/g, "").trim();
}

/**
 * 법령명을 본법/하위법령으로 분리. 시행령·시행규칙은 모법과 **다른 문서**이므로
 * 같은 base라도 tier가 다르면 매칭시키면 안 된다
 * (우리 데이터에 공동주택관리법/공동주택관리법 시행령, 출입국관리법/출입국관리법 시행규칙이 실제로 공존한다).
 */
export function splitTier(name: string): { base: string; tier: "" | "시행령" | "시행규칙" } {
  const n = normalizeLawName(name);
  for (const tier of ["시행규칙", "시행령"] as const) {
    if (n.endsWith(tier)) return { base: n.slice(0, -tier.length), tier };
  }
  return { base: n, tier: "" };
}

// 약칭 ↔ 정식 제명. 우리 저장소는 통용 약칭으로 적혀 있는데 사용자·LLM은 정식 제명을 복붙하는
// 일이 잦다(그 반대도 마찬가지). 부분문자열로는 이어지지 않으므로 표로 잇는다.
// 표에 없으면 매칭 실패 → "미수록"으로 정직하게 떨어진다(틀린 법을 확인해주는 것보다 낫다).
export const ALIAS_GROUPS: string[][] = [
  ["전자상거래법", "전자상거래 등에서의 소비자보호에 관한 법률"],
  ["방문판매법", "방문판매 등에 관한 법률"],
  ["성폭력처벌법", "성폭력범죄의 처벌 등에 관한 특례법"],
  ["성폭력방지법", "성폭력방지 및 피해자보호 등에 관한 법률"],
  ["가정폭력처벌법", "가정폭력범죄의 처벌 등에 관한 특례법"],
  ["가정폭력방지법", "가정폭력방지 및 피해자보호 등에 관한 법률"],
  ["스토킹처벌법", "스토킹범죄의 처벌 등에 관한 법률"],
  ["정보통신망법", "정보통신망 이용촉진 및 정보보호 등에 관한 법률"],
  ["채무자회생법", "채무자 회생 및 파산에 관한 법률"],
  ["통신사기피해환급법", "전기통신금융사기 피해 방지 및 피해금 환급에 관한 특별법"],
  ["학교폭력예방법", "학교폭력예방 및 대책에 관한 법률"],
  ["산업재해보상보험법", "산재보험법", "산재법"],
  ["국민기초생활보장법", "기초생활보장법"],
  ["아동학대범죄의 처벌 등에 관한 특례법", "아동학대처벌법"],
  ["채권의 공정한 추심에 관한 법률", "채권추심법"],
  ["부정경쟁방지 및 영업비밀보호에 관한 법률", "부정경쟁방지법"],
  ["공공기관의 정보공개에 관한 법률", "정보공개법"],
  ["가족관계의 등록 등에 관한 법률", "가족관계등록법"],
  ["국가유공자 등 예우 및 지원에 관한 법률", "국가유공자법"],
  ["북한이탈주민의 보호 및 정착지원에 관한 법률", "북한이탈주민법"],
  ["외국인근로자의 고용 등에 관한 법률", "외국인고용법"],
  ["환경분쟁 조정 및 환경피해 구제 등에 관한 법률", "환경분쟁조정법"],
  ["정신건강증진 및 정신질환자 복지서비스 지원에 관한 법률", "정신건강복지법"],
  ["의료사고 피해구제 및 의료분쟁 조정 등에 관한 법률", "의료분쟁조정법"],
  ["소송촉진 등에 관한 특례법", "소송촉진법", "소촉법"],
  ["형의 실효 등에 관한 법률", "형실효법"],
  ["구직자 취업촉진 및 생활안정지원에 관한 법률", "국민취업지원법"],
  ["위기 임신 및 보호출산 지원과 아동 보호에 관한 특별법", "보호출산법"],
  ["전세사기피해자 지원 및 주거안정에 관한 특별법", "전세사기특별법", "전세사기피해자법"],
  ["양육비 이행확보 및 지원에 관한 법률", "양육비이행법"],
  ["특정범죄신고자 등 보호법", "범죄신고자법"],
  ["자살예방 및 생명존중문화 조성을 위한 법률", "자살예방법"],
  ["재난 및 안전관리 기본법", "재난안전법"],
  ["보호관찰 등에 관한 법률", "보호관찰법"],
  ["부동산 실권리자명의 등기에 관한 법률", "부동산실명법"],
  ["장애인차별금지 및 권리구제 등에 관한 법률", "장애인차별금지법"],
  ["남녀고용평등과 일·가정 양립 지원에 관한 법률", "남녀고용평등법"],
  ["서민의 금융생활 지원에 관한 법률", "서민금융법", "휴면예금관리재단법"],
  ["금융소비자 보호에 관한 법률", "금융소비자보호법"],
  ["근로자퇴직급여 보장법", "퇴직급여법", "근퇴법"],
  ["국민 평생 직업능력 개발법", "평생직업능력법", "근로자직업능력 개발법"],
  ["한국농어촌공사 및 농지관리기금법", "농어촌공사법"],
  ["자동차손해배상보장법", "자동차손해배상 보장법", "자배법"],
  ["교통사고처리특례법", "교통사고처리 특례법"],
  ["군인의 지위 및 복무에 관한 기본법", "군인복무기본법"],
  ["다문화가족지원법", "다문화가족 지원법"],
  ["질서위반행위규제법", "질서위반행위 규제법"],
];

// 정규화된 별칭 → 그룹 인덱스
const ALIAS_INDEX = new Map<string, number>();
ALIAS_GROUPS.forEach((group, i) => {
  for (const name of group) ALIAS_INDEX.set(splitTier(name).base, i);
});

// 부분문자열 매칭을 허용할 최소 길이. "민법"·"형법"·"상법"(2자)은 정확·별칭 매칭만 인정한다
// — 2~3자 이름의 부분문자열 매칭은 무관한 법을 대량으로 물어온다.
const MIN_CONTAINS_LEN = 4;

/**
 * 질의 법령명과 저장 법령명이 같은 법을 가리키는가.
 *
 * 종전 구현은 저장 법령명의 2글자 윈도우 중 하나라도 질의에 있으면 매칭으로 봤는데,
 * 그러면 "주택임대차보호법 제10조" 질의에 **상가건물 임대차보호법 제10조**가
 * ✅수록확인으로 붙었다("임대" 하나로 통과). 인용검증 도구가 틀린 법을 확인해주는 셈이라
 * 정확·별칭·포함(4자 이상)만 인정하도록 좁혔다.
 */
export function matchLawName(query: string, stored: string): boolean {
  const q = splitTier(query);
  const s = splitTier(stored);
  if (q.tier !== s.tier) return false; // 법 vs 시행령·시행규칙은 다른 문서
  if (!q.base || !s.base) return false;
  if (q.base === s.base) return true;

  const qi = ALIAS_INDEX.get(q.base);
  if (qi !== undefined && qi === ALIAS_INDEX.get(s.base)) return true;

  const [short, long] = q.base.length <= s.base.length ? [q.base, s.base] : [s.base, q.base];
  return short.length >= MIN_CONTAINS_LEN && long.includes(short);
}

/**
 * 조문 인용 앞 문맥에서 법령명을 추출.
 * 닫는 낫표(」)가 남아 있으면 종단 앵커가 걸리지 않아 법령명이 **전혀** 안 뽑히고,
 * 그러면 조문 대조에 진입조차 못 한다(= 검증이 조용히 미가동). 먼저 벗긴다.
 */
export function extractLawName(before: string): string | undefined {
  const lookback = before.replace(QUOTES, " ").replace(/[\s,·]+$/, "");
  const m = lookback.match(/([가-힣][가-힣0-9·ㆍ‧•・\s]{0,40}?(?:법률|법|시행령|시행규칙|규칙|규정|조례))$/);
  if (!m) return undefined;
  const name = m[1].replace(/\s+/g, " ").trim().replace(STOPWORDS, "").trim();
  if (name.length < 2) return undefined;
  // 어절이 전부 접미사면("시행규칙"만 남은 경우) 법령 특정 불가 — 모른다고 하는 게 맞다.
  if (name.split(/\s+/).every((t) => SUFFIX_ONLY.has(t))) return undefined;
  if (ANAPHORA.test(name)) return undefined; // 선행 법령명이 없는 "같은 법 …"
  return name;
}

export interface ParsedArticle {
  /** 저장 데이터와 대조할 정규화 표기 — "제623조" / "제10조의4" */
  display: string;
  lawName?: string;
}

/** 인용 문자열에서 조문(+앞의 법령명)을 파싱. 조문이 없으면 undefined. */
export function parseArticle(text: string): ParsedArticle | undefined {
  const m = text.match(ARTICLE);
  if (!m || m.index === undefined) return undefined;
  const display = `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`;
  return { display, lawName: extractLawName(text.slice(0, m.index)) };
}

/**
 * 사건번호 추출. 조문 인용을 먼저 지운다 — "제10조의4"가 연도10+부호"조의"+번호4로
 * 잘못 잡히기 때문이다.
 */
export function extractCaseNumbers(text: string): string[] {
  const cleaned = text.replace(ARTICLE_G, " ");
  const out: string[] = [];
  for (const m of cleaned.matchAll(CASE_NO)) {
    out.push(`${m[1]}${m[2]}${m[3]}${m[4] ?? ""}`);
  }
  return [...new Set(out)];
}

/** 저장된 사건번호를 대조용으로 정규화 — 괄호(전원합의체)·병합번호·부기(-1) 제거. */
export function caseCore(no: string): string {
  return no.replace(/\(.*?\)/g, "").replace(/\s/g, "").split(",")[0].replace(/-\d+$/, "");
}

/** 질의 사건번호와 저장 사건번호가 같은 사건인가(부기 -N 차이는 흡수). */
export function matchCaseNumber(query: string, stored: string): boolean {
  return caseCore(query) === caseCore(stored);
}
