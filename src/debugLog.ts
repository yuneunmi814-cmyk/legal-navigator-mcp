// 도구 호출 디버그 로그 — 관리자 화면(/admin/logs)에서 확인.
// 메모리 링버퍼가 1차 저장소(컨테이너 재시작 시 소실 감수), 파일 기록은 best-effort 보조.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LogEntry = {
  ts: string;
  tool: string;
  args: unknown;
  ms: number;
  ok: boolean;
  error?: string;
  flag?: "no_match";
};

const LOG_DIR = process.env.LOG_DIR || "logs";
const LOG_FILE = path.join(LOG_DIR, "requests.jsonl");
const MAX_ENTRIES = 500;

const ring: LogEntry[] = [];

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
  const full: LogEntry = { ts: new Date().toISOString(), ...entry, args: redact(entry.args) };
  ring.push(full);
  if (ring.length > MAX_ENTRIES) ring.shift();
  // 파일 쓰기는 실패해도 무시(읽기전용 파일시스템 등) — 메모리 로그만으로도 /admin/logs는 동작.
  mkdir(LOG_DIR, { recursive: true })
    .then(() => appendFile(LOG_FILE, JSON.stringify(full) + "\n"))
    .catch(() => {});
}

export function recentLogs(n = 200): LogEntry[] {
  return ring.slice(-n).reverse();
}
