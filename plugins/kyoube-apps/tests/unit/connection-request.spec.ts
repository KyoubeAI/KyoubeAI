// tests/unit/connection-request.spec.ts
import { describe, expect, it } from "vitest";
import { DataError } from "../../src/data/errors.js";
import type { Connection } from "../../src/connections/config.js";
import {
  MAX_REQUEST_BODY_BYTES, MAX_RESPONSE_BODY_BYTES, buildHeaders, buildUrl, parseCallInput, pathWithoutQuery, secretHasControlChar, shapeResponse,
} from "../../src/connections/request.js";

function conn(over: Partial<Connection> = {}): Connection {
  return {
    name: "stripe", baseUrl: "https://api.example.com/v1/", auth: "bearer", headerName: null,
    methods: "read-write", secretRef: { type: "secret_ref" }, configPath: "connections.0.secret", ...over,
  };
}

function failure(fn: () => unknown): DataError {
  try { fn(); } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("expected a DataError, but nothing was thrown");
}

function invalid(fn: () => unknown): void {
  expect(failure(fn).code).toBe("invalid");
}

const SECRET = "sk_live_TOPSECRET:pa:ss";

describe("parseCallInput", () => {
  it("defaults to GET with an empty path and nothing else", () => {
    expect(parseCallInput({})).toEqual({ method: "GET", path: "", query: {}, headers: {}, body: null });
    expect(parseCallInput(undefined)).toEqual({ method: "GET", path: "", query: {}, headers: {}, body: null });
  });

  it.each(["get", "Post", "PUT", "patch", "DELETE"])("accepts method %s", (m) => {
    expect(parseCallInput({ method: m, body: m.toLowerCase() === "get" ? undefined : "x" }).method).toBe(m.toUpperCase());
  });

  it.each([["HEAD"], ["OPTIONS"], ["TRACE"], ["CONNECT"], [""], [5], [null], [{}]])("refuses method %j", (m) => {
    invalid(() => parseCallInput({ method: m }));
  });

  it.each([[null], ["x"], [5], [[]]])("refuses a non-object call %j", (raw) => {
    invalid(() => parseCallInput(raw));
  });

  it("limits the path to 2000 characters and to strings", () => {
    expect(parseCallInput({ path: "a".repeat(2000) }).path).toHaveLength(2000);
    invalid(() => parseCallInput({ path: "a".repeat(2001) }));
    invalid(() => parseCallInput({ path: 5 }));
    invalid(() => parseCallInput({ path: null }));
  });

  it("stringifies numbers and booleans in the query and refuses the rest", () => {
    expect(parseCallInput({ query: { a: "x", n: 5, b: false } }).query).toEqual({ a: "x", n: "5", b: "false" });
    for (const bad of [{ a: null }, { a: { b: 1 } }, { a: [1] }, { a: undefined }, [], "x", 5, { a: Number.NaN }]) {
      invalid(() => parseCallInput({ query: bad }));
    }
  });

  it("allows 100 query keys and refuses 101", () => {
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(parseCallInput({ query: make(100) }).query)).toHaveLength(100);
    invalid(() => parseCallInput({ query: make(101) }));
  });

  it("keeps a __proto__ query key as data", () => {
    const query = parseCallInput(JSON.parse('{"query":{"__proto__":"x"}}')).query;
    expect(Object.keys(query)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
  });

  it("lower-cases header names and keeps only the six app-settable ones", () => {
    const headers = parseCallInput({
      headers: { Accept: "a/b", "Content-Type": "text/plain", "IF-MATCH": "1", "If-None-Match": "2", "Idempotency-Key": "k", "X-Request-Id": "r" },
      method: "POST", body: "x",
    }).headers;
    expect(headers).toEqual({ accept: "a/b", "content-type": "text/plain", "if-match": "1", "if-none-match": "2", "idempotency-key": "k", "x-request-id": "r" });
  });

  it.each(["authorization", "Authorization", "cookie", "proxy-authorization", "host", "content-length", "x-api-key", "user-agent", "x-forwarded-for"])(
    "refuses header %s", (name) => { invalid(() => parseCallInput({ headers: { [name]: "v" } })); },
  );

  it("refuses two spellings of the same header", () => {
    invalid(() => parseCallInput({ headers: { accept: "a", Accept: "b" } }));
  });

  it.each([["a\r\nX: y"], ["a\nb"], ["a\rb"], ["a\0b"], [5], [null], ["a".repeat(1001)]])("refuses header value %j", (v) => {
    invalid(() => parseCallInput({ headers: { accept: v } }));
  });

  it("accepts a header value of exactly 1000 characters", () => {
    expect(parseCallInput({ headers: { accept: "a".repeat(1000) } }).headers.accept).toHaveLength(1000);
  });

  it.each([[[]], ["x"], [5], [null]])("refuses headers %j", (h) => { invalid(() => parseCallInput({ headers: h })); });

  describe("body", () => {
    it("keeps a string as is", () => {
      expect(parseCallInput({ method: "POST", body: "a=1" })).toMatchObject({ body: "a=1", headers: {} });
    });
    it("maps null and undefined to no body", () => {
      expect(parseCallInput({ method: "POST", body: null }).body).toBeNull();
      expect(parseCallInput({ method: "POST" }).body).toBeNull();
    });
    it("serialises JSON values and adds the content type unless set", () => {
      expect(parseCallInput({ method: "POST", body: { a: 1 } })).toMatchObject({ body: '{"a":1}', headers: { "content-type": "application/json" } });
      expect(parseCallInput({ method: "POST", body: [1, 2] }).body).toBe("[1,2]");
      expect(parseCallInput({ method: "POST", body: 5 }).body).toBe("5");
      expect(parseCallInput({ method: "POST", body: { a: 1 }, headers: { "Content-Type": "application/vnd.x+json" } }).headers)
        .toEqual({ "content-type": "application/vnd.x+json" });
    });
    it("limits the body to 1 MiB by bytes", () => {
      expect(MAX_REQUEST_BODY_BYTES).toBe(1024 * 1024);
      expect(parseCallInput({ method: "POST", body: "a".repeat(MAX_REQUEST_BODY_BYTES) }).body).toHaveLength(MAX_REQUEST_BODY_BYTES);
      invalid(() => parseCallInput({ method: "POST", body: "a".repeat(MAX_REQUEST_BODY_BYTES + 1) }));
      // 2-byte characters: under the limit by length, over it by bytes.
      invalid(() => parseCallInput({ method: "POST", body: "é".repeat(MAX_REQUEST_BODY_BYTES / 2 + 1) }));
    });
    it("refuses a body that cannot be serialised", () => {
      invalid(() => parseCallInput({ method: "POST", body: () => 1 }));
      const cycle: Record<string, unknown> = {}; cycle.self = cycle;
      invalid(() => parseCallInput({ method: "POST", body: cycle }));
    });
    it("refuses a body on GET", () => {
      invalid(() => parseCallInput({ body: "x" }));
      invalid(() => parseCallInput({ method: "get", body: { a: 1 } }));
      invalid(() => parseCallInput({ method: "GET", body: "" }));
    });
  });
});

describe("buildUrl", () => {
  const base = conn();

  it.each([
    ["", "https://api.example.com/v1/"],
    ["customers", "https://api.example.com/v1/customers"],
    ["customers/cus_1/charges", "https://api.example.com/v1/customers/cus_1/charges"],
    ["customers/", "https://api.example.com/v1/customers/"],
    ["a b", "https://api.example.com/v1/a%20b"],
    ["a%20b", "https://api.example.com/v1/a%20b"],
    ["file.v2.json", "https://api.example.com/v1/file.v2.json"],
    ["a;b=c", "https://api.example.com/v1/a;b=c"],
    ["images:annotate", "https://api.example.com/v1/images:annotate"],
    ["text:synthesize", "https://api.example.com/v1/text:synthesize"],
    ["v1/projects/p:batchGet", "https://api.example.com/v1/v1/projects/p:batchGet"],
    ["caf%C3%A9", "https://api.example.com/v1/caf%C3%A9"],
    ["javascript:x", "https://api.example.com/v1/javascript:x"],
    ["https:evil.example", "https://api.example.com/v1/https:evil.example"],
    [".well-known/x", "https://api.example.com/v1/.well-known/x"],
    ["v1.2/x", "https://api.example.com/v1/v1.2/x"],
    ["a;jsessionid=1", "https://api.example.com/v1/a;jsessionid=1"],
    ["a.b./c", "https://api.example.com/v1/a.b./c"],
    ["caf%C3%A9;v=1", "https://api.example.com/v1/caf%C3%A9;v=1"],
    ["a..b", "https://api.example.com/v1/a..b"],
    ["%2541", "https://api.example.com/v1/%2541"],
  ])("allows path %j", (path, expected) => {
    expect(buildUrl(base, path, {})).toBe(expected);
  });

  it("appends the query with searchParams.set, encoding it", () => {
    expect(buildUrl(base, "customers", { limit: "5", q: "a b&c=d#e" })).toBe("https://api.example.com/v1/customers?limit=5&q=a+b%26c%3Dd%23e");
    expect(buildUrl(base, "", { "k y": "é" })).toBe("https://api.example.com/v1/?k+y=%C3%A9");
  });

  it("keeps a base URL without a path working", () => {
    expect(buildUrl(conn({ baseUrl: "https://api.example.com/" }), "x/y", {})).toBe("https://api.example.com/x/y");
  });

  const refused: Array<[string, string]> = [
    ["a leading slash", "/customers"],
    ["a leading slash escaping the base", "/v2/customers"],
    ["a leading backslash", "\\customers"],
    ["a backslash", "a\\b"],
    ["a backslash dot-dot", "..\\x"],
    ["a protocol-relative host", "//evil.example/x"],
    ["a protocol-relative host after slash", "///evil.example"],
    ["an absolute https URL", "https://evil.example/x"],
    ["an absolute URL to the same host", "https://api.example.com/v1/x"],
    ["an upper-case scheme", "HTTPS://evil.example"],
    ["a dot segment", "."],
    ["a leading dot-dot", ".."],
    ["dots only", "..."],
    ["dots only, long", "...."],
    ["semicolon after dot-dot", "..;/admin"],
    ["semicolon dot-dot repeated", "a/..;/..;/x"],
    ["semicolon after a dot", ".;"],
    ["semicolon params only", "a/;x/b"],
    ["encoded semicolon after dot-dot", "..%3b/x"],
    ["dot-dot and a space", ".. /x"],
    ["dot-dot and an encoded space", "..%20/x"],
    ["dot-dot and an encoded tab", "..%09/x"],
    ["a trailing-dot dot segment", "a/. ./b"],
    ["an encoded space only", "%20"],
    ["a %u escape", "%u002e%u002e"],
    ["an overlong dot", "%c0%ae%c0%ae"],
    ["an upper-case overlong dot", "%C0%AE/x"],
    ["an overlong slash", "..%c0%afx"],
    ["a 0xC1 lead byte", "%c1%9c"],
    ["a truncated escape", "%2"],
    ["a non-hex escape", "%zz"],
    ["a trailing percent", "a%"],
    ["an encoded full-width dot", "%EF%BC%8E%EF%BC%8E/x"],
    ["a literal colon-slash-slash", "a://b"],
    ["double-encoded dots", "%25%32%65%25%32%65/x"],
    ["double-encoded dots, partly encoded", "%252%65%252%65/x"],
    ["double-encoded dots, mixed", "%25%32e%25%32e/x"],
    ["double-encoded slashes", "a%25%32%66..%25%32%66x"],
    ["triple-encoded dot", "%2525%2532%2565"],
    ["a full-width slash after dots", "..%EF%BC%8Fx"],
    ["a division slash", "a%E2%88%95b"],
    ["a full-width backslash", "a%EF%BC%BCb"],
    ["invalid UTF-8 (lone byte)", "caf%E9"],
    ["invalid UTF-8 (0xff)", "x%ff"],
    ["more than three encodings", "%25252525252e"],
    ["a full-width percent forming a dot", "%EF%BC%852e%EF%BC%852e/x"],
    ["a small percent forming a dot", "%EF%B9%AA2e%EF%B9%AA2e/x"],
    ["a full-width percent, doubly encoded", "%EF%BC%85252e%EF%BC%85252e"],
    ["a full-width percent forming a slash", "..%EF%BC%852f"],
    ["a full-width percent forming a backslash", "a%EF%BC%855cb"],
    ["a full-width percent forming a NUL", "x%EF%BC%8500"],
    ["a full-width numeral forming an escape", "%EF%BC%85%EF%BC%92e/x"],
    ["a yen sign", "a%C2%A5b"],
    ["a won sign", "a%E2%82%A9b"],
    ["a full-width yen sign (folds to a yen sign)", "a%EF%BF%A5b"],
    ["a full-width won sign (folds to a won sign)", "a%EF%BF%A6b"],
    ["a vulgar fraction one half (folds to a fraction slash)", "a%C2%BDb"],
    ["a vulgar fraction one third (folds to a fraction slash)", "a%E2%85%93b"],
    ["a literal percent after decoding", "100%25"],
    ["a literal percent in the middle", "50%25off"],
    ["a dot-dot in the middle", "a/../b"],
    ["a dot-dot at the end", "a/.."],
    ["a dot-dot escaping", "../v2/x"],
    ["a dot segment in the middle", "a/./b"],
    ["a leading dot segment", "./a"],
    ["an encoded dot-dot", "%2e%2e/x"],
    ["an upper-case encoded dot-dot", "%2E%2E/x"],
    ["a mixed-case encoded dot", "%2e./x"],
    ["a dot and an encoded dot", ".%2e/x"],
    ["an encoded slash", "a%2fb"],
    ["an upper-case encoded slash", "a%2Fb"],
    ["dot-dot with an encoded slash", "..%2fx"],
    ["dot-dot with an upper-case encoded slash", "..%2Fx"],
    ["an encoded backslash", "a%5cb"],
    ["an upper-case encoded backslash", "a%5Cb"],
    ["a double-encoded dot", "%252e%252e/x"],
    ["a double-encoded slash", "a%252fb"],
    ["an encoded NUL", "a%00b"],
    ["a full-width dot", "．．/x"],
    ["a full-width slash", "a／b"],
    ["an ideographic full stop", "a。。/x"],
    ["a non-ASCII letter", "café"],
    ["an empty segment", "a//b"],
    ["an empty segment before dot-dot", "a//../b"],
    ["a question mark", "a?x=1"],
    ["only a query", "?x=1"],
    ["a hash", "a#frag"],
    ["only a fragment", "#frag"],
    ["a tab", "a\tb"],
    ["a tab inside dots", ".\t."],
    ["a newline", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a NUL", "a\0b"],
    ["a DEL", "a\x7fb"],
    ["a leading space dot-dot", " .."],
  ];
  it.each(refused)("refuses %s", (_label, path) => {
    invalid(() => buildUrl(base, path, {}));
  });

  it("tells the caller how to write non-ASCII characters", () => {
    expect(failure(() => buildUrl(base, "caf\u00e9", {})).message).toContain("%C3%A9");
  });

  it("joins as text: a leading scheme never changes the origin or the path prefix", () => {
    for (const p of ["javascript:x", "https:evil.example", "evil.example:443", "a@evil.example", ":@evil.example", "x:y@z/q"]) {
      const url = new URL(buildUrl(base, p, {}));
      expect(url.origin).toBe("https://api.example.com");
      expect(url.pathname.startsWith("/v1/")).toBe(true);
      expect(url.username + url.password + url.hash).toBe("");
    }
  });

  it("explains a literal percent after decoding", () => {
    expect(failure(() => buildUrl(base, "100%25", {})).message).toContain("literal %");
  });

  it("gives invalid UTF-8 its own message", () => {
    expect(failure(() => buildUrl(base, "caf%E9", {})).message).toContain("valid UTF-8");
    expect(failure(() => buildUrl(base, "x%ff", {})).message).toContain("valid UTF-8");
  });

  it("refuses a path that is not a string", () => {
    invalid(() => buildUrl(base, 5 as unknown as string, {}));
  });

  it("still checks the resolved URL against the origin and base path (defence in depth)", () => {
    // A connection whose stored base URL is not normalised must not widen what a call can reach.
    invalid(() => buildUrl(conn({ baseUrl: "https://api.example.com/v1" }), "x", {}));
    invalid(() => buildUrl(conn({ baseUrl: "http://api.example.com/v1/" }), "x", {}));
  });

  it("does not put the secret in an error", () => {
    expect(failure(() => buildUrl(base, `../${SECRET}`, {})).message).not.toContain(SECRET);
  });
});

describe("pathWithoutQuery", () => {
  it("drops a query and fragment", () => {
    expect(pathWithoutQuery("a/b?x=1")).toBe("a/b");
    expect(pathWithoutQuery("a/b#f")).toBe("a/b");
    expect(pathWithoutQuery("a/b")).toBe("a/b");
    expect(pathWithoutQuery("?x")).toBe("");
  });
});

describe("buildHeaders", () => {
  const call = (headers: Record<string, string> = {}) => ({ method: "GET" as const, path: "", query: {}, headers, body: null });

  it("sets Bearer", () => {
    expect(buildHeaders(conn({ auth: "bearer" }), call({ accept: "x/y" }), SECRET)).toEqual({ accept: "x/y", authorization: `Bearer ${SECRET}` });
  });
  it("sets the named header for header auth", () => {
    expect(buildHeaders(conn({ auth: "header", headerName: "x-api-key" }), call(), SECRET)).toEqual({ "x-api-key": SECRET });
  });
  it("sets Basic as base64 of the secret", () => {
    const headers = buildHeaders(conn({ auth: "basic" }), call(), "user:pa:ss");
    expect(headers.authorization).toBe(`Basic ${Buffer.from("user:pa:ss").toString("base64")}`);
    expect(headers.authorization).toBe("Basic dXNlcjpwYTpzcw==");
  });
  it("sends the secret as the whole Authorization value for authorization auth", () => {
    expect(buildHeaders(conn({ auth: "authorization" }), call({ accept: "x/y" }), SECRET)).toEqual({ accept: "x/y", authorization: SECRET });
  });
  it("refuses a call that sets the connection's own header, in any case", () => {
    invalid(() => buildHeaders(conn({ auth: "header", headerName: "accept" }), call({ accept: "x" }), SECRET));
    invalid(() => buildHeaders(conn({ auth: "header", headerName: "idempotency-key" }), call({ "Idempotency-Key": "x" }), SECRET));
  });
  it("refuses a call that carries authorization, whatever the auth style", () => {
    for (const auth of ["bearer", "basic", "header", "authorization"] as const) {
      invalid(() => buildHeaders(conn({ auth, headerName: auth === "header" ? "x-api-key" : null }), call({ authorization: "evil" }), SECRET));
    }
  });
  it("refuses a header-auth connection without a header name", () => {
    invalid(() => buildHeaders(conn({ auth: "header", headerName: null }), call(), SECRET));
  });
  it("refuses an empty secret and a secret that would break the header, without echoing it", () => {
    for (const bad of ["", "ab\r\nX-Evil: 1", "ab\ncd", "ab\0cd"]) {
      const error = failure(() => buildHeaders(conn({ auth: "bearer" }), call(), bad));
      expect(error.code).toBe("invalid");
      if (bad) expect(error.message).not.toContain("ab");
    }
    // Basic encodes the secret, so control characters in it are harmless there.
    expect(buildHeaders(conn({ auth: "basic" }), call(), "a\nb").authorization).toMatch(/^Basic /);
  });
  it("tells the service which secrets can never be sent (bearer, header and authorization with a control character)", () => {
    expect(secretHasControlChar(conn({ auth: "bearer" }), "key\n")).toBe(true);
    expect(secretHasControlChar(conn({ auth: "header", headerName: "x-api-key" }), "k\x7fey")).toBe(true);
    expect(secretHasControlChar(conn({ auth: "authorization" }), "key\r")).toBe(true);
    expect(secretHasControlChar(conn({ auth: "bearer" }), "key")).toBe(false);
    expect(secretHasControlChar(conn({ auth: "basic" }), "user:pa\nss")).toBe(false);
  });
  it("refuses a secret with any control character for bearer and header auth, without echoing it", () => {
    for (const auth of ["bearer", "header", "authorization"] as const) {
      for (const bad of ["ab\tcd", "ab\x01cd", "ab\x7fcd", "ab\x1fcd"]) {
        const error = failure(() => buildHeaders(conn({ auth, headerName: auth === "header" ? "x-api-key" : null }), call(), bad));
        expect(error.code).toBe("invalid");
        expect(error.message).not.toContain("ab");
      }
    }
  });
  it("cannot lose the auth header to a prototype key", () => {
    const headers = buildHeaders(conn({ auth: "header", headerName: "__proto__" }), call(), SECRET);
    expect(Object.keys(headers)).toEqual(["__proto__"]);
    expect(headers["__proto__"]).toBe(SECRET);
  });
  it("does not mutate the call", () => {
    const c = call({ accept: "x" });
    buildHeaders(conn(), c, SECRET);
    expect(c.headers).toEqual({ accept: "x" });
  });
});

describe("shapeResponse", () => {
  it("keeps only the allowed headers, lower-cased, and the ratelimit family", () => {
    const shaped = shapeResponse({
      status: 201,
      headers: {
        "Content-Type": "application/json", "Content-Length": "2", ETag: "\"a\"", "Last-Modified": "x", Location: "/y", "Retry-After": "3",
        "X-Request-Id": "r", "X-RateLimit-Remaining": "9", "x-ratelimit-reset": "1", "Set-Cookie": "s=1", Authorization: "Bearer z",
        "WWW-Authenticate": "Basic", "Proxy-Authenticate": "x", Server: "nginx", "X-Powered-By": "php", "x-ratelimitless": "1",
      },
      bodyText: "{}",
    });
    expect(shaped).toEqual({
      status: 201, body: "{}",
      headers: {
        "content-type": "application/json", "content-length": "2", etag: "\"a\"", "last-modified": "x", location: "/y", "retry-after": "3",
        "x-request-id": "r", "x-ratelimit-remaining": "9", "x-ratelimit-reset": "1",
      },
    });
  });
  it("accepts a Headers object", () => {
    const headers = new Headers({ "Content-Type": "text/plain", "Set-Cookie": "a=1", "X-RateLimit-Limit": "5" });
    expect(shapeResponse({ status: 200, headers, bodyText: "hi" }).headers).toEqual({ "content-type": "text/plain", "x-ratelimit-limit": "5" });
  });
  it("returns every status as is", () => {
    for (const status of [204, 301, 404, 429, 500]) expect(shapeResponse({ status, headers: {}, bodyText: "" }).status).toBe(status);
  });
  it("limits the body to 2 MiB by bytes", () => {
    expect(MAX_RESPONSE_BODY_BYTES).toBe(2 * 1024 * 1024);
    expect(shapeResponse({ status: 200, headers: {}, bodyText: "a".repeat(MAX_RESPONSE_BODY_BYTES) }).body).toHaveLength(MAX_RESPONSE_BODY_BYTES);
    expect(failure(() => shapeResponse({ status: 200, headers: {}, bodyText: "a".repeat(MAX_RESPONSE_BODY_BYTES + 1) })).code).toBe("too_large");
    expect(failure(() => shapeResponse({ status: 200, headers: {}, bodyText: "é".repeat(MAX_RESPONSE_BODY_BYTES / 2 + 1) })).code).toBe("too_large");
  });
});
