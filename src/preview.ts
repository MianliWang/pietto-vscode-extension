import {execFile} from 'node:child_process';
import {previewArguments} from './launch';

const maxOutputBytes = 4 * 1024 * 1024;
const timeoutMs = 30_000;

export interface SqlArtifact {
  readonly kind: string;
  readonly name: string;
  readonly sql: string;
}

interface Envelope {
  readonly schema_version: number;
  readonly command: string;
  readonly ok: boolean;
  readonly path: string | null;
  readonly dialect: 'postgres';
  readonly output: null;
  readonly diagnostics: unknown[];
  readonly cli_errors: unknown[];
  readonly artifacts: SqlArtifact[];
}

export type PreviewResult =
  | {readonly status: 'ready'; readonly artifacts: SqlArtifact[]}
  | {readonly status: 'refused'; readonly message: string}
  | {readonly status: 'failed'; readonly message: string}
  | {readonly status: 'cancelled'};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function message(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') return undefined;
  return typeof value.code === 'string' ? `${value.code}: ${value.message}` : value.message;
}

function messages(envelope: Envelope): string {
  const result = [...envelope.diagnostics, ...envelope.cli_errors].map(message).filter((item): item is string => item !== undefined);
  return result.length ? result.join('\n') : 'Pietto refused to emit PostgreSQL SQL.';
}

export function parsePreview(stdout: string, source?: string): PreviewResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {status: 'failed', message: 'Pietto did not return valid JSON for PostgreSQL SQL preview.'};
  }
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.command !== 'emit-sql'
    || typeof value.ok !== 'boolean'
    || (typeof value.path !== 'string' && value.path !== null)
    || value.dialect !== 'postgres'
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
  const envelope: Envelope = {
    schema_version: value.schema_version,
    command: value.command,
    ok: value.ok,
    path: value.path,
    dialect: value.dialect,
    output: value.output,
    diagnostics: value.diagnostics,
    cli_errors: value.cli_errors,
    artifacts,
  };
  if (source !== undefined && envelope.ok && envelope.path !== source) {
    return {status: 'failed', message: 'Pietto SQL preview returned a result for a different source file.'};
  }
  return envelope.ok && !envelope.cli_errors.length
    ? {status: 'ready', artifacts}
    : {status: 'refused', message: messages(envelope)};
}

export function previewPostgresSql(python: string, launcher: string[], source: string[], token: {onCancellationRequested(listener: () => void): {dispose(): void}}): Promise<PreviewResult> {
  return new Promise(resolve => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    execFile(python, previewArguments(launcher, source), {
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
      signal: controller.signal,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      cancellation.dispose();
      if (error?.name === 'AbortError') {
        resolve(timedOut ? {status: 'failed', message: 'Pietto SQL preview timed out after 30 seconds.'} : {status: 'cancelled'});
        return;
      }
      if (stderr.trim()) {
        resolve({status: 'failed', message: `Pietto SQL preview wrote unexpected error output: ${stderr.trim()}`});
        return;
      }
      const parsed = parsePreview(stdout, source[0]);
      if (parsed.status !== 'ready' && parsed.status !== 'refused') {
        resolve(parsed);
        return;
      }
      if (error && parsed.status === 'ready') {
        resolve({status: 'failed', message: 'Pietto stopped before PostgreSQL SQL preview completed.'});
        return;
      }
      resolve(parsed);
    });
  });
}

export async function showIfCurrent<T>(open: () => PromiseLike<T>, current: () => boolean, show: (document: T) => PromiseLike<unknown>): Promise<boolean> {
  const document = await open();
  if (!current()) return false;
  await show(document);
  return true;
}
