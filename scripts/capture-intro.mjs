#!/usr/bin/env node
// PlayMCP 콘솔에 올리는 소개 이미지 5장(960×960)을 우리 서버가 실제로 뱉는
// 카드 JSON으로 렌더링해 찍는다.
//
// 왜 스크립트인가:
//   8/31 5장은 손으로 만들었고 생성기가 없었다. 그래서 9/2에 서식 카드 캡션을
//   고쳤을 때 이미지는 그대로 낡았다(제품에 없는 문구가 콘솔에 걸려 있었다).
//   여기서는 tools/call 응답을 그대로 그리므로 이미지가 제품보다 앞서거나
//   뒤처질 수 없다.
//
//   사용법:  node scripts/capture-intro.mjs [출력폴더]
//   기본 출력: assets/kakao-tools-examples/
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const OUT = resolve(process.argv[2] ?? "assets/kakao-tools-examples");
const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ── 장면 5개 ────────────────────────────────────────────────────────────────
// 카드 종류가 겹치지 않게 골랐다. 8/31판은 5장 중 3장이 같은 '빠른 진단' 카드였고,
// 계산기·기한 카드는 한 번도 보여준 적이 없었다.
const SCENES = [
  {
    file: "01_오인미만해고",
    발화: "직원이 나 포함 세 명인데 갑자기 나오지 말래요",
    tool: "triage",
    args: { situation: "직원이 나 포함 세 명인데 갑자기 나오지 말래요" },
  },
  {
    file: "02_서식카드",
    발화: "임금체불 진정서 양식 보여줘",
    tool: "get_form_template",
    args: { form: "임금체불진정서" },
  },
  {
    file: "03_전화바로걸기",
    발화: "변호사 살 돈이 없어요",
    tool: "find_legal_aid",
    args: { keyword: "무료변호사" },
  },
  {
    // 발화는 사람 말 그대로 두고, 도구에는 모델이 환산해 넘기는 값을 넣는다.
    // (1일 평균임금 = 월 300만 × 3개월 ÷ 91일 ≈ 98,901원 · 3년 = 1,095일)
    file: "04_퇴직금계산",
    발화: "3년 일했고 월급 300만원인데 퇴직금 얼마예요?",
    tool: "calculate_amount",
    args: { item: "퇴직금", daily_avg_wage: 98901, tenure_days: 1095 },
  },
  {
    file: "05_기한디데이",
    발화: "아버지 돌아가신 지 두 달인데 상속포기 아직 돼요?",
    tool: "calculate_deadline",
    args: { start_date: "2026-07-05", deadline_type: "상속포기_한정승인" },
  },
];

// ── 색 ──────────────────────────────────────────────────────────────────────
// 8/31판 화면에서 그대로 뽑았다. 여기서 임의로 바꾸면 콘솔의 다섯 장이
// 서로 다른 제품처럼 보인다.
const C = {
  잉크: "#191F28",
  본문: "#333D4B",
  흐림: "#8B95A1",
  선: "#EDEFF2",
  카드선: "#E5E8EB",
  연회색: "#F2F4F6",
  말풍선: "#EDEFF2",
  파랑배경: "#E8F0FE",
  파랑글자: "#2563EB",
  버튼: "#1B2028",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── 위젯 JSON → HTML ────────────────────────────────────────────────────────
function 컴포넌트(c) {
  switch (c.type) {
    case "Title": {
      const px = c.size === "lg" ? 30 : c.size === "sm" ? 21 : 25;
      return `<div class="t" style="font-size:${px}px">${esc(c.value)}</div>`;
    }
    case "Caption":
      return `<div class="cap">${esc(c.value)}</div>`;
    case "Text":
      return `<div class="tx${c.italic ? " it" : ""}" style="font-size:${
        c.size === "sm" ? 17 : 18
      }px">${esc(c.value)}</div>`;
    case "Markdown":
      return `<div class="tx">${esc(c.value)}</div>`;
    case "Badge": {
      const info = c.color === "info" || c.color === "primary";
      const ok = c.color === "success";
      const bg = info ? C.파랑배경 : ok ? "#E7F6EC" : C.연회색;
      const fg = info ? C.파랑글자 : ok ? "#128A46" : "#4E5968";
      return `<span class="bg" style="background:${bg};color:${fg}">${esc(c.label)}</span>`;
    }
    case "Button": {
      const 주 = c.style === "primary";
      return `<div class="btn ${주 ? "p" : "s"}">${esc(c.label)}</div>`;
    }
    case "Divider":
      return `<div class="div"></div>`;
    case "Row":
      return `<div class="row" style="gap:${c.gap ?? 8}px">${c.children.map(컴포넌트).join("")}</div>`;
    case "Col":
      return `<div class="col" style="gap:${c.gap ?? 8}px">${c.children.map(컴포넌트).join("")}</div>`;
    case "ListViewItem":
      return `<div class="lvi"><div class="tx">${esc(c.title ?? "")}</div>${
        c.description ? `<div class="cap">${esc(c.description)}</div>` : ""
      }</div>`;
    case "ListView":
      return `<div class="col" style="gap:14px">${(c.children ?? []).map(컴포넌트).join("")}</div>`;
    default:
      return "";
  }
}

// 상단 우측 아이콘 — 이모지 글리프는 헤드리스 크롬에서 깨져 SVG로 그린다
const 아이콘 = [
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4E5968" stroke-width="1.7"
     stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>
     <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4E5968" stroke-width="1.7"
     stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4E5968" stroke-width="1.7"
     stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
].join("");

function 페이지(발화, widget) {
  const 본문 = (widget.children ?? []).map(컴포넌트).join("");
  return `<meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:960px;height:960px;background:#fff;overflow:hidden;
       font-family:"Apple SD Gothic Neo","Pretendard",-apple-system,sans-serif;
       -webkit-font-smoothing:antialiased}
  /* 폰은 아래로 흘러 나가게 둔다 — 8/31판과 같은 구도다 */
  .phone{position:absolute;left:100px;top:18px;width:760px;height:1020px;
         background:#0F1115;border-radius:56px;padding:11px}
  .screen{width:100%;height:100%;background:#fff;border-radius:46px;
          padding:26px 30px;overflow:hidden}
  .bar{display:flex;align-items:center;gap:12px;margin-bottom:26px}
  .x{font-size:26px;color:${C.잉크};font-weight:300}
  .gpt{font-size:25px;font-weight:800;color:${C.잉크};letter-spacing:-.4px}
  .fk{font-size:24px;color:#9AA3AD;letter-spacing:-.3px}
  .icons{margin-left:auto;display:flex;gap:18px;align-items:center}
  .me{display:flex;justify-content:flex-end;margin-bottom:24px}
  .me span{background:${C.말풍선};border-radius:22px;padding:15px 22px;
           font-size:19px;color:${C.잉크};max-width:560px;letter-spacing:-.3px}
  .who{display:flex;align-items:center;gap:9px;margin-bottom:16px;
       font-size:19px;color:#4E5968;letter-spacing:-.3px}
  .ring{width:17px;height:17px;border-radius:50%;border:4px solid #FF4E24}
  .card{border:1px solid ${C.카드선};border-radius:20px;padding:26px 24px;
        display:flex;flex-direction:column;gap:12px}
  .t{font-weight:800;color:${C.잉크};letter-spacing:-.6px;line-height:1.32}
  .cap{font-size:16px;color:${C.흐림};letter-spacing:-.3px;line-height:1.5}
  .tx{font-size:18px;color:${C.본문};letter-spacing:-.3px;line-height:1.55}
  .it{font-style:italic}
  .bg{display:inline-block;font-size:15px;font-weight:700;border-radius:999px;
      padding:7px 15px;letter-spacing:-.3px}
  .div{height:1px;background:${C.선};margin:4px 0}
  .row{display:flex;align-items:center;flex-wrap:wrap}
  .col{display:flex;flex-direction:column}
  .lvi{display:flex;flex-direction:column;gap:5px}
  .btn{border-radius:14px;height:62px;display:flex;align-items:center;
       justify-content:center;font-size:19px;font-weight:800;letter-spacing:-.4px}
  .btn.p{background:${C.버튼};color:#fff}
  .btn.s{background:${C.연회색};color:${C.잉크}}
</style>
<div class="phone" id="phone"><div class="screen">
  <div class="bar"><span class="x">✕</span><span class="gpt">ChatGPT</span>
    <span class="fk">for Kakao</span>
    <span class="icons">${아이콘}</span></div>
  <div class="me"><span>${esc(발화)}</span></div>
  <div class="who"><span class="ring"></span>Kakao Tools · 법률 절차 길잡이</div>
  <div class="card" id="card">${본문}</div>
</div></div>
<script>
  // 카드가 짧으면(계산기·기한) 폰 아래가 크게 비어 "내용이 모자란" 인상을 준다.
  // 내용 높이에 맞춰 조금 키우고, 남는 여백을 위아래로 나눈다. 폰 아래는 계속 흘러 나간다.
  (function () {
    var phone = document.getElementById("phone");
    var card = document.getElementById("card");
    var 아래 = card.getBoundingClientRect().bottom + 26;   // 카드 아래 여백까지
    var s = Math.max(1, Math.min(1.22, 880 / 아래));       // 1.22 = 폰 폭 927px, 화면 안에 들어온다
    var 높이 = 아래 * s;
    // 정중앙에 두면 위가 크게 비어 다섯 장의 구도가 서로 어긋난다.
    // 위쪽으로 붙이되 아래 여백이 더 남도록 4:6으로 나눈다.
    var top = Math.max(18, Math.round(18 + (960 - 높이) * 0.28));
    phone.style.transformOrigin = "top center";
    phone.style.transform = "scale(" + s + ")";
    phone.style.top = top + "px";
  })();
</script>`;
}

// ── 서버 호출 ───────────────────────────────────────────────────────────────
async function 카드(tool, args) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const 원문 = await r.text();
  const 줄 = 원문.split("\n").filter((l) => l.trim()).pop().replace(/^data:\s*/, "");
  const j = JSON.parse(줄);
  if (j.error) throw new Error(`${tool}: ${j.error.message}`);
  const text = j.result?.content?.[0]?.text ?? "";
  const kw = JSON.parse(text); // WIDGETS=on이면 봉투 JSON이 그대로 온다
  if (!kw.widget) throw new Error(`${tool}: 위젯이 없다 — WIDGETS=on 확인`);
  return kw.widget;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
spawnSync("npm", ["run", "build"], { stdio: "ignore" });
const srv = spawn("node", ["dist/server.js"], {
  env: { ...process.env, WIDGETS: "on", PORT: String(PORT) },
  stdio: "ignore",
});
const 정리 = () => { try { srv.kill(); } catch {} };
process.on("exit", 정리);
process.on("SIGINT", () => { 정리(); process.exit(1); });

for (let i = 0; i < 40; i++) {
  try { await fetch(`${BASE}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
}

const 임시 = join(tmpdir(), `intro-${process.pid}`);
mkdirSync(임시, { recursive: true });
let n = 0;
for (const s of SCENES) {
  n++;
  const widget = await 카드(s.tool, s.args);
  const html = join(임시, `${s.file}.html`);
  writeFileSync(html, 페이지(s.발화, widget));
  const png = join(OUT, `${s.file}.png`);
  const r = spawnSync(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars",
    "--default-background-color=FFFFFFFF",   // ⛔ 투명배경 금지(9/4 아린님 지적)
    "--force-device-scale-factor=1", "--window-size=960,960",
    `--screenshot=${png}`, `file://${html}`,
  ], { stdio: "ignore" });
  console.log(`${r.status === 0 ? "✅" : "❌"} ${n}/${SCENES.length}  ${s.file}  ← ${s.tool}`);
}
rmSync(임시, { recursive: true, force: true });
정리();
console.log(`\n완료 → ${OUT}`);
