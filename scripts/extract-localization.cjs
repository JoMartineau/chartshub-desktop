'use strict';
// Source-only localization inventory. Never executes product modules or reads profiles.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const messages = [], dynamic = [], seen = new Set();
const name = n => n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) ? n.text : '';
function template(n, expressions = []) {
  if (!n) return null;
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    let value = n.head.text;
    for (const span of n.templateSpans) { expressions.push(span.expression.getText()); value += '{value' + expressions.length + '}' + span.literal.text; }
    return value;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = template(n.left, expressions), right = template(n.right, expressions);
    if (left !== null && right !== null) return left + right;
  }
  expressions.push(n.getText()); return '{value' + expressions.length + '}';
}
function add(fr, en, node, file, ast, context) {
  const fe = [], ee = [], translationFR = template(fr, fe), source = template(en, ee);
  const placeholders = text => [...new Set([...(text || '').matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort();
  if (!source || !translationFR || !/[a-zA-Z]/.test(source.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g,'')) || !/[a-zA-ZÀ-ÿ]/.test(translationFR.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g,'')) || /^#[a-f0-9]{3,8}$/i.test(source)) return;
  if (['en','fr','en-US','en-CA','fr-CA','fr-FR','ltr','rtl'].includes(source)) return;
  const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const key = JSON.stringify([source, translationFR, file, line]); if (seen.has(key)) return; seen.add(key);
  const record = { source: source.normalize('NFC'), translationFR: translationFR.normalize('NFC'), context, file, line };
  const slots = placeholders(source), frenchSlots = placeholders(translationFR);
  if (slots.length || frenchSlots.length) {
    record.placeholders = slots;
    if (ee.length) record.expressions = ee;
    record.dynamic = true;
    if (slots.join(',') !== frenchSlots.join(',')) record.review = 'placeholder-mismatch';
  }
  messages.push(record);
}
function paired(fr, en, node, file, ast, context) {
  if (!fr || !en) return;
  if (ts.isObjectLiteralExpression(fr) && ts.isObjectLiteralExpression(en)) {
    const english = new Map(en.properties.filter(ts.isPropertyAssignment).map(p => [name(p.name), p.initializer]));
    for (const p of fr.properties.filter(ts.isPropertyAssignment)) paired(p.initializer, english.get(name(p.name)), p, file, ast, context + '.' + name(p.name));
  } else if (ts.isArrayLiteralExpression(fr) && ts.isArrayLiteralExpression(en)) {
    fr.elements.forEach((v, i) => paired(v, en.elements[i], v, file, ast, context + '[' + i + ']'));
  } else add(fr, en, node, file, ast, context);
}
const localeCondition = text => /^(?:fr|en|french)$/.test(text) || /(?:language|locale|\.lang|\.startsWith\(['"]fr)/i.test(text);
function scanFile(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8'), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(n) {
    if (ts.isCallExpression(n) && n.arguments.length >= 2) {
      const method = ts.isPropertyAccessExpression(n.expression) ? name(n.expression.name) : name(n.expression);
      if (['tr', 't', 'updateText'].includes(method)) paired(n.arguments[0], n.arguments[1], n, file, ast, 'pair');
      if (['label', 'staticText', 'localizedPair', 'localePair'].includes(method)) paired(n.arguments[1], n.arguments[2], n, file, ast, 'pair');
      if (file === 'desktop/edit-context-menu.cjs' && method === 'command') paired(n.arguments[2], n.arguments[3], n, file, ast, 'context-menu');
      if (file === 'companion/ui/ui-bloom.js') {
        if (['node', 'field'].includes(method)) paired(n.arguments[3], n.arguments[2], n, file, ast, 'theme');
        if (['button', 'toggle'].includes(method)) paired(n.arguments[2], n.arguments[1], n, file, ast, 'theme');
      }
    }
    if (ts.isConditionalExpression(n) && localeCondition(n.condition.getText(ast))) {
      const cond = n.condition.getText(ast), enFirst = /(?:===?|startsWith\()\s*['"]en/.test(cond) || cond === 'en';
      paired(enFirst ? n.whenFalse : n.whenTrue, enFirst ? n.whenTrue : n.whenFalse, n, file, ast, 'conditional');
    }
    if (ts.isObjectLiteralExpression(n)) {
      const entries = n.properties.filter(ts.isPropertyAssignment), props = new Map(entries.map(p => [name(p.name), p.initializer]));
      if (props.has('fr') && props.has('en')) paired(props.get('fr'), props.get('en'), n, file, ast, 'dictionary');
      for (const [key, value] of props) if (key.endsWith('Fr') && props.has(key.slice(0, -2) + 'En')) paired(value, props.get(key.slice(0, -2) + 'En'), n, file, ast, key.slice(0, -2));
      const frenchKeys = ts.isVariableDeclaration(n.parent) && name(n.parent.name) === 'translations'
        || ts.isCallExpression(n.parent) && n.parent.expression.getText(ast) === 'Object.assign' && n.parent.arguments[0]?.getText(ast) === 'translations';
      if (frenchKeys) for (const p of entries) if (ts.isStringLiteralLike(p.name) && ts.isStringLiteralLike(p.initializer)) add(p.name, p.initializer, p, file, ast, 'french-keyed-dictionary');
    }
    // Legacy central map and explicit two-element bilingual tuples.
    if (ts.isArrayLiteralExpression(n) && n.elements.length === 2 && n.elements.every(ts.isStringLiteralLike)) {
      const [fr, en] = n.elements;
      if (file === 'companion/ui/localization.js' || /[éèêàâçîïôûùüœ’]/.test(fr.text)) add(fr, en, n, file, ast, 'legacy-tuple');
    }
    if (file === 'companion/ui/localization.js' && ts.isArrayLiteralExpression(n) && n.elements.length === 2 && n.elements[0].kind === ts.SyntaxKind.RegularExpressionLiteral
      && !/\btr\(/.test(n.elements[1].getText(ast))) dynamic.push({file,line:ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1,pattern:n.elements[0].getText(ast),renderer:n.elements[1].getText(ast),review:'Keep substitutions as parameters; human translation template required.'});
    ts.forEachChild(n, visit);
  }
  visit(ast);
}
const omitted = new Set(['node_modules', 'dist', 'tests', '.git', '.github', 'assets', 'native-drum-host', 'native-filters', 'quick-import-mod', 'game-widgets-mod', 'reshade-bridge', 'scripts', 'outputs']);
function walk(directory = '') { for (const ent of fs.readdirSync(path.join(root, directory), {withFileTypes:true})) { if (omitted.has(ent.name)) continue; const rel = path.posix.join(directory, ent.name); if (ent.isDirectory()) walk(rel); else if (/\.(?:js|cjs|ts)$/.test(ent.name)) scanFile(rel); } }
walk(); messages.sort((a,b) => a.source.localeCompare(b.source,'en') || a.file.localeCompare(b.file,'en') || a.line-b.line);
const value = {version:1,product:'desktop',messages,dynamic};
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(value,null,2)+'\n'); else process.stdout.write(JSON.stringify(value,null,2)+'\n');
