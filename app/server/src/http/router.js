/** 极简路由：方法 + /path/:param 模式匹配，避免额外依赖 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, parts: split(pattern), handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    const segs = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== segs.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const part = route.parts[i];
        const seg = segs[i];
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(seg);
        else if (part !== seg) { matched = false; break; }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

function split(p) {
  return p.split('/').filter(Boolean);
}
