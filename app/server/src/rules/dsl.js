/**
 * 条件表达式 DSL（文档02 §9 约定）：简单比较 + 逻辑运算，无 eval。
 * 支持：field op value、AND / OR / NOT、括号、正则匹配 ~=
 * 示例：type=持住 AND dur_s>2 ；desc~=返工|重装|拆 ；same_desc_count>=2
 * 编译结果按表达式字符串缓存。
 */
const cache = new Map();

const OP_RE = /^(>=|<=|!=|~=|=|>|<)/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ t: ch }); i += 1; continue; }
    const op = OP_RE.exec(src.slice(i));
    if (op) { tokens.push({ t: 'op', v: op[1] }); i += op[1].length; continue; }
    let j = i;
    let word = '';
    while (j < src.length && !/\s/.test(src[j]) && src[j] !== '(' && src[j] !== ')') {
      if (j > i && OP_RE.test(src.slice(j))) break;
      word += src[j];
      j += 1;
    }
    if (!word) throw new Error(`条件表达式无法解析，位置 ${i}`);
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ t: 'kw', v: upper });
    else tokens.push({ t: 'word', v: word });
    i = j;
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const expectParen = (t) => {
    const token = tokens[pos];
    if (!token || token.t !== t) throw new Error(`条件表达式缺少括号 ${t}`);
    pos += 1;
  };

  function parseOr() {
    let left = parseAnd();
    while (peek()?.t === 'kw' && peek().v === 'OR') {
      pos += 1;
      left = { type: 'or', l: left, r: parseAnd() };
    }
    return left;
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek()?.t === 'kw' && peek().v === 'AND') {
      pos += 1;
      left = { type: 'and', l: left, r: parseUnary() };
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.t === 'kw' && peek().v === 'NOT') {
      pos += 1;
      return { type: 'not', e: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error('条件表达式不完整');
    if (token.t === '(') {
      pos += 1;
      const node = parseOr();
      expectParen(')');
      return node;
    }
    if (token.t !== 'word') throw new Error(`条件表达式此处应为字段名，实际是 ${token.v ?? token.t}`);
    pos += 1;
    const field = token.v;
    const opToken = peek();
    if (!opToken || opToken.t !== 'op') return { type: 'truthy', field };
    pos += 1;
    const valueToken = peek();
    if (!valueToken || valueToken.t === 'op') throw new Error(`条件表达式 ${field}${opToken.v} 缺少比较值`);
    pos += 1;
    return { type: 'cmp', field, op: opToken.v, value: valueToken.v };
  }

  const ast = parseOr();
  if (pos !== tokens.length) throw new Error(`条件表达式存在多余内容：${tokens[pos].v ?? tokens[pos].t}`);
  return ast;
}

function looseEq(left, right) {
  if (left === undefined || right === undefined) return false;
  const ln = Number(left);
  const rn = Number(right);
  if (left !== '' && right !== '' && Number.isFinite(ln) && Number.isFinite(rn)) return ln === rn;
  return String(left) === String(right);
}

function evaluate(node, ctx) {
  switch (node.type) {
    case 'or': return evaluate(node.l, ctx) || evaluate(node.r, ctx);
    case 'and': return evaluate(node.l, ctx) && evaluate(node.r, ctx);
    case 'not': return !evaluate(node.e, ctx);
    case 'truthy': return Boolean(ctx[node.field]);
    case 'cmp': {
      const left = ctx[node.field];
      if (left === undefined) throw new Error(`条件引用了上下文中不存在的字段：${node.field}`);
      switch (node.op) {
        case '=': return looseEq(left, node.value);
        case '!=': return !looseEq(left, node.value);
        case '>': return Number(left) > Number(node.value);
        case '>=': return Number(left) >= Number(node.value);
        case '<': return Number(left) < Number(node.value);
        case '<=': return Number(left) <= Number(node.value);
        case '~=': return new RegExp(String(node.value)).test(String(left));
        default: throw new Error(`不支持的操作符：${node.op}`);
      }
    }
    default: throw new Error(`未知表达式节点：${node.type}`);
  }
}

export function compileCondition(expression) {
  const key = String(expression ?? '').trim();
  if (!key) throw new Error('条件表达式为空');
  if (cache.has(key)) return cache.get(key);
  const compiled = parse(tokenize(key));
  cache.set(key, compiled);
  return compiled;
}

/** 运行条件：返回布尔值；字段缺失抛错（尽早暴露规则配置错误） */
export function testCondition(expression, ctx) {
  return Boolean(evaluate(compileCondition(expression), ctx));
}
