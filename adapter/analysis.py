"""Version-bound Pietto editor projection. JSON lines in; data-only facts out.

Run with Python -I -B. This module never executes SQL or imports database drivers.
Private compiler owners are confined here; the extension consumes only this schema.
"""

from __future__ import annotations

from dataclasses import fields, replace
from functools import lru_cache
from hashlib import sha256
from importlib import import_module, metadata
from pathlib import Path, PureWindowsPath
from tempfile import TemporaryDirectory
from time import perf_counter
from urllib.parse import urlparse, unquote
import json
import os
import re
import sys

PROTOCOL = 1
REFERENCE = "69192849bb2a4ace73c3f806031616a4c89b555b"
BASELINE = "9e74aa681133a359ee825b31a9b8573c29932d7c"
API_FINGERPRINT = "f3b882a3a6f1bd2dc5cdbce3aea112a5cf9876162b0157ddd359cb05159c83ee"
BASELINE_FINGERPRINT = "4dd8c1db45c99f48a0d13f503297ca976091e97b4b315a659e1f5b51b86ecf86"
MAX_BYTES = 1_048_576
MAX_DOCUMENTS = 128
MAX_PROJECT_BYTES = 16 * MAX_BYTES


def filesystem_path(value):
    """The sole local Windows-to-WSL path boundary; no UNC/network mapping."""
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError("Invalid filesystem path.")
    windows = PureWindowsPath(value)
    if os.name != "nt" and windows.is_absolute():
        if not re.fullmatch(r"[A-Za-z]:", windows.drive):
            raise ValueError("UNC project paths are unsupported by the WSL bridge.")
        return Path("/mnt", windows.drive[0].lower(), *windows.parts[1:])
    return Path(value)


def original_uri(root, relative):
    windows = PureWindowsPath(root)
    if windows.is_absolute():
        return (windows / PureWindowsPath(relative)).as_uri()
    return (Path(root) / relative).as_uri()


@lru_cache(maxsize=1)
def compiler_identity():
    package = import_module("pietto")
    origin = Path(package.__file__).resolve().parent
    digest = sha256()
    # Pin every Python owner, including generated grammar, transitively used by analysis.
    for path in sorted(origin.rglob("*.py"), key=lambda p: p.relative_to(origin).as_posix()):
        digest.update(path.relative_to(origin).as_posix().encode())
        digest.update(path.read_bytes())
    fingerprint = digest.hexdigest()
    identity = dict(python=sys.executable, origin=str(origin),
                    distributionVersion=metadata.version("pietto"),
                    sourceFingerprint=fingerprint,
                    reference=BASELINE if fingerprint == BASELINE_FINGERPRINT else REFERENCE,
                    compatibleBaseline=BASELINE)
    if fingerprint not in {API_FINGERPRINT, BASELINE_FINGERPRINT}:
        raise ValueError("Incompatible Pietto compiler APIs. Install the documented source reference.")
    return identity


def source_lines(text):
    # ANTLR counts LF. Unicode separators are valid string content, not editor lines.
    return re.split(r"(?<=\n)", text)


def walk(node):
    """Walk only the public authored AST, never semantic authority graphs."""
    from pietto.ast_nodes import Node
    if not isinstance(node, Node):
        return
    yield node
    for member in fields(node):
        if member.name == "span":
            continue
        value = getattr(node, member.name)
        if isinstance(value, Node):
            yield from walk(value)
        elif isinstance(value, tuple):
            for child in value:
                if isinstance(child, Node):
                    yield from walk(child)


def kind(node):
    name = type(node).__name__
    if name == "SetRelationDef":
        return node.kind.value
    return {"TypeDef": "type", "EnumDef": "enum", "ShapeDef": "shape",
            "SourceDef": "source", "TableDef": "table", "QueryDef": "query",
            "ConstraintDef": "constraint", "DeriveDef": "derive",
            "RelationshipMetadata": "relationship"}.get(name, "field")


def type_fact(value):
    if value is None:
        return {}
    return dict(type=value.resolved_type.name, nullability=value.nullability.value)


def field_declaration(owner, field):
    """Project a known field through its exact compiler-resolved input owner."""
    from pietto.ast_nodes import QueryDef, TableDef
    from pietto.semantic.relation_schemas import _projection_output_name
    if isinstance(owner, (TableDef, QueryDef)):
        matches = [item for item in owner.select_items if _projection_output_name(item) == field.name]
        return matches[0] if len(matches) == 1 else None
    return getattr(field, "definition", None) or getattr(field, "field_def", None)


def grouped_candidates(definition, schema, let_expressions, items):
    """Ask the compiler's group key resolver which bare row identities survive."""
    from pietto.ast_nodes import DottedNameExpr, NameExpr
    from pietto.semantic.group_by import _resolve_group_keys, _effective_group_key_expression, _field_identity
    keys, _, _ = _resolve_group_keys(definition, schema, let_expansions=let_expressions)
    identities = {key.identity for key in keys}
    result = []
    for item in items:
        name = item["name"]
        leaf = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
        effective = _effective_group_key_expression(leaf, let_expansions=let_expressions, let_stack=frozenset())
        if _field_identity(definition, effective, schema) in identities:
            result.append(item)
    return result


def window_reference_leaves(expression):
    """Authored window value uses, excluding callable names."""
    from pietto.ast_nodes import CallExpr, DottedNameExpr, NameExpr
    nodes = tuple(walk(expression))
    callees = {id(node.callee) for node in nodes if isinstance(node, CallExpr)}
    return tuple(node for node in nodes if isinstance(node, (NameExpr, DottedNameExpr)) and id(node) not in callees)


def window_binding_definition(binding, definition, input_owner, schema, lets):
    from pietto.semantic.window_input_analysis import WindowInputOriginKind
    from pietto.semantic.relation_schemas import _projection_output_name
    if binding.origin is WindowInputOriginKind.LET_BINDING:
        return lets.get(binding.target_name)
    if binding.origin in {WindowInputOriginKind.GROUP_KEY, WindowInputOriginKind.AGGREGATE_RESULT}:
        targets = [item for item in definition.select_items if _projection_output_name(item) == binding.target_name]
        return targets[0] if len(targets) == 1 else None
    field = schema.fields.get(binding.source_field_name)
    return field_declaration(input_owner, field) if field else None


def window_input_observations(projection, definition, scope, input_owner, schema, lets, checked):
    """Use the existing ROW/GROUP-to-WINDOW scope for both candidates and references."""
    from pietto.ast_nodes import NameExpr, WindowExpr
    qualifier = definition.from_clause.source_name
    items = [projection.item(binding.name, "field", binding.value_type,
        window_binding_definition(binding, definition, input_owner, schema, lets)) for binding in scope.bindings]
    if scope.allows_qualified_fields:
        items += [projection.item(f"{qualifier}.{field.name}", "field", field,
            field_declaration(input_owner, field)) for field in schema.fields.values()]
    for window in (node for node in walk(definition) if isinstance(node, WindowExpr)):
        projection.context(window.span, "window", items)
        if not checked:
            continue
        for leaf in window_reference_leaves(window):
            binding = scope.resolve(leaf, field_qualifier=qualifier)
            if binding is None or sum(b.name == binding.name for b in scope.bindings) != 1:
                continue
            name = leaf.name if isinstance(leaf, NameExpr) else ".".join(leaf.parts)
            target = window_binding_definition(binding, definition, input_owner, schema, lets)
            projection.bound_occurrence(leaf, name, binding.value_type, target)


class Projection:
    def __init__(self, documents):
        from antlr4 import InputStream
        from antlr4.Token import Token
        from pietto.generated.PiettoLexer import PiettoLexer
        self.documents = documents
        self.results = {}
        self.tokens = {}
        for path, document in documents.items():
            self.results[path] = dict(uri=document["uri"], version=document["version"],
                                     state="parsed", diagnostics=[], symbols=[],
                                     occurrences=[], contexts=[])
            lexer = PiettoLexer(InputStream(document["text"].removeprefix("\ufeff")))
            lexer.removeErrorListeners()
            tokens = []
            while True:
                token = lexer.nextToken()
                if token.type == Token.EOF:
                    break
                tokens.append(token)
            self.tokens[path] = tokens
            from pietto.ast_nodes import Span
            for token in tokens:
                if token.type == PiettoLexer.STRING:
                    self.context(Span(path=path, line=token.line, column=token.column + 1,
                        end_line=token.line, end_column=token.column + 1 + len(token.text)), "excluded", [])
            source = document["text"].removeprefix("\ufeff")
            strings = [(t.start, t.stop + 1) for t in tokens if t.type == PiettoLexer.STRING]
            for match in re.finditer(r"#[^\r\n]*", source):
                if any(start <= match.start() < end for start, end in strings):
                    continue
                line = source.count("\n", 0, match.start()) + 1
                column = match.start() - (source.rfind("\n", 0, match.start()) + 1) + 1
                self.context(Span(path=path, line=line, column=column, end_line=line,
                    end_column=column + len(match.group())), "excluded", [])

    def position(self, path, line, column):
        source = self.documents[path]["text"]
        lines = source_lines(source)
        index = max(0, line - 1)
        text = lines[index].rstrip("\r\n") if index < len(lines) else ""
        offset = max(0, column - 1) + (1 if index == 0 and source.startswith("\ufeff") else 0)
        return dict(line=index, character=len(text[:offset].encode("utf-16-le", "surrogatepass")) // 2)

    def range(self, span):
        path = span.path
        if path not in self.documents:
            return None
        return dict(start=self.position(path, span.line, span.column),
                    end=self.position(path, getattr(span, "end_line", None) or span.line,
                                      getattr(span, "end_column", None) or span.column))

    def name_range(self, node, name=None, after=None):
        name = name or getattr(node, "name", "") or getattr(node, "alias", "")
        if not name and hasattr(node, "expression"):
            name = getattr(node.expression, "name", "") or (getattr(node.expression, "parts", ("",))[-1])
        span = node.span
        # Token evidence preserves keyword-identifiers and excludes strings/comments.
        passed = after is None
        for token in self.tokens.get(span.path, ()):
            if token.line == span.line and token.column + 1 >= span.column and token.text == after:
                passed = True
                continue
            if (token.line == span.line and token.column + 1 >= span.column
                    and token.text == name and passed):
                return dict(start=self.position(span.path, token.line, token.column + 1),
                            end=self.position(span.path, token.line, token.column + 1 + len(token.text)))
        return self.range(span)

    def target(self, node, name=None):
        if node is None or node.span.path not in self.documents:
            return None
        return dict(uri=self.documents[node.span.path]["uri"], range=self.name_range(node, name))

    def occurrence(self, node, name, category, value=None, definition=None, documentation=None, exact=False, after=None):
        result = self.results.get(node.span.path)
        if result is None:
            return
        item = dict(range=self.range(node.span) if exact else self.name_range(node, name, after),
                    name=name, kind=category, **type_fact(value))
        target = self.target(definition)
        if target:
            item["definition"] = target
        if documentation:
            item["documentation"] = documentation
        result["occurrences"].append(item)

    def bound_occurrence(self, node, name, value, definition):
        observations = self.results[node.span.path]["occurrences"]
        observations[:] = [item for item in observations if item["range"] != self.range(node.span)]
        self.occurrence(node, name, "field", value, definition, exact=True)

    def diagnostic(self, diagnostic, related=()):
        path = diagnostic.location.path
        result = self.results.get(path)
        if result is None:
            return
        item = dict(code=diagnostic.code, severity=diagnostic.severity.value,
                    message=diagnostic.message)
        location = self.range(diagnostic.location)
        if location:
            item["range"] = location
        if diagnostic.suggestion:
            item["suggestion"] = diagnostic.suggestion
        locations = []
        for span in related:
            if span.path in self.documents:
                locations.append(dict(uri=self.documents[span.path]["uri"], range=self.range(span),
                                      message="Related compiler location"))
        if locations:
            item["related"] = locations
        result["diagnostics"].append(item)

    def item(self, name, category, value=None, definition=None):
        item = dict(name=name, kind=category, **type_fact(value))
        target = self.target(definition)
        if target:
            item["definition"] = target
        return item

    def context(self, span, category, items):
        if span is not None and span.path in self.results:
            self.results[span.path]["contexts"].append(
                dict(range=self.range(span), kind=category, items=items))

    def block_span(self, definition, keyword):
        from pietto.ast_nodes import Span
        tokens = self.tokens[definition.span.path]
        indentation = definition.from_clause.span.column - 1
        header = next((t for t in tokens if t.text == keyword
                       and definition.span.line < t.line <= definition.span.end_line
                       and t.column == indentation), None)
        if header is None:
            return None
        following = next((t for t in tokens if t.line > header.line and t.column <= indentation
                          and t.text.strip() and t.text not in {"\n", "\r\n", "\r"}), None)
        end_line = following.line if following else definition.span.end_line
        return Span(path=definition.span.path, line=header.line, column=header.column + 1,
                    end_line=end_line, end_column=1 if following else definition.span.end_column)

    def declarations(self, script, checked, ordinal_base=0):
        from pietto.ast_nodes import CallExpr, DottedNameExpr, LiteralExpr, ShapeDef, SourceDef
        for ordinal, declaration in enumerate((*script.definitions, *script.relationships), start=ordinal_base):
            symbol = dict(id=f"{self.documents[declaration.span.path]['uri']}#{kind(declaration)}:{ordinal}:{declaration.name}",
                          name=declaration.name, kind=kind(declaration), range=self.range(declaration.span),
                          selectionRange=self.name_range(declaration), state="checked" if checked and kind(declaration) != "relationship" else "parsed",
                          fields=[])
            if isinstance(declaration, ShapeDef):
                symbol["fields"] = [dict(id=f"{symbol['id']}.{ordinal}:{field.name}", name=field.name,
                                          kind="field", range=self.range(field.span),
                                          selectionRange=self.name_range(field), state="parsed")
                                     for ordinal, field in enumerate(declaration.fields)]
            if isinstance(declaration, SourceDef):
                connector = declaration.connector
                if isinstance(connector, CallExpr) and isinstance(connector.callee, DottedNameExpr):
                    symbol["provider"] = ".".join(connector.callee.parts)
                    if (symbol["provider"] in {"postgres.table", "mysql.table"}
                            and len(connector.arguments) == 1 and isinstance(connector.arguments[0], LiteralExpr)):
                        physical = connector.arguments[0].value
                        # Only inert identifier pairs. Never expose arbitrary connector arguments.
                        if isinstance(physical, str) and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*(\.[A-Za-z_][A-Za-z_0-9]*)?", physical):
                            parts = physical.split(".")
                            symbol["physical"] = dict(table=parts[-1], **({"schema": parts[0]} if len(parts) == 2 else {}))
            self.results[declaration.span.path]["symbols"].append(symbol)
            self.occurrence(declaration, declaration.name, kind(declaration), definition=declaration)
            if hasattr(declaration, "endpoints"):
                symbol["relationship"] = dict(endpoints=[dict(name=e.local_name, relation=e.relation_name)
                    for e in declaration.endpoints])

    def relationship(self, declaration, endpoints):
        symbol = next((s for s in self.results[declaration.span.path]["symbols"]
                       if s["kind"] == "relationship" and s["range"] == self.range(declaration.span)), None)
        if symbol is None:
            return
        symbol["state"] = "checked"
        for authored, target, projected in zip(declaration.endpoints, endpoints, symbol["relationship"]["endpoints"]):
            definition = self.target(target)
            if definition:
                projected["definition"] = definition
                self.occurrence(authored, authored.relation_name, kind(target), definition=target, after=":")

    def schema(self, definition, schema, input_schema=None):
        symbol = next((s for s in self.results[definition.span.path]["symbols"]
                       if s["name"] == definition.name and s["range"] == self.range(definition.span)), None)
        if symbol is None:
            return
        if schema is None or schema.is_unknown:
            symbol["state"] = "checked; schema unknown" if schema is not None else "checked; schema unavailable"
            return
        symbol["state"] = "checked"
        projected = []
        for ordinal, field in enumerate(schema.fields.values()):
            origin = getattr(field, "definition", None) or getattr(field, "field_def", None)
            selected = None
            if hasattr(definition, "select_items"):
                selected = next((item for item in definition.select_items
                                 if item.alias == field.name or (item.alias is None and
                                    getattr(item.expression, "name", None) == field.name) or
                                 (item.alias is None and getattr(item.expression, "parts", ())[-1:] == (field.name,))), None)
            navigation = selected or origin
            fact = dict(id=f"{symbol['id']}.{ordinal}:{field.name}", name=field.name, kind="field",
                        state="checked", **type_fact(field))
            if navigation:
                fact.update(range=self.range(navigation.span), selectionRange=self.name_range(navigation, field.name))
                fact["definition"] = self.target(navigation, field.name)
            if origin:
                fact["origin"] = self.target(origin)
            projected.append(fact)
            if navigation and (selected is None or selected.alias is not None):
                self.occurrence(navigation, field.name, "field", field, navigation)
        symbol["fields"] = projected
        if input_schema is not None and not input_schema.is_unknown:
            symbol["inputFields"] = [self.item(f.name, "field", f,
                getattr(f, "definition", None) or getattr(f, "field_def", None)) for f in input_schema.fields.values()]

    def builtins(self, script):
        from pietto.ast_nodes import CallExpr, NameExpr
        from pietto.semantic.catalog import BUILTIN_FUNCTIONS, BUILTIN_TYPE_NAMES
        builtin_items = [self.item(name, "type") for name in sorted(BUILTIN_TYPE_NAMES)]
        builtin_items += [self.item(name, "function") for name in BUILTIN_FUNCTIONS]
        self.context(script.span, "global", builtin_items)
        for node in walk(script):
            if isinstance(node, CallExpr) and isinstance(node.callee, NameExpr):
                function = BUILTIN_FUNCTIONS.get(node.callee.name)
                if function:
                    signature = f"{function.name}({', '.join(function.parameter_types)}) -> {function.return_type}"
                    self.occurrence(node.callee, function.name, "function", documentation=signature, exact=True)


def single_lineage(projection, script, semantic):
    """Reuse Semantic Metadata Artifact v1's limited, compiler-produced leaves."""
    from pietto.ir import build_ir
    from pietto._metadata.builder import build_semantic_metadata_artifact
    result = build_ir(script, semantic.model)
    if result.ir is None or any(d.severity.value == "error" for d in result.diagnostics):
        return  # Semantic schemas still have their separate checked authority.
    artifact = build_semantic_metadata_artifact(path=script.span.path, script=script,
        semantic_result=semantic, ir=result.ir, diagnostics=result.diagnostics)
    symbols = projection.results[script.span.path]["symbols"]
    for relation in artifact.metadata.relations:
        matches = [s for s in symbols if s["kind"] == relation.kind and s["name"] == relation.name]
        if len(matches) != 1:
            continue
        for lineage in relation.lineage:
            fields = [field for field in matches[0]["fields"] if field["name"] == lineage.output]
            if len(fields) == 1 and lineage.field_leaves:
                fields[0]["lineage"] = [f"{leaf.relation}.{leaf.field}" for leaf in lineage.field_leaves]


def single_projection(projection, script, result, checked):
    from pietto.ast_nodes import (ConstraintDef, DeriveDef, DottedNameExpr, FieldDef,
                                 NameExpr, QueryDef, ShapeDef, SourceDef, TableDef, TypeExpr, WindowExpr)
    from pietto.semantic.expressions import _input_schema, _shape_row_schema, infer_row_expression
    from pietto.semantic.let_bindings import admitted_relation_let_expressions
    from pietto.semantic.model import ValueType
    from pietto.semantic.window_input_analysis import build_window_input_scope
    model = result.model
    projection.declarations(script, checked)
    projection.builtins(script)
    if checked:
        for declaration in script.relationships:
            relationships = [r for r in model.relationships if r.name == declaration.name]
            if len(relationships) == 1:
                projection.relationship(declaration, tuple(e.relation for e in relationships[0].endpoints))
    visible = []
    for symbols in (model.type_symbols, model.callable_symbols, model.relation_symbols):
        visible.extend(projection.item(name, kind(node), definition=node) for name, node in symbols.items())
    projection.context(script.span, "declaration", visible)
    for node in walk(script):
        if isinstance(node, TypeExpr):
            resolved = model.type_resolutions.get(node)
            target = resolved.definition if resolved else None
            value = ValueType(model.type_expansions.get(node, resolved), model.type_nullability[node]) if resolved else None
            projection.occurrence(node, node.name, "type", value if checked else None, target if checked else None, exact=True)
        if checked and isinstance(node, FieldDef):
            resolved = model.type_expansions.get(node.type_expr)
            if resolved:
                projection.occurrence(node, node.name, "field", ValueType(resolved, model.type_nullability[node.type_expr]), node)
    for definition in script.definitions:
        if isinstance(definition, ShapeDef):
            schema = _shape_row_schema(definition, type_resolutions=model.type_expansions,
                                       type_nullability=model.type_nullability)
            if checked:
                projection.schema(definition, schema)
            candidates = [projection.item(f.name, "field", f, f.definition) for f in schema.fields.values()]
            for node in walk(definition):
                if isinstance(node, (NameExpr, DottedNameExpr)) and node in model.expression_value_types:
                    field = schema.fields.get(getattr(node, "name", ""))
                    projection.occurrence(node, getattr(node, "name", ".".join(getattr(node, "parts", ()))),
                                          "field", model.expression_value_types[node] if checked else None,
                                          field.definition if checked and field else None, exact=True)
                if isinstance(node, FieldDef) and node.derive_expression:
                    projection.context(node.derive_expression.span, "row", candidates)
            continue
        if isinstance(definition, SourceDef):
            if checked:
                projection.schema(definition, model.source_row_schemas.get(definition))
            if definition.shape_name:
                target = model.type_symbols.get(definition.shape_name)
                projection.occurrence(definition, definition.shape_name, "shape", definition=target if checked else None, after=":")
            continue
        if isinstance(definition, (ConstraintDef, DeriveDef)):
            candidates = []
            for parameter in definition.parameters:
                value = ValueType(model.type_expansions[parameter.type], model.type_nullability[parameter.type])
                candidates.append(projection.item(parameter.name, "parameter", value, parameter))
                projection.occurrence(parameter, parameter.name, "parameter", value if checked else None, parameter)
            projection.context(definition.body.span, "row", candidates)
            for node in walk(definition.body):
                if isinstance(node, NameExpr):
                    target = next((p for p in definition.parameters if p.name == node.name), None)
                    projection.occurrence(node, node.name, "parameter", model.expression_value_types.get(node) if checked else None,
                                          target, exact=True)
            continue
        if not isinstance(definition, (TableDef, QueryDef)):
            continue
        input_owner = model.from_resolutions.get(definition.from_clause)
        projection.occurrence(definition.from_clause, definition.from_clause.source_name, kind(input_owner) if input_owner else "relation", definition=input_owner if checked else None)
        schema = _input_schema(definition, from_resolutions=model.from_resolutions,
                               source_row_schemas=model.source_row_schemas, relation_row_schemas=model.relation_row_schemas)
        if checked:
            projection.schema(definition, model.relation_row_schemas.get(definition), schema)
        if schema.is_unknown or definition.join_clauses:
            continue  # Single-file checker does not own JOIN semantics.
        scope = model.let_scopes.get(definition)
        lets = dict(scope.value_types) if scope else {}
        let_nodes = {binding.name: binding for binding in scope.bindings} if scope else {}
        expressions = admitted_relation_let_expressions(definition, schema)
        qualifier = definition.from_clause.source_name

        def candidates(bare_values):
            items = []
            for field in schema.fields.values():
                for name in (field.name, f"{qualifier}.{field.name}"):
                    expression = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
                    diagnostics = []
                    value = infer_row_expression(expression, schema, {}, diagnostics, report_unknown_name=True,
                                                 field_qualifier=qualifier, bare_value_types=bare_values)
                    if not diagnostics and value.resolved_type.name != "<unknown>":
                        items.append(projection.item(name, "field", value, field_declaration(input_owner, field)))
            items.extend(projection.item(name, "variable", value, let_nodes.get(name)) for name, value in bare_values.items()
                         if value.resolved_type.name != "<unknown>")
            return items

        row_items = candidates(lets)
        for keyword in ("where", "group"):
            projection.context(projection.block_span(definition, keyword), "row", row_items)
        from pietto.semantic.aggregates import is_semantic_aggregate_call
        selected_items = grouped_candidates(definition, schema, expressions, row_items) if definition.group_by_clause else row_items
        projection.context(projection.block_span(definition, "select"), "row", selected_items)
        if definition.group_by_clause:
            for item in definition.select_items:
                for expression in walk(item.expression):
                    if is_semantic_aggregate_call(expression):
                        projection.context(expression.span, "aggregate", row_items)
        if definition.order_by_clause:
            from pietto.ast_nodes import OrderByClause, OrderItem
            from pietto.semantic.group_by import project_grouped_schema
            from pietto.semantic.aggregates import contains_semantic_aggregate
            output_schema = model.relation_row_schemas.get(definition)
            if definition.group_by_clause and output_schema and not output_schema.is_unknown:
                order_items = []
                names = list(output_schema.fields) + list(lets)
                for name in dict.fromkeys(names):
                    leaf = NameExpr(span=definition.order_by_clause.span, name=name)
                    probe = replace(definition, order_by_clause=OrderByClause(span=definition.order_by_clause.span,
                        items=(OrderItem(span=leaf.span, expression=leaf, direction=None),)))
                    _, diagnostics = project_grouped_schema(probe, schema,
                        expression_value_types=model.expression_value_types, let_expansions=expressions)
                    if not diagnostics:
                        value = output_schema.fields.get(name) or lets.get(name)
                        target = next((item for item in definition.select_items if item.alias == name or
                            getattr(item.expression, "name", None) == name), None) or let_nodes.get(name)
                        order_items.append(projection.item(name, "field", value, target))
            elif any(contains_semantic_aggregate(item.expression) for item in definition.select_items):
                order_items = []
            else:
                order_items = list(row_items)
                if output_schema:
                    order_items += [projection.item(item.alias, "field", output_schema.fields.get(item.alias), item)
                        for item in definition.select_items if isinstance(item.expression, WindowExpr) and item.alias]
            projection.context(projection.block_span(definition, "order"), "order", order_items)
            if checked:
                for node in walk(definition.order_by_clause):
                    if isinstance(node, (NameExpr, DottedNameExpr)):
                        name = node.name if isinstance(node, NameExpr) else ".".join(node.parts)
                        matching = [item for item in order_items if item["name"] == name]
                        if len(matching) == 1:
                            observation = dict(matching[0], range=projection.range(node.span))
                            projection.results[node.span.path]["occurrences"].append(observation)
        if definition.let_clause:
            prior = {}
            for binding in definition.let_clause.bindings:
                projection.context(binding.span, "let", candidates(prior))
                if binding.name in lets:
                    prior[binding.name] = lets[binding.name]
                    projection.occurrence(binding, binding.name, "variable", lets[binding.name] if checked else None, binding)
        window_scope = build_window_input_scope(definition=definition, input_schema=schema, field_qualifier=qualifier,
                                                value_types=model.expression_value_types, let_value_types=lets,
                                                let_expressions=expressions)
        window_members = {id(leaf) for window in walk(definition) if isinstance(window, WindowExpr) for leaf in walk(window)}
        for node in walk(definition):
            if isinstance(node, (NameExpr, DottedNameExpr)) and node in model.expression_value_types and id(node) not in window_members:
                name = node.name if isinstance(node, NameExpr) else ".".join(node.parts)
                field_name = node.name if isinstance(node, NameExpr) else (node.parts[-1] if node.parts[0] == qualifier else "")
                field = schema.fields.get(field_name)
                origin = let_nodes.get(name) or (field_declaration(input_owner, field) if field else None)
                if origin is None and definition.order_by_clause and node in model.expression_value_types:
                    origin = next((item for item in definition.select_items if item.alias == name
                                   and isinstance(item.expression, WindowExpr)), None)
                projection.occurrence(node, name, "variable" if name in lets else "field",
                                      model.expression_value_types[node] if checked else None, origin if checked else None, exact=True)
        window_input_observations(projection, definition, window_scope, input_owner, schema, let_nodes, checked)


def project_projection(projection, parsed, semantic, completed, checked):
    """Project actual module/occurrence authorities without flattening modules."""
    from pietto.ast_nodes import DottedNameExpr, NameExpr, QueryDef, ShapeDef, SourceDef, TableDef, WindowExpr
    from pietto._project import module_semantic_fact_preservation as facts
    from pietto._project.project_final_outputs import (ProjectCompletedEffectiveOutput, ProjectCompletedSetOutput,
        ProjectConcreteNoJoinReplay, _entry_schema)
    from pietto._project.project_completion import ProjectExistingEffectiveOutput
    from pietto._project.project_joined_qualify import ProjectConcreteJoinedQualify
    from pietto._project.row_expression_type_facts import project_row_field_to_semantic_value_type, project_row_schema_to_semantic_row_schema
    from pietto.semantic.window_input_analysis import build_window_input_scope
    for item in parsed.parsed_inputs:
        projection.declarations(item.script, checked)
        projection.builtins(item.script)
    if semantic.module_catalogs is None:
        return
    type_environments = {e.module.path: e for e in semantic.module_type_source_resolutions.environments}
    relation_environments = {e.module.path: e for e in semantic.module_relation_resolutions.environments}
    fact_environments = {e.module.path: e for e in semantic.module_semantic_facts.environments}
    definitions_by_identity = {o.identity: o.definition for c in semantic.module_catalogs.catalogs for o in c.occurrences}
    entries = {id(e.owner.definition): e for e in getattr(getattr(completed, "effective_outputs", None), "entries", ())}
    if checked:
        from pietto._project.project_relationships import build_project_relationships, ProjectConcreteRelationshipSubject
        relationships = build_project_relationships(semantic)
        for environment in relationships.environments:
            for subject in environment.subjects:
                if isinstance(subject, ProjectConcreteRelationshipSubject):
                    occurrence = subject.occurrence
                    projection.relationship(occurrence.relationship,
                        tuple(e.target.target_occurrence.definition for e in occurrence.endpoints))
    for module in parsed.modules:
        script = module.parsed_input.script
        types = type_environments[module.path]
        relations = relation_environments[module.path]
        visible = [projection.item(s.local_name, kind(s.target_occurrence.definition), definition=s.target_occurrence.definition)
                   for s in (*types.symbols, *relations.symbols)]
        projection.context(script.span, "declaration", visible)
        for resolution in types.type_resolutions:
            expression = resolution.reference.type_expr
            target = resolution.direct_symbol.target_occurrence.definition if resolution.direct_symbol else None
            projection.occurrence(expression, expression.name, "type", definition=target if checked else None, exact=True)
        for resolution in types.source_shape_resolutions:
            source = resolution.reference.source
            projection.occurrence(source, source.shape_name, "shape", definition=resolution.target_symbol.target_occurrence.definition if checked else None, after=":")
        for resolution in relations.resolutions:
            clause = resolution.reference.from_clause
            projection.occurrence(clause, clause.source_name, kind(resolution.target_symbol.target_occurrence.definition),
                                  definition=resolution.target_symbol.target_occurrence.definition if checked else None)
        bindings = semantic.module_bindings.find_module_path(module.path)
        for binding in bindings[0].bindings if len(bindings) == 1 else ():
            target = definitions_by_identity.get(binding.target_identity)
            projection.occurrence(binding.request.source_item, binding.identity.local_binding_name,
                                  kind(target) if target else "declaration", definition=target if checked else None)
        for relation in fact_environments[module.path].relation_facts:
            definition = relation.owner.definition
            entry = entries.get(id(definition))
            concrete = isinstance(entry, (ProjectCompletedEffectiveOutput, ProjectCompletedSetOutput, ProjectExistingEffectiveOutput))
            output = _entry_schema(entry) if concrete else None
            input_schema = relation.input_state.schema if relation.input_state else None
            if isinstance(entry, ProjectCompletedEffectiveOutput) and isinstance(entry.root, ProjectConcreteNoJoinReplay):
                input_schema = entry.root.input_schema
            if checked and concrete:
                projection.schema(definition, output, input_schema)
            if isinstance(definition, SourceDef):
                # Source's schema fields retain exact shape FieldDef identity.
                continue
            if not isinstance(definition, (TableDef, QueryDef)):
                continue
            if isinstance(entry, ProjectCompletedEffectiveOutput) and isinstance(entry.root, ProjectConcreteJoinedQualify):
                joined_projection(projection, definition, entry, checked)
                continue
            if definition.join_clauses or input_schema is None or input_schema.is_unknown:
                continue
            scope = entry.root.let_scope if isinstance(entry, ProjectCompletedEffectiveOutput) and isinstance(entry.root, ProjectConcreteNoJoinReplay) else relation.let_scope_facts
            if scope is None:
                continue
            qualifier = definition.from_clause.source_name
            lets = {b.name: b for b in scope.bindings}

            def candidates(bindings):
                result = []
                names = [f.name for f in input_schema.fields.values()] + [b.name for b in bindings]
                names += [f"{qualifier}.{f.name}" for f in input_schema.fields.values()]
                for name in dict.fromkeys(names):
                    leaf = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
                    buckets = tuple(facts._expression_reference_candidates(expression=leaf, relation_qualifier=qualifier,
                        input_schema=input_schema, input_status=facts.ProjectModuleCandidateBucketStatus.CONCRETE,
                        let_scope=scope, let_candidates=tuple(bindings), selected_items=()))
                    _, _, field, matches, _, status = buckets[0]
                    if status is not facts.ProjectModuleCandidateBucketStatus.CONCRETE:
                        continue
                    value = project_row_field_to_semantic_value_type(field, field.nullability) if field else scope.value_types.get(name)
                    input_owner = relation.resolution.target_symbol.target_occurrence.definition if relation.resolution else None
                    origin = field_declaration(input_owner, field) if field else matches[0] if len(matches) == 1 else None
                    result.append(projection.item(name, "field" if field else "variable", value, origin))
                return result

            row_items = candidates(scope.bindings)
            for keyword in ("where", "group"):
                projection.context(projection.block_span(definition, keyword), "row", row_items)
            if definition.let_clause:
                for ordinal, binding in enumerate(definition.let_clause.bindings):
                    projection.context(binding.span, "let", candidates(scope.bindings[:ordinal]))
                    projection.occurrence(binding, binding.name, "variable", scope.value_types.get(binding.name) if checked else None, binding)
            value_types = dict(scope.expression_value_types)
            reference_facts = [r for item in relation.select_facts for r in item.references]
            reference_facts += [r for group in relation.group_key_references for r in group]
            reference_facts += [r for binding in relation.let_bindings for r in binding.references]
            if relation.where_fact:
                reference_facts += list(relation.where_fact.references)
                value_types.update(relation.where_fact.expression_value_types)
            for item in relation.select_expressions:
                value_types.update(item.expression_value_types)
            for reference in reference_facts:
                if reference.status is not facts.ProjectModuleCandidateBucketStatus.CONCRETE:
                    continue
                value = project_row_field_to_semantic_value_type(reference.input_field, reference.input_field.nullability) if reference.input_field else scope.value_types.get(reference.local_name)
                input_owner = relation.resolution.target_symbol.target_occurrence.definition if relation.resolution else None
                origin = field_declaration(input_owner, reference.input_field) if reference.input_field else reference.let_candidates[0] if len(reference.let_candidates) == 1 else None
                name = getattr(reference.expression, "name", ".".join(getattr(reference.expression, "parts", ())))
                projection.occurrence(reference.expression, name, "field", value if checked else None, origin if checked else None, exact=True)
            # Reuse the compiler's exact GROUP-to-WINDOW owner after projecting row types.
            row = project_row_schema_to_semantic_row_schema(input_schema)
            from pietto.semantic.aggregates import is_semantic_aggregate_call, contains_semantic_aggregate
            selected_items = grouped_candidates(definition, row, scope.binding_expressions, row_items) if definition.group_by_clause else row_items
            projection.context(projection.block_span(definition, "select"), "row", selected_items)
            if definition.group_by_clause:
                for item in definition.select_items:
                    for expression in walk(item.expression):
                        if is_semantic_aggregate_call(expression):
                            projection.context(expression.span, "aggregate", row_items)
            if definition.order_by_clause:
                order_items = []
                if definition.group_by_clause and output:
                    from pietto.ast_nodes import OrderByClause, OrderItem
                    from pietto._project.model import ProjectRelationRowSchemaState, ProjectRelationRowSchemaStatus
                    state = ProjectRelationRowSchemaState(status=ProjectRelationRowSchemaStatus.CONCRETE,
                        schema=output, reason=relation.state.reason)
                    for name in dict.fromkeys([*output.fields, *scope.value_types]):
                        leaf = NameExpr(span=definition.order_by_clause.span, name=name)
                        probe = replace(definition, order_by_clause=OrderByClause(span=leaf.span,
                            items=(OrderItem(span=leaf.span, expression=leaf, direction=None),)))
                        owner = replace(relation.owner, definition=probe)
                        dependencies = facts._clause_dependency_facts(owner=owner, definition=probe,
                            input_schema=input_schema, group_input_status=facts.ProjectModuleCandidateBucketStatus.CONCRETE,
                            state=state, let_scope=scope, aggregate_result_facts=relation.aggregate_result_facts)
                        matches = [fact for fact in dependencies if fact.role is facts.ProjectModuleFactOccurrenceRole.GROUPED_ORDER]
                        if len(matches) == 1 and matches[0].status is facts.ProjectModuleCandidateBucketStatus.CONCRETE:
                            fact = matches[0]
                            if len(fact.target_fields) == 1 and len(fact.target_occurrences) == 1:
                                order_items.append(projection.item(name, "field", fact.target_fields[0], fact.target_occurrences[0]))
                elif not any(contains_semantic_aggregate(item.expression) for item in definition.select_items):
                    order_items = list(row_items)
                    if output:
                        order_items += [projection.item(item.alias, "field", output.fields.get(item.alias), item)
                            for item in definition.select_items if isinstance(item.expression, WindowExpr) and item.alias]
                projection.context(projection.block_span(definition, "order"), "order", order_items)
                if checked:
                    for node in walk(definition.order_by_clause):
                        if isinstance(node, (NameExpr, DottedNameExpr)):
                            name = node.name if isinstance(node, NameExpr) else ".".join(node.parts)
                            matches = [item for item in order_items if item["name"] == name]
                            if len(matches) == 1:
                                projection.results[node.span.path]["occurrences"].append(dict(matches[0], range=projection.range(node.span)))
            window = build_window_input_scope(definition=definition, input_schema=row, field_qualifier=qualifier,
                value_types=value_types, let_value_types=scope.value_types,
                let_expressions={b.name: b.expression for b in scope.bindings})
            input_owner = relation.resolution.target_symbol.target_occurrence.definition if relation.resolution else None
            window_input_observations(projection, definition, window, input_owner, input_schema, lets, checked)
        # Reuse the same exact type/nullability owners used by project source schemas.
        for declaration in script.definitions:
            if isinstance(declaration, ShapeDef) and checked:
                from pietto._project.model import ProjectRowField, ProjectRowSchema
                from pietto._project.module_relation_resolution import _resolved_row_type, _row_field_nullability
                exact = {}
                for field in declaration.fields:
                    resolutions = types.find_type_expr(field.type_expr)
                    if len(resolutions) == 1 and resolutions[0].canonical_name != "<unknown>":
                        exact[field.name] = ProjectRowField(name=field.name,
                            resolved_type=_resolved_row_type(resolutions[0], semantic.module_catalogs),
                            nullability=_row_field_nullability(field.type_expr.nullability), field_def=field)
                if len(exact) == len(declaration.fields):
                    projection.schema(declaration, ProjectRowSchema(fields=exact))
    if checked:
        for lineage in semantic.module_attribution_facts.row_lineages:
            identity = lineage.owner.identity
            if identity.module_path not in projection.results:
                continue
            symbols = [s for s in projection.results[identity.module_path]["symbols"]
                       if s["name"] == identity.declared_name and s["kind"] == identity.declaration_kind.value]
            if len(symbols) != 1:
                continue
            for field_lineage in lineage.fields:
                projected = [f for f in symbols[0]["fields"] if f["name"] == field_lineage.field.name]
                if len(projected) == 1:
                    projected[0]["lineage"] = [
                        f"{path.root_field.owner.identity.module_path}::{path.root_field.owner.identity.declared_name}.{path.root_field.name}"
                        for path in field_lineage.paths]
        for condition in completed.roots.join_conditions.entries:
            if condition.expression is None or not condition.ready:
                continue
            items = []
            for field in condition.environment.fields:
                if field.value_type.resolved_type.name == "<unknown>" or field.binding.target is None:
                    continue
                owner = field.binding.target.target_occurrence.definition
                items.append(projection.item(f"{field.binding.name}.{field.input_field.evidence.name}", "field",
                    field.value_type, field_declaration(owner, field.input_field.evidence)))
            projection.context(condition.use.clause.on_clause.span, "join_on", items)
            for reference in condition.references:
                if reference.target is None or reference.target.binding.target is None:
                    continue
                target = reference.target
                owner = target.binding.target.target_occurrence.definition
                leaf = reference.expression
                name = leaf.name if isinstance(leaf, NameExpr) else ".".join(leaf.parts)
                # ON has pre-match nullability, separate from the final joined row.
                observations = projection.results[leaf.span.path]["occurrences"]
                observations[:] = [o for o in observations if o["range"] != projection.range(leaf.span)]
                projection.occurrence(leaf, name, "field", target.value_type,
                    field_declaration(owner, target.input_field.evidence), exact=True)


def joined_projection(projection, definition, entry, checked):
    from pietto.ast_nodes import DottedNameExpr, NameExpr, WindowExpr
    from pietto._project.project_scalar_namespaces import resolve_project_joined_namespace_reference
    from pietto._project.project_scalar_references import ProjectScalarReferenceOccurrence
    from pietto._project.project_joined_qualify import ProjectQualifyReferenceResolution
    from pietto._project.module_semantic_fact_preservation import ProjectModuleCandidateBucketStatus
    stage = entry.root.window_stage
    namespace = stage.input_aggregation.input_filter.namespace
    bindings = namespace.binding_environment

    def items(current, allowed=None):
        names = [f.evidence.name for f in bindings.visible_fields]
        names += [f"{b.binding.name}.{f.evidence.name}" for b in bindings.bindings for f in b.fields]
        names += [v.occurrence.binding.name for v in current.let_values]
        result = []
        for name in dict.fromkeys(names):
            leaf = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
            reference = ProjectScalarReferenceOccurrence(environment=bindings.scalar_environment, expression=leaf)
            resolved = resolve_project_joined_namespace_reference(current, reference)
            target = resolved.target
            if target is None:
                continue
            if allowed is not None and id(target) not in allowed:
                continue
            origin = target.evidence.field_def if hasattr(target, "evidence") else target.occurrence.binding
            value = target.value_type
            result.append(projection.item(name, "field" if hasattr(target, "evidence") else "variable", value, origin))
        return result

    row_items = items(namespace)
    for keyword in ("where", "group"):
        projection.context(projection.block_span(definition, keyword), "row", row_items)
    if definition.group_by_clause:
        from pietto.semantic.aggregates import is_semantic_aggregate_call
        keys = stage.input_aggregation.group_keys
        allowed = {id(key.field_semantics.scalar_field) for key in keys}
        allowed.update(id(r.target) for key in keys for r in key.resolutions)
        projection.context(projection.block_span(definition, "select"), "row", items(namespace, allowed))
        for item in definition.select_items:
            for expression in walk(item.expression):
                if is_semantic_aggregate_call(expression):
                    projection.context(expression.span, "aggregate", row_items)
    else:
        projection.context(projection.block_span(definition, "select"), "row", row_items)
    joined_lets = stage.input_aggregation.input_filter.current_semantics
    if joined_lets is None:
        joined_lets = entry.base_entry.joined_completion
    let_namespaces = joined_lets.namespaces
    for current in let_namespaces.binding_namespaces:
        binding = current.occurrences[current.binding_ordinal].binding
        projection.context(binding.span, "let", items(current))
    window_items = []
    names = [b.name for b in stage.pre_window.bindings]
    names += [f"{b.qualifier}.{b.name}" for b in stage.pre_window.bindings if b.qualifier]
    for name in dict.fromkeys(names):
        leaf = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
        matches = stage.pre_window.candidates(leaf)
        if len(matches) == 1:
            binding = matches[0]
            origin = binding.let_value.occurrence.binding if binding.let_value else (
                binding.joined_field.scalar_field.evidence.field_def if binding.joined_field else binding.stage_output.item)
            window_items.append(projection.item(name, "field", binding.value_type, origin))
    if definition.order_by_clause:
        from pietto._project.project_joined_aggregation import ProjectJoinedAggregationMode
        order_items = []
        names = [i["name"] for i in window_items] + [r.output_name for r in stage.selected_results]
        if stage.input_aggregation.mode is ProjectJoinedAggregationMode.ABSENT:
            names += [i["name"] for i in row_items]
        if stage.input_aggregation.mode is not ProjectJoinedAggregationMode.GLOBAL:
            for name in dict.fromkeys(names):
                leaf = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
                target = None
                if stage.input_aggregation.mode is ProjectJoinedAggregationMode.GROUPED:
                    if isinstance(leaf, DottedNameExpr):
                        continue
                    candidates = stage.pre_window.candidates(leaf)
                    if len(candidates) == 1:
                        target = candidates[0]
                    elif not candidates:
                        selected = stage.post_window.selected_candidates(name)
                        target = selected[0] if len(selected) == 1 else None
                else:
                    resolved = resolve_project_joined_namespace_reference(namespace,
                        ProjectScalarReferenceOccurrence(environment=bindings.scalar_environment, expression=leaf))
                    target = resolved.target
                    if target is None and not getattr(resolved, "candidates", ()) and isinstance(leaf, NameExpr):
                        selected = stage.post_window.selected_candidates(name)
                        target = selected[0] if len(selected) == 1 else None
                if target:
                    origin = target.evidence.field_def if hasattr(target, "evidence") else (
                        target.occurrence.binding if hasattr(target, "occurrence") else
                        target.computation.site.item if hasattr(target, "computation") else
                        target.stage_output.item if target.stage_output else None)
                    order_items.append(projection.item(name, "field", target.value_type, origin))
        projection.context(projection.block_span(definition, "order"), "order", order_items)
        if checked:
            for node in walk(definition.order_by_clause):
                if isinstance(node, (NameExpr, DottedNameExpr)):
                    name = node.name if isinstance(node, NameExpr) else ".".join(node.parts)
                    matches = [i for i in order_items if i["name"] == name]
                    if len(matches) == 1:
                        projection.results[node.span.path]["occurrences"].append(dict(matches[0], range=projection.range(node.span)))
    windows = tuple(node for node in walk(definition) if isinstance(node, WindowExpr))
    window_members = {id(leaf) for window in windows for leaf in walk(window)}
    for node in walk(definition):
        if isinstance(node, WindowExpr):
            projection.context(node.span, "window", window_items)
        if isinstance(node, (NameExpr, DottedNameExpr)) and id(node) not in window_members:
            reference = ProjectScalarReferenceOccurrence(environment=bindings.scalar_environment, expression=node)
            resolved = resolve_project_joined_namespace_reference(namespace, reference)
            target = resolved.target
            if target:
                origin = target.evidence.field_def if hasattr(target, "evidence") else target.occurrence.binding
                name = node.name if isinstance(node, NameExpr) else ".".join(node.parts)
                projection.occurrence(node, name, "field", target.value_type if checked else None, origin if checked else None, exact=True)
    if checked:
        for window in windows:
            for leaf in window_reference_leaves(window):
                candidates = stage.pre_window.candidates(leaf)
                if len(candidates) != 1:
                    continue
                binding = candidates[0]
                origin = binding.let_value.occurrence.binding if binding.let_value else (
                    binding.joined_field.scalar_field.evidence.field_def if binding.joined_field else binding.stage_output.item)
                name = leaf.name if isinstance(leaf, NameExpr) else ".".join(leaf.parts)
                projection.bound_occurrence(leaf, name, binding.value_type, origin)
    # QUALIFY uses its own compiler-owned post-window candidate collector.
    if definition.qualify_clause:
        names = [i["name"] for i in window_items] + [r.output_name for r in stage.selected_results]
        qualify_items = []
        for name in dict.fromkeys(names):
            leaf = NameExpr(span=definition.span, name=name) if "." not in name else DottedNameExpr(span=definition.span, parts=tuple(name.split(".")))
            resolved = ProjectQualifyReferenceResolution(stage=stage, expression=leaf,
                candidates=__import__("pietto._project.project_joined_qualify", fromlist=["_reference_candidates"])._reference_candidates(stage, leaf))
            if resolved.status is ProjectModuleCandidateBucketStatus.CONCRETE:
                value = resolved.target.value_type if hasattr(resolved.target, "value_type") else resolved.target.computation.analysis.semantic_fact.result.value_type
                qualify_items.append(projection.item(name, "field", value))
        projection.context(definition.qualify_clause.span, "qualify", qualify_items)


def partial_declarations(projection, path):
    """Keep independently parsed authored declarations after a whole-file parse failure."""
    from pietto.parser_api import parse_source
    text = projection.documents[path]["text"]
    lines = source_lines(text)
    starts = [i for i, line in enumerate(lines) if re.match(r"(?:type|enum|shape|source|table|query|constraint|derive|relationship)\s", line.removeprefix("\ufeff") if i == 0 else line)]
    for ordinal, start in enumerate(starts):
        end = starts[ordinal + 1] if ordinal + 1 < len(starts) else len(lines)
        fragment = "\n" * start + "".join(lines[start:end])
        parsed = parse_source(fragment, path=path)
        if parsed.ast:
            projection.declarations(parsed.ast, False, ordinal_base=ordinal)


def recover(text, diagnostics):
    """One bounded syntax repair for candidates only; original diagnostics survive."""
    lines = source_lines(text)
    if not diagnostics:
        return None
    index = min(max(0, diagnostics[0].location.line - 1), len(lines) - 1)
    if index < 0:
        return None
    line = lines[index].rstrip("\r\n")
    if re.fullmatch(r"\s+(?:[A-Za-z_][A-Za-z_0-9]*\s*=\s*)?[A-Za-z_][A-Za-z_0-9]*\.", line):
        lines[index] = line + "__editor_probe__\n"
        return "".join(lines)
    if line.strip() in {"select:", "let:", "group by:"}:
        indentation = len(line) - len(line.lstrip()) + 4
        lines.insert(index + 1, " " * indentation + ("__editor_probe__ = 1" if line.strip() == "let:" else "__editor_probe__") + "\n")
        return "".join(lines)
    return None


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("documents"), list):
        raise ValueError("Invalid analysis request.")
    if len(request["documents"]) > MAX_DOCUMENTS:
        raise ValueError("Too many open documents.")
    seen = set()
    total = 0
    for document in request["documents"]:
        if (not isinstance(document, dict) or not isinstance(document.get("uri"), str)
                or not isinstance(document.get("text"), str) or type(document.get("version")) is not int):
            raise ValueError("Invalid document input.")
        if document["uri"] in seen:
            raise ValueError("Duplicate document URI.")
        if urlparse(document["uri"]).scheme not in {"file", "untitled"}:
            raise ValueError("Only file and untitled document URIs are supported.")
        seen.add(document["uri"])
        size = len(document["text"].encode("utf-8", "surrogatepass"))
        if size > MAX_BYTES:
            raise ValueError("Document exceeds the supported source byte limit.")
        total += size
    if total > MAX_PROJECT_BYTES:
        raise ValueError("Open document byte budget exceeded.")


def analyze_request(request):
    started = perf_counter()
    response = dict(id=request.get("id") if isinstance(request, dict) else None,
                    protocol=PROTOCOL, ok=False, compiler=None, issues=[], documents=[])
    try:
        validate_request(request)
        response["compiler"] = compiler_identity()
        from pietto.parser_api import parse_source
        from pietto.semantic import analyze
        if request.get("root"):
            return analyze_project(request, response, started)
        documents = {document["uri"]: document for document in request["documents"]}
        projection = Projection(documents)
        for path, document in documents.items():
            parsed = parse_source(document["text"], path=path)
            for diagnostic in parsed.diagnostics:
                projection.diagnostic(diagnostic)
            if parsed.ast is None:
                projection.results[path]["state"] = "invalid"
                partial_declarations(projection, path)
                repaired = recover(document["text"], parsed.diagnostics)
                if repaired:
                    recovered = parse_source(repaired, path=path)
                    if recovered.ast:
                        scratch = Projection({path: dict(document, text=repaired)})
                        single_projection(scratch, recovered.ast, analyze(recovered.ast), False)
                        error_line = parsed.diagnostics[0].location.line - 1
                        for context in scratch.results[path]["contexts"]:
                            if context["kind"] in {"global", "declaration", "excluded"}:
                                continue
                            if context["range"]["start"]["line"] <= error_line <= context["range"]["end"]["line"]:
                                context["items"] = [{key: value for key, value in item.items() if key != "definition"}
                                    for item in context["items"]]
                                projection.results[path]["contexts"].append(context)
                continue
            semantic = analyze(parsed.ast)
            checked = not any(d.severity.value == "error" for d in semantic.diagnostics)
            projection.results[path]["state"] = "checked" if checked else "parsed"
            for diagnostic in semantic.diagnostics:
                projection.diagnostic(diagnostic)
            single_projection(projection, parsed.ast, semantic, checked)
            if checked:
                single_lineage(projection, parsed.ast, semantic)
        response["documents"] = list(projection.results.values())
        response["ok"] = all(d["state"] == "checked" for d in response["documents"])
    except ImportError:
        response["issues"] = ["Pietto compiler is unavailable. Select an interpreter with the documented Pietto source build."]
    except (ValueError, OSError, TypeError, AttributeError, KeyError) as error:
        # Never echo request objects, connector arguments, or arbitrary exception graphs.
        response["issues"] = [str(error) if isinstance(error, ValueError) else f"Compiler analysis failed ({type(error).__name__})."]
    response["elapsedMs"] = round((perf_counter() - started) * 1000, 3)
    return response


def analyze_project(request, response, started):
    from pietto._project.config import load_project_config
    from pietto._project.source_selection import select_project_sources
    from pietto._project.trusted_source import _load_trusted_source
    from pietto._project.check import check_project_parse_only
    from pietto._project.model import build_empty_project_semantic_result
    from pietto._project.module_carrier import ProjectCompilationMode
    from pietto._project.project_completed_semantics import build_project_completed_semantic_result
    root = filesystem_path(request["root"])
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("Select an absolute, non-symlink project root.")
    root = root.resolve(strict=True)
    config = load_project_config(root)
    selection = select_project_sources(root, config)
    if selection.errors:
        response["issues"] = [e.message for e in selection.errors]
        response["elapsedMs"] = round((perf_counter() - started) * 1000, 3)
        return response
    if len(selection.inputs) > MAX_DOCUMENTS:
        raise ValueError("Project exceeds the editor's 128 document limit.")
    documents = {}
    total = 0
    for entry in selection.selected_input_index.entries:
        try:
            snapshot = _load_trusted_source(selection.pinned_root, entry, byte_limit=MAX_BYTES)
        except OSError as error:
            if os.name == "nt" and str(error) == "Project stored canonical file changed while being opened.":
                raise ValueError("This Pietto build's trusted project loader is unavailable on native Windows. Use Remote WSL or the documented WSL interpreter route.") from error
            raise
        if not hasattr(snapshot, "source_text"):
            raise ValueError("Project source could not be loaded within compiler limits.")
        total += snapshot.byte_count
        documents[entry.identity.path] = dict(uri=original_uri(request["root"], entry.identity.path),
            path=str(root / entry.identity.path), text=snapshot.source_text, version=-1)
    if total > MAX_PROJECT_BYTES:
        raise ValueError("Project exceeds the editor's 16 MiB source budget.")
    for document in request["documents"]:
        if not document.get("path") or not filesystem_path(document["path"]).is_absolute():
            raise ValueError("Project documents require absolute filesystem paths.")
        path = filesystem_path(document["path"]).resolve(strict=False)
        if not path.is_relative_to(root):
            raise ValueError("Document escapes the selected project root.")
        relative = path.relative_to(root).as_posix()
        if relative not in documents:
            continue  # Excluded open buffers remain separate single-file observations.
        parsed_uri = urlparse(document["uri"])
        uri_path = unquote(parsed_uri.path)
        if re.match(r"^/[A-Za-z]:/", uri_path):
            uri_path = uri_path[1:]
        if parsed_uri.scheme != "file" or parsed_uri.netloc or filesystem_path(uri_path).resolve(strict=False) != path:
            raise ValueError("Document URI does not match its selected filesystem path.")
        documents[relative] = document
    # ponytail: one bounded shadow directory; core retains its filesystem authority laws.
    # No source-provider seam exists in this compiler. Preserve selected membership exactly.
    with TemporaryDirectory(prefix="pietto-editor-") as directory:
        shadow = Path(directory)
        include = json.dumps(list(config.config.sources.include_patterns), ensure_ascii=False)
        exclude = json.dumps(list(config.config.sources.exclude_patterns), ensure_ascii=False)
        (shadow / "pietto.toml").write_text(f"schema_version = {config.config.schema_version}\n[sources]\ninclude = {include}\nexclude = {exclude}\n", encoding="utf-8")
        for path, document in documents.items():
            target = shadow / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(document["text"].encode("utf-8"))
        parsed = check_project_parse_only(shadow)
        projection = Projection(documents)
        for diagnostic in parsed.diagnostics:
            projection.diagnostic(diagnostic)
        if parsed.errors:
            response["issues"] = [e.message for e in parsed.errors]
        checked = False
        if parsed.ok:
            semantic = build_empty_project_semantic_result(parsed)
            if parsed.compilation_mode is ProjectCompilationMode.EXPLICIT_MODULES:
                completed = build_project_completed_semantic_result(semantic)
                diagnostics = completed.diagnostics
                checked = completed.ok
                related = {}
                for fact in semantic.module_diagnostic_facts.facts:
                    related[id(fact.diagnostic)] = fact.related_locations
                for group in (semantic.module_diagnostic_facts, semantic.module_type_source_resolutions,
                              semantic.module_relation_resolutions):
                    for issue in getattr(group, "issues", ()):
                        if getattr(issue, "diagnostic", None):
                            related[id(issue.diagnostic)] = getattr(issue, "related_locations", ())
                for diagnostic in diagnostics:
                    projection.diagnostic(diagnostic, related.get(id(diagnostic), ()))
                project_projection(projection, parsed, semantic, completed, checked)
            else:
                # Legacy flat must use project semantics, never independent per-file checks.
                response["issues"] = ["Editor project models require schema_version = 2 explicit modules. Legacy flat diagnostics remain available."]
                for diagnostic in semantic.diagnostics:
                    projection.diagnostic(diagnostic)
                for item in parsed.parsed_inputs:
                    projection.declarations(item.script, False)
                    projection.builtins(item.script)
        else:
            for item in parsed.parsed_inputs:
                projection.declarations(item.script, False)
                projection.builtins(item.script)
            for path in documents:
                if path not in {item.path for item in parsed.parsed_inputs}:
                    partial_declarations(projection, path)
        for path, document in projection.results.items():
            document["state"] = "checked" if checked else "invalid" if any(d["severity"] == "error" for d in document["diagnostics"]) else "parsed"
        response["documents"] = list(projection.results.values())
        response["ok"] = checked
    response["elapsedMs"] = round((perf_counter() - started) * 1000, 3)
    return response


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = analyze_request(request)
        except (json.JSONDecodeError, RecursionError):
            response = dict(id=None, protocol=PROTOCOL, ok=False, compiler=None,
                            issues=["Malformed analysis request."], documents=[])
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
