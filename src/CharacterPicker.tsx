import { useLayoutEffect, useRef } from 'react';
import type { CharacterId } from '../shared/protocol';
import { CHARACTERS, characterAsset } from './characters';

export function CharacterPicker({ selected, onSelect }: { selected: CharacterId; onSelect: (character: CharacterId) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const current = CHARACTERS.find((character) => character.id === selected) || CHARACTERS[0];
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const button = viewport?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!viewport || !button) return;
    const bounds = viewport.getBoundingClientRect();
    const selection = button.getBoundingClientRect();
    // Restore a saved selection without scrolling the nickname or room controls away.
    if (selection.bottom > bounds.bottom) viewport.scrollTop += selection.bottom - bounds.bottom + 4;
    else if (selection.top < bounds.top) viewport.scrollTop -= bounds.top - selection.top + 4;
  }, [selected]);
  return <div className="profile-character-picker">
    <div className="character-picker-heading"><span>함께할 캐릭터</span><span>{CHARACTERS.length}명의 친구<span className="character-picker-scroll-hint"> · 위아래로 더 보기</span></span></div>
    <div className="character-picker-viewport" ref={viewportRef}>
      <div className="character-picker" role="group" aria-label="내 캐릭터 선택">
        {CHARACTERS.map((character) => <button key={character.id} type="button" data-character={character.id} className={`character-option ${selected === character.id ? 'selected' : ''}`} aria-label={`${character.name} ${character.note}`} aria-pressed={selected === character.id} title={character.note} onClick={() => onSelect(character.id)}>
          <img className="character-image" src={characterAsset(character.id)} alt="" />
          <span className="character-name">{character.name}</span>
        </button>)}
      </div>
    </div>
    <div className="character-selection" role="status" aria-live="polite"><i style={{ background: current.color }} aria-hidden="true" /><strong>{current.name}</strong><span>{current.note}</span></div>
  </div>;
}
