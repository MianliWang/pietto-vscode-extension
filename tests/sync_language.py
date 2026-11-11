"""Snapshot the Pietto language for the TextMate grammar tests.

Usage, with an interpreter that has the Pietto dependencies (antlr4):

    python -I -B tests/sync_language.py TREE [TREE ...]

Each TREE is an extracted Pietto source tree, such as
`git -C pietto archive REV | tar -x -C TREE`. The script computes each tree's
git tree id itself and writes, for the union of the trees:

- tests/fixtures/language.json: the keywords of grammar/Pietto.g4 (all of
  them, those a name may also spell, and the retired header words; checked
  against the tree's generated lexer both ways) and the built-in types, scalar
  functions, aggregates (the sets `semantic_aggregate_call_name` tests) and
  window functions of src/pietto/semantic/{catalog,aggregates,window_semantics}.py;
- tests/fixtures/corpus.json: every ```pietto block of README.md,
  docs/language.md, docs/style.md and docs/worked-example.md and every
  examples/**/*.pietto file, once per distinct text, with each origin (tree
  id, path, line) and, from the tree's own lexer and parser, the position and
  role (keyword or name) of each keyword token, and the string, number and
  comment spans.

An origin's line is the one-based file line of the block's first line; the
lines and columns of the spans are zero-based within the block.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ("README.md", "docs/language.md", "docs/style.md", "docs/worked-example.md")
HEADER_RULES = ("versionDecl", "modeDecl", "dialectDecl", "encodingDecl")
NAME_RULES = ("identifier", "softKeyword", "typeArgumentName")


def git_tree_id(path: Path) -> str:
    """The git tree id of a directory, as `git write-tree` would record it."""

    def digest(kind: bytes, data: bytes) -> bytes:
        return hashlib.sha1(b"%s %d\0" % (kind, len(data)) + data).digest()

    def tree(directory: Path) -> bytes:
        entries = []
        for child in directory.iterdir():
            name = child.name.encode()
            if child.is_symlink():
                entries.append((name, b"120000", digest(b"blob", os.readlink(child).encode())))
            elif child.is_dir():
                entries.append((name + b"/", b"40000", tree(child)))
            else:
                mode = b"100755" if child.stat().st_mode & 0o111 else b"100644"
                entries.append((name, mode, digest(b"blob", child.read_bytes())))
        entries.sort()
        return digest(b"tree", b"".join(m + b" " + n.rstrip(b"/") + b"\0" + h for n, m, h in entries))

    return tree(path).hex()


def grammar_words(text: str) -> dict[str, object]:
    text = re.sub(r"//[^\n]*", "", text)
    keywords: dict[str, list[str]] = {}
    # A lexer rule may span lines and quote a `;`.
    for rule, body in re.findall(r"^([A-Z][A-Z_]*)\s*:((?:'(?:\\.|[^'\\])*'|[^';])*);", text, re.MULTILINE):
        spellings = re.findall(r"'([^']*)'", body)
        if spellings and all(s.isalpha() for s in spellings):
            keywords[rule] = spellings
    rules = dict(re.findall(r"^([a-z]\w*)\s*:(.*?)^\s*;", text, re.MULTILINE | re.DOTALL))

    def spell(names: set[str]) -> list[str]:
        return sorted({s for name in names & keywords.keys() for s in keywords[name]})

    def tokens(*names: str) -> set[str]:
        return {t for name in names for t in re.findall(r"\b[A-Z][A-Z_]*\b", rules[name])}

    return {
        "keywords": spell(set(keywords)),
        "names": spell(tokens(*NAME_RULES)),
        "header": spell(tokens(*HEADER_RULES)),
        "_rules": sorted(keywords),
    }


def module_sets(path: Path, wanted) -> set[str]:
    """The strings of the module-level constants whose name `wanted` accepts,
    following names, set operations, starred items and call arguments."""

    module = ast.parse(path.read_text(encoding="utf-8"))
    values: dict[str, list[ast.expr]] = {}
    for node in module.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and node.value:
            targets = [node.target]
        else:
            continue
        for target in targets:
            if isinstance(target, ast.Name):
                values.setdefault(target.id, []).append(node.value)

    def strings(node: ast.AST) -> set[str]:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return {node.value}
        if isinstance(node, ast.Name):
            return {s for value in values.get(node.id, []) for s in strings(value)}
        if isinstance(node, ast.Call):
            return {s for arg in node.args for s in strings(arg)}
        if isinstance(node, (ast.Set, ast.Tuple, ast.List)):
            return {s for item in node.elts for s in strings(item)}
        if isinstance(node, ast.Starred):
            return strings(node.value)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return strings(node.left) | strings(node.right)
        raise ValueError(f"{path}: unsupported constant form {ast.dump(node)[:80]}")

    return {s for name, nodes in values.items() if wanted(name) for node in nodes for s in strings(node)}


def catalog(src: Path) -> dict[str, list[str]]:
    semantic = src / "pietto" / "semantic"
    catalog_tree = ast.parse((semantic / "catalog.py").read_text(encoding="utf-8"))
    functions = {
        node.args[0].value
        for node in ast.walk(catalog_tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "BuiltinFunction"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    }
    functions |= module_sets(semantic / "catalog.py", lambda n: n == "SPECIAL_BUILTIN_FUNCTION_NAMES")
    # Aggregates: every set the analyzer's classifier tests a call name against.
    aggregates_tree = ast.parse((semantic / "aggregates.py").read_text(encoding="utf-8"))
    classifier = [
        node
        for node in aggregates_tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "semantic_aggregate_call_name"
    ]
    if not classifier:
        raise ValueError("aggregates.py: no semantic_aggregate_call_name")
    aggregates: set[str] = set()
    for node in ast.walk(classifier[0]):
        if isinstance(node, ast.Compare) and isinstance(node.ops[0], ast.In):
            tested = node.comparators[0]
            found = module_sets(semantic / "aggregates.py", tested.id.__eq__) if isinstance(tested, ast.Name) else None
            if not found:
                raise ValueError(f"semantic_aggregate_call_name: unsupported test {ast.unparse(node)}")
            aggregates |= found
    return {
        "types": sorted(module_sets(semantic / "catalog.py", lambda n: n == "BUILTIN_TYPE_NAMES")),
        "functions": sorted(functions),
        "aggregates": sorted(aggregates),
        "windowFunctions": sorted(
            module_sets(semantic / "window_semantics.py", lambda n: n == "WINDOW_FUNCTION_NAMES")
        ),
    }


def blocks(tree: Path):
    for name in DOCS:
        lines = (tree / name).read_text(encoding="utf-8").splitlines()
        index = 0
        while index < len(lines):
            fence = re.match(r"^(\s*)```(pietto\b.*)$", lines[index])
            if fence:
                indent, start = len(fence.group(1)), index + 1
                end = start
                while not re.match(r"^\s*```\s*$", lines[end]):
                    end += 1
                text = "".join(line[indent:] + "\n" for line in lines[start:end])
                yield {"path": name, "line": start + 1, "fence": fence.group(2).strip()}, text
                index = end
            index += 1
    for path in sorted((tree / "examples").rglob("*.pietto")):
        yield {"path": path.relative_to(tree).as_posix(), "line": 1}, path.read_text(encoding="utf-8")


# Runs in a child interpreter with the tree's src first on sys.path.
PARSE = r"""
import json, re, sys
sys.path.insert(0, sys.argv[1])
from antlr4 import CommonTokenStream, InputStream
from antlr4.atn.LexerATNSimulator import LexerATNSimulator
from antlr4.ListTokenSource import ListTokenSource
from antlr4.PredictionContext import PredictionContextCache
from antlr4.Token import Token
from antlr4.tree.Tree import TerminalNode
from pietto.generated.PiettoLexer import PiettoLexer
from pietto.generated.PiettoParser import PiettoParser
from pietto.indentation import inject_indentation, join_parenthesized_lines
from pietto.parser_api import parse_source

request = json.load(sys.stdin)
missing = sorted(set(request["rules"]) - set(PiettoLexer.symbolicNames))
literals = {name[1:-1] for name in PiettoLexer.literalNames if name.startswith("'")}
unread = sorted({word for word in literals if word.isalpha()} - set(request["spellings"]))
if missing or unread:
    sys.exit(f"Pietto.g4 and its generated lexer disagree: keyword rules not in the lexer {missing}, "
             f"lexer keywords not read from Pietto.g4 {unread}")
keyword_types = {getattr(PiettoLexer, name) for name in request["rules"]}
name_parents = (PiettoParser.IdentifierContext, PiettoParser.SoftKeywordContext, PiettoParser.TypeArgumentNameContext)

class LineEndSimulator(LexerATNSimulator):
    def consume(self, input):
        character = input.LA(1)
        if character == 0x0A or (character == 0x0D and input.LA(2) != 0x0A):
            self.line += 1
            self.column = 0
        else:
            self.column += 1
        input.consume()

class SourceLexer(PiettoLexer):
    def __init__(self, input):
        super().__init__(input)
        self._interp = LineEndSimulator(self, self.atn, self.decisionsToDFA, PredictionContextCache())

def source_tokens(text):
    lexer = SourceLexer(InputStream(text))
    lexer.removeErrorListeners()
    tokens = []
    while True:
        token = lexer.nextToken()
        tokens.append(token)
        if token.type == Token.EOF:
            return tokens

def syntax_tree(text):
    # The public parser admits the source; this tree supplies grammar roles.
    raw = source_tokens(text)
    joined = join_parenthesized_lines(
        raw,
        newline_type=PiettoLexer.NEWLINE,
        open_type=PiettoLexer.LPAREN,
        close_type=PiettoLexer.RPAREN,
        window_type=PiettoLexer.WINDOW,
        colon_type=PiettoLexer.COLON,
        path=None,
    )
    if joined.diagnostics:
        return None
    tokens = list(
        inject_indentation(
            joined.tokens,
            newline_type=PiettoLexer.NEWLINE,
            indent_type=PiettoParser.INDENT,
            dedent_type=PiettoParser.DEDENT,
            path=None,
        ).tokens
    )
    layout = {Token.EOF, PiettoLexer.NEWLINE, PiettoParser.INDENT, PiettoParser.DEDENT}
    starts = [
        index
        for index, token in enumerate(tokens)
        if token.column == 0 and token.type not in layout and (index == 0 or tokens[index - 1].type in layout)
    ]
    for index in starts:
        token = tokens[index]
        if (
            token.type == PiettoLexer.IDENTIFIER
            and index + 1 < len(tokens)
            and tokens[index + 1].type == PiettoLexer.COLON
        ):
            depth = 0
            for candidate in tokens[index + 2:]:
                if candidate.type in {Token.EOF, PiettoLexer.NEWLINE, PiettoParser.INDENT, PiettoParser.DEDENT}:
                    break
                depth += (candidate.type == PiettoLexer.LPAREN) - (candidate.type == PiettoLexer.RPAREN)
                if candidate.type == PiettoLexer.ASSIGN and depth == 0:
                    token.type = PiettoParser.CONSTANT_NAME
                    break
    parser = PiettoParser(CommonTokenStream(ListTokenSource(tokens)))
    parser.removeErrorListeners()
    tree = parser.script()
    return None if parser.getNumberOfSyntaxErrors() else tree

def keyword_roles(tree):
    if tree is None:
        return None
    keywords = []
    def walk(node):
        if isinstance(node, TerminalNode):
            token = node.symbol
            if token.type in keyword_types and token.tokenIndex >= 0 and token.line > 0:
                role = "name" if isinstance(node.parentCtx, name_parents) else "keyword"
                keywords.append([token.line - 1, token.column, token.text, role])
            return
        for child in node.getChildren():
            walk(child)
    walk(tree)
    keywords.sort()
    return keywords

def parsed_tree(text):
    result = parse_source(text)
    migrated_spelling = result.diagnostics and all(
        diagnostic.code == "PIE-P1000"
        and diagnostic.message.startswith("This spelling is not accepted by the modern syntax.")
        for diagnostic in result.diagnostics
    )
    return result, syntax_tree(text) if result.ast is not None or migrated_spelling else None

def self_check():
    for name, text, expected in (
        ("LF", "shape S:\n    id: Int\nshape T:\n    id: Int\n", [[0, 0, "shape", "keyword"], [2, 0, "shape", "keyword"]]),
        ("CRLF", "shape S:\r\n    id: Int\r\nshape T:\r\n    id: Int\r\n", [[0, 0, "shape", "keyword"], [2, 0, "shape", "keyword"]]),
        ("lone CR", "shape S:\r    id: Int\rshape T:\r    id: Int\r", [[0, 0, "shape", "keyword"], [2, 0, "shape", "keyword"]]),
        ("retired header", "pietto 0.9\nshape Legacy:\n    id: Int\n", [[0, 0, "pietto", "keyword"], [1, 0, "shape", "keyword"]]),
    ):
        result, tree = parsed_tree(text)
        if keyword_roles(tree) != expected:
            sys.exit(
                f"{name} parser role self-check failed: {keyword_roles(tree)!r}; "
                f"diagnostics {[item.code for item in result.diagnostics]}"
            )

self_check()
out = []
for text in request["texts"]:
    tokens = source_tokens(text)[:-1]
    lines = re.split(r"\r\n|\r|\n", text)
    def span(token):
        return [token.line - 1, token.column, token.column + len(token.text)]
    strings = [span(t) for t in tokens if t.type in (PiettoLexer.STRING, PiettoLexer.UNTERMINATED_STRING)]
    comments = []
    for number, line in enumerate(lines):
        for column, char in enumerate(line):
            if char == "#" and not any(s[0] == number and s[1] <= column < s[2] for s in strings):
                comments.append([number, column])
                break
    result, tree = parsed_tree(text)
    keywords = keyword_roles(tree)
    out.append({
        "keywords": keywords,
        "strings": strings,
        "numbers": [span(t) for t in tokens if t.type == PiettoLexer.NUMBER],
        "comments": comments,
        "diagnostics": [d.code for d in result.diagnostics],
    })
json.dump(out, sys.stdout)
"""


def parse(src: Path, rules: list[str], spellings: list[str], texts: list[str]) -> list[dict]:
    # The child's stderr goes to ours, so a failure shows its reason.
    process = subprocess.run(
        [sys.executable, "-I", "-B", "-c", PARSE, str(src)],
        input=json.dumps({"rules": rules, "spellings": spellings, "texts": texts}),
        stdout=subprocess.PIPE,
        check=False,
        text=True,
    )
    if process.returncode:
        raise SystemExit(f"{src}: the parse step failed (exit {process.returncode}), see its error above")
    return json.loads(process.stdout)


def main(arguments: list[str]) -> int:
    if not arguments:
        print(__doc__, file=sys.stderr)
        return 2
    trees = [(Path(argument).resolve(), git_tree_id(Path(argument).resolve())) for argument in arguments]
    language: dict[str, set[str]] = {}
    corpus: dict[str, dict] = {}
    for tree, tree_id in trees:
        words = grammar_words((tree / "grammar" / "Pietto.g4").read_text(encoding="utf-8"))
        rules = words.pop("_rules")
        for key, values in {**words, **catalog(tree / "src")}.items():
            language.setdefault(key, set()).update(values)
        fresh: list[str] = []
        for origin, text in blocks(tree):
            entry = corpus.setdefault(text, {"origins": [], "text": text})
            entry["origins"].append({"tree": tree_id, **origin})
            if "parsedBy" not in entry:
                entry["parsedBy"] = tree_id
                fresh.append(text)
        for text, facts in zip(fresh, parse(tree / "src", rules, words["keywords"], fresh)):
            corpus[text].update(facts)
    fixtures = ROOT / "tests" / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    snapshot = {"trees": [tree_id for _, tree_id in trees], **{k: sorted(v) for k, v in language.items()}}
    (fixtures / "language.json").write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    # One block per line, so that a diff shows the blocks that changed.
    blocks_json = ",\n".join(json.dumps(block, ensure_ascii=False) for block in corpus.values())
    document = f'{{"trees": {json.dumps(snapshot["trees"])}, "blocks": [\n{blocks_json}\n]}}\n'
    (fixtures / "corpus.json").write_text(document, encoding="utf-8")
    print(f"{len(corpus)} distinct blocks from {len(trees)} trees: {', '.join(snapshot['trees'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
