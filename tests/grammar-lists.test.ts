import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { KEYWORD_SCOPE, grammarPath, root } from './grammarHost';

// tests/fixtures/language.json is written by tests/sync_language.py from
// grammar/Pietto.g4 and the semantic catalogs of the Pietto trees it names.
const language = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/language.json'), 'utf8')) as Record<string, string[]>;

type Rule = Record<string, unknown>;

/** Every rule of the grammar with its scopes and the literal words of its regexes. */
function rules(): { scopes: string[]; words: string[] }[] {
  const found: { scopes: string[]; words: string[] }[] = [];
  const visit = (rule: Rule) => {
    const scopes: string[] = [];
    for (const key of ['name', 'contentName']) if (typeof rule[key] === 'string') scopes.push(rule[key] as string);
    for (const key of ['captures', 'beginCaptures', 'endCaptures', 'whileCaptures']) {
      for (const capture of Object.values((rule[key] ?? {}) as Record<string, Rule>)) {
        if (typeof capture.name === 'string') scopes.push(capture.name);
        for (const child of (capture.patterns ?? []) as Rule[]) visit(child);
      }
    }
    const words = ['match', 'begin', 'end', 'while']
      .filter(key => typeof rule[key] === 'string')
      .flatMap(key => (rule[key] as string)
        .replace(/\\[A-Za-z]/g, ' ')
        .replace(/\[(?:\\.|[^\]\\])*\]/g, ' ')
        .match(/[A-Za-z_]+/g) ?? []);
    found.push({ scopes, words });
    for (const child of (rule.patterns ?? []) as Rule[]) visit(child);
  };
  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8')) as Rule;
  visit(grammar);
  for (const rule of Object.values(grammar.repository as Record<string, Rule>)) visit(rule);
  return found;
}

function words(accept: (scope: string) => boolean): string[] {
  return [...new Set(rules().filter(rule => rule.scopes.some(accept)).flatMap(rule => rule.words))].sort();
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

test('builtin types and functions equal the Pietto catalog snapshot', () => {
  assert.deepEqual(words(scope => scope.startsWith('support.type.builtin.')), language.types);
  assert.deepEqual(words(scope => scope.startsWith('support.function.builtin.aggregate.')), language.aggregates);
  assert.deepEqual(words(scope => scope.startsWith('support.function.builtin.window.')), language.windowFunctions);
  assert.deepEqual(words(scope => scope === 'support.function.builtin.pietto'), language.functions);
});

test('keyword scopes cover exactly the Pietto.g4 keywords, retired header words excluded', () => {
  const keywords = words(scope => KEYWORD_SCOPE.test(scope));
  const extra = keywords.filter(word => !language.keywords.includes(word));
  assert.deepEqual(extra, [], 'keyword-scoped words that Pietto.g4 does not define');
  const header = keywords.filter(word => language.header.includes(word));
  assert.deepEqual(header, [], 'retired header words must get no keyword scope');
  // A keyword that is only ever a built-in call (`any`) may be highlighted as one.
  const builtins = words(scope => scope.startsWith('support.function.builtin.'));
  const covered = sorted([...keywords, ...builtins.filter(word => language.keywords.includes(word))]);
  assert.deepEqual(covered, sorted(language.keywords.filter(word => !language.header.includes(word))));
});

test('the snapshot records the grammar facts the TextMate grammar relies on', () => {
  for (const word of ['asof', 'def', 'relationship', 'import', 'export', 'qualify', 'having', 'distinct', 'None', 'True', 'False']) {
    assert.ok(language.keywords.includes(word), word);
  }
  // Operator, literal and modifier words and `window` are reserved; the rest may be names.
  const reserved = language.keywords.filter(word => !language.names.includes(word));
  assert.deepEqual(reserved, ['False', 'None', 'True', 'and', 'between', 'false', 'like', 'not', 'null', 'nullable', 'or', 'true', 'window']);
  for (const name of ['variance', 'pvariance', 'pstdev', 'count_distinct', 'all', 'any', 'first', 'last', 'median', 'quantile', 'string_agg']) {
    assert.ok(language.aggregates.includes(name), name);
  }
  for (const name of ['now', 'lpad', 'add_months', 'same_value', 'date_trunc']) assert.ok(language.functions.includes(name), name);
});
