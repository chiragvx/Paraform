// Expression parser + evaluator for the parameters system.
//
// All numeric values are in millimeters. Literals may carry a unit suffix
// (mm / cm / m / in) which is converted at tokenization time. Identifiers
// are looked up from a scope object and assumed to already be in mm.
//
// Grammar (recursive descent + precedence climbing on binary ops):
//
//   expr      := addSub
//   addSub    := mulDiv (('+' | '-') mulDiv)*
//   mulDiv    := unary  (('*' | '/') unary )*
//   unary     := ('+' | '-') unary | primary
//   primary   := number | ident | ident '(' args? ')' | '(' expr ')'
//   args      := expr (',' expr)*
//
// The parser is stateless; each parse() call creates a fresh cursor.

const UNIT_TO_MM = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
};

const FUNCTIONS = {
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  abs: (args) => Math.abs(args[0]),
  sqrt: (args) => Math.sqrt(args[0]),
  sin: (args) => Math.sin(args[0]),
  cos: (args) => Math.cos(args[0]),
};

const FUNCTION_ARITY = {
  min: 2,
  max: 2,
  abs: 1,
  sqrt: 1,
  sin: 1,
  cos: 1,
};

// Identifiers that are constants, not variables (no scope lookup, no dep).
const CONSTANTS = {
  pi: Math.PI,
};

// ---- Tokenizer -------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Numbers (with optional unit suffix)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      if (src[j] === '.') {
        j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      const numText = src.slice(i, j);
      let value = parseFloat(numText);
      if (!Number.isFinite(value)) {
        throw new Error(`invalid number: ${numText}`);
      }

      // Optional unit suffix immediately after the digits.
      let unitEnd = j;
      while (unitEnd < n && isIdentChar(src[unitEnd], unitEnd === j)) unitEnd++;
      if (unitEnd > j) {
        const unit = src.slice(j, unitEnd);
        if (UNIT_TO_MM[unit] === undefined) {
          throw new Error(`unknown unit: ${unit}`);
        }
        value *= UNIT_TO_MM[unit];
        j = unitEnd;
      }

      tokens.push({ type: 'num', value, pos: i });
      i = j;
      continue;
    }

    // Identifiers
    if (isIdentChar(ch, true)) {
      let j = i + 1;
      while (j < n && isIdentChar(src[j], false)) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // Operators and punctuation
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ type: ch, pos: i });
      i++;
      continue;
    }

    throw new Error(`unexpected character '${ch}' at ${i}`);
  }

  tokens.push({ type: 'eof', pos: n });
  return tokens;
}

function isIdentChar(ch, isFirst) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  const isAlpha =
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ch === '_';
  if (isFirst) return isAlpha;
  const isDigit = code >= 48 && code <= 57;
  return isAlpha || isDigit;
}

// ---- Parser ----------------------------------------------------------------

function makeParser(tokens) {
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (type) => {
    const t = tokens[pos];
    if (t.type !== type) {
      throw new Error(`expected ${type} but got ${t.type} at ${t.pos}`);
    }
    pos++;
    return t;
  };

  function parseExpr() {
    return parseAddSub();
  }

  function parseAddSub() {
    let left = parseMulDiv();
    while (peek().type === '+' || peek().type === '-') {
      const op = peek().type;
      pos++;
      const right = parseMulDiv();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  function parseMulDiv() {
    let left = parseUnary();
    while (peek().type === '*' || peek().type === '/') {
      const op = peek().type;
      pos++;
      const right = parseUnary();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek().type === '+' || peek().type === '-') {
      const op = peek().type;
      pos++;
      const operand = parseUnary();
      return { type: 'unary', op, operand };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'num') {
      pos++;
      return { type: 'num', value: t.value };
    }
    if (t.type === 'ident') {
      pos++;
      // Function call?
      if (peek().type === '(') {
        pos++;
        const args = [];
        if (peek().type !== ')') {
          args.push(parseExpr());
          while (peek().type === ',') {
            pos++;
            args.push(parseExpr());
          }
        }
        eat(')');
        return { type: 'call', name: t.value, args };
      }
      return { type: 'ident', name: t.value };
    }
    if (t.type === '(') {
      pos++;
      const inner = parseExpr();
      eat(')');
      return inner;
    }
    throw new Error(`unexpected token ${t.type} at ${t.pos}`);
  }

  return {
    parseAll() {
      if (peek().type === 'eof') {
        throw new Error('empty expression');
      }
      const ast = parseExpr();
      if (peek().type !== 'eof') {
        const t = peek();
        throw new Error(`unexpected token ${t.type} at ${t.pos}`);
      }
      return ast;
    },
  };
}

// ---- Public API ------------------------------------------------------------

export function parse(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new Error('empty expression');
  }
  const tokens = tokenize(expr);
  return makeParser(tokens).parseAll();
}

function evalNode(node, scope) {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'ident': {
      if (CONSTANTS[node.name] !== undefined) return CONSTANTS[node.name];
      if (!scope || !Object.prototype.hasOwnProperty.call(scope, node.name)) {
        throw new Error(`unknown variable: ${node.name}`);
      }
      const v = scope[node.name];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`unknown variable: ${node.name}`);
      }
      return v;
    }
    case 'unary': {
      const v = evalNode(node.operand, scope);
      return node.op === '-' ? -v : v;
    }
    case 'binop': {
      const l = evalNode(node.left, scope);
      const r = evalNode(node.right, scope);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new Error('divide by zero');
          return l / r;
        default:
          throw new Error(`unknown operator: ${node.op}`);
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`unknown function: ${node.name}`);
      const expected = FUNCTION_ARITY[node.name];
      if (node.args.length !== expected) {
        throw new Error(
          `${node.name}() expects ${expected} arg(s), got ${node.args.length}`,
        );
      }
      const args = node.args.map((a) => evalNode(a, scope));
      return fn(args);
    }
    default:
      throw new Error(`unknown node type: ${node.type}`);
  }
}

export function evaluate(expr, scope = {}) {
  const ast = parse(expr);
  return evalNode(ast, scope);
}

export function extractDeps(expr) {
  const ast = parse(expr);
  const deps = new Set();
  function walk(node) {
    switch (node.type) {
      case 'num':
        return;
      case 'ident':
        if (CONSTANTS[node.name] === undefined) deps.add(node.name);
        return;
      case 'unary':
        walk(node.operand);
        return;
      case 'binop':
        walk(node.left);
        walk(node.right);
        return;
      case 'call':
        // function name is not a dep
        for (const a of node.args) walk(a);
        return;
    }
  }
  walk(ast);
  return [...deps];
}

export function validate(expr) {
  try {
    parse(expr);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

export function format(value, unit = 'mm', decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  const text = value.toFixed(decimals);
  return unit ? `${text} ${unit}` : text;
}
