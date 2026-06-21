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
} from "./data/index.js";
import {
  calcUnpaidWages,
  calcSeverance,
  calcWeeklyHolidayPay,
  calcDelayInterest,
} from "./calc.js";

// 서비스명 — PlayMCP 개발가이드: description에 영문/국문 병기 서비스명 포함 필수
const SVC = "법률 절차 길잡이(Legal Navigator)";

const SERVER_INSTRUCTIONS =
  "이 서버는 한국 생활법률(노동·주택임대차·돈거래/사기·소비자·교통사고·형사·민사절차)에 대한 " +
  "법률 정보·대응 절차·표준 서식·금액 계산·법령/판례 안내를 제공하는 정보 도구입니다. " +
  "사용자가 상황을 설명하면 먼저 list_topics로 주제를 파악하고, 적절한 주제 키로 get_procedure·get_checklist·get_form_template·get_precedent를 호출해 안내하세요. " +
  "중요: 이 도구는 법률 자문이 아닙니다. 개별 사건의 법적 결론(승소·유무죄 등)을 단정하지 말고 정보 제공에 그치며, " +
  "표준서식은 사용자가 제공한 사실로 공란을 채우는 수준까지만 돕고 법적 주장·전략 작성은 하지 마세요. 구체적 판단은 변호사·공인노무사 상담을 권하세요.";

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

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "legal-navigator", version: "0.2.0", title: "법률 절차 길잡이" },
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
      description: `Provides a blank standard document template (complaint/내용증명/신청서/소장/고소장/합의서 etc.) with [blank] fields and writing tips. Fill blanks only with facts the user provides; do NOT draft legal arguments. Service: ${SVC}.`,
      inputSchema: { form: z.enum(FORM_KEYS).describe("서식 키. get_procedure/list_topics에서 안내된 서식명을 사용") },
      annotations: { title: "표준 서식 제공", ...READONLY },
    },
    async ({ form }) => {
      const f = FORMS[form];
      if (!f) {
        return { content: [{ type: "text", text: withDisclaimer(`'${form}' 서식이 없습니다.`) }] };
      }
      const text = [
        `📝 ${f.제목}`,
        `용도: ${f.용도}`,
        "",
        "─── 서식 시작 ───",
        f.본문,
        "─── 서식 끝 ───",
        "",
        "작성요령",
        ...f.작성요령.map((s) => `  - ${s}`),
      ].join("\n");
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
      return { content: [{ type: "text", text: withDisclaimer(`⚖️ 판례 (검색: ${keyword})\n\n${body}\n\n원문 확인: https://www.law.go.kr 또는 https://casenote.kr`) }] };
    },
  );

  server.registerTool(
    "calculate_amount",
    {
      title: "금액 계산기",
      description: `Estimates Korean labor amounts: unpaid wages, severance pay, weekly holiday allowance, or delay interest. Provide the numbers matching the chosen item. Estimates only. Service: ${SVC}.`,
      inputSchema: {
        item: z.enum(항목값).describe("체불임금 | 퇴직금 | 주휴수당 | 지연이자"),
        monthly_wage: z.number().optional().describe("[체불임금] 월 정상 임금(원)"),
        unpaid_months: z.number().optional().describe("[체불임금] 미지급 개월 수"),
        other_unpaid: z.number().optional().describe("[체불임금] 기타 미지급액(원)"),
        daily_avg_wage: z.number().optional().describe("[퇴직금] 1일 평균임금(원)"),
        tenure_days: z.number().optional().describe("[퇴직금] 총 재직일수"),
        weekly_hours: z.number().optional().describe("[주휴수당] 1주 소정근로시간"),
        hourly_wage: z.number().optional().describe("[주휴수당] 시급(원)"),
        principal: z.number().optional().describe("[지연이자] 미지급 원금(원)"),
        delay_days: z.number().optional().describe("[지연이자] 지연 일수"),
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
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
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
      const text = `⚖️ 법령 요지${keyword ? ` (검색: ${keyword})` : ""}\n\n${body}\n\n원문(국가법령정보센터):\n${links}`;
      return { content: [{ type: "text", text: withDisclaimer(text) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("text/plain").send("법률 절차 길잡이 MCP 서버 — POST /mcp (Streamable HTTP)");
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
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
app.listen(PORT, () => {
  console.error(`법률 절차 길잡이 MCP listening on http://localhost:${PORT}/mcp`);
});
