// 공통 데이터 타입 — 모든 도메인(노동·주택임대차·돈거래·소비자·교통사고·형사·민사절차)이 공유.

export type Category =
  | "노동"
  | "주택임대차"
  | "돈거래"
  | "소비자"
  | "교통사고"
  | "형사"
  | "민사절차";

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
