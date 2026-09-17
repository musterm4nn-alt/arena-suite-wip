import * as m001 from './001_initial.js';

export const all = [m001];

export type Migration = {
  id: string;
  description: string;
  sql: string;
};

export function getOrdered(): Migration[] {
  return all
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(m => ({ id: m.id, description: m.description, sql: m.sql }));
}
