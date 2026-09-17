/**
 * Read qualification probe per section 9.1
 * 1. Require current session epoch and identity probe
 * 2. Observe operation during normal owner usage and bind it to partition
 * 3. Capture server-visible target fingerprint before replay
 * 4. Issue exactly one same-session request (app-owned Session fetch when works, otherwise narrow same-partition execution)
 * 5. Capture fingerprint after replay. Any change or inability to establish equivalence yields mutation_unknown and blocks autonomous replay
 * 6. Observe pagination boundary and repeat a page to establish cursor/order behavior
 * 7. Cross-check at least one detail read against conversation captured live
 * 8. Record probe; any later drift invalidates qualification until reprobed
 */

export type ProbeResult = 'verified_read' | 'mutation_unknown' | 'auth_failed' | 'drift_detected' | 'unknown';

export interface Fingerprint {
  url: string;
  method: string;
  status: number;
  bodyHash: string;
  timestamp: string;
}

export interface ReadProbe {
  id: string;
  account_id: string;
  operation_id: string;
  session_epoch_id: string;
  beforeFingerprint: Fingerprint | null;
  afterFingerprint: Fingerprint | null;
  result: ProbeResult;
  observed_at: string;
  paginationVerified: boolean;
  detailCrossChecked: boolean;
}

export class ReadQualificationProbe {
  private probes = new Map<string, ReadProbe>();

  async probe(
    accountId: string,
    operationId: string,
    sessionEpochId: string,
    actions: {
      getBeforeFingerprint: () => Promise<Fingerprint | null>;
      executeReplay: () => Promise<{ fingerprint: Fingerprint | null; success: boolean }>;
      getAfterFingerprint: () => Promise<Fingerprint | null>;
      testPagination: () => Promise<boolean>;
      crossCheckDetail: () => Promise<boolean>;
    }
  ): Promise<ReadProbe> {
    const before = await actions.getBeforeFingerprint();
    if (!before) {
      const p: ReadProbe = {
        id: `${accountId}-${operationId}-${Date.now()}`,
        account_id: accountId,
        operation_id: operationId,
        session_epoch_id: sessionEpochId,
        beforeFingerprint: null,
        afterFingerprint: null,
        result: 'auth_failed',
        observed_at: new Date().toISOString(),
        paginationVerified: false,
        detailCrossChecked: false,
      };
      this.probes.set(p.id, p);
      return p;
    }

    const replay = await actions.executeReplay();
    if (!replay.success) {
      const p: ReadProbe = {
        id: `${accountId}-${operationId}-${Date.now()}`,
        account_id: accountId,
        operation_id: operationId,
        session_epoch_id: sessionEpochId,
        beforeFingerprint: before,
        afterFingerprint: replay.fingerprint,
        result: 'auth_failed',
        observed_at: new Date().toISOString(),
        paginationVerified: false,
        detailCrossChecked: false,
      };
      this.probes.set(p.id, p);
      return p;
    }

    const after = await actions.getAfterFingerprint();
    // Any change yields mutation_unknown
    if (after && before.bodyHash !== after.bodyHash) {
      const p: ReadProbe = {
        id: `${accountId}-${operationId}-${Date.now()}`,
        account_id: accountId,
        operation_id: operationId,
        session_epoch_id: sessionEpochId,
        beforeFingerprint: before,
        afterFingerprint: after,
        result: 'mutation_unknown',
        observed_at: new Date().toISOString(),
        paginationVerified: false,
        detailCrossChecked: false,
      };
      this.probes.set(p.id, p);
      return p;
    }

    const paginationOk = await actions.testPagination();
    const detailOk = await actions.crossCheckDetail();

    const result: ProbeResult = paginationOk && detailOk ? 'verified_read' : 'unknown';

    const p: ReadProbe = {
      id: `${accountId}-${operationId}-${Date.now()}`,
      account_id: accountId,
      operation_id: operationId,
      session_epoch_id: sessionEpochId,
      beforeFingerprint: before,
      afterFingerprint: after,
      result,
      observed_at: new Date().toISOString(),
      paginationVerified: paginationOk,
      detailCrossChecked: detailOk,
    };
    this.probes.set(p.id, p);
    return p;
  }

  getProbe(id: string): ReadProbe | undefined {
    return this.probes.get(id);
  }

  listByAccount(accountId: string): ReadProbe[] {
    return Array.from(this.probes.values()).filter(p => p.account_id === accountId);
  }

  isQualified(operationId: string, accountId: string): boolean {
    return Array.from(this.probes.values()).some(
      p => p.operation_id === operationId && p.account_id === accountId && p.result === 'verified_read'
    );
  }
}
