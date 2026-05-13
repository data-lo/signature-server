import { randomUUID } from 'crypto';

export function shortUuid(): string {
  return randomUUID().replace(/-/g, '').substring(0, 4).toUpperCase();
}
