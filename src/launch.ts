import {execFile} from 'node:child_process';
import * as path from 'node:path';

// The console entry point `pietto = "pietto.cli:main"`, run through the selected
// interpreter in isolated mode (-I: no PYTHON* variables, user site or working-directory
// imports). Single quotes keep the script intact if a WSL launcher hands it to a shell.
const entryPoint = (argv: string[]) => ['-I', '-c', `import sys; from pietto.cli import main; sys.exit(main([${argv.map(arg => `'${arg}'`).join(', ')}]))`];
export const serverArguments = (launcher: string[]) => [...launcher, ...entryPoint(['lsp'])];
export const probeArguments = (launcher: string[]) => [...launcher, ...entryPoint(['lsp', '--help'])];

// Commands with document paths must pass their arguments separately. Embedding those paths
// in the Python program would make a quote in a filename change the program itself.
const commandEntryPoint = ['-I', '-c', 'import sys; from pietto.cli import main; sys.exit(main(sys.argv[1:]))'];
export const commandArguments = (launcher: string[], argv: string[]) => [...launcher, ...commandEntryPoint, ...argv];
export const previewArguments = (launcher: string[], source: string[]) => commandArguments(launcher, ['emit-sql', ...source, '--dialect', 'postgres', '--format', 'json']);

// Settings arrive unchecked (VS Code only warns about a value that breaks the schema),
// so a list setting keeps its strings and anything else counts as empty.
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

// `pietto lsp --help` exits 0 only where the lsp subcommand exists, so a missing or
// older pietto gets one message instead of a language client that keeps restarting.
// The message is the last line of error output (UTF-16LE when it comes from wsl.exe), or
// Node's own error when the interpreter cannot be started at all, such as an empty path.
export function probe(python: string, launcher: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(python, probeArguments(launcher), {encoding: 'buffer', timeout: 60_000, windowsHide: true}, (error, _stdout, stderr) =>
        resolve(error ? stderr.toString(stderr.includes(0) ? 'utf16le' : 'utf8').trim().split(/\r?\n/).at(-1) || error.message : undefined));
    } catch (error) {
      resolve(String(error instanceof Error ? error.message : error));
    }
  });
}

// Each workspace folder's pietto.projectRoots entries, resolved against that folder;
// pietto lsp refuses duplicate roots, so the first spelling of each path is kept.
export function resolveRoots(folders: [folder: string, roots: unknown][], windows = process.platform === 'win32'): string[] {
  const paths = windows ? path.win32 : path.posix;
  const roots = new Map<string, string>();
  for (const [folder, entries] of folders) {
    for (const entry of strings(entries)) {
      if (!entry.trim()) continue;
      const root = paths.resolve(folder, entry);
      const key = windows ? root.toLowerCase() : root;
      if (!roots.has(key)) roots.set(key, root);
    }
  }
  return [...roots.values()];
}

// A Windows desktop that launches a Linux interpreter through wsl.exe sees C:\x as /mnt/c/x.
export const isWslLauncher = (python: string, platform = process.platform) => platform === 'win32' && /^wsl(?:\.exe)?$/i.test(path.win32.basename(python));
export function toWsl(windowsPath: string): string {
  const match = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(windowsPath);
  if (!match) return windowsPath;
  const rest = (match[2] ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}
export function fromWsl(posixPath: string): string | undefined {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(posixPath);
  return match ? `${match[1]}:/${match[2] ?? ''}` : undefined;
}
