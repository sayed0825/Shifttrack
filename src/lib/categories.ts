import type { LucideIcon } from 'lucide-react';
import { Utensils, Trees, Landmark, ShoppingBag, Bed, MapPin } from 'lucide-react';

export type CategoryKey =
  | 'Food'
  | 'Nature'
  | 'Culture'
  | 'Shopping'
  | 'Stay'
  | 'General';

export type CategoryMeta = {
  key: CategoryKey;
  label: string;
  color: string;
  icon: LucideIcon;
};

export const CATEGORIES: CategoryMeta[] = [
  { key: 'Food', label: 'Food & Drink', color: '#e11d48', icon: Utensils },
  { key: 'Nature', label: 'Nature', color: '#16a34a', icon: Trees },
  { key: 'Culture', label: 'Culture', color: '#2563eb', icon: Landmark },
  { key: 'Shopping', label: 'Shopping', color: '#d97706', icon: ShoppingBag },
  { key: 'Stay', label: 'Stay', color: '#0d9488', icon: Bed },
  { key: 'General', label: 'General', color: '#64748b', icon: MapPin },
];

export const CATEGORY_MAP: Record<string, CategoryMeta> = CATEGORIES.reduce(
  (acc, c) => {
    acc[c.key] = c;
    return acc;
  },
  {} as Record<string, CategoryMeta>
);

export function categoryFor(key: string): CategoryMeta {
  return CATEGORY_MAP[key] ?? CATEGORY_MAP.General;
}
