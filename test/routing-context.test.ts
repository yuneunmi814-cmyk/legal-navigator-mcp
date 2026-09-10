import { beforeAll, afterAll, expect, it } from 'vitest';
import { app } from '../src/server.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
let server: Server;
let base: string;
beforeAll(async () => { await new Promise<void>(resolve => { server = app.listen(0,resolve); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
it.each([
 ['상사가 성추행했어요', '성폭력신고고소'],
 ['상사가 육아휴직을 거부해요', '육아휴직급여출산휴가급여'],
 ['저도 받을 수 있는 복지 지원이 있나요', '긴급복지지원'],
 ['산재로 통원치료 받고 있어요', '산재요양급여신청'],
 ['병원 의료사고로 통원치료 중입니다', '의료사고대응증거확보'],
])('%s → %s', async (query, expected) => {
 const response = await fetch(`${base}/mcp`, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_topics',arguments:{query}}})});
 const result = await response.json();
 const text = result.result?.content?.[0]?.text ?? '';
 expect((text.match(/- `([^`]+)`/) ?? [])[1]).toBe(expected);
});

// 여러 분야에서 쓰는 표현만으로 주제를 단정하지 않는다.
it.each([
 ['통원치료 얼마나 받아야 하나요', /교통사고/],
 ['제 재산보다 채무가 더 많아요', /상속|한정승인/],
 ['저도 받을 지원금이 있나요', /상속/],
 ['계속 살고 싶어요', /계약갱신/],
 ['회사에서 급여를 2년 더 안 줘요', /계약갱신/],
 ['아버지 혼자 모시고 살고 있는데 돌봄 지원이 있나요', /상속/],
])('문맥 없는 표현: %s', async (query, excluded) => {
 const response = await fetch(`${base}/mcp`, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_topics',arguments:{query}}})});
 const result = await response.json();
 const text = result.result?.content?.[0]?.text ?? '';
 const topics = [...text.matchAll(/- `([^`]+)`/g)].map(m => m[1]);
 expect(topics.some(topic => excluded.test(topic))).toBe(false);
});

it.each([
 ['회사에서 급여를 안 줘요 2년 더 기다리래요', '임금체불'],
 ['부장이 폭언을 해요', '직장내괴롭힘'],
 ['팀장이 계속 괴롭히는데', '직장내괴롭힘'],
 ['교통사고 손해배상 청구에 통원치료 비용도 포함되나요', '교통사고손해배상청구'],
 ['유산을 저도 받을 수 있나요', '상속재산분할협의'],
])('문맥을 갖춘 표현: %s', async (query, expected) => {
 const response = await fetch(`${base}/mcp`, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_topics',arguments:{query}}})});
 const result = await response.json();
 expect((result.result?.content?.[0]?.text?.match(/- `([^`]+)`/) ?? [])[1]).toBe(expected);
});
