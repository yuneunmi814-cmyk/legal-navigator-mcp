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
  type ProcedureType,
  type FormKey,
} from "./data/labor.js";
import {
  calcUnpaidWages,
  calcSeverance,
  calcWeeklyHolidayPay,
  calcDelayInterest,
} from "./calc.js";

// 서비스명 — PlayMCP 개발가이드: description에 영문/국문 병기 서비스명 포함 필수
const SVC = "법률 절차 길잡이(Legal Navigator)";

const SERVER_INSTRUCTIONS =
  "이 서버는 한국 노동 분쟁(임금체불·부당해고·퇴직금 미지급·직장 내 괴롭힘)에 대한 " +
  "법률 정보·대응 절차·표준 서식·금액 계산을 제공하는 정보 도구입니다. " +
  "사용자가 상황을 설명하면 적절한 도구를 호출해 절차·필요서류·서식·계산·법령 정보를 안내하세요. " +
  "중요: 이 도구는 법률 자문이 아닙니다. 개별 사건의 법적 결론(승소 여부 등)을 단정하지 말고 " +
  "정보 제공에 그치며, 구체적 판단이 필요하면 변호사·공인노무사 상담을 권하세요.";

// 모든 도구는 읽기전용 정보 조회 (PlayMCP 필수 annotations 5종 전부 지정)
const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const 유형값 = ["임금체불", "부당해고", "퇴직금미지급", "직장내괴롭힘"] as const;
const 서식값 = ["임금체불진정서", "임금지급_내용증명", "부당해고구제신청서"] as const;
const 항목값 = ["체불임금", "퇴직금", "주휴수당", "지연이자"] as const;

function 절차텍스트(유형: ProcedureType): string {
  const p = PROCEDURES[유형];
  return [
    `📋 ${p.제목}`,
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
    { name: "legal-navigator", version: "0.1.0", title: "법률 절차 길잡이" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "get_procedure",
    {
      title: "절차 안내",
      description:
        `Returns the official response procedure, competent authority, deadline, online filing channel, and legal basis for a Korean labor dispute type (wage arrears, unfair dismissal, unpaid severance, workplace harassment). Information only, not legal advice. Service: ${SVC}.`,
      inputSchema: {
        dispute_type: z
          .enum(유형값)
          .describe("임금체불 | 부당해고 | 퇴직금미지급 | 직장내괴롭힘"),
      },
      annotations: { title: "절차 안내", ...READONLY },
    },
    async ({ dispute_type }) => ({
      content: [{ type: "text", text: withDisclaimer(절차텍스트(dispute_type)) }],
    }),
  );

  server.registerTool(
    "get_checklist",
    {
      title: "필요 서류·증거 체크리스트",
      description:
        `Returns a checklist of evidence to gather and documents to prepare when filing, by Korean labor dispute type. Information only. Service: ${SVC}.`,
      inputSchema: {
        dispute_type: z
          .enum(유형값)
          .describe("임금체불 | 부당해고 | 퇴직금미지급 | 직장내괴롭힘"),
      },
      annotations: { title: "필요 서류·증거 체크리스트", ...READONLY },
    },
    async ({ dispute_type }) => {
      const c = CHECKLISTS[dispute_type];
      const text = [
        `🗂️ ${dispute_type} — 준비 체크리스트`,
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
      description:
        `Provides a blank standard document template (labor complaint / certified mail / unfair-dismissal relief application) with [blank] fields and writing tips. Does NOT auto-fill from the user's facts. Service: ${SVC}.`,
      inputSchema: {
        form: z
          .enum(서식값)
          .describe("임금체불진정서 | 임금지급_내용증명 | 부당해고구제신청서"),
      },
      annotations: { title: "표준 서식 제공", ...READONLY },
    },
    async ({ form }) => {
      const f = FORMS[form as FormKey];
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
    "calculate_amount",
    {
      title: "금액 계산기",
      description:
        `Estimates Korean labor amounts: unpaid wages, severance pay, weekly holiday allowance, or delay interest. Provide the numbers matching the chosen item. Estimates only. Service: ${SVC}.`,
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
      description:
        `Looks up summaries of key Korean labor statutes (Labor Standards Act, etc.) with an optional keyword filter. See law.go.kr for full text. Service: ${SVC}.`,
      inputSchema: {
        keyword: z
          .string()
          .optional()
          .describe("예: 해고, 퇴직금, 임금, 주휴, 괴롭힘 (비우면 전체)"),
      },
      annotations: { title: "법령 요지 조회", ...READONLY },
    },
    async ({ keyword }) => {
      const list = keyword
        ? STATUTES.filter(
            (s) => s.요지.includes(keyword) || s.조문.includes(keyword) || s.법령.includes(keyword),
          )
        : STATUTES;
      if (!list.length) {
        return {
          content: [
            { type: "text", text: withDisclaimer(`'${keyword}'에 해당하는 조문을 찾지 못했습니다.`) },
          ],
        };
      }
      const body = list.map((s) => `• ${s.법령} ${s.조문} — ${s.요지}`).join("\n");
      // 모든 법령을 국가법령정보센터 공식 페이지로 deep-link (grounding)
      const laws = [...new Set(list.map((s) => s.법령))];
      const links = laws
        .map((n) => `  - ${n}: https://www.law.go.kr/법령/${encodeURIComponent(n)}`)
        .join("\n");
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

// 헬스체크 (배포 환경용)
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Stateless Streamable HTTP: 요청마다 새 서버/트랜스포트 생성 후 종료
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
