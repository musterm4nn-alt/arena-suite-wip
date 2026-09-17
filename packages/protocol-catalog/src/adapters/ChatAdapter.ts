import { BaseAdapter, type AdapterContext, type AdapterResult } from './BaseAdapter.js';
import { createHash } from 'node:crypto';

/**
 * Example adapter for chat turns — demonstrates fail-closed sanitization and shape hashing
 * Real Arena traffic will include search+citations, code outputs, images, etc. per incremental roadmap
 */

export class ChatAdapter extends BaseAdapter {
  readonly id = 'chat_turn';
  readonly version = '1.0.0';
  readonly payloadFamily = 'chat';

  async parse(raw: unknown, ctx: AdapterContext): Promise<AdapterResult> {
    try {
      if (!raw || typeof raw !== 'object') {
        return { success: false, errorCode: 'INVALID_SHAPE', byteLength: 0 };
      }
      const obj = raw as Record<string, unknown>;
      // Unknown remains unknown — never guess model identity, endpoint semantics
      const text = typeof obj.text === 'string' ? obj.text : typeof obj.content === 'string' ? obj.content : null;
      if (!text) {
        return { success: false, errorCode: 'MISSING_TEXT', byteLength: JSON.stringify(raw).length };
      }

      const shapeHash = createHash('sha256').update(JSON.stringify(Object.keys(obj).sort())).digest('hex').slice(0, 16);

      return {
        success: true,
        normalized: {
          account_id: ctx.accountId,
          session_epoch_id: ctx.sessionEpochId,
          text,
          role: obj.role ?? 'unknown',
          observed_at: ctx.observedAt,
          operation_id: ctx.operationId,
        },
        byteLength: text.length,
        shapeHash,
      };
    } catch (e) {
      return {
        success: false,
        errorCode: 'PARSE_EXCEPTION',
        byteLength: JSON.stringify(raw).length,
      };
    }
  }
}
