import L from 'leaflet';
import { categoryFor } from '@/lib/categories';

const cache: Record<string, L.DivIcon> = {};

export function markerIcon(category: string, active = false): L.DivIcon {
  const key = `${category}-${active ? 'a' : 'n'}`;
  if (cache[key]) return cache[key];

  const meta = categoryFor(category);
  const scale = active ? 1.15 : 1;
  const size = 34 * scale;

  const html = `
    <div style="
      position: relative;
      width: ${size}px;
      height: ${size}px;
      transform: translate(-50%, -100%);
      filter: drop-shadow(0 4px 6px rgba(0,0,0,0.28));
    ">
      <svg viewBox="0 0 32 44" width="${size}" height="${size * 44 / 32}" xmlns="http://www.w3.org/2000/svg">
        <path d="M16 0C7.16 0 0 7.16 0 16c0 11 16 28 16 28s16-17 16-28C32 7.16 24.84 0 16 0z" fill="${meta.color}"/>
        <circle cx="16" cy="16" r="6.5" fill="#ffffff"/>
      </svg>
    </div>`;

  const icon = L.divIcon({
    html,
    className: 'place-marker',
    iconSize: [size, (size * 44) / 32],
    iconAnchor: [0, 0],
  });
  cache[key] = icon;
  return icon;
}
