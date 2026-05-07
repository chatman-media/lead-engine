export type RouteContext = {
  req: Request;
  url: URL;
  params: Record<string, string>;
};

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

type CompiledRoute = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
};

export class Router {
  private routes: CompiledRoute[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    const paramNames: string[] = [];
    const regexSrc = path
      .replace(/[.+*?^${}()|[\]\\]/g, "\\$&")
      .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      });
    const pattern = new RegExp(`^${regexSrc}$`);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
    });
    return this;
  }

  get(path: string, handler: RouteHandler) {
    return this.add("GET", path, handler);
  }
  post(path: string, handler: RouteHandler) {
    return this.add("POST", path, handler);
  }
  put(path: string, handler: RouteHandler) {
    return this.add("PUT", path, handler);
  }
  delete(path: string, handler: RouteHandler) {
    return this.add("DELETE", path, handler);
  }
  patch(path: string, handler: RouteHandler) {
    return this.add("PATCH", path, handler);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== method && route.method !== "ALL") continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] ?? "");
      });
      try {
        return await route.handler({ req, url, params });
      } catch (err) {
        console.error(`[router] ${method} ${url.pathname} failed`, err);
        return new Response("Internal Server Error", { status: 500 });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
}

export function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function text(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}
