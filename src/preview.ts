import {execFile} from 'node:child_process';
import {Dialect, previewArguments, projectPreviewArguments, ProjectRequest} from './launch';

export const dialectNames: Record<Dialect, string> = {postgres: 'PostgreSQL', mysql: 'MySQL'};

export interface SqlArtifact {
  readonly kind: string;
  readonly name: string;
  readonly sql: string;
}

type Stopped = {readonly status: 'failed'; readonly message: string} | {readonly status: 'cancelled'};

export type PreviewResult =
  | {readonly status: 'ready'; readonly artifacts: SqlArtifact[]}
  | {readonly status: 'refused'; readonly message: string}
  | Stopped;

export type EmissionStatus = 'VERIFIED' | 'BLOCKED' | 'INPUT_REJECTED';

export interface EmissionItem {
  readonly kind: string;
  readonly name: string;
  readonly status: EmissionStatus;
  // The exact SQL of a VERIFIED document; otherwise a heading line and Pietto's own text
  // presentation of the failure document.
  readonly text: string;
}

export type ProjectPreviewResult =
  | {readonly status: 'ready'; readonly items: EmissionItem[]}
  | {readonly status: 'blocked'; readonly report: string}
  | {readonly status: 'refused'; readonly message: string}
  | Stopped;

interface Cancellation {onCancellationRequested(listener: () => void): {dispose(): void}}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function message(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') return undefined;
  return typeof value.code === 'string' ? `${value.code}: ${value.message}` : value.message;
}

// Single-file CLI JSON v1 for the requested dialect. Fields it does not read are ignored.
export function parsePreview(stdout: string, dialect: Dialect, source?: string): PreviewResult {
  const name = dialectNames[dialect];
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {status: 'failed', message: `Pietto did not return valid JSON for ${name} SQL preview.`};
  }
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.command !== 'emit-sql'
    || typeof value.ok !== 'boolean'
    || (typeof value.path !== 'string' && value.path !== null)
    || value.dialect !== dialect
    || value.output !== null
    || !Array.isArray(value.diagnostics)
    || !Array.isArray(value.cli_errors)
    || !Array.isArray(value.artifacts)) {
    return {status: 'failed', message: 'Pietto returned an unsupported emit-sql JSON response.'};
  }
  const artifacts: SqlArtifact[] = [];
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || typeof artifact.kind !== 'string' || typeof artifact.name !== 'string' || typeof artifact.sql !== 'string') {
      return {status: 'failed', message: 'Pietto returned an invalid SQL artifact.'};
    }
    artifacts.push({kind: artifact.kind, name: artifact.name, sql: artifact.sql});
  }
  if (source !== undefined && value.ok && value.path !== source) {
    return {status: 'failed', message: 'Pietto SQL preview returned a result for a different source file.'};
  }
  if (value.ok && !value.cli_errors.length) return {status: 'ready', artifacts};
  const messages = [...value.diagnostics, ...value.cli_errors].map(message).filter((item): item is string => item !== undefined);
  return {status: 'refused', message: messages.length ? messages.join('\n') : `Pietto refused to emit ${name} SQL.`};
}

const statuses: readonly unknown[] = ['VERIFIED', 'BLOCKED', 'INPUT_REJECTED'] satisfies EmissionStatus[];
const isStatus = (value: unknown): value is EmissionStatus => statuses.includes(value);
const exits: Record<EmissionStatus, number> = {VERIFIED: 0, BLOCKED: 1, INPUT_REJECTED: 2};

// A complete single-owner pietto.sql-emission.v1 or v2 document: VERIFIED with its SQL, or a
// failure with its blockers, diagnostics and CLI errors. Fields it does not read are ignored.
function emission(value: unknown): {readonly status: EmissionStatus; readonly fields: Record<string, unknown>} | undefined {
  if (!isRecord(value) || (value.format !== 'pietto.sql-emission.v1' && value.format !== 'pietto.sql-emission.v2') || !isStatus(value.status)) return undefined;
  const complete = value.status === 'VERIFIED' ? typeof value.sql === 'string' : ['blockers', 'diagnostics', 'cli_errors'].every(key => Array.isArray(value[key]));
  return complete ? {status: value.status, fields: value} : undefined;
}

// A value as Pietto's text presentation prints it: Python's str() (null is None), with C0
// controls and DEL as \xNN and C1, separator and bidi controls as \uNNNN, so a path or message
// can neither break its line nor reorder it.
const shown = (value: unknown) => (value === null || value === undefined ? 'None' : String(value))
  .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, character => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
const located = (location: unknown): location is Record<string, unknown> => isRecord(location) && location.path !== null && location.path !== undefined;
const at = (location: Record<string, unknown>) => `${shown(location.path)}:${shown(location.line)}:${shown(location.column)}`;
// The lines of `pietto emit-sql --project ... --dialect D --format text` for a failure document,
// after its `format status` line: CLI errors, then each blocker with its location, related
// locations and hint, then diagnostics.
function problems(document: Record<string, unknown>): string[] {
  const records = (key: string) => (document[key] as unknown[]).filter(isRecord);
  return [
    ...records('cli_errors').map(error => `error ${shown(error.kind)}: ${shown(error.message)}${error.path !== null && error.path !== undefined ? ` (path: ${shown(error.path)})` : ''}`),
    ...records('blockers').flatMap(blocker => {
      const related = (Array.isArray(blocker.related) ? blocker.related : []).filter(located).map(at);
      return [
        `blocker ${shown(blocker.code)} ${shown(blocker.reason)}: ${shown(isRecord(blocker.subject) ? blocker.subject.detail : undefined)}${located(blocker.location) ? ` (${at(blocker.location)})` : ''}`,
        ...related.length ? [`  related: ${related.join(', ')}`] : [],
        `  hint: ${shown(blocker.suggestion)}`,
      ];
    }),
    ...records('diagnostics').map(diagnostic => `${at(isRecord(diagnostic.location) ? diagnostic.location : {})} ${shown(diagnostic.code)} ${shown(diagnostic.severity)}: ${shown(diagnostic.message)}`),
  ];
}
const report = (heading: string, document: Record<string, unknown>) => [heading, `${document.format} ${document.status}`, ...problems(document)].join('\n') + '\n';
// The batch status that items derive: any INPUT_REJECTED, else any BLOCKED, else VERIFIED.
const aggregate = (items: EmissionItem[]): EmissionStatus =>
  items.some(item => item.status === 'INPUT_REJECTED') ? 'INPUT_REJECTED' : items.some(item => item.status === 'BLOCKED') ? 'BLOCKED' : 'VERIFIED';

// The pietto.sql-emission.batch.v1 document of one module. A result is used only when the exit
// code is the one its status documents, the status is the one its failure document or its
// items give, and only for the module and dialect requested.
export function parseProjectPreview(stdout: string, exit: number | null, module: string, dialect: Dialect): ProjectPreviewResult {
  const unsupported = {status: 'failed', message: 'Pietto returned an unsupported project emit-sql JSON response.'} as const;
  const name = dialectNames[dialect];
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {status: 'failed', message: `Pietto did not return valid JSON for project ${name} SQL preview.`};
  }
  if (!isRecord(value)
    || value.format !== 'pietto.sql-emission.batch.v1'
    || !isStatus(value.status)
    || !Array.isArray(value.items)
    || (value.failure !== null && !isRecord(value.failure))) {
    return unsupported;
  }
  if (exit !== exits[value.status]) return {status: 'failed', message: `Pietto stopped before project ${name} SQL preview completed.`};
  if (value.failure !== null) {
    const failure = emission(value.failure);
    if (!failure || failure.status !== value.status || failure.status === 'VERIFIED' || value.items.length) return unsupported;
    if (failure.status === 'BLOCKED') return {status: 'blocked', report: report(`${shown(module)}, ${name}`, failure.fields)};
    const lines = problems(failure.fields);
    return {status: 'refused', message: lines.length ? lines.join('\n') : `Pietto refused to emit project ${name} SQL.`};
  }
  const items: EmissionItem[] = [];
  for (const item of value.items) {
    const owner = isRecord(item) && isRecord(item.owner) ? item.owner : undefined;
    const document = isRecord(item) ? emission(item.document) : undefined;
    if (!owner || !document || typeof owner.kind !== 'string' || typeof owner.name !== 'string' || typeof owner.module !== 'string') {
      return {status: 'failed', message: 'Pietto returned an invalid SQL emission item.'};
    }
    const target = document.fields.target;
    if (owner.module !== module || (document.status === 'VERIFIED' && !(isRecord(target) && target.family === dialect))) {
      return {status: 'failed', message: 'Pietto project SQL preview returned a result for a different module or dialect.'};
    }
    items.push({kind: owner.kind, name: owner.name, status: document.status,
      text: document.status === 'VERIFIED' ? String(document.fields.sql) : report(`${shown(owner.kind)} ${shown(owner.name)} in ${shown(module)}, ${name}`, document.fields)});
  }
  return aggregate(items) === value.status ? {status: 'ready', items} : unsupported;
}

type Run = {readonly status: 'done'; readonly exit: number | null; readonly stdout: string} | Stopped;

function run(python: string, args: string[], what: string, maxBytes: number, timeoutMs: number, token: Cancellation): Promise<Run> {
  return new Promise(resolve => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    execFile(python, args, {
      encoding: 'utf8',
      maxBuffer: maxBytes,
      signal: controller.signal,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      cancellation.dispose();
      if (error?.name === 'AbortError') {
        resolve(timedOut ? {status: 'failed', message: `Pietto ${what} timed out after ${timeoutMs / 1000} seconds.`} : {status: 'cancelled'});
        return;
      }
      if (stderr.trim()) {
        resolve({status: 'failed', message: `Pietto ${what} wrote unexpected error output: ${stderr.trim()}`});
        return;
      }
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        resolve({status: 'failed', message: `Pietto ${what} wrote more than ${maxBytes / 1024 / 1024} MiB.`});
        return;
      }
      resolve({status: 'done', exit: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout});
    });
  });
}

export async function previewSql(python: string, launcher: string[], source: string, dialect: Dialect, token: Cancellation): Promise<PreviewResult> {
  const ran = await run(python, previewArguments(launcher, [source], dialect), 'SQL preview', 4 * 1024 * 1024, 30_000, token);
  if (ran.status !== 'done') return ran;
  const parsed = parsePreview(ran.stdout, dialect, source);
  return parsed.status === 'ready' && ran.exit !== 0 ? {status: 'failed', message: `Pietto stopped before ${dialectNames[dialect]} SQL preview completed.`} : parsed;
}

// The batch output is limited to 64 MiB by Pietto itself; a whole project is compiled, so it
// gets a longer deadline than one file.
export async function previewProjectSql(python: string, launcher: string[], request: ProjectRequest, token: Cancellation): Promise<ProjectPreviewResult> {
  const ran = await run(python, projectPreviewArguments(launcher, request), 'project SQL preview', 64 * 1024 * 1024, 60_000, token);
  return ran.status === 'done' ? parseProjectPreview(ran.stdout, ran.exit, request.module, request.dialect) : ran;
}

export async function showIfCurrent<T>(open: () => PromiseLike<T>, current: () => boolean, show: (document: T) => PromiseLike<unknown>): Promise<boolean> {
  const document = await open();
  if (!current()) return false;
  await show(document);
  return true;
}
