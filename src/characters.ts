import type { CharacterId } from '../shared/protocol';

export const CHARACTERS: { id: CharacterId; name: string; note: string; color: string }[] = [
  { id: 'chiikawa', name: '치이카와', note: '조금 수줍은 작은 친구', color: '#ebc5c3' },
  { id: 'hachiware', name: '하치와레', note: '다정한 이야기 친구', color: '#c2dde4' },
  { id: 'usagi', name: '우사기', note: '가만있기 어려운 친구', color: '#eadb9e' },
];
export const characterAsset = (id: CharacterId) => `${import.meta.env.BASE_URL}characters/${id}.png`;
export const characterName = (id: CharacterId) => CHARACTERS.find((c) => c.id === id)?.name || id;
