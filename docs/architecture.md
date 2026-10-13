# Architecture and capability map

One TypeScript analysis service, native VS Code providers/trees, TextMate
highlighting, and one Python JSON-lines projection. No LSP/webview duplication,
database runtime, source upload, or vendored compiler implementation.

## Reference and runtime identity

The initial supplied reference was `9e74aa681133a359ee825b31a9b8573c29932d7c`.
The owner subsequently updated the target to released **pietto 0.1.2**, release
source/tag `69192849bb2a4ace73c3f806031616a4c89b555b`, S21 audit head
`177c2e18906f22c3d42a9b0c9d65944d9af5a21d`. Phase69 has all 21 slices closed.
Later checkouts are not assumed equivalent to this release.

The first isolated environments were installed from a read-only `git archive`
of release source. At a safe checkpoint after the editor test process exited,
separate environments were created from the official PyPI wheel. Old environments
were preserved. The release wheel is `pietto-0.1.2-py3-none-any.whl`, 2,073,704 bytes,
SHA-256 `123257f48a7b40825a303110253675aebf7a25f304b0ca0780f16259c423840f`.
`artifacts/release-wheel-receipt.json` records the official download URLs,
dependency hashes, environment origins, and installed interface identity.

The actual tested package origins are recorded in `docs/verification.md`. The
adapter hashes every installed package `.py` owner, sorted by exact POSIX-relative
path, rather than trusting distribution metadata. Release compatibility hash:
`f3b882a3a6f1bd2dc5cdbce3aea112a5cf9876162b0157ddd359cb05159c83ee`.
Original baseline hash:
`4dd8c1db45c99f48a0d13f503297ca976091e97b4b315a659e1f5b51b86ecf86`.
Runtime acceptance of the baseline hash is a compatibility gate, not a claim that
the old PyPI 0.1.1 artifact was tested. Identity is captured once per worker;
Refresh and interpreter-setting changes restart it to load/recheck changed code.

## Compiler owners

- `pietto.parser_api.parse_source(source, path=...)`: original live text and
  authored AST/spans. Parse errors have no successful AST. Generated PiettoLexer
  supplies exact token occurrences, contextual identifiers, and string/comment
  exclusions. Original diagnostics remain authoritative during recovery.
- `pietto.semantic.analyze`: single-file semantic model, actual type expansions,
  nullability, source/relation row schemas, FROM resolutions, expression value
  types, LET scopes, windows, and relationship identities.
- `pietto.semantic.catalog`: actual builtin types/functions and signatures.
  Single-file row helpers and existing ORDER/qualified/LET stage owners provide
  editor projections without TypeScript resolution/type inference.
- `_project.config`, `_project.source_selection`, and trusted source loading: explicit
  root/configuration, include/exclude membership, pinned reads, and bounded input.
  `_project.check.check_project_parse_only`, `build_empty_project_semantic_result`,
  and `build_project_completed_semantic_result`: project semantics. The historical
  `empty` function name does not imply a per-file substitute.
- Module catalogs/facades/attribution and semantic fact preservation provide
  authored `(module, namespace, kind, name, occurrence)` identities, canonical
  imports/re-exports, field origins, and stage reference candidates. Completed
  output owners override deferred intermediate schemas. JOIN namespace/window/
  QUALIFY and GROUP ORDER owners determine candidates and reference identity.

Private project/stage APIs stay inside `adapter/analysis.py`, behind the package
fingerprint gate and real-compiler compatibility tests. Only typed projections
cross the boundary. No arbitrary private graph is serialized. Existing check,
Project Explain, metadata artifact, and SQL contracts were inspected as distinct
contracts; none is treated as a ready-made project editor index. Metadata alone
lacks these scoped reference/stage observations and omits connector arguments.

## Analysis and location boundary

Requests carry ID, an optional **explicitly selected** project root, and live
document URI/path/text/version overlays. The core selects disk members. Only
selected sources/configuration are copied to a bounded temporary shadow project,
preserving relative membership and imports; live selected buffers replace those
snapshot bytes. Excluded buffers receive separate single-file analysis. Shadow
files are cleaned on normal completion. Original source and core files are never
rewritten, saved, flattened, or relaxed around the core trust laws.

Replies carry protocol 1, compiler identity, current document states, diagnostics,
symbols/schemas, occurrences, and compiler-produced completion contexts. One
validator checks all projected leaves/ranges before any native provider sees
them. One URI/position boundary converts one-based compiler code-point columns
to zero-based UTF-16. BOM offsets, CRLF, astral characters, Unicode separators,
non-ASCII paths, absent locations, and Windows-to-WSL drive paths have fixtures.
Location-less Problems entries use a labelled document header anchor because
VS Code requires a range; they do not claim an exact compiler location.

Document/dependency/settings/workspace changes clear current observations and
increment an epoch. Older replies cannot publish. One worker and one coalesced
refresh bound pending work. Providers and tree expansion use the current shared
snapshot without compiling again. Per-scope process failures leave independent
successful roots available, with visible error nodes. Caches are current
observations only; timing history is bounded to 20 records. Process timeout,
crash, incompatible/malformed output, shutdown, and workspace removal clear or
restart owned work without blocking synchronous providers.

## Feature-to-evidence map

| Required behavior | Producer/input/scope | Freshness and failure | Verification |
| --- | --- | --- | --- |
| Syntax/edit configuration/snippets | Actual grammar, TextMate, colon/indent folding | Independent of Python; strings/comments/contextual names remain distinct | Real Oniguruma/TextMate tests, snippets parsed by core |
| Diagnostics | Original parser/semantic/project diagnostics and available related spans | Live versions/dependencies; obsolete diagnostics clear; no recovered success | Adapter error/fix/import tests and native Problems host |
| Completion | Compiler catalogs, schemas, stage candidates, bounded syntax recovery | Narrowest context; exact qualifier filtering; no stale authoritative candidates | LET/GROUP/JOIN/window fixtures and real completion insertion |
| Hover/definition | Actual value type/nullability and canonical reference identity | Unknown/ambiguous identity has no invented target | Single/project field/symbol/alias host navigation and UTF-16 selection |
| Outline/model explorer | Authored declarations, checked schemas, origins/relationships | Parsed/checked/error states; URI-scoped identities; current targets at click time | Native outline/tree provider host, refresh identity, same-spelled modules |
| Connections | Authored provider/safe physical mapping plus extension-owned allowlisted JSON | Exact root/module/source binding; invalid config fails closed; live state always not checked | Config/schema tests, secret rejection, native tree, zero network/driver calls |
| Trust/failure/cleanup | VS Code Workspace Trust plus shell-free isolated Python | No process in Restricted Mode; bounded timeout/process/output; disposal | Separate trust-enabled host, real crash/malformed/timeout workers and PID checks |

## Configuration boundary and references

`pietto-connections.json` is an extension-owned format with a JSON Schema and a
matching runtime validator. It is neither a core format nor proof of a working
connection. Only fixed profile fields and explicit scoped mappings are projected.
Raw configuration objects, unknown keys, secret values, and executable data are
not copied into views, logs, or errors. Reads/creation check resolved roots and
reject escaping/dangling links. No credential discovery, SQL, TCP/DNS probes,
driver imports, or catalog fetching is part of preview.

Malloy read-only reference: `4dec85b662bab74a2714f10daefa5a345c68b385`, specifically
`src/extension/tree_views/schema_view.ts`, `connections_view.ts`, and server
definitions/hover/schema completions. Borrowed organization: separate native
trees, typed field hierarchy, scoped IDs, compiler observations, and disposal.
Its runtime, telemetry, silent last-good fallback, and connection policies are
not copied.

Official implementation references: [native trees](https://code.visualstudio.com/api/extension-guides/tree-view),
[TextMate](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide),
[Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust),
[remote host placement](https://code.visualstudio.com/api/advanced-topics/remote-extensions),
and [supported editor test tooling](https://github.com/microsoft/vscode-test).

## Effective skills

- Caveman FULL: actual installed `~/.codex/skills/caveman/SKILL.md`
  in WSL Ubuntu, SHA-256 `415d43518f2b1a9498c15a445d4657117b129ee5e81b19454ce348439cc6672b`.
  This installed revision merges old FULL into its default voice; no separate
  FULL material exists. Technical facts remain intact; repository text is normal English.
- Ponytail FULL: `%USERPROFILE%/.codex/skills/ponytail/SKILL.md`, SHA-256
  `D11DF477B1A4E807155A7E578B135A4D9C52BEEF06EB3A44322940C331A06942`.
  Standard libraries/native VS Code first, one shared bridge, no speculative
  frameworks; required validation, security, accessibility, and behavior remain.

Both actual files were read before substantive implementation. No skill or
global skill configuration was installed/replaced/edited. Code Work was the only
additional implementation skill; Computer Use was read for the attempted GUI
check, whose native helper was unavailable.
