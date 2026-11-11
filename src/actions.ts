// Quick fixes are keyed on the public diagnostic contract only: source `pietto`, the
// PIE code and, for PIE-S2708, the Warning severity it has outside a project (in a
// schema_version = 1 project it is an Error that asks for schema_version = 2 instead).
// No message text is read, so an editor-only message, which has no code, gets none.
export type QuickFix = 'selectProjectRoot' | 'previewMigration';

export type PiettoDiagnostic = {readonly source?: string; readonly code?: unknown; readonly severity?: unknown};

export const quickFixTitles: Record<QuickFix, string> = {
  selectProjectRoot: 'Select project root',
  previewMigration: 'Preview migration (pietto migrate)',
};

export function diagnosticCode(code: unknown): string | undefined {
  if (typeof code === 'string') return code;
  const value = typeof code === 'object' && code !== null ? (code as {value?: unknown}).value : undefined;
  return typeof value === 'string' ? value : undefined;
}

// `warning` is vscode.DiagnosticSeverity.Warning, passed in so that this module needs no vscode.
export function quickFix(diagnostic: PiettoDiagnostic, warning: number): QuickFix | undefined {
  if (diagnostic.source !== 'pietto') return undefined;
  const code = diagnosticCode(diagnostic.code);
  if (code === 'PIE-S2708') return diagnostic.severity === warning ? 'selectProjectRoot' : undefined;
  return code === 'PIE-P1000' ? 'previewMigration' : undefined;
}

// One action per quick fix, carrying its diagnostics in the order they came.
export function quickFixes<T extends PiettoDiagnostic>(diagnostics: readonly T[], warning: number): [QuickFix, T[]][] {
  const fixes = new Map<QuickFix, T[]>();
  for (const diagnostic of diagnostics) {
    const fix = quickFix(diagnostic, warning);
    if (fix) fixes.set(fix, [...fixes.get(fix) ?? [], diagnostic]);
  }
  return [...fixes];
}
