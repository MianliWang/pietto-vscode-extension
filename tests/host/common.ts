import {readFileSync, readdirSync} from 'node:fs';
import * as vscode from 'vscode';
import {serverArguments} from '../../src/launch';

export interface Api {
  readonly client?: {initializeResult?: {serverInfo?: {name: string; version?: string}}};
  readonly notices: string[];
}

const script = serverArguments([]).at(-1)!;

// The pietto lsp processes this extension host started, read from /proc (undefined off Linux).
export function servers(): {pid: number; argv: string[]}[] | undefined {
  if (process.platform !== 'linux') return undefined;
  const found: {pid: number; argv: string[]}[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').slice(0, -1);
      if (parent === process.pid && argv.includes(script)) found.push({pid: Number(name), argv});
    } catch { /* The process exited while it was read. */ }
  }
  return found;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor<T>(what: string, check: () => T | undefined | null | false, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${what}.`);
    await sleep(50);
  }
}

export const pietto = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(item => item.source === 'pietto');
export const span = (range: vscode.Range) => [range.start.line, range.start.character, range.end.line, range.end.character];
export const codes = (uri: vscode.Uri) => pietto(uri).map(item => String(item.code)).sort();
