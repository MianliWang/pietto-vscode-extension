import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validReply} from '../src/types';
const position = {line: 0, character: 0};
const range = {start: position, end: position};
const doc = {uri: 'untitled:fixture', version: 1, state: 'checked', diagnostics: [], symbols: [], contexts: [], occurrences: []};
const compiler = {python: '/python', origin: '/pietto', distributionVersion: '0.1.2', sourceFingerprint: 'hash', reference: 'ref'};
test('analysis protocol validates leaves before native providers use them', () => {
  const reply = {id: 1, protocol: 1, ok: true, compiler, issues: [], documents: [doc], elapsedMs: 2};
  assert.ok(validReply(reply));
  assert.ok(validReply({...reply, ok: false, compiler: null, issues: ['Compiler unavailable.'], documents: []}));
  for (const change of [
    {symbols: [null]}, {occurrences: [{name: 'x', kind: 'field', range: null}]},
    {contexts: [{range, kind: 'row', items: [{name: 'x'}]}]}, {diagnostics: [{message: 'error'}]},
    {symbols: [{id: 'x', name: 'x', kind: 'shape', state: 'checked', range: {start: {line: -1, character: 0}, end: position}}]}
  ]) assert.equal(validReply({...reply, documents: [{...doc, ...change}]}), false);
  assert.equal(validReply({...reply, compiler: null}), false);
});
