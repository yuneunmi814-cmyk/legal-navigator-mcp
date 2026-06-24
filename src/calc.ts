// 결정론적 금액 계산기. 추정치이며 정확한 산정은 평균임금·통상임금 정의에 따라 달라질 수 있음.

export interface CalcResult {
  결과: string;
  계산식: string;
  비고?: string;
}

function won(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

// 체불임금(개략) = 월정상임금 × 미지급월수 + 기타 미지급액
export function calcUnpaidWages(월정상임금: number, 미지급월수: number, 기타미지급액 = 0): CalcResult {
  const total = 월정상임금 * 미지급월수 + 기타미지급액;
  return {
    결과: won(total),
    계산식: `${won(월정상임금)} × ${미지급월수}개월 + ${won(기타미지급액)}(기타) = ${won(total)}`,
    비고: "수당·상여 등 누락분이 있으면 '기타 미지급액'에 더하세요.",
  };
}

// 퇴직금(개략) = 1일 평균임금 × 30 × (재직일수 / 365)
export function calcSeverance(일평균임금: number, 재직일수: number): CalcResult {
  const total = 일평균임금 * 30 * (재직일수 / 365);
  return {
    결과: won(total),
    계산식: `${won(일평균임금)} × 30일 × (${재직일수}일 ÷ 365) = ${won(total)}`,
    비고: "정확한 1일 평균임금은 퇴직 전 3개월 임금총액 ÷ 그 기간의 총일수로 산정합니다(여기서는 입력값 기준 추정).",
  };
}

// 주휴수당 = (주 소정근로시간 ÷ 40) × 8 × 시급, 단 1일분(8 × 시급) 상한
export function calcWeeklyHolidayPay(주소정근로시간: number, 시급: number): CalcResult {
  const raw = (주소정근로시간 / 40) * 8 * 시급;
  const cap = 8 * 시급;
  const total = Math.min(raw, cap);
  return {
    결과: won(total),
    계산식: `(${주소정근로시간}시간 ÷ 40) × 8시간 × ${won(시급)} = ${won(total)} (주 1회분)`,
    비고: "주 15시간 미만 근로자는 주휴수당 대상이 아닙니다. 위 금액은 1주분입니다.",
  };
}

// 지연이자 = 미지급액 × 0.20 × (지연일수 / 365)  — 퇴직 후 미지급 임금 기준(근로기준법 제37조)
export function calcDelayInterest(미지급액: number, 지연일수: number): CalcResult {
  const total = 미지급액 * 0.2 * (지연일수 / 365);
  return {
    결과: won(total),
    계산식: `${won(미지급액)} × 20% × (${지연일수}일 ÷ 365) = ${won(total)}`,
    비고: "근로기준법 제37조의 지연이자(연 20%)는 '퇴직한' 근로자의 미지급 임금·퇴직금에 적용됩니다. 재직 중 미지급분은 이율이 다릅니다.",
  };
}

// 민사 소송비용(인지대+송달료) 개략 — 인지법·송달료 예규(2025-06-01, 1회 5,500원) 기준.
const 송달료횟수: Record<string, number> = { 소액: 10, 단독: 15, 합의: 15, 항소: 12, 상고: 8, 지급명령: 6, 조정: 5, 보전: 3 };
export function calcCourtCost(소가: number, 당사자수: number, 절차: string, 전자소송: boolean): CalcResult {
  let 인지: number;
  if (소가 < 10_000_000) 인지 = 소가 * 0.005;
  else if (소가 < 100_000_000) 인지 = 소가 * 0.0045 + 5_000;
  else if (소가 < 1_000_000_000) 인지 = 소가 * 0.004 + 55_000;
  else 인지 = 소가 * 0.0035 + 555_000;
  const 배수 = 절차 === "항소" ? 1.5 : 절차 === "상고" ? 2 : 1;
  인지 *= 배수;
  if (전자소송) 인지 *= 0.9;
  인지 = Math.floor(Math.round(인지) / 100) * 100; // 원 단위 반올림 후 끝수 100원 절사(부동소수점 보정)
  if (인지 < 1000) 인지 = 1000; // 최소 인지액
  const 횟수 = 송달료횟수[절차] ?? 15;
  const 송달 = 당사자수 * 5500 * 횟수;
  const 합계 = 인지 + 송달;
  return {
    결과: `인지대 ${won(인지)} + 송달료 ${won(송달)} = 합계 ${won(합계)}`,
    계산식: `인지대: 소가 ${won(소가)} 구간식${배수 !== 1 ? ` ×${배수}(${절차})` : ""}${전자소송 ? " ×0.9(전자소송)" : ""} → ${won(인지)} / 송달료: 당사자 ${당사자수}명 × 5,500원 × ${횟수}회(${절차}) = ${won(송달)}`,
    비고: "개략값입니다. 소가 산정 방식·절차별 송달 횟수는 사건마다 달라질 수 있어 전자소송(ecfs.scourt.go.kr) 자동계산으로 확인하세요. 저소득·수급자는 법원 소송구조로 면제·유예가 가능합니다.",
  };
}

// 기한 계산 — 기준일에 기간을 더해 마감일·남은일수를 산출(날짜 산술).
export function calcDeadline(기준일: string, 기간: { 일?: number; 월?: number; 년?: number }): { 마감일: string; 남은일수: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(기준일.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const end = new Date(y, mo - 1, d);
  // JS Date는 불가능한 날짜(2026-02-31 등)를 조용히 다음 달로 롤오버하므로, 입력 그대로인지 검증.
  if (end.getFullYear() !== y || end.getMonth() !== mo - 1 || end.getDate() !== d) return null;
  if (기간.년) end.setFullYear(end.getFullYear() + 기간.년);
  if (기간.월) end.setMonth(end.getMonth() + 기간.월);
  if (기간.일) end.setDate(end.getDate() + 기간.일);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const 남은일수 = Math.round((end.getTime() - today.getTime()) / 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return { 마감일: `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`, 남은일수 };
}
