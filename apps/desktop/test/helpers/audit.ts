// Known bugs from the 2026-11-22 QC audit (M0 to M7.5) are written as
// expected failures: `it.fails(audit('H2', '...'), ...)`. The test body
// asserts the *correct* behaviour, so it fails today and CI stays green.
// When a fix lands, Vitest reports the test as an unexpected pass; the fix PR
// then changes `it.fails` to `it` so the test guards the fix from then on.
//
// Audit doc: https://claude.ai/artifact/CGiC34t3N2yqqpfPHtSZ7P
export const AUDIT_DOC = 'https://claude.ai/artifact/CGiC34t3N2yqqpfPHtSZ7P';

export type AuditId =
  | 'H1' | 'H2' | 'H3' | 'H4' | 'H5'
  | 'M1' | 'M2' | 'M3' | 'M4' | 'M5'
  | 'L1' | 'L2' | 'L3';

export function audit(id: AuditId, title: string): string {
  return `[audit ${id}] ${title}`;
}
