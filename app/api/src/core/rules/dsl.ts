/**
 * 规则条件 DSL（从 MVP rules/dsl.js 原样平移为 TS，语法零变化）。
 * 支持：比较 = != > >= < <= ~=（正则）/ 逻辑 AND OR NOT / 括号 / 裸字段（真值）。
 * 禁 eval/new Function；编译结果缓存；字段引用不存在直接抛错（尽早暴露规则配置错误）。
 */

type Ctx = Record<string, any>;
type Node = { eval: (ctx: Ctx) => boolean };

const CACHE = new Map<string, Node>();

class EvalError extends Error {}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push(c); i++; continue; }
    // 运算符（两字符优先）
    const two = expr.slice(i, i + 2);
    if (['!=', '>=', '<=', '~='].includes(two)) { tokens.push(two); i += 2; continue; }
    if (['=', '>', '<'].includes(c)) { tokens.push(c); i++; continue; }
    // 值/字段：读到空白或括号或运算符为止（'=' 结尾如 type=装配）
    let j = i;
    while (j < expr.length && !/[\s()]/.test(expr[j]) && !['=', '!', '>', '<', '~'].includes(expr[j])) j++;
    if (j === i) throw new EvalError(`无法解析的字符 '${c}' @${i} in: ${expr}`);
    tokens.push(expr.slice(i, j));
    i = j;
  }
  return tokens;
}

function isOp(t: string | undefined): boolean {
  return !!t && ['=', '!=', '>=', '<=', '>', '<', '~='].includes(t);
}

function compileExpr(tokens: string[], pos: { i: number }): Node {
  return compileOr(tokens, pos);
}

function compileOr(tokens: string[], pos: { i: number }): Node {
  let left = compileAnd(tokens, pos);
  while (tokens[pos.i]?.toUpperCase() === 'OR') {
    pos.i++;
    const right = compileAnd(tokens, pos);
    const l = left, r = right;
    left = { eval: (ctx) => l.eval(ctx) || r.eval(ctx) };
  }
  return left;
}

function compileAnd(tokens: string[], pos: { i: number }): Node {
  let left = compileUnary(tokens, pos);
  while (tokens[pos.i]?.toUpperCase() === 'AND') {
    pos.i++;
    const right = compileUnary(tokens, pos);
    const l = left, r = right;
    left = { eval: (ctx) => l.eval(ctx) && r.eval(ctx) };
  }
  return left;
}

function compileUnary(tokens: string[], pos: { i: number }): Node {
  if (tokens[pos.i]?.toUpperCase() === 'NOT') {
    pos.i++;
    const inner = compileUnary(tokens, pos);
    return { eval: (ctx) => !inner.eval(ctx) };
  }
  return compilePrimary(tokens, pos);
}

function compilePrimary(tokens: string[], pos: { i: number }): Node {
  const t = tokens[pos.i];
  if (t === undefined) throw new EvalError('表达式意外结束');
  if (t === '(') {
    pos.i++;
    const node = compileExpr(tokens, pos);
    if (tokens[pos.i] !== ')') throw new EvalError('缺少右括号');
    pos.i++;
    return node;
  }
  if (t === ')') throw new EvalError('多余的右括号');
  // 逻辑关键字不可作为字段
  if (['AND', 'OR', 'NOT'].includes(t.toUpperCase())) throw new EvalError(`意外的关键字 ${t}`);
  pos.i++;
  if (isOp(tokens[pos.i])) {
    const op = tokens[pos.i]; pos.i++;
    const valTok = tokens[pos.i];
    if (valTok === undefined) throw new EvalError(`运算符 ${op} 后缺少值`);
    pos.i++;
    const field = t;
    const numVal = Number(valTok);
    const useNum = valTok !== '' && !Number.isNaN(numVal) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(valTok);
    const strVal = valTok;
    return {
      eval: (ctx) => {
        if (!(field in ctx)) throw new EvalError(`规则引用了不存在的字段: ${field}`);
        const actual = ctx[field];
        const expected = useNum ? numVal : strVal;
        switch (op) {
          case '=': return typeof expected === 'number' ? Number(actual) === expected : String(actual) === expected;
          case '!=': return typeof expected === 'number' ? Number(actual) !== expected : String(actual) !== expected;
          case '>': return Number(actual) > Number(expected);
          case '>=': return Number(actual) >= Number(expected);
          case '<': return Number(actual) < Number(expected);
          case '<=': return Number(actual) <= Number(expected);
          case '~=': {
            let re: RegExp;
            try { re = new RegExp(String(expected)); } catch { throw new EvalError(`非法正则: ${expected}`); }
            return re.test(String(actual));
          }
          default: throw new EvalError(`未知运算符 ${op}`);
        }
      },
    };
  }
  // 裸字段 = 真值判断
  const field = t;
  return {
    eval: (ctx) => {
      if (!(field in ctx)) throw new EvalError(`规则引用了不存在的字段: ${field}`);
      return !!ctx[field];
    },
  };
}

/** 编译条件表达式；语法错误立即抛错 */
export function compile(expr: string): (ctx: Ctx) => boolean {
  const cached = CACHE.get(expr);
  if (cached) return (ctx) => cached.eval(ctx);
  const node = compileExpr(tokenize(expr), { i: 0 });
  const tokens = tokenize(expr);
  if (node === undefined) throw new EvalError('空表达式');
  if (tokens.filter((t) => t === '(').length !== tokens.filter((t) => t === ')').length) {
    throw new EvalError(`括号不配对: ${expr}`);
  }
  CACHE.set(expr, node);
  return (ctx) => node.eval(ctx);
}

/** 供启动自检：表达式可编译即通过 */
export function validate(expr: string): void {
  compile(expr);
}
