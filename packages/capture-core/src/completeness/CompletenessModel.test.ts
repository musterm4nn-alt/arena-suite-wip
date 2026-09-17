import { describe, it, expect } from 'vitest';
import { CompletenessModel } from './CompletenessModel.js';

describe('CompletenessModel', () => {
  it('complete when positive terminal and no gap', () => {
    const state = CompletenessModel.evaluate({
      hasPositiveTerminal: true,
      hasObserverGap: false,
      hasStopSignal: false,
      hasTransportFailure: false,
      hasOnlyUiEvidence: false,
      isImported: false,
      byteLength: 100,
      gapIntervals: [],
    });
    expect(state).toBe('complete');
  });

  it('observer_gap when gap present', () => {
    const state = CompletenessModel.evaluate({
      hasPositiveTerminal: true,
      hasObserverGap: true,
      hasStopSignal: false,
      hasTransportFailure: false,
      hasOnlyUiEvidence: false,
      isImported: false,
      byteLength: 100,
      gapIntervals: [{ reason: 'overflow' }],
    });
    expect(state).toBe('observer_gap');
  });

  it('partial_stream when no terminal but content exists', () => {
    const state = CompletenessModel.evaluate({
      hasPositiveTerminal: false,
      hasObserverGap: false,
      hasStopSignal: false,
      hasTransportFailure: false,
      hasOnlyUiEvidence: false,
      isImported: false,
      byteLength: 50,
      gapIntervals: [],
    });
    expect(state).toBe('partial_stream');
  });

  it('can promote partial to complete', () => {
    expect(CompletenessModel.canPromote('partial_stream', 'complete')).toBe(true);
    expect(CompletenessModel.canPromote('complete', 'partial_stream')).toBe(false);
  });
});
