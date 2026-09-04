#!/usr/bin/env node
// 소개 이미지 5장이 카카오 공식 가이드(v1.1)를 지키는지 항목별로 기계 검사한다.
// 눈으로 보고 "괜찮은 것 같다"로 넘기지 않기 위해 만들었다 — 9/4에 세 번 지적받았다.
//   사용법:  node scripts/check-intro.mjs [폴더]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = resolve(process.argv[2] ?? "assets/kakao-tools-examples");

// 가이드 실측 기준값 (960×960)
const 기준 = {
  크기: 960,
  폰좌: 148, 폰상: 74, 폰폭: 664,
  목업색: [56, 56, 56],
  화면좌: 164, 화면우: 796,
  질문색: [24, 24, 24],     // #181818
  서비스색: [93, 93, 93],   // #5D5D5D
  링지름: 29,
  상단바: [144, 174],       // 잉크 y 범위
  말풍선1줄: [228, 300],    // pill y 범위(1줄)
  서비스명: [356, 385],
  답변상: 406,
};

// PNG를 RGBA 배열로 — 파이썬 PIL을 빌려 쓴다(의존성 추가 없이).
function 픽셀(path) {
  const r = spawnSync("python3", ["-c", `
from PIL import Image
import sys, numpy as np
im = Image.open(${JSON.stringify(path)}).convert('RGBA')
a = np.asarray(im)
sys.stdout.buffer.write(f"{im.size[0]} {im.size[1]}\\n".encode())
sys.stdout.buffer.write(a.tobytes())
sys.stdout.buffer.flush()
`], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const nl = r.stdout.indexOf(0x0a);
  const [w, h] = r.stdout.slice(0, nl).toString().trim().split(" ").map(Number);
  const buf = r.stdout.slice(nl + 1);
  const px = (x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]; };
  return { w, h, px, buf };
}

const 결과 = [];
const 확인 = (파일, 항목, 통과, 실제) => 결과.push({ 파일, 항목, 통과, 실제 });
const 근사 = (a, b, 허용 = 6) => a.every((v, i) => Math.abs(v - b[i]) <= 허용);
// 색상환 각도. 분홍(#F455C6)도 R>B라 R·B 비교로는 노랑과 구분되지 않는다.
function 색상각(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return -1;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
}

// 잉크(어두운 픽셀) y 구간 찾기
function 잉크세로(p, x0, x1, y0, y1, 임계 = 200) {
  const out = [];
  for (let y = y0; y < y1; y++) {
    let 있 = false;
    for (let x = x0; x < x1; x++) { const c = p.px(x, y); if (Math.min(c[0], c[1], c[2]) < 임계 && c[3] > 128) { 있 = true; break; } }
    out.push(있);
  }
  const i = out.indexOf(true), j = out.lastIndexOf(true);
  return i < 0 ? null : [y0 + i, y0 + j];
}

for (const f of readdirSync(DIR).filter((x) => x.endsWith(".png")).sort()) {
  const 이름 = basename(f, ".png");
  const path = join(DIR, f);
  const p = 픽셀(path);

  // ── 포맷 (가이드 p.2 · p.16)
  확인(이름, "① 960×960 1:1", p.w === 960 && p.h === 960, `${p.w}×${p.h}`);
  확인(이름, "② PNG", readFileSync(path).slice(1, 4).toString() === "PNG", "매직바이트");

  // ── 배경: 바깥은 투명, 폰 화면 안쪽은 불투명 (p.2 "배경은 반드시 투명하게")
  const 모서리 = [[0, 0], [959, 0], [0, 959], [959, 959], [10, 480], [949, 480]];
  확인(이름, "③ 바깥 투명", 모서리.every(([x, y]) => p.px(x, y)[3] === 0),
       모서리.map(([x, y]) => p.px(x, y)[3]).join(","));
  let 화면투명 = 0;
  for (let y = 92; y < 958; y += 3) for (let x = 165; x < 795; x += 3) if (p.px(x, y)[3] !== 255) 화면투명++;
  확인(이름, "④ 폰 화면 불투명", 화면투명 === 0, `투명 ${화면투명}점`);

  // ── 목업 (p.16 Don't: 목업 컬러 변경·제거·위치 조정 금지)
  확인(이름, "⑤ 목업 색 #383838", 근사(p.px(152, 500).slice(0, 3), 기준.목업색, 3),
       "#" + p.px(152, 500).slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join(""));
  let 좌 = -1, 우 = -1;
  for (let x = 0; x < 960; x++) { const c = p.px(x, 500); if (c[3] > 128 && c[0] < 100) { if (좌 < 0) 좌 = x; 우 = x; } }
  확인(이름, "⑥ 폰 좌표 148/664", 좌 === 기준.폰좌 && 우 - 좌 + 1 === 기준.폰폭, `좌${좌} 폭${우 - 좌 + 1}`);
  let 상 = -1;
  for (let y = 0; y < 960; y++) { const c = p.px(480, y); if (c[3] > 128) { 상 = y; break; } }
  확인(이름, "⑦ 폰 상단 74", 상 === 기준.폰상, `${상}`);

  // ── 질문 말풍선 (p.3 고정값 · p.4 줄수)
  const 말풍선 = 잉크세로(p, 300, 780, 200, 340, 250);
  const 줄수 = 말풍선 ? (말풍선[1] - 말풍선[0] > 90 ? 2 : 1) : 0;
  확인(이름, "⑧ 질문 2줄 이내", 줄수 >= 1 && 줄수 <= 2, `${줄수}줄`);
  // 질문 글자색 — 말풍선 안 가장 어두운 픽셀
  let 최암 = [255, 255, 255];
  for (let y = 240; y < 300; y++) for (let x = 300; x < 780; x++) {
    const c = p.px(x, y); if (c[0] + c[1] + c[2] < 최암[0] + 최암[1] + 최암[2]) 최암 = c.slice(0, 3);
  }
  확인(이름, "⑨ 질문 색 #181818", 근사(최암, 기준.질문색, 12),
       "#" + 최암.map((v) => v.toString(16).padStart(2, "0")).join(""));

  // ── 서비스명 (p.5 고정값 · p.6 블릿 유지)
  const 밀림 = (줄수 - 1) * 38;   // 2줄이면 서비스명·답변이 그만큼 내려간다
  const 서비스 = 잉크세로(p, 230, 700, 340 + 밀림, 400 + 밀림, 200);
  확인(이름, "⑩ 서비스명 y위치", 서비스 && Math.abs(서비스[0] - 359 - 밀림) <= 3, 서비스 ? 서비스.join("~") : "없음");
  let 서최암 = [255, 255, 255];
  for (let y = 355 + 밀림; y < 385 + 밀림; y++) for (let x = 230; x < 700; x++) {
    const c = p.px(x, y); if (c[0] + c[1] + c[2] < 서최암[0] + 서최암[1] + 서최암[2]) 서최암 = c.slice(0, 3);
  }
  확인(이름, "⑪ 서비스명 색 #5D5D5D", 근사(서최암, 기준.서비스색, 16),
       "#" + 서최암.map((v) => v.toString(16).padStart(2, "0")).join(""));
  // 링 — 지름 29 · 여러 색(단색이면 위반: p.6 "블릿을 임의로 변경")
  let rx0 = 999, rx1 = -1; const 색조 = new Set();
  for (let y = 352 + 밀림; y < 390 + 밀림; y++) for (let x = 170; x < 260; x++) {
    const c = p.px(x, y), 채도 = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
    if (채도 > 60) {
      rx0 = Math.min(rx0, x); rx1 = Math.max(rx1, x);
      const h = 색상각(c[0], c[1], c[2]);
      색조.add(h < 0 ? "무채" : h < 70 ? "노랑계" : h < 200 ? "초록계" : h < 280 ? "파랑계" : "분홍계");
    }
  }
  확인(이름, "⑫ 링 지름 29", rx1 - rx0 + 1 === 기준.링지름, `${rx1 - rx0 + 1}`);
  확인(이름, "⑬ 링 그라데이션", 색조.size >= 2, [...색조].join("+") || "없음");

  // ── 상단바 (템플릿 목업)
  const 바 = 잉크세로(p, 190, 790, 120, 200, 200);
  확인(이름, "⑭ 상단바 y위치", 바 && Math.abs(바[0] - 144) <= 4, 바 ? 바.join("~") : "없음");

  // ── 답변 영역 (p.13 Don't: 잘림·품질)
  const 답변 = 잉크세로(p, 170, 790, 395 + 밀림, 960, 235);
  const 예상 = 406 + 밀림;
  확인(이름, "⑮ 답변 시작 위치", 답변 && Math.abs(답변[0] - 예상) <= 12, 답변 ? `${답변[0]} (예상 ${예상})` : "없음");
  확인(이름, "⑯ 답변 채움 60%↑", 답변 && (답변[1] - 405 - 밀림) / (554 - 밀림) > 0.6,
       답변 ? `${(((답변[1] - 405 - 밀림) / (554 - 밀림)) * 100).toFixed(0)}%` : "0%");
}

// ── 출력
const 파일들 = [...new Set(결과.map((r) => r.파일))];
const 항목들 = [...new Set(결과.map((r) => r.항목))];
let 전부 = true;
for (const 항목 of 항목들) {
  const 줄 = 파일들.map((f) => {
    const r = 결과.find((x) => x.파일 === f && x.항목 === 항목);
    if (!r.통과) 전부 = false;
    return r.통과 ? "✅" : `❌(${r.실제})`;
  });
  console.log(`${항목.padEnd(22)} ${줄.join("  ")}`);
}
console.log("\n" + 파일들.map((f, i) => `  ${i + 1}. ${f}`).join("\n"));
console.log(전부 ? "\n✅ 전 항목 통과" : "\n❌ 실패 항목 있음");
process.exit(전부 ? 0 : 1);
