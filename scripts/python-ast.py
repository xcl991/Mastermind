"""Parse supplied source as syntax only; never import or execute target code."""
import ast
import json
import sys

payload = json.load(sys.stdin)
file_id = payload['id']
out = dict(parser='python-ast', symbols=[], imports=[], calls=[], exports={}, scopes=[dict(parent=None, bindings={}, kind='module')], limitations=[], coverage='static-subset')

class Visitor(ast.NodeVisitor):
    def __init__(self):
        self.scope = 0
        self.owner = file_id

    def symbol(self, node, kind):
        ident = f'symbol:{file_id}#{node.name}@{node.lineno}'
        end = getattr(node, 'end_lineno', node.lineno)
        out['symbols'].append(dict(id=ident, label=node.name, kind=kind, type='symbol', source_file=file_id, source_location=f'L{node.lineno}-L{end}', startLine=node.lineno, endLine=end, owner=self.owner, confidence='EXTRACTED', parser='python-ast'))
        out['scopes'][self.scope]['bindings'][node.name] = dict(symbol=ident)
        if self.scope == 0:
            out['exports'][node.name] = dict(symbol=ident)
        return ident

    def visit_FunctionDef(self, node):
        if len(out['symbols']) >= 2000:
            return
        ident = self.symbol(node, 'function')
        previous = self.scope, self.owner
        self.scope = len(out['scopes'])
        self.owner = ident
        parent = previous[0]
        while out['scopes'][parent].get('kind') == 'class':
            parent = out['scopes'][parent]['parent']
        out['scopes'].append(dict(parent=parent, bindings={}, kind='function'))
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs + ([node.args.vararg] if node.args.vararg else []) + ([node.args.kwarg] if node.args.kwarg else []):
            out['scopes'][self.scope]['bindings'][arg.arg] = dict(unknown=True)
        for child in node.body:
            self.visit(child)
        self.scope, self.owner = previous

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        if len(out['symbols']) >= 2000:
            return
        ident = self.symbol(node, 'class')
        for base in node.bases:
            if isinstance(base, ast.Name):
                out['calls'].append(dict(name=base.id, scope=self.scope, **{'from': ident}, line=node.lineno, relation='inherits'))
        previous = self.scope, self.owner
        self.scope = len(out['scopes'])
        self.owner = ident
        out['scopes'].append(dict(parent=previous[0], bindings={}, kind='class'))
        for child in node.body:
            self.visit(child)
        self.scope, self.owner = previous

    def visit_ImportFrom(self, node):
        for alias in node.names:
            local = alias.asname or alias.name
            out['imports'].append(dict(target='.' * node.level + (node.module or ''), local=local, imported=alias.name, line=node.lineno))
            out['scopes'][self.scope]['bindings'][local] = dict(import_=len(out['imports']) - 1)

    def visit_Import(self, node):
        for alias in node.names:
            local = alias.asname or alias.name.split('.')[0]
            out['imports'].append(dict(target=alias.name, local=local, imported='*', line=node.lineno))
            out['scopes'][self.scope]['bindings'][local] = dict(import_=len(out['imports']) - 1)

    def visit_Assign(self, node):
        for target in node.targets:
            for child in ast.walk(target):
                if isinstance(child, ast.Name):
                    out['scopes'][self.scope]['bindings'][child.id] = dict(unknown=True)
        self.visit(node.value)

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            out['scopes'][self.scope]['bindings'][node.id] = dict(unknown=True)

    def visit_Call(self, node):
        def name(n):
            if isinstance(n, ast.Name): return n.id
            if isinstance(n, ast.Attribute):
                prefix = name(n.value)
                return f'{prefix}.{n.attr}' if prefix else None
        target = name(node.func)
        if target:
            out['calls'].append(dict(name=target, scope=self.scope, **{'from': self.owner}, line=node.lineno, relation='calls'))
        self.generic_visit(node)

try:
    Visitor().visit(ast.parse(payload['content'], filename=file_id))
    if len(out['symbols']) >= 2000:
        out['limitations'].append('Symbol limit 2000 per file reached.')
except (SyntaxError, RecursionError) as exc:
    out['coverage'] = 'unavailable'
    out['limitations'].append(str(exc))
for scope in out['scopes']:
    for binding in scope['bindings'].values():
        if 'import_' in binding: binding['import'] = binding.pop('import_')
json.dump(out, sys.stdout)
