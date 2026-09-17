import { describe, it, expect } from 'vitest';
import { StreamAssemblyLedger } from './StreamAssemblyLedger.js';

describe('StreamAssemblyLedger', () => {
  it('assembles UTF-8 split at every boundary', () => {
    const text = 'Hello 🌍 world — café 🎉';
    const chunks = StreamAssemblyLedger.splitAtUtf8Boundaries(text);
    const ledger = new StreamAssemblyLedger();
    ledger.createRecord('req-1', 'acc-1', {});
    chunks.forEach((c, i) => ledger.appendChunk('req-1', c, i));
    ledger.markTransportTerminal('req-1', 'finished');
    const assembled = ledger.assemble('req-1');
    expect(assembled?.text).toBe(text);
  });

  it('counts duplicate but not appends twice', () => {
    const ledger = new StreamAssemblyLedger();
    ledger.createRecord('req-2', 'acc-1', {});
    const data = new TextEncoder().encode('hello');
    ledger.appendChunk('req-2', data, 0);
    const dup = ledger.appendChunk('req-2', data, 0);
    expect(dup.duplicate).toBe(true);
    const rec = ledger.getRecord('req-2')!;
    expect(rec.duplicateCount).toBe(1);
    expect(rec.totalBytes).toBe(5);
  });
});
