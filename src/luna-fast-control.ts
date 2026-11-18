import { timingSafeEqual } from 'node:crypto';

export const LUNA_FAST_CREATOR = '821682594830614578';
export type LunaFastMode = 'enable' | 'disable' | 'status';
export type ServiceTier = 'default' | 'fast';

export function lunaFastMode(value: unknown): value is LunaFastMode {
  return value === 'enable' || value === 'disable' || value === 'status';
}

export function canControlLunaFast(configured: string, presented: string): boolean {
  if (configured.length < 32) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
