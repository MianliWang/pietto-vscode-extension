import {existsSync} from 'node:fs';
import path from 'node:path';
import {downloadAndUnzipVSCode} from '@vscode/test-electron';

export const root = path.resolve(__dirname, '..', '..');

// A runner started from a VS Code terminal must not hand that editor's IPC hooks to
// the test editor, so only VSCODE_EXECUTABLE survives.
const configured = process.env.VSCODE_EXECUTABLE;
for (const key of Object.keys(process.env)) if (/^(?:VSCODE_|ELECTRON_)/.test(key)) delete process.env[key];

// The test editor: VSCODE_EXECUTABLE, or one download of PIETTO_VSCODE_VERSION (default stable).
export async function editor(): Promise<string> {
  const executable = configured ?? await downloadAndUnzipVSCode({version: process.env.PIETTO_VSCODE_VERSION ?? 'stable', cachePath: path.join(root, '.vscode-test')});
  if (!existsSync(executable)) throw new Error(`VS Code executable not found: ${executable}`);
  return process.env.VSCODE_EXECUTABLE = executable;
}

// The interpreter with pietto 0.1.10 or later that the test editor runs pietto lsp from.
export function python(): string {
  const executable = process.env.PIETTO_TEST_PYTHON ?? path.join(root, '.local', 'pietto-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(executable)) throw new Error('Set PIETTO_TEST_PYTHON to a Python that has pietto 0.1.10 or later.');
  return executable;
}

export function pythonArguments(): string[] {
  const value: unknown = JSON.parse(process.env.PIETTO_TEST_PYTHON_ARGUMENTS ?? '[]');
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('PIETTO_TEST_PYTHON_ARGUMENTS must be a JSON array of strings.');
  return value;
}

export const quietEditor = {
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'files.hotExit': 'off',
};
