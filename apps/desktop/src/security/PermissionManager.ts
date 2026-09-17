/**
 * Permission/Nav — no remote app privileges (section 4)
 * Diagnostics GUI: local app origin, strict CSP, narrow context bridge
 * Arena renderers: sandbox:true, contextIsolation:true, nodeIntegration:false, no application preload API
 */

export type Permission = 'media' | 'geolocation' | 'notifications' | 'fullscreen' | 'openExternal' | 'unknown';

export class PermissionManager {
  private allowedOrigins = new Set(['https://arena.ai', 'https://lmarena.ai']);

  checkPermission(origin: string, permission: Permission): boolean {
    // No remote app privileges — deny everything except explicitly allowed
    if (permission === 'openExternal') {
      // Only allow if user gesture and not automatic
      return false;
    }
    if (permission === 'media' || permission === 'geolocation' || permission === 'notifications') {
      // Deny by default for Arena — owner-driven inside view, but no extra privileges
      return false;
    }
    return false;
  }

  checkNavigation(url: string, accountId: string): { allowed: boolean; reason?: string } {
    try {
      const u = new URL(url);
      // Allow Arena primary and auth flows (Google auth for sign-in)
      if (u.host.endsWith('arena.ai') || u.host.endsWith('lmarena.ai')) {
        return { allowed: true };
      }
      if (u.host.endsWith('google.com') || u.host.endsWith('googleapis.com') || u.host.endsWith('gstatic.com')) {
        // Popups required by flow remain in same partition — allow auth
        return { allowed: true };
      }
      // Block everything else — no remote app privileges
      return { allowed: false, reason: `Navigation to ${u.host} blocked — not Arena or auth` };
    } catch {
      return { allowed: false, reason: 'Invalid URL' };
    }
  }

  getCsp(): string {
    // Strict CSP for diagnostics GUI — local app origin only
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'", // allow inline for simple diagnostics
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join('; ');
  }
}
