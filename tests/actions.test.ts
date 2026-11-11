import assert from 'node:assert/strict';
import {test} from 'node:test';
import {diagnosticCode, quickFix, quickFixes} from '../src/actions';

// The numeric values of vscode.DiagnosticSeverity, which the code action provider passes in.
const severity = {error: 0, warning: 1, information: 2, hint: 3};
const {warning} = severity;

test('quick fixes are keyed on the public pietto diagnostic code alone, never on a message', () => {
  assert.equal(quickFix({source: 'pietto', code: 'PIE-S2708', severity: warning}, warning), 'selectProjectRoot');
  assert.equal(quickFix({source: 'pietto', code: {value: 'PIE-S2708'}, severity: warning}, warning), 'selectProjectRoot');
  // A schema_version = 1 project reports PIE-S2708 as an Error that asks for schema_version = 2.
  for (const other of [severity.error, severity.information, severity.hint, undefined]) {
    assert.equal(quickFix({source: 'pietto', code: 'PIE-S2708', severity: other}, warning), undefined, String(other));
  }
  for (const other of [severity.error, warning, undefined]) {
    assert.equal(quickFix({source: 'pietto', code: 'PIE-P1000', severity: other}, warning), 'previewMigration', String(other));
  }
  assert.equal(quickFix({source: 'pietto', code: {value: 'PIE-P1000'}, severity: severity.error}, warning), 'previewMigration');
  for (const code of ['PIE-S2301', 'PIE-P1011', 'pie-s2708', 'PIE-S27080', 2708, undefined]) assert.equal(quickFix({source: 'pietto', code, severity: warning}, warning), undefined, String(code));
  assert.equal(quickFix({source: 'other', code: 'PIE-S2708', severity: warning}, warning), undefined);
  assert.equal(quickFix({code: 'PIE-P1000', severity: severity.error}, warning), undefined);
  // Editor-only messages have no code; their text is not read, even where it names a code or a fix.
  for (const message of ['This file belongs to two project roots: /a and /b. Keep one of them in projectRoots.', 'PIE-S2708 Module import is resolved only by check --project ROOT', 'project error: config: PIE-P1000']) {
    const editorOnly = {source: 'pietto', message, severity: warning};
    assert.equal(quickFix(editorOnly, warning), undefined, message);
  }
});

test('one action per quick fix carries all its diagnostics in their order', () => {
  const diagnostics = [
    {source: 'pietto', code: 'PIE-P1000', severity: severity.error, id: 1},
    {source: 'pietto', code: 'PIE-S2708', severity: warning, id: 2},
    {source: 'pietto', code: 'PIE-S2301', severity: severity.error, id: 3},
    {source: 'pietto', code: 'PIE-P1000', severity: severity.error, id: 4},
    {source: 'pietto', code: 'PIE-S2708', severity: severity.error, id: 5},
    {source: 'pietto', severity: severity.error, id: 6},
    {source: 'pietto', code: 'PIE-S2708', severity: warning, id: 7},
  ];
  assert.deepEqual(quickFixes(diagnostics, warning).map(([fix, items]) => [fix, items.map(item => item.id)]), [['previewMigration', [1, 4]], ['selectProjectRoot', [2, 7]]]);
  assert.deepEqual(quickFixes(diagnostics.filter(item => item.severity !== warning), warning).map(([fix]) => fix), ['previewMigration']);
  assert.deepEqual(quickFixes([], warning), []);
});

test('a diagnostic code is a string or the string value of a code object', () => {
  assert.equal(diagnosticCode('PIE-S2708'), 'PIE-S2708');
  assert.equal(diagnosticCode({value: 'PIE-S2708', target: 'https://example.invalid'}), 'PIE-S2708');
  assert.equal(diagnosticCode({value: 2708}), undefined);
  assert.equal(diagnosticCode(null), undefined);
  assert.equal(diagnosticCode(2708), undefined);
});
