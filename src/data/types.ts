// 공통 데이터 타입 — 모든 도메인이 공유.
// 형사는 뭉뚱그리지 않고 세분화: 형사절차·폭력협박·가정폭력·성폭력피해자·스토킹·디지털성범죄·명예훼손모욕.

export type Category =
  | "노동"
  | "주택임대차"
  | "돈거래"
  | "소비자"
  | "교통사고"
  | "민사절차"
  | "형사절차"
  | "폭력·협박"
  | "가정폭력"
  | "성폭력피해자"
  | "스토킹"
  | "디지털성범죄"
  | "명예훼손·모욕"
  | "가사·가족"
  | "상속"
  | "채무자구제"
  | "금융사기"
  | "학교폭력"
  | "산업재해"
  | "행정"
  | "의료분쟁"
  | "조세"
  | "계약"
  | "부동산매매"
  | "출입국"
  | "보험"
  | "지식재산"
  | "아동·노인학대"
  | "고용보험"
  | "공동주택"
  | "상가임대차"
  | "통신·개인정보"
  | "군·병역"
  | "선거"
  | "환경"
  | "반려동물"
  | "외국인·이주민"
  | "청소년·미성년"
  | "장애인"
  | "북한이탈주민"
  | "플랫폼·특수고용"
  | "국가유공자·보훈"
  | "복지·취약가구"
  | "농어업인"
  | "노인·고령"
  | "정신건강";

export interface Procedure {
  category: Category;
  제목: string;
  적용대상: string;
  근거법: string[];
  기한: string;
  관할기관: string;
  온라인접수: string;
  단계: string[];
  비고: string;
}

export interface Checklist {
  증거: string[];
  준비서류: string[];
}

export interface FormTemplate {
  제목: string;
  용도: string;
  본문: string;
  작성요령: string[];
  공식양식?: string; // 공식 표준서식(별지서식 등) 받는 곳. 있으면 응답 상단에 노출.
}

// 실재가 검증된 판례만 수록(사건번호 확인). 검증 못한 것은 절대 넣지 않음.
export interface Precedent {
  법원: string;
  사건번호: string;
  요지: string;
}

export interface Statute {
  법령: string;
  조문: string;
  요지: string;
}
