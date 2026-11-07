import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { INITIAL, IGrammar, Registry, StateStack, parseRawGrammar } from 'vscode-textmate';
import { OnigScanner, OnigString, loadWASM } from 'vscode-oniguruma';

export const root = process.cwd();
export const grammarPath = path.join(root, 'syntaxes/pietto.tmLanguage.json');

export interface Token { start: number; end: number; scopes: string[] }

/** A scope that marks a word as a keyword (or a keyword literal such as None). */
export const KEYWORD_SCOPE = /^(?:keyword|storage\.type|storage\.modifier|constant\.language)\./;

let loading: Promise<IGrammar> | undefined;

export function loadGrammar(): Promise<IGrammar> {
  loading ??= (async () => {
    const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await loadWASM(new Uint8Array(wasm).buffer);
    const registry = new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: patterns => new OnigScanner(patterns),
        createOnigString: text => new OnigString(text),
      }),
      loadGrammar: async scope => scope === 'source.pietto'
        ? parseRawGrammar(readFileSync(grammarPath, 'utf8'), grammarPath)
        : null,
    });
    const grammar = await registry.loadGrammar('source.pietto');
    assert.ok(grammar);
    return grammar;
  })();
  return loading;
}

/** Tokenize a whole text line by line, carrying the rule stack. */
export function tokenize(grammar: IGrammar, text: string): Token[][] {
  let state: StateStack = INITIAL;
  return text.split('\n').map(line => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map(token => ({ start: token.startIndex, end: token.endIndex, scopes: token.scopes }));
  });
}

export function scopesAt(tokens: Token[], column: number): string[] {
  return tokens.find(token => token.start <= column && token.end > column)?.scopes ?? [];
}

/** The scopes of the first occurrence of `text` in a one-line source. */
export async function scopesOf(line: string, text: string, occurrence = 0): Promise<string[]> {
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = line.indexOf(text, start + 1);
  assert.notEqual(start, -1, `${text} in ${line}`);
  return scopesAt(tokenize(await loadGrammar(), line)[0], start);
}
