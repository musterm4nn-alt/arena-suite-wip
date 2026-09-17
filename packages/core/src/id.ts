import { randomBytes, randomUUID } from 'node:crypto';

/** Stable local UUID for accounts and every durable archive key (plan §5). Never derived from emails, names or page data. */
export function newAccountId(): string {
  return randomUUID();
}

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
