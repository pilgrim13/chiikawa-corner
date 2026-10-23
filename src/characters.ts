import type { CharacterId } from '../shared/protocol';

export const CHARACTERS: { id: CharacterId; name: string; note: string; color: string }[] = [
  { id: 'chiikawa', name: '치이카와', note: '조금 수줍은 작은 친구', color: '#ebc5c3' },
  { id: 'hachiware', name: '하치와레', note: '다정한 이야기 친구', color: '#c2dde4' },
  { id: 'usagi', name: '우사기', note: '가만있기 어려운 친구', color: '#eadb9e' },
  { id: 'momonga', name: '모몽가', note: '귀여움을 뽐내는 친구', color: '#d9d0e7' },
  { id: 'kurimanju', name: '쿠리만쥬', note: '느긋하게 쉬어가는 친구', color: '#d7c4aa' },
  { id: 'shisa', name: '시사', note: '작은 일에도 성실한 친구', color: '#ead8ad' },
  { id: 'rakko', name: '랏코', note: '든든하게 곁을 지키는 친구', color: '#d1c9b9' },
  { id: 'furuhonya', name: '후루혼야', note: '책과 친구를 좋아하는 친구', color: '#e7bac6' },
];
export const characterAsset = (id: CharacterId) => `${import.meta.env.BASE_URL}characters/${id}.png`;
export const characterSleepAsset = (id: CharacterId) => `${import.meta.env.BASE_URL}characters/${id}-sleep.png`;
export const characterName = (id: CharacterId) => CHARACTERS.find((c) => c.id === id)?.name || id;
