# Verification

Local runs of version 0.4.0 on 2026-11-13 (UTC). They are not CI and not a
Marketplace publication. Reproduce with the commands in
[Develop and verify](../README.md#develop-and-verify).

## Environment

- Linux, WSL2 Ubuntu 26.04.1 (kernel 6.18.58.1-microsoft-standard-WSL2),
  display through WSLg (`DISPLAY=:0`).
- VS Code 1.145.2 for linux-x64 (commit
  `c4453f8ea430795f941c1b2ff6c9321135a74a02`), a copy that
  `@vscode/test-electron` had downloaded earlier, passed as
  `VSCODE_EXECUTABLE`, with its own user data and extensions folders. The host
  has no system NSS or ALSA libraries, so `LD_LIBRARY_PATH` named a
  user-local copy of them. No other VS Code installation or profile was used.
- Node 22.23.4, npm 10.9.9, dependencies from `package-lock.json`
  (`npm ci --ignore-scripts`). Runtime dependency `vscode-languageclient`
  9.0.1 with `vscode-languageserver-protocol` 3.17.5, `vscode-jsonrpc` 8.2.0,
  `vscode-languageserver-types` 3.17.5, `semver` 7.8.5, `minimatch` 5.1.9,
  `brace-expansion` 2.1.7, `balanced-match` 1.0.2.
- Pietto 0.1.11 from PyPI (tag
  [v0.1.11](https://github.com/MianliWang/pietto/releases/tag/v0.1.11), commit
  `d03d6e4b4928e798b3f3704bc2c654e6eaa0c176`, tree
  `758f7e1cfc103a53102507ea69f536561829b09d`), installed with
  `uv pip install --no-cache pietto==0.1.11` into a CPython 3.13.13 virtual
  environment. The files it installed match the `RECORD` of
  `pietto-0.1.11-py3-none-any.whl` on PyPI, SHA-256
  `67fa2317c490b9fc11ea5ea9ed09459199e79259ddae626ba50750b1026abfaa`, with
  `antlr4-python3-runtime` 4.13.2. The server reported `serverInfo`
  `pietto 0.1.11` and announced `completionProvider`, `hoverProvider`,
  `definitionProvider`, `documentSymbolProvider`,
  `documentFormattingProvider`, `workspaceSymbolProvider` and
  `documentLinkProvider` besides document synchronization and the `utf-16`
  position encoding.
- Pietto 0.1.10 from PyPI, the first release with `pietto lsp` (tag
  [v0.1.10](https://github.com/MianliWang/pietto/releases/tag/v0.1.10), commit
  `8e7c43f1852b2c26318b3217268a1f7416f44965`, tree
  `dceca22cc2ae0c1a5dabfb7d047d59d283912996`), installed the same way into a
  second environment; its files match the `RECORD` of
  `pietto-0.1.10-py3-none-any.whl`, SHA-256
  `a0c371d22479cedf5ac2051010789211196b3e6bd8e25b8c5600e55d11945480`. The
  server reported `serverInfo` `pietto 0.1.10` and announced document
  synchronization and the `utf-16` position encoding only.
- With each of them as `PIETTO_TEST_PYTHON`, `npm test` and
  `npm run test:vsix` ran once and `npm run test:host` ran three times with
  0.1.10 and twice with 0.1.11; `test:restricted` ran with 0.1.11.
- A pietto without `pietto lsp`: the released 0.1.9 wheel, SHA-256
  `d8b8567556482edd3cdfbb47c1213bcc4698f56cf0fbdb0c44b40d90e0004e2d`, in a
  third virtual environment (`PIETTO_TEST_OLD_PYTHON`).
- Grammar fixtures: unchanged since 0.2.1. `tests/sync_language.py` read a
  `git archive` of the 0.1.10 release commit, and the fixtures record its
  tree id, `dceca22cc2ae0c1a5dabfb7d047d59d283912996`. `grammar/Pietto.g4` is
  the same in v0.1.10 and v0.1.11; the fixtures were not regenerated from
  0.1.11.

## Results

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | PASS |
| `npm run build` (TypeScript) | PASS |
| `npm run lint` (ESLint) | PASS |
| `npm test`: TextMate grammar word lists against the fixture snapshot, the corpus (keyword and name scopes, whole strings, numbers and comments), focused grammar cases, language configuration, the snippets (each of the 26 expanded in its smallest file or project passes `pietto check` with no diagnostic and `pietto fmt --check`), launch arguments, the probe's failure messages, list settings, root resolution, WSL path mapping, the server script run by the real interpreter, the SQL previews, quick fixes, Pietto Models and target diagnostics | pietto 0.1.11: 56/56 PASS; pietto 0.1.10: 56/56 PASS; none skipped |
| `npm run test:host`: the acceptance below, against the source tree | pietto 0.1.11: 35/35 PASS, no SKIP, in each run; pietto 0.1.10: 28 PASS and 7 SKIP (the steps of the 0.1.11 editor features), no FAIL, in each run |
| `npm run test:restricted`: real Restricted Mode, Workspace Trust enabled | PASS |
| `npm run package` with `SOURCE_DATE_EPOCH=1794528000` | PASS; `artifacts/pietto-vscode-extension-0.4.0.vsix`, 544,883 bytes, SHA-256 `b8f6081bce515c2fee1b6da7ed8071a3780c2f2457802212f497d8dc59402bc0`, the same on two builds from a `git archive` of the commit |
| `npm run test:vsix`: the VSIX installed into an isolated profile, then the same acceptance against the installed copy | pietto 0.1.11: 35/35 PASS, no SKIP; pietto 0.1.10: 28 PASS and 7 SKIP, no FAIL |
| `pietto lsp` processes left after all runs | none |

The VSIX has 341 entries: `out/src` (six files), the grammar, snippets,
language configuration, examples, the four images that `package.json` and the
README name, README, CHANGELOG, LICENSE (byte-identical to the repository's)
and the production `node_modules` only (the runtime dependencies above);
`vsce` warns that the extension is not bundled. `vsce` rewrites the relative
links of the packaged README and CHANGELOG to `blob/HEAD` of the GitHub
repository.

## Acceptance

The host tests open a workspace with an EXPLICIT_MODULES project
(`project/pietto.toml`, `schema_version = 2`, modules `models/users.pietto`,
`models/report.pietto`, where `report` imports `users` and selects the
unknown field `emial`, and `models/facts.pietto`, which imports the shape
`User` and the source `users`), a second configuration
`project/models/pietto.toml` that selects the same modules, files outside the
project such as `loose/outside.pietto` and `loose/format.pietto`, and an emit
project. Every diagnostic comes from the real `pietto lsp`. The steps of the
SQL previews, quick fixes, Pietto Models and target diagnostics are named in
`tests/host/index.ts`, and each run writes every step that runs with its
details to `artifacts/host-results.json` (`artifacts/vsix-host-results.json`
for `test:vsix`); a step that the server's capabilities skip prints its
`SKIP` line only and is not written there.

### Diagnostics and the server

1. **Project root.** Once the server started at activation (no roots) has
   initialized, `Pietto: Select Explicit Project Root` stores
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

### pietto 0.1.11 editor features

Each of these steps runs only when the server announces its capability; with
pietto 0.1.10 each printed `SKIP` instead.

12. **Hover, definition, outline.** In `facts.pietto`, hover on the `User` of
   `owner: User` shows `shape User`; definition of that `User` and of
   `from users` goes to `users.pietto` 0:0–2:22 and 4:0–4:51; the outline is
   `Audit`, `audit_users`. A document-symbol request sent right after an edit
   answers once with the edited outline.
13. **Workspace symbols of a root.** The query `user` gives `User` and `users`
   of the unopened `users.pietto` and `audit_users` of `facts.pietto` (VS Code
   sorts them by name).
14. **Import link.** The import path of `facts.pietto` (0:5–0:26) links to
   `users.pietto`.
15. **Completion** on the empty last line of `facts.pietto`: `select` as a
   keyword, `shape` as a keyword and a snippet, `Int`, `coalesce`, the file's
   own `audit_users`, and no `emails`, which only other open files write;
   172 items, 29 of them snippets.
16. **Formatting.** `loose/format.pietto` (a two-space field, three blank
   lines) formats in the buffer to the four-space, one-blank-line layout of
   `pietto fmt`, and the file is unchanged; a formatted buffer gets no edit.
   With `[pietto]` `editor.formatOnSave` on, a save writes the formatted text,
   and a save of the buffer with the syntax error `from (` writes it as typed.
17. **pietto.toml restart.** With definitions, the restored root shows by a
   cross-module definition; with pietto 0.1.10, by a new process and no
   diagnostics in `report.pietto` for five seconds.
18. **Workspace symbols in single file mode.** The empty query lists only
   `Item` and `items` of the open `format.pietto`: nothing of the unopened
   `users.pietto`, and nothing of the open files with errors.

A direct `pietto lsp` 0.1.11 session outside the host suite confirmed that a
single file whose only diagnostic is the `PIE-S2708` warning of its import
gets no import link.

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

- CI with pietto 0.1.11: the workflow runs once these commits are on `main`.
- Windows: native Windows Python, the Windows desktop with the `wsl.exe`
  launcher (its path mapping has unit tests only), and a Remote WSL session.
- macOS, and VS Code 1.90.0, the oldest version `engines.vscode` admits.
- Pixel inspection of highlighting and of the icons; the grammar is checked
  by the TextMate tests, and the icons by the VSIX manifest and the VS Code
  logs of the VSIX run.
- The open-under-two-URIs, letter-case and partial-change editor messages, and
  the Not checked message; the host tests cover the two-roots message.
