// 도구 호출 디버그 로그 — 관리자 화면(/admin/logs)에서 최근 호출·에러·"주제 매칭 실패"를 본다.
//
// 이 서비스는 가정폭력·성폭력·스토킹·디지털성범죄·학교폭력 상담을 다룬다. triage의 situation처럼
// 사용자가 직접 쓴 문장이 인자로 들어오므로, 로깅을 "무엇을 남길지"가 아니라 "무엇을 안 남길지"로 설계한다.
//
//  1) 파일 기록 없음 — 메모리 링버퍼만. 재배포하면 사라지지만, 피해 사실이 적힌 문장이 디스크에
//     쌓이지 않는 쪽이 안전하다. 소실은 감수한다.
//  2) 정상 호출은 자유 텍스트를 아예 담지 않는다 — 도구명·소요시간·성공여부와 인자의 "키 이름만".
//     원인 파악이 실제로 필요한 건 매칭 실패 케이스이고, 성공한 호출은 값을 몰라도 충분히 디버깅된다.
//     "저장한 뒤 가린다"가 아니라 "애초에 담지 않는다" — 지시 기반 마스킹은 원문 처리를 막지 못한다.
//  3) 매칭 실패(no_match)일 때만 자유 텍스트를 담되, 담기 전에 주민번호·전화번호·이메일을 가리고
//     200자로 자른다.
//  4) 기본 꺼짐(DEBUG_LOG=on일 때만 수집). 심사·투표 기간엔 꺼 두면 수집도 조회도 일어나지 않는다.

export type LogEntry = {
  ts: string;
  tool: string;
  /** 인자의 키 이름만. 값은 담지 않는다. */
  argKeys: string[];
  ms: number;
  ok: boolean;
  error?: string;
  flag?: "no_match";
  /** 매칭 실패일 때만 채운다(마스킹·길이 제한 적용). */
  args?: Record<string, unknown>;
};

/** 링버퍼 크기 — 최근 것만 보면 되므로 넘치면 오래된 것부터 버린다. */
const MAX_ENTRIES = 500;
/** 자유 텍스트 저장 상한. server.ts의 MAX_FREE_TEXT와 같은 값(입력 처리 상한과 맞춘다). */
const MAX_TEXT = 200;

let 화면에서켬 = false;
/** 관리자 화면의 켜기/끄기. 서버 재시작 시 꺼진 상태로 돌아간다. */
export function setCollecting(on: boolean): void {
  화면에서켬 = on;
  if (!on) ring.length = 0; // 끄면 이미 모인 것도 지운다 — 꺼져 있는데 남아 있으면 안 된다.
}
/** 지금 수집 중인가 (환경변수 또는 화면 스위치). */
export function collectingBy(): "env" | "screen" | "off" {
  if (process.env.DEBUG_LOG === "on") return "env";
  return 화면에서켬 ? "screen" : "off";
}

const ring: LogEntry[] = [];

/** 기본 꺼짐. 호출 시점에 평가하므로 환경변수를 켜고 끄면 즉시 반영된다. */
export function debugLogEnabled(): boolean {
  // 환경변수를 못 쓰는 배포 환경이 있어(2026-08-24 PlayMCP in KC 확인) 관리자 화면에서도 켤 수 있게 한다.
  // 켠 상태는 메모리에만 있으므로 서버가 다시 뜨면 꺼진 상태로 돌아간다 — 켜둔 채 잊는 일이 없다.
  return process.env.DEBUG_LOG === "on" || 화면에서켬;
}

// 노출 위험이 가장 큰 식별자만 가린다. 완전 익명화는 아니지만("남편이 때려요"는 그대로 남는다)
// 실패 원인 파악에는 충분하고, 연락처·주민번호가 메모리에 뜨는 일은 막는다.
// 주민번호(13자리)를 먼저 처리해야 전화번호 규칙이 그 일부를 먼저 먹지 않는다.
function maskText(s: string): string {
  const masked = s
    .replace(/\d{6}\s*-\s*\d{7}|\b\d{13}\b/g, "[주민번호]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[이메일]")
    .replace(/\b0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, "[전화번호]");
  // 가린 뒤에 자른다 — 먼저 자르면 번호가 반쪽만 남아 가려지지 않는다.
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT)}…` : masked;
}

function maskValue(value: unknown): unknown {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskValue(v)]));
  }
  return value; // 숫자·불리언·null은 자유 텍스트가 아니다
}

function keysOf(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.keys(args as Record<string, unknown>);
}

export function logCall(entry: {
  tool: string;
  args: unknown;
  ms: number;
  ok: boolean;
  error?: string;
  flag?: "no_match";
}): void {
  if (!debugLogEnabled()) return; // 꺼져 있으면 수집 자체를 하지 않는다
  const full: LogEntry = {
    ts: new Date().toISOString(),
    tool: entry.tool,
    argKeys: keysOf(entry.args),
    ms: entry.ms,
    ok: entry.ok,
    error: entry.error ? maskText(entry.error) : undefined,
    flag: entry.flag,
    args: entry.flag === "no_match" ? (maskValue(entry.args) as Record<string, unknown>) : undefined,
  };
  ring.push(full);
  if (ring.length > MAX_ENTRIES) ring.shift();
}

/** 최신순. 꺼져 있으면 조회도 하지 않는다(빈 배열). */
export function recentLogs(n = 200): LogEntry[] {
  if (!debugLogEnabled()) return [];
  return ring.slice(-n).reverse();
}

/** 테스트용 — 링버퍼 비우기. */
export function clearLogs(): void {
  ring.length = 0;
}
