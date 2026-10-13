import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const workspace = path.join(root, '.local', 'host-workspace');
  const other = path.join(root, '.local', 'host-other');
  const profile = process.env.PIETTO_HOST_USER_DATA ?? path.join(root, '.vscode-test', 'host-user-data');
  const extensions = process.env.PIETTO_HOST_EXTENSIONS ?? path.join(root, '.vscode-test', 'host-extensions');
  const python = process.env.PIETTO_TEST_PYTHON ?? path.join(root, '.local', 'release-venv', 'Scripts', 'python.exe');
  const pythonArguments = JSON.parse(process.env.PIETTO_TEST_PYTHON_ARGUMENTS ?? '[]') as unknown;
  const installed = process.env.PIETTO_HOST_INSTALLED === '1';
  const driver = path.join(root, '.local', 'vsix-test-driver');
  if (!Array.isArray(pythonArguments) || pythonArguments.some(argument => typeof argument !== 'string')) throw new Error('PIETTO_TEST_PYTHON_ARGUMENTS must be a JSON array of strings.');
  const executable = process.env.VSCODE_EXECUTABLE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  if (!existsSync(executable)) throw new Error('Set VSCODE_EXECUTABLE to a desktop VS Code executable.');
  if (!existsSync(python)) throw new Error('Set PIETTO_TEST_PYTHON to the isolated compatible Pietto interpreter.');
  if (installed) {
    mkdirSync(driver, { recursive: true });
    writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
      name: 'pietto-vsix-test-driver', publisher: 'local-pietto-tests', version: '0.0.0', private: true,
      engines: { vscode: '^1.90.0' }, main: './extension.js', activationEvents: ['onStartupFinished'],
    }, null, 2));
    writeFileSync(path.join(driver, 'extension.js'), 'exports.activate = function () {};\n');
  }
  for (const directory of [workspace, other, path.join(profile, 'User'), extensions, path.join(root, 'artifacts')]) mkdirSync(directory, { recursive: true });
  for (const folder of [workspace, other]) {
    const configuration = path.join(folder, '.vscode');
    mkdirSync(configuration, { recursive: true });
    writeFileSync(path.join(configuration, 'settings.json'), '{}\n');
  }
  writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'pietto.pythonPath': python,
    'pietto.pythonArguments': pythonArguments,
    'pietto.analysisDelay': 20,
    'pietto.analysisTimeout': 15000,
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'files.hotExit': 'off',
  }, null, 2));
  const fixture = path.join(root, '.local', 'host.code-workspace');
  writeFileSync(fixture, JSON.stringify({ folders: [{ path: workspace }, { path: other }], settings: {} }, null, 2));
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: installed ? driver : root,
    extensionTestsPath: path.join(root, 'out', 'tests', 'host', 'index.js'),
    reuseMachineInstall: false,
    launchArgs: [fixture, '--user-data-dir=' + profile, '--extensions-dir=' + extensions, '--disable-gpu', ...(installed ? [] : ['--disable-extensions'])],
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      PIETTO_HOST_ROOT: root,
      PIETTO_HOST_WORKSPACE: workspace,
      PIETTO_HOST_OTHER: other,
      PIETTO_TEST_PYTHON: python,
      PIETTO_TEST_PYTHON_ARGUMENTS: JSON.stringify(pythonArguments),
      PIETTO_TEST_PROJECT_PYTHON: process.env.PIETTO_TEST_PROJECT_PYTHON,
      PIETTO_TEST_PROJECT_PYTHON_ARGUMENTS: process.env.PIETTO_TEST_PROJECT_PYTHON_ARGUMENTS,
      PIETTO_HOST_INSTALLED: process.env.PIETTO_HOST_INSTALLED,
      PIETTO_HOST_INSTALLED_PATH: process.env.PIETTO_HOST_INSTALLED_PATH,
    },
  });
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
