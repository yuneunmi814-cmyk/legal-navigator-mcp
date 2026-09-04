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
// 고른 기준 둘.
//  ① 카드 종류가 겹치지 않을 것 — 8/31판은 5장 중 3장이 같은 '빠른 진단' 카드였다.
//  ② 답변 영역(554px)을 채울 것 — 절반만 찬 화면은 '내용이 모자란' 인상을 준다.
//     실측 채움률: 진단 100% · 계산기 61% · 체크리스트 100% · 서식 94% · 전화 90%.
//     계산기만 짧은데, 큰 금액이 한눈에 박히는 카드라 자리를 지킨다.
//     (기한 D-day 카드는 69%에 그쳐 체크리스트에 자리를 내줬다.)
// 순서는 이용자 여정: 내 상황 → 얼마 → 뭘 준비 → 서류 작성 → 도움 받기.
const SCENES = [
  {
    file: "01_오인미만해고",
    발화: "직원이 나 포함 세 명인데 갑자기 나오지 말래요",
    tool: "triage",
    args: { situation: "직원이 나 포함 세 명인데 갑자기 나오지 말래요" },
  },
  {
    // 발화는 사람 말 그대로 두고, 도구에는 모델이 환산해 넘기는 값을 넣는다.
    // (1일 평균임금 = 월 300만 × 3개월 ÷ 91일 ≈ 98,901원 · 3년 = 1,095일)
    file: "02_퇴직금계산",
    발화: "3년 일했고 월급 300만원인데 퇴직금 얼마예요?",
    tool: "calculate_amount",
    args: { item: "퇴직금", daily_avg_wage: 98901, tenure_days: 1095 },
  },
  {
    file: "03_준비서류",
    발화: "임금체불 신고하려면 뭘 준비해야 해요?",
    tool: "get_checklist",
    args: { topic: "임금체불" },
  },
  {
    file: "04_서식카드",
    발화: "임금체불 진정서 양식 보여줘",
    tool: "get_form_template",
    args: { form: "임금체불진정서" },
  },
  {
    file: "05_전화바로걸기",
    발화: "변호사 살 돈이 없어요",
    tool: "find_legal_aid",
    args: { keyword: "무료변호사" },
  },
];

// ── 템플릿 실측값 (960×960) ──────────────────────────────────────────────────
// 공식 가이드 `KakaoTools_서비스소개이미지제작가이드v1.1.pdf`의 제작 예시(p.15)와
// 템플릿 도해(p.2)를 300dpi로 렌더해 픽셀로 쟀다. 눈대중이 아니다.
//   폰 바깥폭 664.4 · 좌여백 148.0 · 우여백 147.6 · 상여백 72.9 · 프레임 16.5
//   화면 안쪽 좌 164.2 · 폭 631.7
//   상단바 텍스트 y 144.8~173.8 / 말풍선 텍스트 y 253.2~276.0
//   서비스명 y 357.0~383.4 / 답변 영역 y 406~960(아래로 흘러 나감)
// ⛔ 가이드 p.16 Don't: "위치를 임의로 조정하지 않습니다" — 이 값들을 흔들지 말 것.
//    9/4 1차판은 카드 길이에 맞춰 폰을 1.22배까지 키우고 위아래로 옮겼다가
//    "비율이 조금 확대되어 나온다"는 지적을 받았다(아린님).
const T = {
  폰좌: 148, 폰상: 74, 폰폭: 664, 프레임: 16.5, 라운드: 49,
  // ⛔ 가이드 p.16 "목업 컬러는 임의로 변경하지 않습니다" — 실측 #383838. 순검정 아니다.
  목업색: "#383838",
  화면좌: 164.2, 화면폭: 631.7,
  상단바중심: 159, 말풍선중심: 264.5, 서비스명중심: 370, 답변상: 406,
  // 가이드가 못박은 값 — 변경 금지(p.3, p.5)
  질문폰트: 27, 질문색: "#181818",
  서비스폰트: 24, 서비스색: "#5D5D5D",
};
// 답변 이미지는 "width 393px · zoom 100% · DPR 2.0"으로 캡처해 넣도록 되어 있다(p.9).
// 즉 393px 폭으로 그린 화면이 631.7px 자리에 들어간다 → 이 배율로 키운다.
T.화면상 = T.폰상 + T.프레임;               // 화면 안쪽 위 = 90.5
// 1줄 말풍선 기준으로 실측 좌표(상단바 159 · 말풍선 264.5 · 서비스명 370)에 맞춘 간격
const 간격 = 52.6;
const 답변배율 = T.화면폭 / 393;

const C = {
  잉크: "#191F28",
  본문: "#333D4B",
  흐림: "#8B95A1",
  선: "#EDEFF2",
  카드선: "#E5E8EB",
  연회색: "#F2F4F6",
  말풍선: "#F4F4F4",   // 가이드 예시에서 실측
  파랑배경: "#E8F0FE",
  파랑글자: "#2563EB",
  버튼: "#1B2028",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── 위젯 JSON → HTML ────────────────────────────────────────────────────────
// 크기는 전부 '393px 폭 휴대폰' 기준이다. 위에서 답변배율로 한 번에 키운다.
function 컴포넌트(c) {
  switch (c.type) {
    case "Title": {
      const px = c.size === "lg" ? 19 : c.size === "sm" ? 13.5 : 16;
      return `<div class="t" style="font-size:${px}px">${esc(c.value)}</div>`;
    }
    case "Caption":
      return `<div class="cap">${esc(c.value)}</div>`;
    case "Text":
      return `<div class="tx${c.italic ? " it" : ""}" style="font-size:${
        c.size === "sm" ? 12 : 13
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
      return `<div class="row" style="gap:${(c.gap ?? 8) / 2}px">${c.children.map(컴포넌트).join("")}</div>`;
    case "Col":
      return `<div class="col" style="gap:${(c.gap ?? 8) / 2}px">${c.children.map(컴포넌트).join("")}</div>`;
    case "ListViewItem":
      return `<div class="lvi"><div class="tx">${esc(c.title ?? "")}</div>${
        c.description ? `<div class="cap">${esc(c.description)}</div>` : ""
      }</div>`;
    case "ListView":
      return `<div class="col" style="gap:9px">${(c.children ?? []).map(컴포넌트).join("")}</div>`;
    default:
      return "";
  }
}

// 상단바 우측 아이콘 — 이모지 글리프는 헤드리스 크롬에서 깨져 SVG로 그린다
const 아이콘 = [
  `<svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="#4E5968" stroke-width="1.7"
     stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>
     <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  `<svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="#4E5968" stroke-width="1.7"
     stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  `<svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="#4E5968" stroke-width="1.7"
     stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
].join("");

function 페이지(발화, widget) {
  const 본문 = (widget.children ?? []).map(컴포넌트).join("");
  return `<meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  /* ⛔ 캔버스 바깥은 투명이어야 한다(가이드 p.2 "배경은 반드시 투명하게").
     카카오 상세화면이 라이트/다크에 맞춰 자기 배경을 깔고 그 위에 이 그림을 얹는다.
     흰색으로 칠하면 좌우 여백이 흰 판때기로 떠 보인다 — 9/4 19:08 아린님 3차 지적.
     반대로 폰 '화면 안쪽'은 흰 불투명이어야 한다. 8/31 원본은 여기가 투명이라
     어두운 화면에서 검게 비쳤고 그게 1차 지적이었다. 둘은 다른 자리다. */
  body{width:960px;height:960px;background:transparent;overflow:hidden;
       font-family:Pretendard,"Apple SD Gothic Neo",-apple-system,sans-serif;
       -webkit-font-smoothing:antialiased}
  /* ── 템플릿 고정 좌표. 카드 길이에 따라 움직이지 않는다 ── */
  .phone{position:absolute;left:${T.폰좌}px;top:${T.폰상}px;width:${T.폰폭}px;height:1180px;
         background:${T.목업색};border-radius:${T.라운드}px;padding:${T.프레임}px}
  .screen{width:100%;height:100%;background:#fff;display:flex;flex-direction:column;
          border-radius:${T.라운드 - T.프레임}px;overflow:hidden;position:relative}
  /* 흐름 배치 — 1줄 말풍선일 때 실측 좌표에 정확히 떨어지고,
     2줄이면 아래가 밀린다(가이드 p.4: "질문 텍스트가 길어질수록 답변 영역이 좁아지므로"). */
  .bar{display:flex;align-items:center;gap:13px;height:34px;
       margin:${T.상단바중심 - T.화면상 - 17}px 20px 0}
  .x{font-size:28px;color:${C.잉크};font-weight:300}
  .gpt{font-size:27px;font-weight:700;color:${C.잉크};letter-spacing:-.4px}
  .fk{font-size:26px;color:#9AA3AD;letter-spacing:-.3px}
  .icons{margin-left:auto;display:flex;gap:19px;align-items:center}
  /* 질문 말풍선 — 폰트·크기·색은 가이드 고정값(p.3). 절대 바꾸지 말 것. */
  .me{display:flex;justify-content:flex-end;margin:${간격}px 16px 0}
  .me span{background:${C.말풍선};border-radius:24px;padding:17px 24px;
           font-size:${T.질문폰트}px;font-weight:400;color:${T.질문색};
           line-height:1.4;letter-spacing:-.3px;max-width:540px}
  /* 서비스명 — 폰트·크기·색은 가이드 고정값(p.5). 절대 바꾸지 말 것. */
  .who{display:flex;align-items:center;gap:10px;height:34px;margin:${간격}px 20px 0;
       font-size:${T.서비스폰트}px;font-weight:500;color:${T.서비스색};letter-spacing:-.3px}
  .ring{width:16px;height:16px;border-radius:50%;border:4px solid #FF4E24;flex:none}
  /* 답변 영역 — 393px 폭으로 그려 ${답변배율.toFixed(4)}배로 키운다(가이드 p.9 캡처 규격) */
  .ans{flex:1;margin-top:19px;overflow:hidden}
  .ans-in{width:393px;transform:scale(${답변배율});transform-origin:top left}
  .card{margin:0 10px;border:1px solid ${C.카드선};border-radius:14px;padding:16px 15px;
        display:flex;flex-direction:column;gap:7px}
  .t{font-weight:700;color:${C.잉크};letter-spacing:-.4px;line-height:1.34}
  .cap{font-size:10.5px;color:${C.흐림};letter-spacing:-.2px;line-height:1.5}
  .tx{color:${C.본문};letter-spacing:-.2px;line-height:1.55}
  .it{font-style:italic}
  .bg{display:inline-block;font-size:10px;font-weight:600;border-radius:999px;
      padding:4px 9px;letter-spacing:-.2px}
  .div{height:1px;background:${C.선};margin:2px 0}
  .row{display:flex;align-items:center;flex-wrap:wrap}
  .col{display:flex;flex-direction:column}
  .lvi{display:flex;flex-direction:column;gap:3px}
  .btn{border-radius:9px;height:39px;display:flex;align-items:center;
       justify-content:center;font-size:12.5px;font-weight:700;letter-spacing:-.3px}
  .btn.p{background:${C.버튼};color:#fff}
  .btn.s{background:${C.연회색};color:${C.잉크}}
</style>
<div class="phone"><div class="screen">
  <div class="bar"><span class="x">✕</span><span class="gpt">ChatGPT</span>
    <span class="fk">for Kakao</span><span class="icons">${아이콘}</span></div>
  <div class="me"><span>${esc(발화)}</span></div>
  <div class="who"><span class="ring"></span>Kakao Tools · 법률 절차 길잡이</div>
  <div class="ans"><div class="ans-in"><div class="card">${본문}</div></div></div>
</div></div>`;
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
    "--default-background-color=00000000",   // 바깥은 투명 — 위 주석 참조
    "--force-device-scale-factor=1", "--window-size=960,960",
    `--screenshot=${png}`, `file://${html}`,
  ], { stdio: "ignore" });
  console.log(`${r.status === 0 ? "✅" : "❌"} ${n}/${SCENES.length}  ${s.file}  ← ${s.tool}`);
}
rmSync(임시, { recursive: true, force: true });
정리();
console.log(`\n완료 → ${OUT}`);
