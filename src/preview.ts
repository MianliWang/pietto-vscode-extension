import {execFile} from 'node:child_process';
import {Dialect, migrateArguments, previewArguments, projectPreviewArguments, ProjectRequest} from './launch';

export const dialectNames: Record<Dialect, string> = {postgres: 'PostgreSQL', mysql: 'MySQL'};

export interface SqlArtifact {
  readonly kind: string;
  readonly name: string;
  readonly sql: string;
}

export type Failed = {readonly status: 'failed'; readonly message: string};
export type Stopped = Failed | {readonly status: 'cancelled'};

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

export interface Cancellation {onCancellationRequested(listener: () => void): {dispose(): void}}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function message(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') return undefined;
  return typeof value.code === 'string' ? `${value.code}: ${value.message}` : value.message;
}

export type Envelope = {readonly ok: boolean; readonly path: string | null; readonly diagnostics: unknown[]; readonly cli_errors: unknown[]; readonly artifacts: unknown[]};

// A single-file CLI JSON v1 emit-sql envelope for the requested dialect; `what` names the
// command in a message. Fields it does not read are ignored.
export function envelope(stdout: string, dialect: Dialect, what: string): {readonly status: 'done'; readonly value: Envelope} | Failed {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {status: 'failed', message: `Pietto did not return valid JSON for ${what}.`};
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
  return {status: 'done', value: value as Envelope};
}

export function parsePreview(stdout: string, dialect: Dialect, source?: string): PreviewResult {
  const name = dialectNames[dialect];
  const parsed = envelope(stdout, dialect, `${name} SQL preview`);
  if (parsed.status === 'failed') return parsed;
  const {value} = parsed;
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

export interface Emission {readonly status: EmissionStatus; readonly fields: Record<string, unknown>}

// A complete single-owner pietto.sql-emission.v1 or v2 document: VERIFIED with its SQL, or a
// failure with its blockers, diagnostics and CLI errors. Fields it does not read are ignored.
function emission(value: unknown): Emission | undefined {
  if (!isRecord(value) || (value.format !== 'pietto.sql-emission.v1' && value.format !== 'pietto.sql-emission.v2') || !isStatus(value.status)) return undefined;
  const complete = value.status === 'VERIFIED' ? typeof value.sql === 'string' : ['blockers', 'diagnostics', 'cli_errors'].every(key => Array.isArray(value[key]));
  return complete ? {status: value.status, fields: value} : undefined;
}

// A value as Pietto's text presentation prints it: Python's str() (null is None), with C0
// controls and DEL as \xNN and C1, separator and bidi controls as \uNNNN, so a path or message
// can neither break its line nor reorder it.
export const shown = (value: unknown) => (value === null || value === undefined ? 'None' : String(value))
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
const aggregate = (items: readonly {readonly status: EmissionStatus}[]): EmissionStatus =>
  items.some(item => item.status === 'INPUT_REJECTED') ? 'INPUT_REJECTED' : items.some(item => item.status === 'BLOCKED') ? 'BLOCKED' : 'VERIFIED';

export interface BatchItem extends Emission {readonly owner: {readonly kind: string; readonly module: string; readonly name: string}}

// A pietto.sql-emission.batch.v1 document; `what` names the command in a message. It is used
// only when the exit code is the one its status documents and the status is the one its
// failure document, or else its items, give.
export function parseBatch(stdout: string, exit: number | null, what: string): {readonly status: 'done'; readonly failure: Emission | null; readonly items: BatchItem[]} | Failed {
  const unsupported = {status: 'failed', message: 'Pietto returned an unsupported project emit-sql JSON response.'} as const;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {status: 'failed', message: `Pietto did not return valid JSON for ${what}.`};
  }
  if (!isRecord(value)
    || value.format !== 'pietto.sql-emission.batch.v1'
    || !isStatus(value.status)
    || !Array.isArray(value.items)
    || (value.failure !== null && !isRecord(value.failure))) {
    return unsupported;
  }
  if (exit !== exits[value.status]) return {status: 'failed', message: `Pietto stopped before ${what} completed.`};
  if (value.failure !== null) {
    const failure = emission(value.failure);
    return !failure || failure.status !== value.status || failure.status === 'VERIFIED' || value.items.length ? unsupported : {status: 'done', failure, items: []};
  }
  const items: BatchItem[] = [];
  for (const item of value.items) {
    const owner = isRecord(item) && isRecord(item.owner) ? item.owner : undefined;
    const document = isRecord(item) ? emission(item.document) : undefined;
    if (!owner || !document || typeof owner.kind !== 'string' || typeof owner.name !== 'string' || typeof owner.module !== 'string') {
      return {status: 'failed', message: 'Pietto returned an invalid SQL emission item.'};
    }
    items.push({owner: {kind: owner.kind, module: owner.module, name: owner.name}, ...document});
  }
  return aggregate(items) === value.status ? {status: 'done', failure: null, items} : unsupported;
}

// A VERIFIED document has the requested target family.
export const sameDialect = ({status, fields}: Emission, dialect: Dialect) => status !== 'VERIFIED' || (isRecord(fields.target) && fields.target.family === dialect);

// The batch document of one module, used only for the module and dialect requested.
export function parseProjectPreview(stdout: string, exit: number | null, module: string, dialect: Dialect): ProjectPreviewResult {
  const name = dialectNames[dialect];
  const batch = parseBatch(stdout, exit, `project ${name} SQL preview`);
  if (batch.status === 'failed') return batch;
  if (batch.failure?.status === 'BLOCKED') return {status: 'blocked', report: report(`${shown(module)}, ${name}`, batch.failure.fields)};
  if (batch.failure) {
    const lines = problems(batch.failure.fields);
    return {status: 'refused', message: lines.length ? lines.join('\n') : `Pietto refused to emit project ${name} SQL.`};
  }
  if (batch.items.some(item => item.owner.module !== module || !sameDialect(item, dialect))) {
    return {status: 'failed', message: 'Pietto project SQL preview returned a result for a different module or dialect.'};
  }
  return {status: 'ready', items: batch.items.map(({owner, status, fields}) => ({kind: owner.kind, name: owner.name, status,
    text: status === 'VERIFIED' ? String(fields.sql) : report(`${shown(owner.kind)} ${shown(owner.name)} in ${shown(module)}, ${name}`, fields)}))};
}

type Executed =
  | {readonly status: 'done'; readonly error: {readonly code?: unknown; readonly message: string} | null; readonly stdout: string; readonly stderr: string}
  | {readonly status: 'timeout'}
  | Stopped;

// One pietto command through the selected interpreter, without a shell, within an output
// limit and a deadline.
function execute(python: string, args: string[], maxBytes: number, timeoutMs: number, token: Cancellation): Promise<Executed> {
  return new Promise(resolve => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const child = execFile(python, args, {
        encoding: 'utf8',
        maxBuffer: maxBytes,
        signal: controller.signal,
        timeout: timeoutMs,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        clearTimeout(timeout);
        cancellation.dispose();
        if (error?.name !== 'AbortError') { resolve({status: 'done', error, stdout, stderr}); return; }
        // Node reports an abort as soon as it signals the process; a stopped run ends only once
        // the process has exited, so the next run of the same caller never overlaps it.
        const stopped = {status: timedOut ? 'timeout' : 'cancelled'} as const;
        if (child.exitCode !== null || child.signalCode !== null) resolve(stopped);
        else child.once('exit', () => resolve(stopped));
      });
    } catch (error) {
      // An interpreter that cannot be started at all, such as an empty pietto.pythonPath.
      clearTimeout(timeout);
      cancellation.dispose();
      resolve({status: 'failed', message: `"${python}" could not be started: ${error instanceof Error ? error.message : String(error)}`});
    }
  });
}

type Run = {readonly status: 'done'; readonly exit: number | null; readonly stdout: string} | Stopped;

// emit-sql and explain write their whole result to stdout, so any error output, or more
// output than the limit, fails the run.
export async function run(python: string, args: string[], what: string, maxBytes: number, timeoutMs: number, token: Cancellation): Promise<Run> {
  const ran = await execute(python, args, maxBytes, timeoutMs, token);
  if (ran.status === 'timeout') return {status: 'failed', message: `Pietto ${what} timed out after ${timeoutMs / 1000} seconds.`};
  if (ran.status !== 'done') return ran;
  if (ran.stderr.trim()) return {status: 'failed', message: `Pietto ${what} wrote unexpected error output: ${ran.stderr.trim()}`};
  if (ran.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return {status: 'failed', message: `Pietto ${what} wrote more than ${maxBytes / 1024 / 1024} MiB.`};
  return {status: 'done', exit: ran.error ? (typeof ran.error.code === 'number' ? ran.error.code : null) : 0, stdout: ran.stdout};
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

export type MigrationResult =
  | {readonly status: 'ready'; readonly source: string}
  | {readonly status: 'refused'; readonly message: string}
  | {readonly status: 'failed'; readonly message: string}
  | {readonly status: 'cancelled'};

// `pietto migrate PATH` has no JSON form. Exit 0 writes one complete migrated source to
// stdout and nothing to stderr; a refusal (exit 1) or a command error (exit 2) writes its
// diagnostics to stderr, and any stdout then is never shown.
export function parseMigration(error: {readonly code?: unknown; readonly message: string} | null, stdout: string, stderr: string): MigrationResult {
  const errors = stderr.trim();
  if (!error) return errors ? {status: 'failed', message: `pietto migrate wrote unexpected error output: ${errors}`} : {status: 'ready', source: stdout};
  if (typeof error.code === 'number' && errors) return {status: 'refused', message: `pietto migrate emitted no source: ${errors}`};
  return {status: 'failed', message: `pietto migrate did not complete: ${errors || error.message}`};
}

export async function previewMigration(python: string, launcher: string[], source: string, token: Cancellation): Promise<MigrationResult> {
  const result = await execute(python, migrateArguments(launcher, source), 4 * 1024 * 1024, 30_000, token);
  if (result.status === 'timeout') return {status: 'failed', message: 'pietto migrate timed out after 30 seconds.'};
  return result.status === 'done' ? parseMigration(result.error, result.stdout, result.stderr) : result;
}

export async function showIfCurrent<T>(open: () => PromiseLike<T>, current: () => boolean, show: (document: T) => PromiseLike<unknown>): Promise<boolean> {
  const document = await open();
  if (!current()) return false;
  await show(document);
  return true;
}
