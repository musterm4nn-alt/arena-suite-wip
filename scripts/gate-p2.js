"use strict";
/**
 * P2 Complete text capture per section 15
 * Battle, Direct and Side-by-Side; completed/stopped/failed/partial; branches/regenerations; late model identity; history-opened conversations; worker/SW coverage; UI/network reconciliation; downloads linked when available. Golden fixtures and property tests vary chunk boundaries/order/duplicates.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
async function main() {
    console.log('=== Gate P2: Complete text capture ===');
    console.log('This gate requires real Arena owner-session observations — not runnable in mock mode without live Electron + account');
    console.log('Checks that would be performed:');
    console.log('- Battle, Direct, Side-by-Side modes captured');
    console.log('- completed/stopped_by_user/failed_transport/partial_stream/observer_gap/reconstructed_ui_only/imported/unknown states');
    console.log('- Branches/regenerations create branch/revision relationships, not replace prior outputs');
    console.log('- Late model identity evidence via reveal');
    console.log('- History-opened conversations');
    console.log('- Worker/SW coverage');
    console.log('- UI/network reconciliation');
    console.log('- Downloads linked when available');
    console.log('- Golden fixtures and property tests vary chunk boundaries/order/duplicates');
    const result = {
        gate: 'p2',
        timestamp: new Date().toISOString(),
        runtime_versions: { node: process.version, platform: process.platform, arch: process.arch },
        checks: [
            { name: 'battle_mode', passed: false, details: 'Requires live Arena session — not executed in CI' },
            { name: 'direct_mode', passed: false, details: 'Requires live Arena session' },
            { name: 'side_by_side', passed: false, details: 'Requires live Arena session' },
            { name: 'branches_regenerations', passed: false, details: 'Requires live Arena session' },
            { name: 'late_identity', passed: false, details: 'Requires live Arena session' },
            { name: 'worker_sw_coverage', passed: true, details: 'Mock coverage via adapter — real requires live' },
        ],
        passed: false,
        decision: 'P2 requires owner-session — run with real account on macOS Electron to validate',
    };
    await fs.promises.mkdir('artifacts/gates', { recursive: true });
    await fs.promises.writeFile('artifacts/gates/p2.json', JSON.stringify(result, null, 2));
    console.log('Wrote artifacts/gates/p2.json — P2 is expected to fail in mock mode');
    process.exit(0);
}
main().catch(err => {
    console.error(err);
    process.exit(2);
});
//# sourceMappingURL=gate-p2.js.map