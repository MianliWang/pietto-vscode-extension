# Verification

Local runs of version 0.2.1 on 2026-11-07 (UTC). They are not CI and not a
Marketplace publication. Reproduce with the commands in
[Develop and verify](../README.md#develop-and-verify).

## Environment

- Linux, WSL2 Ubuntu 24.04 (kernel 6.18.54.1-microsoft-standard-WSL2), display
  through WSLg (`DISPLAY=:0`).
- VS Code 1.145.2 for linux-x64 (commit
  `c4453f8ea430795f941c1b2ff6c9321135a74a02`), downloaded once by
  `@vscode/test-electron` into `.vscode-test/`, with its own user data and
  extensions folders. No other VS Code installation or profile was used.
- Node 22.23.1, npm 10.9.8, dependencies from `package-lock.json`
  (`npm ci --ignore-scripts`). Runtime dependency `vscode-languageclient`
  9.0.1 with `vscode-languageserver-protocol` 3.17.5, `vscode-jsonrpc` 8.2.0,
  `vscode-languageserver-types` 3.17.5, `semver` 7.8.5, `minimatch` 5.1.9,
  `brace-expansion` 2.1.7, `balanced-match` 1.0.2.
- Pietto 0.1.10 from PyPI, the first release with `pietto lsp` (tag
  [v0.1.10](https://github.com/MianliWang/pietto/releases/tag/v0.1.10), commit
  `8e7c43f1852b2c26318b3217268a1f7416f44965`, tree
  `dceca22cc2ae0c1a5dabfb7d047d59d283912996`), installed with
  `pip install --no-cache-dir pietto==0.1.10` into a CPython 3.13.13 virtual
  environment, used as `PIETTO_TEST_PYTHON`. pip downloaded
  `pietto-0.1.10-py3-none-any.whl`, SHA-256
  `a0c371d22479cedf5ac2051010789211196b3e6bd8e25b8c5600e55d11945480`, and
  `antlr4-python3-runtime` 4.13.2. `pietto lsp --help` exits 0, and the
  server reported `serverInfo` `pietto 0.1.10`.
- A pietto without `pietto lsp`: the released 0.1.9 wheel, SHA-256
  `d8b8567556482edd3cdfbb47c1213bcc4698f56cf0fbdb0c44b40d90e0004e2d`, in a
  second virtual environment (`PIETTO_TEST_OLD_PYTHON`).
- Grammar fixtures: `tests/sync_language.py`, run with the
  `PIETTO_TEST_PYTHON` interpreter, read a `git archive` of the release
  commit; the fixtures record its tree id,
  `dceca22cc2ae0c1a5dabfb7d047d59d283912996`. `tests/fixtures/corpus.json`
  holds 77 distinct Pietto code blocks (1,447 lines) with 1,108 keyword uses
  and 121 keyword-spelled names, as Pietto's parser read them. A second run
  wrote the same bytes.

## Results

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts --offline` | PASS |
| `npm run build` (TypeScript) | PASS |
| `npm run lint` (ESLint) | PASS |
| `npm test`: TextMate grammar word lists against the fixture snapshot, the corpus (keyword and name scopes, whole strings, numbers and comments), focused grammar cases, language configuration, the snippets (each of the 26 expanded in its smallest file or project passes `pietto check` with no diagnostic and `pietto fmt --check`), launch arguments, the probe's failure messages, list settings, root resolution, WSL path mapping, the server script run by the real interpreter | 24/24 PASS, none skipped; with no interpreter (`PIETTO_TEST_PYTHON` unset or missing, no `.local/pietto-venv`) the snippet and server-script tests fail instead of skipping |
| `npm run test:host`: the acceptance below, against the source tree | 11/11 PASS |
| `npm run test:restricted`: real Restricted Mode, Workspace Trust enabled | PASS |
| `npm run package` with `SOURCE_DATE_EPOCH=1791876535` | PASS; `artifacts/pietto-vscode-extension-0.2.1.vsix`, 520,013 bytes, SHA-256 `9c9c286de895552d9e3b5b519cac9c31da0f82e3cf09d74ce1862f59a16918eb`, the same on a second build |
| `npm run test:vsix`: the VSIX installed into an isolated profile, then the same acceptance against the installed copy | 11/11 PASS |
| `pietto lsp` processes left after all runs | none |

The VSIX holds `out/src`, the grammar, snippets, language configuration,
examples, the four images that `package.json` and the README name, README,
CHANGELOG, LICENSE (byte-identical to the repository's) and the production
`node_modules` only; `vsce` warns that the extension is not bundled.

## Acceptance

The host tests open a workspace with an EXPLICIT_MODULES project
(`project/pietto.toml`, `schema_version = 2`, modules `models/users.pietto`
and `models/report.pietto`, where `report` imports `users` and selects the
unknown field `emial`), a second configuration `project/models/pietto.toml`
that selects the same modules, and `loose/outside.pietto` outside the project.
Every diagnostic comes from the real `pietto lsp`.

1. **Project root.** `Pietto: Select Explicit Project Root` stores
   `pietto.projectRoots: ["project"]`. `report.pietto` then has exactly one
   diagnostic: code `PIE-S2102`, message `Unknown field: emial`, Error, range
   7:8–7:13 covering `emial`. The import resolves, so there is no `PIE-S2708`.
   Exactly one `pietto lsp` child of the extension host runs, with `-I`.
2. **Fix by edit.** An unsaved edit to `email` clears the diagnostic; the file
   on disk is unchanged and the buffer stays dirty.
3. **Outside the root.** `loose/outside.pietto` is checked as a single file:
   `PIE-S2708` (Warning, 0:0–1:17, the import) and `PIE-S2301`
   `Unknown relation: users` (Error, 4:4–4:14).
4. **Editor-only message.** With roots `["project", "project/models"]` both
   modules, the open one and the unopened one, get only
   `This file belongs to two project roots: <root>/project and <root>/project/models. Keep one of them in projectRoots.`:
   no code, Error, at 0:0. The outside file keeps its single-file diagnostics.
5. **Single file mode.** `Pietto: Use Single File Mode` sets the roots to
   `[]`; the open module is checked as a single file (`PIE-S2301`,
   `PIE-S2708`) and the unopened module's diagnostics are gone.
6. **Untitled buffer.** An untitled Pietto buffer gets `PIE-S2301`
   `Unknown relation: nowhere` at 1:4–1:16.
7. **No pietto.** The same interpreter with `-S` (no site-packages) gives one
   error message, `... could not run "pietto lsp" (ModuleNotFoundError: No module named 'pietto'). Install pietto 0.1.10 or later ...`;
   three seconds later there is still one message, no client, no server
   process and no stale diagnostics.
8. **Recovery and restart.** Removing `-S` brings the diagnostics back with
   one server; `Pietto: Restart Language Server` replaces it with a new
   process.
9. **Empty interpreter path.** `pietto.pythonPath` set to `""` gives one
   message, `Pietto diagnostics are off: "" could not run "pietto lsp" (The argument 'file' cannot be empty. ...`,
   and no server; restoring the setting brings the diagnostics back.
10. **A server that never answers.** A stand-in interpreter (a shell script)
   passes the `--help` probe, then reads requests without answering. After
   30 seconds there is one message, `... has not answered within 30 seconds. ...`;
   restoring `pietto.pythonPath` then replaces the silent process with one
   real server and the diagnostics come back.
11. **Pietto without lsp.** The released 0.1.9 gives one message with
   `pietto: error: argument command: invalid choice: 'lsp' ...`, no server;
   restoring the interpreter brings the diagnostics back.

Restricted Mode: the workspace is untrusted, the user interpreter is the real
one and the workspace names a fake one with `pietto.projectRoots: ["."]`. After
opening a file with an error and running `Pietto: Restart Language Server`,
five seconds pass with no client, no `pietto lsp` process, no diagnostics and
no message; the workspace interpreter is ignored; the snippets (`all`,
`any`, `asof`, `collect`, `constant`, `count`, `count_distinct`, `def`,
`enum`, `export`, `first`, `import`, `join` twice, `last`, `median`,
`quantile`, `query` five times, `relationship`, `shape`, `source`, `sum`,
`unique`, `unnest`, `variance`) are offered, and
indented blocks fold without their trailing blank lines (VS Code's indentation
folding with `folding.offSide`; folds 0–1, 3–6 and 5–6 of the test file).

## Not run

- Windows: native Windows Python, the Windows desktop with the `wsl.exe`
  launcher (its path mapping has unit tests only), and a Remote WSL session.
- macOS, and VS Code 1.90.0, the oldest version `engines.vscode` admits.
- Pixel inspection of highlighting and of the icons; the grammar is checked
  by the TextMate tests, and the icons by the VSIX manifest and the VS Code
  logs of the VSIX run.
- The open-under-two-URIs, letter-case and partial-change editor messages, and
  the Not checked message; the host tests cover the two-roots message.
