# Local verification evidence

Delivery reference: released PyPI `pietto==0.1.2`, source/tag
`69192849bb2a4ace73c3f806031616a4c89b555b`; owner audit head
`177c2e18906f22c3d42a9b0c9d65944d9af5a21d`. Results below are local execution,
not CI or proof of Marketplace publication. Reproduce with `npm run verify`, then
`npm run package` and `npm run test:vsix`.

## Environment and exact package identity

- Desktop Windows, VS Code `1.141.0`, commit
  `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`, x64. Executable:
  `%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe`.
- Node `22.15.1`, npm `11.4.1`; locked dev dependencies in `package-lock.json`.
- Native CPython `3.12.2`:
  `<extension-checkout>/.local/release-venv/Scripts/python.exe`.
  Package origin:
  `<extension-checkout>/.local/release-venv/Lib/site-packages/pietto`.
- WSL Ubuntu CPython `3.12.3`:
  `<WSL-extension-checkout>/.local/release-venv-wsl/bin/python`.
  Package origin:
  `<WSL-extension-checkout>/.local/release-venv-wsl/lib/python3.12/site-packages/pietto`.
  Placeholders describe the measured layout; ignored identity receipts retain
  exact machine-local paths.
- Both environments install the SHA-verified official PyPI 0.1.2 wheel and ANTLR
  `4.13.2`. The dependency inventory has no DB drivers or PyArrow. Original
  source-build environments and the core Python environment were preserved.
- All 307 installed Python files match the release source build byte for byte;
  consumed signatures and full adapter fingerprint agree across Windows/WSL:
  `f3b882a3a6f1bd2dc5cdbce3aea112a5cf9876162b0157ddd359cb05159c83ee`.
  See `artifacts/release-compatibility-comparison.json`, `release-*-identity.json`,
  and `release-wheel-receipt.json` for read-backs and official wheel URLs/hashes.

## Results

| Check | Observed result |
| --- | --- |
| TypeScript build and ESLint | PASS |
| Real TextMate/Oniguruma, connection/configuration, protocol leaf validation | 11/11 PASS |
| Real compiler adapter, native Python | 12 PASS; 10 project tests explicitly SKIP because the core trusted loader fails on native Windows |
| Real compiler adapter, WSL Python | 22/22 PASS, including all 10 project tests |
| Real desktop Extension Development Host | 15/15 stages PASS; `completed: true`, exit 0 |
| Actual Restricted Mode in a separate trust-enabled host | PASS; `trusted: false`, 0 compiler requests, no compiler process |
| Installed VSIX smoke | `npm run test:vsix` installs into an isolated profile and runs the same 15 host assertions; its actual receipt is `artifacts/vsix-host-results.json` |
| GUI pixel inspection | NOTRUN: Computer Use native pipe returned `系统找不到指定的文件。 (os error 2)` after bounded retries and reinitialization |
| Remote WSL VS Code GUI/session | NOTRUN; the Windows desktop WSL compiler bridge and Linux adapter were executed |
| Browser-only VS Code | Unsupported |
| Publication | Local tests do not establish publication. Git and Marketplace operational receipts are kept in ignored `artifacts/`; Open VSX and GitHub releases are outside scope. |

Host stages demonstrate Problems clearing, real hover/type/nullability,
completions and inserted qualified paths, declaration/field/import navigation,
native outline and model/connection trees, unsaved imported edits with unchanged
disk bytes, older-response rejection, BOM/CRLF/Unicode/UTF-16 selection,
same-spelled multi-root models, authoritative include/exclude membership,
independent folder failure, missing interpreter/recovery, actual malformed/crash/
timeout workers, OS PID termination, untitled analysis without a project root,
bounded metrics, and shared hover observations. Installed-package assertions
read back `extension.extensionPath` to prevent accidentally testing source code.

Adapter fixtures separately verify aliases, ambiguous names without first-match
navigation, hidden JOIN intermediates, pre-match JOIN ON types, LEFT JOIN null
extension, LET prefixes, GROUP ORDER output scope, window inputs, relationship
endpoint identities, metadata lineage, U+2028, parser recovery, compiler
incompatibility, and source/configuration escape rejection. Preview tests trap
TCP/DNS/fetch/process calls; real compiler tests trap sockets and confirm that
DB drivers are not imported. None of these proves live connectivity; every
connection state remains **not checked**.

Latest commands, exit results and measurements are in ignored
`artifacts/verification-final.log`, `host-results.json`, `restricted-host-results.json`,
`host-final.log`, and `vsix-host-results.json`. VSIX content validation checks that
no core checkout, environment, test profile, node_modules, or test helper is
packaged, and that the packaged MIT LICENSE bytes equal the original LICENSE.

## Measurements and practical limits

The preserved first successful source-host run is
`artifacts/history/host-first.pass.json`. One 207-byte, 13-line single-file buffer
measured cold bridge reply **463.897 ms**. An automatic unsaved type edit, without
flushing analysis, reached the requested checked version in **47.954 ms** with
the test profile's **20 ms** debounce (product default is 250 ms). A warm refresh
of **9 observed documents**, one explicit project, and **6 actual compiler requests**
took **644.289 ms**. Ten real Hover requests left compiler request count at
**76 before / 76 after**. These timings are fixture-specific, not a general SLA.

Adapter-only measurements use the 411-byte `examples/single.pietto` and the
4-module example project, two warm repetitions in the same worker:

- Native single cold 236.699 ms; warm 7.371–8.304 ms.
- WSL single cold 6382.907 ms; warm 6.778–6.913 ms.
- WSL project first 3597.226 ms after single-file imports; warm 375.375–474.837 ms.

Exact workload/identity/cache counters are in
`artifacts/adapter-performance-{native,wsl}.json`. The initial WSL fingerprint
read from the Windows mount is expensive. It is cached once per worker; no
speedup is inferred from comparing different workloads. Refresh/settings
restart the worker. Pending work remains one active request and one coalesced
refresh; source/configuration limits and the 20-record metric bound are explicit.

## Repairs and preservation

Integration review repaired global completion shadowing, repeated qualified
insertion, GROUP ORDER scope leakage, JOIN ON pre-match facts, aliases/field
origins, Unicode separator positions, BOM partial declarations, stale tree
targets, source membership and resolved-root boundaries, malformed projected
leaves, per-root failure isolation, configuration link reads/creation, and
ambiguous source bindings. Ponytail simplification retained one service/bridge
and native controls; no webview, LSP duplicate, execution engine, speculative
framework, or core copy was added to shipped code.

Historical failures remain recorded in `artifacts/history/`: the initial
Windows project trusted-open failure was routed through WSL without changing
core laws; platform-dependent fingerprint sorting was made explicit; the host
test's substring `email` incorrectly matched `emails`; and a canceled test
configuration update left a failing interpreter in a task-only workspace.
Test setup/finally cleanup now restore that task configuration through actual
save/configuration events. Failed runs were not relabelled as passes.

The initial local delivery was based on Git HEAD
`80869f37dcb6f58546ec18cb3b7e823982416162`, before committing or publishing.
Original LICENSE SHA-256 remains
`6BF991096877DD6B4AC2E4D49CC4FBFB510FA34DA773AE6DF7FDE04346D1640E`.
Core was read-only throughout. Its owner moved it to audit head `177c2e189...`;
the final read-only status retained untracked `.agents/` and `NUL`. The core
environment still has historical distribution metadata 0.1.1; this extension's
new release environments have actual 0.1.2. No core modification, tag,
repository-setting change, DB operation, or cloud job is part of this extension.
The original local-delivery records and candidate are preserved in ignored
`artifacts/history/`; publication preparation does not rewrite those records.
