import type { Idea } from './model';
import './palette.css';

const brushMarks = [
  'M4 10C5 6 10 5 17 5L46 4C52 4 56 7 55 12L54 25C54 30 50 32 45 31L12 32C6 32 3 29 3 24Z',
  'M4 10C4 6 9 4 14 5L48 5C54 5 56 8 55 13L56 24C55 30 52 31 46 31L12 32C7 33 3 29 4 24Z',
  'M3 12C3 8 7 6 13 5L46 4C51 4 56 7 56 12L55 24C55 29 51 32 46 32L12 31C7 31 3 28 4 24Z',
];

function paletteColors(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const hex = typeof item === 'string' ? item.trim() : '';
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? [hex] : [];
  });
}

export function PaletteCard({ idea }: { idea: Idea }) {
  const colors = paletteColors(idea.palette);
  return <figure className="candidate-palette" aria-label="选题配色">
    <figcaption className="candidate-palette-title">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14.4 3.5c4.3.6 7.2 3.8 6.6 7.3-.4 2.4-2.3 3.4-4.5 2.9-2-.4-3.6 1-3 2.9.5 1.6-.6 3.4-2.8 3.6-4.6.4-8.1-3.2-8-7.9.1-5.3 5.4-9.5 11.7-8.8Z"/>
        <path d="m6.7 12.1.3.4m2.4-4.6.2.4m3.5-1.7.3.5m3.3 1.6.2.4"/>
      </svg>
      <span>配色小样</span>
      {colors.length > 0 && <span className="candidate-palette-count">{colors.length} 色</span>}
    </figcaption>
    {colors.length ? <ul className="candidate-palette-swatches" role="list" aria-label="已保存色值">
      {colors.map((hex, index) => <li key={`${hex}-${index}`}>
        <svg viewBox="0 0 59 36" aria-hidden="true">
          <path d={brushMarks[index % brushMarks.length]} fill={hex} stroke="#4f5c4e" strokeWidth="1" strokeOpacity=".65" strokeLinejoin="round"/>
          <path d="M9 12c1.7-2 4-2.5 8-2.7" fill="none" stroke="#fff" strokeWidth="1.5" strokeOpacity=".65" strokeLinecap="round"/>
        </svg>
        <span>{hex}</span>
      </li>)}
    </ul> : <div className="candidate-palette-empty">
      <span>暂无可展示的色值</span>
      {idea.art_direction && <p>{idea.art_direction}</p>}
    </div>}
  </figure>;
}
