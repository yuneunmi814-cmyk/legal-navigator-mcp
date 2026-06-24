import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withDisclaimer } from "./disclaimer.js";
import {
  PROCEDURES,
  CHECKLISTS,
  FORMS,
  STATUTES,
  PRECEDENTS,
  TOPIC_KEYS,
  FORM_KEYS,
  TOPICS,
  CATEGORIES,
  CITATION_STATUS,
  LAW_TIMELINE,
  SEARCH_SYNONYMS,
  DEADLINES,
  SUPPORT_PROGRAMS,
  HOTLINES,
  APPLICATION_GUIDE,
  DOCUMENT_GUIDE,
  DOC_TIPS,
  GLOSSARY,
} from "./data/index.js";
import {
  calcUnpaidWages,
  calcSeverance,
  calcWeeklyHolidayPay,
  calcDelayInterest,
  calcCourtCost,
  calcDeadline,
} from "./calc.js";

// 서비스명 — PlayMCP 개발가이드: description에 영문/국문 병기 서비스명 포함 필수
const SVC = "법률 절차 길잡이(Legal Navigator)";

const SERVER_INSTRUCTIONS =
  "이 서버는 한국 생활법률 56개 분야 233개 주제(노동(임금·해고·괴롭힘·성희롱·직업훈련)·임대차·상가·돈거래/사기·소비자·교통사고·민사/형사 절차·가정폭력·성범죄·스토킹·가사/상속·채무조정·금융사기·산재·행정·의료·조세·계약·부동산·출입국·보험·지식재산·학대·고용보험(실업급여·육아휴직·국민취업지원)·통신/개인정보·군·선거·환경·반려동물·외국인/이주민·청소년/미성년·장애인(등록·활동지원)·북한이탈주민·플랫폼/특수고용·국가유공자/보훈·복지/취약가구·농어업인·노인/고령(기초연금·장기요양)·정신건강·범죄피해자·자살예방/유족·재난/안전·소상공인/폐업재기·출소자/갱생보호·위기임신/보호출산·공적연금/사회보험·육아/보육(아동수당·부모급여·난임·첫만남)·주거복지(주거급여·공공임대·청년월세)·교육/학자금(국가장학금)·가사(개명/성본변경) 등)에 대한 " +
  "법률 정보·대응 절차·표준 서식·금액 계산·법령/판례 안내를 제공하는 정보 도구입니다. " +
  "권장 흐름: ① 사용자가 상황을 일상어로 설명하면 search_topics(자연어)로 주제 키를 찾고, 주제명을 알면 list_topics로 확인 → ② 그 키로 get_procedure·get_checklist·get_form_template·get_precedent 호출 → ③ 판례·법령 인용을 확인할 땐 verify_citation, 최근 법 개정·시행일은 law_updates로 검증. " +
  "필요에 따라 triage(빠른 진단)·calculate_deadline(기한)·calculate_court_cost(소송비용)·calculate_amount(금액)로 계산하고, find_legal_aid로 무료 변호사·구제 제도와 신청 방법을, how_to_get_document로 준비서류 발급 방법을 안내하세요. 사용자가 모르는 법률용어(각하·가압류·공시송달 등)나 일상어(떼인 돈·빨간딱지)가 나오면 explain_term으로 뜻을 풀이하세요. " +
  "중요(declaw): 이 도구는 개별 법률 자문이 아닙니다. 특정 사건의 법적 결론(승소·유무죄 등)을 단정하지 말고 정보 제공에 그치며, " +
  "표준서식은 사용자가 제공한 사실로 공란을 채우는 수준까지만 돕고 법적 주장·전략 작성은 하지 마세요. 없는 판례·법령은 지어내지 말고, 중대·복잡·기한임박 사안은 변호사·공인노무사·대한법률구조공단(132) 상담을 권하세요.";

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const 항목값 = ["체불임금", "퇴직금", "주휴수당", "지연이자"] as const;
const TOPIC_DESC = "주제 키. 카테고리: 노동·주택임대차·돈거래·소비자·교통사고·형사·민사절차. 모르면 list_topics로 목록을 먼저 확인.";

function 절차텍스트(key: string): string {
  const p = PROCEDURES[key];
  return [
    `📋 [${p.category}] ${p.제목}`,
    "",
    `• 적용대상: ${p.적용대상}`,
    `• 기한: ${p.기한}`,
    `• 관할기관: ${p.관할기관}`,
    `• 접수: ${p.온라인접수}`,
    "",
    "진행 단계",
    ...p.단계.map((s) => `  ${s}`),
    "",
    "근거 법령",
    ...p.근거법.map((s) => `  - ${s}`),
    "",
    `참고: ${p.비고}`,
  ].join("\n");
}

// 자연어 질의 → 관련 주제 키 랭킹(동의어군 + 메타데이터 가중). search_topics·triage 공용.
function rankTopics(query: string): string[] {
  const Q = query.replace(/\s+/g, " ").trim();
  const nQ = Q.replace(/\s/g, "");
  const words = [...new Set(Q.split(/\s+/).filter((w) => w.length >= 2))];
  const score = new Map<string, number>();
  const add = (k: string, n: number) => {
    if (PROCEDURES[k]) score.set(k, (score.get(k) ?? 0) + n);
  };
  for (const syn of SEARCH_SYNONYMS) {
    if (syn.q.some((ph) => nQ.includes(ph.replace(/\s/g, "")) || Q.includes(ph))) {
      for (const t of syn.topics) add(t, 5);
    }
  }
  for (const k of TOPIC_KEYS) {
    const p = PROCEDURES[k];
    if (nQ.includes(k) || k.includes(nQ)) add(k, 6);
    const hay = `${p.적용대상} ${p.근거법.join(" ")}`;
    for (const w of words) {
      if (p.제목.includes(w)) add(k, 4);
      else if (p.category.includes(w)) add(k, 3);
      else if (hay.includes(w)) add(k, 2);
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export function createServer(baseUrl?: string): McpServer {
  const server = new McpServer(
    { name: "legal-navigator", version: "0.4.0", title: "법률 절차 길잡이" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "list_topics",
    {
      title: "주제 목록",
      description: `Lists available legal topics (key·category·title), optionally filtered by category. Call this first to find the right topic key. Service: ${SVC}.`,
      inputSchema: {
        category: z.enum(CATEGORIES as [string, ...string[]]).optional().describe("노동 | 주택임대차 | 돈거래 | 소비자 | 교통사고 | 형사 | 민사절차 (비우면 전체)"),
      },
      annotations: { title: "주제 목록", ...READONLY },
    },
    async ({ category }) => {
      const list = category ? TOPICS.filter((t) => t.category === category) : TOPICS;
      const byCat = new Map<string, string[]>();
      for (const t of list) {
        if (!byCat.has(t.category)) byCat.set(t.category, []);
        byCat.get(t.category)!.push(`  - ${t.key} : ${t.제목}`);
      }
      const body = [...byCat.entries()].map(([c, items]) => `[${c}]\n${items.join("\n")}`).join("\n\n");
      return { content: [{ type: "text", text: withDisclaimer(`🗂️ 주제 목록 (${list.length}개)\n\n${body}`) }] };
    },
  );

  server.registerTool(
    "get_procedure",
    {
      title: "절차 안내",
      description: `Returns the official response procedure, competent authority, deadline, online filing channel, and legal basis for a Korean everyday-law topic (labor, housing lease, debt/fraud, consumer, traffic accident, criminal, civil procedure). Information only. Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "절차 안내", ...READONLY },
    },
    async ({ topic }) => ({
      content: [{ type: "text", text: withDisclaimer(절차텍스트(topic)) }],
    }),
  );

  server.registerTool(
    "get_checklist",
    {
      title: "필요 서류·증거 체크리스트",
      description: `Returns a checklist of evidence to gather and documents to prepare when filing, by Korean everyday-law topic. Information only. Service: ${SVC}.`,
      inputSchema: { topic: z.enum(TOPIC_KEYS).describe(TOPIC_DESC) },
      annotations: { title: "필요 서류·증거 체크리스트", ...READONLY },
    },
    async ({ topic }) => {
      const c = CHECKLISTS[topic];
      if (!c) {
        return { content: [{ type: "text", text: withDisclaimer(`'${topic}' 주제의 체크리스트가 없습니다. list_topics로 확인하세요.`) }] };
      }
      const text = [
        `🗂️ ${PROCEDURES[topic]?.제목 ?? topic} — 준비 체크리스트`,
        "",
        "모아둘 증거",
        ...c.증거.map((s) => `  ☐ ${s}`),
        "",
        "접수용 준비서류",
        ...c.준비서류.map((s) => `  ☐ ${s}`),
      ].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_form_template",
    {
      title: "표준 서식 제공",
      description: `Provides a blank standard document template (complaint, certified mail, application form, lawsuit, criminal complaint, settlement, support-application forms, etc.) with [blank] fields, writing tips, the official-form source, and a .txt download link. Fill blanks only with facts the user provides; do NOT draft legal arguments. Service: ${SVC}.`,
      inputSchema: { form: z.enum(FORM_KEYS).describe("서식 키. get_procedure/list_topics에서 안내된 서식명을 사용") },
      annotations: { title: "표준 서식 제공", ...READONLY },
    },
    async ({ form }) => {
      const f = FORMS[form];
      if (!f) {
        return { content: [{ type: "text", text: withDisclaimer(`'${form}' 서식이 없습니다.`) }] };
      }
      const head = [`📝 ${f.제목}`, `용도: ${f.용도}`];
      if (f.공식양식) head.push(`📄 공식 양식 받는 곳: ${f.공식양식}`);
      const tail = ["작성요령", ...f.작성요령.map((s) => `  - ${s}`)];
      if (baseUrl) {
        tail.push(
          "",
          `📎 파일로 저장·공유: ${baseUrl}/forms/${encodeURIComponent(form)}.txt`,
          "  링크를 누르면 이 서식이 .txt 파일로 저장됩니다 — 구글 드라이브·카카오톡 '나에게 보내기'·메일 어디로든 공유하세요." +
            (f.공식양식 ? " 단, 관공서 제출본은 위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성하세요." : ""),
        );
      }
      const text = [...head, "", "─── 서식 시작 ───", f.본문, "─── 서식 끝 ───", "", ...tail].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_precedent",
    {
      title: "판례 조회",
      description: `Looks up verified Korean court precedents (case number + holding) by keyword or topic key. Only real, verified cases are stored. Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("주제 키 또는 검색어(예: 전세보증금반환, 사기, 해고, 지급명령). 비우면 판례가 있는 주제 목록"),
      },
      annotations: { title: "판례 조회", ...READONLY },
    },
    async ({ keyword }) => {
      const entries = Object.entries(PRECEDENTS).filter(([, v]) => v.length > 0);
      if (!keyword) {
        const topics = entries.map(([k]) => `  - ${k} (${PROCEDURES[k]?.제목 ?? ""})`).join("\n");
        return { content: [{ type: "text", text: withDisclaimer(`⚖️ 판례가 등록된 주제\n\n${topics}\n\n키워드를 넣으면 해당 판례를 보여드립니다.`) }] };
      }
      const matched = entries
        .filter(([k, v]) => k.includes(keyword) || v.some((p) => p.요지.includes(keyword) || p.사건번호.includes(keyword) || p.법원.includes(keyword)))
        .flatMap(([, v]) => v);
      if (!matched.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 등록 판례를 찾지 못했습니다. (등록된 판례만 조회되며, 없는 판례는 지어내지 않습니다.)`) }] };
      }
      const body = matched.map((p) => `• ${p.법원} ${p.사건번호}\n  ${p.요지}`).join("\n\n");
      const caseNos = [...new Set(matched.map((p) => p.사건번호.replace(/\s|\(.*?\)/g, "").split(",")[0]).filter(Boolean))].slice(0, 5);
      const caseLinks = caseNos.map((no) => `  - ${no}: https://casenote.kr/search/?q=${encodeURIComponent(no)}`).join("\n");
      return { content: [{ type: "text", text: withDisclaimer(`⚖️ 판례 (검색: ${keyword})\n\n${body}\n\n원문(사건번호로 바로 검색):\n${caseLinks}\n또는 국가법령정보센터 https://www.law.go.kr · CaseNote https://casenote.kr`) }] };
    },
  );

  server.registerTool(
    "calculate_amount",
    {
      title: "금액 계산기",
      description: `Estimates Korean labor amounts: unpaid wages, severance pay, weekly holiday allowance, or delay interest. Provide the numbers matching the chosen item. Estimates only. Service: ${SVC}.`,
      inputSchema: {
        item: z.enum(항목값).describe("체불임금 | 퇴직금 | 주휴수당 | 지연이자"),
        monthly_wage: z.number().finite().nonnegative().optional().describe("[체불임금] 월 정상 임금(원)"),
        unpaid_months: z.number().finite().nonnegative().optional().describe("[체불임금] 미지급 개월 수"),
        other_unpaid: z.number().finite().nonnegative().optional().describe("[체불임금] 기타 미지급액(원)"),
        daily_avg_wage: z.number().finite().nonnegative().optional().describe("[퇴직금] 1일 평균임금(원)"),
        tenure_days: z.number().finite().nonnegative().optional().describe("[퇴직금] 총 재직일수"),
        weekly_hours: z.number().finite().nonnegative().optional().describe("[주휴수당] 1주 소정근로시간"),
        hourly_wage: z.number().finite().nonnegative().optional().describe("[주휴수당] 시급(원)"),
        principal: z.number().finite().nonnegative().optional().describe("[지연이자] 미지급 원금(원)"),
        delay_days: z.number().finite().nonnegative().optional().describe("[지연이자] 지연 일수"),
      },
      annotations: { title: "금액 계산기", ...READONLY },
    },
    async (a) => {
      const need = (cond: boolean, msg: string) => {
        if (!cond) throw new Error(`입력값이 부족합니다: ${msg}`);
      };
      let r;
      try {
        switch (a.item) {
          case "체불임금":
            need(a.monthly_wage != null && a.unpaid_months != null, "monthly_wage, unpaid_months");
            r = calcUnpaidWages(a.monthly_wage!, a.unpaid_months!, a.other_unpaid ?? 0);
            break;
          case "퇴직금":
            need(a.daily_avg_wage != null && a.tenure_days != null, "daily_avg_wage, tenure_days");
            r = calcSeverance(a.daily_avg_wage!, a.tenure_days!);
            break;
          case "주휴수당":
            need(a.weekly_hours != null && a.hourly_wage != null, "weekly_hours, hourly_wage");
            r = calcWeeklyHolidayPay(a.weekly_hours!, a.hourly_wage!);
            break;
          case "지연이자":
            need(a.principal != null && a.delay_days != null, "principal, delay_days");
            r = calcDelayInterest(a.principal!, a.delay_days!);
            break;
        }
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: withDisclaimer((e as Error).message) }] };
      }
      const text = [
        `🧮 ${a.item} 계산 결과`,
        "",
        `결과: ${r!.결과}`,
        `계산식: ${r!.계산식}`,
        r!.비고 ? `비고: ${r!.비고}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  server.registerTool(
    "get_statute",
    {
      title: "법령 요지 조회",
      description: `Looks up summaries of key Korean statutes across everyday-law areas with an optional keyword filter. See law.go.kr for full text. Service: ${SVC}.`,
      inputSchema: { keyword: z.string().optional().describe("예: 해고, 보증금, 소멸시효, 청약철회, 사기, 지급명령 (비우면 전체)") },
      annotations: { title: "법령 요지 조회", ...READONLY },
    },
    async ({ keyword }) => {
      const list = keyword
        ? STATUTES.filter((s) => s.요지.includes(keyword) || s.조문.includes(keyword) || s.법령.includes(keyword))
        : STATUTES;
      if (!list.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 조문을 찾지 못했습니다.`) }] };
      }
      const body = list.map((s) => `• ${s.법령} ${s.조문} — ${s.요지}`).join("\n");
      const laws = [...new Set(list.map((s) => s.법령))];
      const links = laws.map((n) => `  - ${n}: https://www.law.go.kr/법령/${encodeURIComponent(n)}`).join("\n");
      const text = `⚖️ 법령 요지${keyword ? ` (검색: ${keyword})` : ""}\n\n${body}\n\n원문(국가법령정보센터):\n${links}\n\n※ 조문 전문·신구조문·관련 판례 등 더 깊은 원문은 국가법령정보센터(law.go.kr)·찾기쉬운 생활법령정보(easylaw.go.kr)에서 확인하세요.`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 자연어 통합검색 — 일상어 상황 설명을 주제 키로 매핑(접근성).
  server.registerTool(
    "search_topics",
    {
      title: "자연어 주제 검색",
      description: `Maps a natural-language description of a problem (everyday Korean) to the most relevant legal topic keys. Use when the user describes a situation rather than naming a topic; pass the returned keys to get_procedure/get_checklist/get_form_template/get_precedent. Service: ${SVC}.`,
      inputSchema: {
        query: z.string().describe("자연어 상황 설명 (예: 월세 보증금을 못 돌려받고 있어요 / 회사가 갑자기 나가라고 해요 / 보이스피싱으로 돈을 송금했어요)"),
      },
      annotations: { title: "자연어 주제 검색", ...READONLY },
    },
    async ({ query }) => {
      const ranked = rankTopics(query).slice(0, 12);
      if (!ranked.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${query}'에 맞는 주제를 바로 찾지 못했습니다. list_topics로 전체 목록(56개 분야)을 확인하거나, 더 구체적인 표현으로 다시 검색해 주세요.`) }] };
      }
      const body = ranked.map((k) => `  - ${k} [${PROCEDURES[k].category}] : ${PROCEDURES[k].제목}`).join("\n");
      return { content: [{ type: "text", text: withDisclaimer(`🔎 '${query}' 관련 주제 (관련도순)\n\n${body}\n\n→ 위 주제 키로 get_procedure(절차)·get_checklist(서류)·get_form_template(서식)·get_precedent(판례)를 호출하세요.`) }] };
    },
  );

  // 판례·법령 인용 검증(+유효성) — 환각 차단. 우리 저장소에 실재하는지 확인하고 폐기·하급심 등 주의를 표시.
  server.registerTool(
    "verify_citation",
    {
      title: "판례·법령 인용 검증",
      description: `Verifies whether a cited Korean case number or statute article actually exists in this service's verified store and flags validity caveats (overruled, lower-court, sunset, amended). Never fabricates: unknown citations are reported as unverified with official lookup links (law.go.kr, casenote.kr). Service: ${SVC}.`,
      inputSchema: {
        citation: z.string().describe("검증할 사건번호 또는 법령 조문 (예: 2020다247190 / 대법원 2024도10141 / 민법 제759조 / 상가건물 임대차보호법 제10조의4)"),
      },
      annotations: { title: "판례·법령 인용 검증", ...READONLY },
    },
    async ({ citation }) => {
      const raw = citation.trim();
      const nq = raw.replace(/\s|\(.*?\)/g, "");
      const lines: string[] = [];
      // 1) 판례(사건번호) 매칭
      const seen = new Set<string>();
      for (const [k, arr] of Object.entries(PRECEDENTS)) {
        for (const p of arr) {
          const core = p.사건번호.replace(/\s|\(.*?\)/g, "").split(",")[0];
          if (core && (nq.includes(core) || core.includes(nq)) && !seen.has(p.사건번호 + k)) {
            seen.add(p.사건번호 + k);
            lines.push(`✅ [판례·수록확인] ${p.법원} ${p.사건번호} (주제: ${k})\n   ${p.요지}`);
          }
        }
      }
      // 2) 법령 조문 매칭(조문 일치 + 법령명 일부 일치로 오탐 방지)
      const joMatch = raw.match(/제\s*\d+\s*조(\s*의\s*\d+)?/);
      if (joMatch) {
        const joN = joMatch[0].replace(/\s/g, "");
        for (const s of STATUTES) {
          const lawTokens = s.법령.replace(/\s/g, "");
          // 법령명을 2글자 윈도우로만 대조(끝의 1글자 '법' 단독 매칭이 다른 법의 동일 조문을 거짓 확인시키던 버그 수정).
          const nameHit =
            lawTokens.length >= 2 &&
            Array.from({ length: lawTokens.length - 1 }, (_, i) => lawTokens.slice(i, i + 2)).some((bi) => nq.includes(bi));
          if (s.조문.replace(/\s/g, "") === joN && (nameHit || !/\d{2,4}[가-힣]/.test(nq))) {
            lines.push(`✅ [법령·수록확인] ${s.법령} ${s.조문} — ${s.요지}`);
          }
        }
      }
      // 3) 유효성 주의(폐기·하급심·헌법불합치 등) — 질의한 번호 또는 매칭된 번호 모두 점검
      const statusKeys = Object.keys(CITATION_STATUS).filter((no) => nq.includes(no) || [...seen].some((s) => s.includes(no)));
      for (const no of statusKeys) {
        const st = CITATION_STATUS[no];
        lines.push(`⚠️ [유효성] ${no} — ${st.라벨}: ${st.설명}`);
      }
      if (!lines.length) {
        const enc = encodeURIComponent(raw);
        return { content: [{ type: "text", text: withDisclaimer(`🔍 '${raw}'은(는) 이 서비스의 검증된 저장소에서 확인되지 않았습니다.\n없는 판례·법령은 지어내지 않으니, 아래에서 직접 확인하세요:\n  - 국가법령정보센터: https://www.law.go.kr/precScListR.do?menuId=1&query=${enc}\n  - CaseNote: https://casenote.kr/search/?q=${enc}`) }] };
      }
      return { content: [{ type: "text", text: withDisclaimer(`🔍 인용 검증: '${raw}'\n\n${lines.join("\n\n")}\n\n원문 확인: https://www.law.go.kr · https://casenote.kr`) }] };
    },
  );

  // 시점법 — 최근 법령·판례 변경과 시행일(사건 발생 시점에 적용되는 법이 다를 수 있음).
  server.registerTool(
    "law_updates",
    {
      title: "최근 법령·판례 변경(시점법)",
      description: `Returns recent significant Korean statutory or precedent changes and their effective dates relevant to a keyword/topic, so guidance reflects the law applicable at the right time. Information only. Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("예: 스토킹 / 통상임금 / 유류분 / 임대차 / 개인정보 / 출퇴근 (비우면 최근 변경 전체)"),
      },
      annotations: { title: "최근 법령·판례 변경", ...READONLY },
    },
    async ({ keyword }) => {
      const kw = keyword?.trim();
      const list = kw
        ? LAW_TIMELINE.filter((c) => c.법령.includes(kw) || c.요지.includes(kw) || c.키워드.some((x) => x.includes(kw) || kw.includes(x)))
        : LAW_TIMELINE;
      if (!list.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}' 관련 최근 변경 정보가 없습니다. 다른 키워드로 검색하거나 비우고 전체를 확인하세요.`) }] };
      }
      const body = list.map((c) => `• ${c.법령} — ${c.변경}\n  시행/적용: ${c.시행일}\n  ${c.요지}`).join("\n\n");
      return { content: [{ type: "text", text: withDisclaimer(`🕒 최근 법령·판례 변경${kw ? ` (검색: ${kw})` : ""}\n\n${body}\n\n※ 사건 발생 시점에 적용되는 법이 다를 수 있습니다. 정확한 시행일·경과규정은 law.go.kr에서 확인하세요.`) }] };
    },
  );

  // 빠른 진단(트리아지) — 상황 설명을 받아 가장 가까운 절차의 '기한·첫 단계·확보할 증거·도움처'를 한 장으로 안내.
  // declaw: 특정 결론·행동을 권하지 않고 '선택지·다음 단계' 정보만 제공(경로 안내). 빈칸 채움형 서식은 get_form_template로 연결.
  server.registerTool(
    "triage",
    {
      title: "빠른 진단·다음 단계",
      description: `Triage a free-text everyday-law situation: returns the closest topic's key deadline, the first action steps, the evidence to secure now, and where to get help, plus other candidate topics to confirm. Path-guidance and information only — does NOT give a verdict or recommend a specific legal action. Service: ${SVC}.`,
      inputSchema: {
        situation: z.string().describe("처한 상황을 일상어로 설명 (예: 전세 만기인데 집주인이 보증금을 안 줘요 / 어제 보이스피싱으로 500만원 보냈어요 / 직장 상사가 계속 폭언해요)"),
      },
      annotations: { title: "빠른 진단·다음 단계", ...READONLY },
    },
    async ({ situation }) => {
      const ranked = rankTopics(situation);
      if (!ranked.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${situation}'에 맞는 주제를 바로 찾지 못했습니다. search_topics로 다시 검색하거나 list_topics로 전체 분야를 확인해 주세요.`) }] };
      }
      const top = ranked[0];
      const p = PROCEDURES[top];
      const c = CHECKLISTS[top];
      const steps = p.단계.slice(0, 3).map((s) => `  ${s}`).join("\n");
      const evid = (c?.증거 ?? []).slice(0, 3).map((s) => `  - ${s}`).join("\n");
      const others = ranked.slice(1, 5).map((k) => `  · ${k} [${PROCEDURES[k].category}] ${PROCEDURES[k].제목}`).join("\n");
      const hasPrec = (PRECEDENTS[top]?.length ?? 0) > 0;
      const parts = [
        `🧭 빠른 진단: '${situation}'`,
        `※ 특정 결론·행동을 권하는 것이 아니라, 가장 가까운 절차의 기한·단계 정보를 안내합니다.`,
        ``,
        `▶ 가장 가까운 주제: ${top} [${p.category}] ${p.제목}`,
        ``,
        `⏰ 기한(놓치면 권리 소멸 위험): ${p.기한}`,
        ``,
        `✅ 지금 할 일(첫 단계)`,
        steps,
      ];
      if (evid) parts.push(``, `📎 먼저 확보할 증거`, evid);
      parts.push(``, `📞 접수·도움받을 곳: ${p.온라인접수}`);
      if (others) parts.push(``, `※ 상황이 아래에 더 가깝다면 그 주제로 다시 진단/조회하세요:`, others);
      parts.push(
        ``,
        `→ 더 자세히: get_procedure("${top}") · 서류 get_checklist("${top}") · 표준서식 get_form_template · 기한계산 calculate_amount${hasPrec ? ` · 판례 get_precedent("${top}")` : ""}`,
      );
      return { content: [{ type: "text", text: withDisclaimer(parts.join("\n")) }] };
    },
  );

  // 소송비용 계산기 — 민사 인지대·송달료(전자소송 감액·심급 배수 포함). 공시 산식 기반.
  server.registerTool(
    "calculate_court_cost",
    {
      title: "소송비용 계산기 (인지대·송달료)",
      description: `Estimates Korean civil court filing costs (court stamp fee + service fee) from the claim amount, number of parties, track, and whether it is e-litigation. Based on published statutory formulas. Estimate only. Service: ${SVC}.`,
      inputSchema: {
        claim_amount: z.number().finite().nonnegative().describe("소가(청구금액, 원). 금전청구는 청구액"),
        parties: z.number().int().min(2).describe("당사자 수(원고 수 + 피고 수, 최소 2)"),
        track: z.enum(["소액", "단독", "합의", "지급명령", "조정", "항소", "상고", "보전"]).describe("절차 종류(소액=3천만↓ / 단독 / 합의 / 지급명령 / 조정 / 항소 / 상고 / 보전=가압류·가처분)"),
        e_litigation: z.boolean().optional().describe("전자소송 여부(true면 인지대 10% 감액). 기본 false"),
      },
      annotations: { title: "소송비용 계산기", ...READONLY },
    },
    async ({ claim_amount, parties, track, e_litigation }) => {
      const r = calcCourtCost(claim_amount, parties, track, e_litigation ?? false);
      const text = `🧮 소송비용(개략)\n\n결과: ${r.결과}\n계산식: ${r.계산식}\n\n비고: ${r.비고}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 기한/소멸시효 계산기 — 기준일 + 법정기간 → 마감일·남은일수. 기산점·중단/예외 경고 포함.
  server.registerTool(
    "calculate_deadline",
    {
      title: "기한·소멸시효 계산기",
      description: `Computes the deadline date and days remaining for a Korean legal time limit (statute of limitations, exclusion period, or appeal/objection period) from a start date. Returns the due date, D-day, the accrual point, and tolling/exception cautions. Information only — confirm the accrual point per your facts. Service: ${SVC}.`,
      inputSchema: {
        start_date: z.string().describe("기산 기준일 (YYYY-MM-DD). 예: 해고일, 사고일, 송달받은 날"),
        deadline_type: z.enum(Object.keys(DEADLINES) as [string, ...string[]]).describe("기한 종류(예: 부당해고_구제신청, 불법행위_손해배상시효, 민사_항소, 상속포기_한정승인 등)"),
      },
      annotations: { title: "기한·소멸시효 계산기", ...READONLY },
    },
    async ({ start_date, deadline_type }) => {
      const rule = DEADLINES[deadline_type];
      const r = calcDeadline(start_date, rule.기간);
      if (!r) {
        return { content: [{ type: "text", text: withDisclaimer(`날짜 형식이 올바르지 않습니다. 기준일을 YYYY-MM-DD 형식(예: 2026-06-23)으로 입력하세요.`) }] };
      }
      const 기간표시 = rule.기간.년 ? `${rule.기간.년}년` : rule.기간.월 ? `${rule.기간.월}개월` : `${rule.기간.일}일`;
      const status = r.남은일수 < 0 ? `⛔ 기한 경과 (${-r.남은일수}일 지남)` : r.남은일수 === 0 ? "⚠️ 오늘이 마감일" : `⏳ D-${r.남은일수} (${r.남은일수}일 남음)`;
      const text = [
        `⏰ 기한 계산: ${deadline_type}`,
        ``,
        `기준일 ${start_date} + ${기간표시}`,
        `→ 마감일: ${r.마감일}`,
        `→ ${status}`,
        ``,
        `기산점: ${rule.기산}`,
        `주의: ${rule.경고}`,
        ``,
        `※ 기산점·중단(청구·압류·승인)·정지 사유에 따라 실제 기한이 달라질 수 있으니 반드시 확인하세요.`,
      ].join("\n");
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 무료 법률지원·구제 연결 — 무료상담/소송대리/소송구조/구제금/핫라인 라우팅(자격 단정 아님).
  server.registerTool(
    "find_legal_aid",
    {
      title: "무료 법률지원·구제 연결",
      description: `Routes the user to Korean free legal-help and victim-relief programs (free counsel, free representation, court-fee waiver, crime-victim relief, unpaid-wage state payout) with eligibility criteria and contacts, plus a hotline directory. Routing and information only — it does not decide eligibility. Service: ${SVC}.`,
      inputSchema: {
        keyword: z.string().optional().describe("상황·필요(예: 무료변호사, 체불, 범죄피해, 소송비용, 상담). 비우면 전체"),
      },
      annotations: { title: "무료 법률지원·구제 연결", ...READONLY },
    },
    async ({ keyword }) => {
      const kw = keyword?.trim();
      const hot = HOTLINES.map((h) => `  ${h.번호} — ${h.기관} (${h.용도})`).join("\n");
      const detail = (p: (typeof SUPPORT_PROGRAMS)[number]) => {
        const base = `▶ ${p.명칭}\n  · 대상: ${p.대상}\n  · 내용: ${p.내용}\n  · 연락: ${p.연락}`;
        const g = APPLICATION_GUIDE[p.명칭];
        if (!g) return base;
        const steps = g.절차.map((s, i) => `${i + 1}) ${s}`).join("  ");
        return `${base}\n  📝 신청절차: ${steps}\n  📎 준비서류: ${g.준비물.join(" · ")}`;
      };
      const 꼬리 = `\n\n※ 위는 제도·기준 안내이며 자격을 확정하지 않습니다. 실제 지원 여부는 해당 기관(특히 대한법률구조공단 132)에서 확인하세요.`;
      if (!kw) {
        // 키워드 없으면 전체 색인(명칭 + 대표 키워드) + 핫라인
        const idx = SUPPORT_PROGRAMS.map((p) => `  · ${p.명칭} [${p.키워드.slice(0, 3).join("·")}]`).join("\n");
        const text = `📑 무료 법률지원·구제 프로그램 ${SUPPORT_PROGRAMS.length}개\n상황 키워드로 검색하세요 — 예: 성폭력 / 전세사기 / 의료사고 / 체불 / 장애인 / 채무 / 양육비 / 통신\n\n${idx}\n\n📞 24시간·대표 핫라인\n${hot}${꼬리}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const matched = SUPPORT_PROGRAMS.filter((p) => p.명칭.includes(kw) || p.대상.includes(kw) || p.내용.includes(kw) || p.키워드.some((k) => k.includes(kw) || kw.includes(k)));
      if (!matched.length) {
        const text = `'${kw}'에 딱 맞는 프로그램을 못 찾았습니다. 우선 아래로 문의하세요:\n\n${detail(SUPPORT_PROGRAMS[0])}\n\n다른 키워드(예: 성폭력·전세사기·의료사고·체불·장애인·채무)로 다시 검색하거나, 비우면 전체 목록을 봅니다.\n\n📞 핫라인\n${hot}${꼬리}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const shown = matched.slice(0, 8);
      const more = matched.length > 8 ? `\n\n(외 ${matched.length - 8}개 — 키워드를 더 좁혀보세요)` : "";
      const text = `🤝 '${kw}' 관련 무료 법률지원·구제 (${matched.length}개)\n\n${shown.map(detail).join("\n\n")}${more}${꼬리}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 증빙서류 발급 안내 — 준비서류를 '어디서 어떻게' 떼는지(발급처·온라인·수수료·팁) + 절약 꿀팁.
  server.registerTool(
    "how_to_get_document",
    {
      title: "증빙서류 발급 안내",
      description: `Explains where and how to obtain Korean civil documents needed for filings (residence/family/property registry/income/tax/medical records, bank/debt records, etc.): issuing office, online URL, fee, and practical tips — plus document-prep shortcuts. Information only. Service: ${SVC}.`,
      inputSchema: {
        document: z.string().optional().describe("서류명/키워드(예: 등기부등본, 가족관계증명서, 소득금액증명, 진단서, 부채증명, 전입세대확인서). 비우면 전체 목록 + 준비 꿀팁"),
      },
      annotations: { title: "증빙서류 발급 안내", ...READONLY },
    },
    async ({ document }) => {
      const kw = document?.trim();
      const tips = DOC_TIPS.map((t) => `  • ${t}`).join("\n");
      const detail = (k: string) => {
        const g = DOCUMENT_GUIDE[k];
        return `📄 ${k}\n  · 발급처: ${g.발급처}\n  · 온라인: ${g.온라인}\n  · 수수료: ${g.수수료}\n  · 팁: ${g.팁}`;
      };
      if (!kw) {
        const idx = Object.keys(DOCUMENT_GUIDE).map((k) => `  · ${k}`).join("\n");
        const text = `📑 증빙서류 발급 안내 (서류명으로 검색하세요)\n\n${idx}\n\n★ 서류 준비 꿀팁\n${tips}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const matched = Object.keys(DOCUMENT_GUIDE).filter((k) => k.includes(kw) || DOCUMENT_GUIDE[k].별칭.some((a) => a.includes(kw) || kw.includes(a)));
      if (!matched.length) {
        const text = `'${kw}' 서류 발급 안내가 목록에 없습니다. 대부분의 행정서류는 정부24(gov.kr), 부동산 등기는 인터넷등기소(iros.go.kr), 세금 관련은 홈택스(hometax.go.kr)에서 발급됩니다.\n\n★ 서류 준비 꿀팁\n${tips}`;
        return { content: [{ type: "text", text: withDisclaimer(text) }] };
      }
      const text = `🗂️ '${kw}' 서류 발급 안내\n\n${matched.slice(0, 5).map(detail).join("\n\n")}\n\n★ 서류 준비 꿀팁\n${tips}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  // 법률용어 풀이 — 일상어↔법률어 + 자주 보는 법정용어 뜻(정의만, declaw). 큐레이션·인메모리·키 불요.
  server.registerTool(
    "explain_term",
    {
      title: "법률용어 풀이",
      description: `Explains Korean legal terms in plain language and maps everyday/colloquial words to their legal terms. Returns definitions and the distinction between easily-confused terms (e.g., dismissal on procedural grounds vs on the merits). Definition/information only, not legal advice. Service: ${SVC}.`,
      inputSchema: {
        term: z.string().describe("뜻이 궁금한 단어(법률용어 또는 일상어). 예: 각하, 가압류, 공시송달, 통상임금, 떼인 돈, 빨간딱지"),
      },
      annotations: { title: "법률용어 풀이", ...READONLY },
    },
    async ({ term }) => {
      const kw = term.trim();
      const nkw = kw.replace(/\s/g, "");
      if (nkw.length < 2) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}'은(는) 너무 짧아 검색이 어렵습니다. 두 글자 이상으로 입력해 주세요(예: 각하, 압류, 통상임금).`) }] };
      }
      const matched = GLOSSARY.filter((t) => {
        const u = t.용어.replace(/\s/g, "");
        if (u.includes(nkw) || nkw.includes(u)) return true;
        // 별칭은 '질의가 별칭을 포함(또는 동일)'할 때만 — '대법원'이 별칭 '대법원 상고'에 부분일치해 상고로 오매칭되던 문제 방지.
        return (t.별칭 ?? []).some((a) => {
          const na = a.replace(/\s/g, "");
          return na.length >= 2 && nkw.includes(na);
        });
      }).slice(0, 6);
      if (!matched.length) {
        return { content: [{ type: "text", text: withDisclaimer(`'${kw}'은(는) 용어사전에 없습니다. 비슷한 말로 다시 찾거나, 상황 설명이면 search_topics("${kw}")로 관련 절차를 찾아보세요.\n공식 용어: 찾기쉬운 생활법령정보(https://www.easylaw.go.kr) · 국가법령정보센터 법령용어(https://www.law.go.kr)`) }] };
      }
      const body = matched
        .map((t) => {
          const lines = [`📖 ${t.용어} [${t.분류}]`, `   ${t.풀이}`];
          if (t.헷갈림) lines.push(`   ⚖ 구별: ${t.헷갈림}`);
          if (t.별칭?.length) lines.push(`   (다른 말: ${t.별칭.join(", ")})`);
          return lines.join("\n");
        })
        .join("\n\n");
      const tail = `\n\n→ 관련 절차는 search_topics("${kw}"), 더 깊은 원문은 국가법령정보센터(law.go.kr) 법령용어·생활법령(easylaw.go.kr).`;
      return { content: [{ type: "text", text: withDisclaimer(`🔎 '${kw}' 뜻풀이 (${matched.length}건)\n\n${body}${tail}`) }] };
    },
  );

  return server;
}

export const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("text/plain").send("법률 절차 길잡이 MCP 서버 — POST /mcp (Streamable HTTP)");
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// 요청에서 공개 베이스 URL 도출(프록시 뒤에서도 정확하도록 X-Forwarded-* 우선, PUBLIC_BASE_URL로 강제 가능).
function getBaseUrl(req: express.Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const xfproto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const xfhost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const proto = xfproto || req.protocol || "http";
  const host = xfhost || req.headers.host;
  return host ? `${proto}://${host}` : "";
}

// 서식 파일 다운로드 — get_form_template 응답의 '📎 파일로 저장·공유' 링크 대상. 읽기전용·무상태·인메모리.
app.get("/forms/:key", (req, res) => {
  const key = req.params.key.replace(/\.txt$/i, ""); // Express 5가 params를 이미 디코드(이중 디코딩 금지)
  const f = FORMS[key];
  if (!f) {
    res.status(404).type("text/plain; charset=utf-8").send("서식을 찾을 수 없습니다. get_form_template의 서식 키를 확인하세요.");
    return;
  }
  const lines = [f.제목, `용도: ${f.용도}`];
  if (f.공식양식) lines.push(`공식 양식 받는 곳: ${f.공식양식}`);
  lines.push(
    "",
    "─── 서식 시작 ───",
    f.본문,
    "─── 서식 끝 ───",
    "",
    "[작성요령]",
    ...f.작성요령.map((s) => `- ${s}`),
    "",
    "────────────────────",
    "※ 일반 법률·절차 정보이며 개별 법률 자문이 아닙니다. 관공서 제출본은 위 '공식 양식 받는 곳'에서 정식 서식을 받아 작성하세요.",
  );
  const filename = `${f.제목.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_")}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="legal-form.txt"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send("\uFEFF" + lines.join("\n")); // BOM: Windows 메모장 UTF-8 호환
});

app.post("/mcp", async (req, res) => {
  const server = createServer(getBaseUrl(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP 요청 처리 오류:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed (stateless: use POST)" },
    id: null,
  });
});

const PORT = Number(process.env.PORT ?? 4100);
// 테스트(NODE_ENV=test)에서는 자동 listen을 막아, 테스트가 임의 포트로 app을 직접 띄울 수 있게 한다.
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.error(`법률 절차 길잡이 MCP listening on http://localhost:${PORT}/mcp`);
  });
}
