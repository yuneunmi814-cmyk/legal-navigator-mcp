// 도구 호출 디버그 로그 — 관리자 화면(/admin/logs)에서 확인.
// 메모리 링버퍼만 씀(파일 기록 없음) — 컨테이너 재시작 시 소실되지만, 이 서비스가 다루는 사안
// (가정폭력·성폭행·스토킹 등)을 감안하면 디스크에 누적되지 않는 편이 안전하다(2026-08-24 PR 리뷰 반영).
// 자유 텍스트(situation 등)는 원인 파악이 실제로 필요한 '주제 매칭 실패' 케이스에서만 남긴다 —
// 성공한 호출은 어떤 문장이었는지 몰라도 도구명·소요시간·성공 여부만으로 충분히 디버깅된다.
export type LogEntry = {
  ts: string;
  tool: string;
  args?: unknown; // no_match일 때만 채움
  ms: number;
  ok: boolean;
  error?: string;
  flag?: "no_match";
};

const MAX_ENTRIES = 500;
const ring: LogEntry[] = [];

// 기본 꺼짐(프로덕션 안전) — 검토·평가 기간처럼 필요할 때만 DEBUG_LOG=on으로 켠다.
const enabled = (): boolean => process.env.DEBUG_LOG === "on";

// 주민번호·전화번호·이메일만 마스킹 — 완전 익명화는 아니지만 원인 파악엔 충분하고
// 노출 위험이 큰 패턴만 걸러낸다(툴 설명에서도 원문 대신 요약 전달을 요청하지만, 강제는 안 됨).
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\d{6}-?\d{7}/g, "[주민번호]")
      .replace(/01[016789]-?\d{3,4}-?\d{4}/g, "[전화번호]")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[이메일]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export function logCall(entry: Omit<LogEntry, "ts" | "args"> & { args: unknown }): void {
  if (!enabled()) return;
  const full: LogEntry = {
    ts: new Date().toISOString(),
    tool: entry.tool,
    ms: entry.ms,
    ok: entry.ok,
    error: entry.error,
    flag: entry.flag,
    args: entry.flag === "no_match" ? redact(entry.args) : undefined,
  };
  ring.push(full);
  if (ring.length > MAX_ENTRIES) ring.shift();
}

export function recentLogs(n = 200): LogEntry[] {
  return ring.slice(-n).reverse();
}
