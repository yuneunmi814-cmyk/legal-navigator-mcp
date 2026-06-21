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
