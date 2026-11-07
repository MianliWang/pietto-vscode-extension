import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { KEYWORD_SCOPE, Token, loadGrammar, root, scopesAt, tokenize } from './grammarHost';

// tests/fixtures/corpus.json is written by tests/sync_language.py: every
// ```pietto block of the Pietto README and docs and every examples/ file, with
// the keyword roles, strings, numbers and comments that Pietto's own lexer and
// parser found in it (zero-based lines and columns).
interface Block {
  origins: { tree: string; path: string; line: number; fence?: string }[];
  text: string;
  keywords: [number, number, string, 'keyword' | 'name'][] | null;
  strings: [number, number, number][];
  numbers: [number, number, number][];
  comments: [number, number][];
}
const corpus = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/corpus.json'), 'utf8')) as { trees: string[]; blocks: Block[] };
const language = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/language.json'), 'utf8')) as Record<string, string[]>;
const builtinCalls = new Set([...language.functions, ...language.aggregates, ...language.windowFunctions]);

const where = (block: Block, line: number) => {
  const origin = block.origins[0];
  return `${origin.path}:${origin.line + line} (tree ${origin.tree.slice(0, 8)}): ${block.text.split('\n')[line]}`;
};
const has = (scopes: string[], prefix: string) => scopes.some(scope => scope.startsWith(prefix));

test('every Pietto tree the corpus names contributes a block, and every block parsed', () => {
  assert.ok(corpus.blocks.length > 50);
  for (const block of corpus.blocks) assert.notEqual(block.keywords, null, where(block, 0));
  for (const tree of corpus.trees) assert.ok(corpus.blocks.some(block => block.origins.some(origin => origin.tree === tree)), tree);
});

test('corpus blocks tokenize without invalid scopes', async () => {
  const grammar = await loadGrammar();
  for (const block of corpus.blocks) {
    tokenize(grammar, block.text).forEach((tokens, line) => {
      const bad = tokens.find(token => token.scopes.some(scope => scope.startsWith('invalid')));
      assert.equal(bad, undefined, where(block, line));
    });
  }
});

test('every keyword occurrence of the corpus gets its keyword scope and every keyword-named name does not', async () => {
  const grammar = await loadGrammar();
  for (const block of corpus.blocks) {
    const lines = tokenize(grammar, block.text);
    for (const [line, column, word, role] of block.keywords ?? []) {
      const scopes = scopesAt(lines[line], column);
      const keyword = scopes.some(scope => KEYWORD_SCOPE.test(scope));
      const message = `${word} (${role}) at ${column}: ${scopes.join(' ')}\n  ${where(block, line)}`;
      if (role === 'name') assert.ok(!keyword, message);
      else assert.ok(keyword || (builtinCalls.has(word) && has(scopes, 'support.function.builtin.')), message);
    }
  }
});

function covered(tokens: Token[], from: number, to: number, prefix: string) {
  for (let column = from; column < to; column++) if (!has(scopesAt(tokens, column), prefix)) return column;
  return -1;
}

test('strings, numbers and comments of the corpus are whole and never leak', async () => {
  const grammar = await loadGrammar();
  for (const block of corpus.blocks) {
    const lines = tokenize(grammar, block.text);
    const text = block.text.split('\n');
    const starts = new Set(block.strings.map(([line, column]) => `${line}:${column}`));
    for (const [line, from, to] of block.strings) {
      assert.equal(covered(lines[line], from, to, 'string.quoted.'), -1, `string ${where(block, line)}`);
      if (to < text[line].length && !starts.has(`${line}:${to}`)) {
        assert.ok(!has(scopesAt(lines[line], to), 'string.'), `string leaks at ${to}: ${where(block, line)}`);
      }
    }
    for (const [line, from, to] of block.numbers) {
      assert.equal(covered(lines[line], from, to, 'constant.numeric.'), -1, `number ${where(block, line)}`);
    }
    const comments = new Map(block.comments.map(([line, column]) => [line, column]));
    text.forEach((content, line) => {
      const start = comments.get(line) ?? content.length;
      assert.equal(covered(lines[line], start, content.length, 'comment.line.'), -1, `comment ${where(block, line)}`);
      assert.equal(lines[line].some(token => token.start < start && has(token.scopes, 'comment.')), false, `comment leaks: ${where(block, line)}`);
    });
  }
});
