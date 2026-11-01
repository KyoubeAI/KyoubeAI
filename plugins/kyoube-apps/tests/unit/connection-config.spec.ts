import { describe, expect, it } from "vitest";
import { CONNECTIONS_CONFIG_SCHEMA, MAX_CONNECTIONS, parseConnections, validateConnectionsConfig } from "../../src/connections/config.js";
import { DECISIONS_CONFIG_SCHEMA } from "../../src/decisions/config.js";
import manifest from "../../src/manifest.js";

const REF = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };
const good = (over: Record<string, unknown> = {}) => ({ name: "stripe", baseUrl: "https://api.stripe.com/v1", auth: "bearer", secret: REF, ...over });
const one = (over: Record<string, unknown> = {}) => parseConnections({ connections: [good(over)] });
const problemOf = (over: Record<string, unknown>) => one(over).problems[0]?.problem ?? "none";

describe("parseConnections", () => {
  it("parses a valid connection with defaults and normalisation", () => {
    const { connections, problems } = one();
    expect(problems).toEqual([]);
    expect(connections).toEqual([{
      name: "stripe", baseUrl: "https://api.stripe.com/v1/", auth: "bearer", headerName: null,
      methods: "read", secretRef: REF, configPath: "connections.0.secret",
    }]);
  });
  it("returns nothing for a missing or non-array connections value", () => {
    expect(parseConnections({})).toEqual({ connections: [], problems: [] });
    expect(parseConnections({ connections: "x" }).connections).toEqual([]);
  });
  it("normalises the base URL", () => {
    expect(one({ baseUrl: "https://api.x.com/v1" }).connections[0]?.baseUrl).toBe("https://api.x.com/v1/");
    expect(one({ baseUrl: "https://api.x.com" }).connections[0]?.baseUrl).toBe("https://api.x.com/");
    expect(one({ baseUrl: "https://api.x.com/a/../b" }).connections[0]?.baseUrl).toBe("https://api.x.com/b/");
  });
  it("refuses bad base URLs", () => {
    for (const baseUrl of ["http://api.x.com/", "nope", "", "https://u:p@api.x.com/", "https://api.x.com/?a=1", "https://api.x.com/#f"]) {
      expect(problemOf({ baseUrl })).not.toBe("none");
    }
  });
  it("checks the name format and uniqueness", () => {
    for (const name of ["Stripe", "1abc", "", "a b", "a".repeat(41)]) expect(problemOf({ name })).not.toBe("none");
    expect(one({ name: "a".repeat(40) }).problems).toEqual([]);
    const r = parseConnections({ connections: [good(), good()] });
    expect(r.connections).toHaveLength(1);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ index: 1, name: "stripe" });
  });
  it("allows at most 20 connections", () => {
    const many = Array.from({ length: MAX_CONNECTIONS + 1 }, (_, i) => good({ name: `c${i}` }));
    const r = parseConnections({ connections: many });
    expect(r.connections).toHaveLength(MAX_CONNECTIONS);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.index).toBe(MAX_CONNECTIONS);
  });
  it("checks auth and header names", () => {
    expect(problemOf({ auth: "oauth" })).not.toBe("none");
    expect(problemOf({ auth: undefined })).not.toBe("none");
    expect(problemOf({ auth: "header" })).not.toBe("none");
    expect(problemOf({ auth: "header", headerName: "bad name" })).not.toBe("none");
    for (const headerName of ["Authorization", "Cookie", "HOST", "Proxy-Authorization", "proxy-x", "Content-Length", "content-type"]) {
      expect(problemOf({ auth: "header", headerName })).not.toBe("none");
    }
    const c = one({ auth: "header", headerName: "X-API-Key" }).connections[0];
    // A header that names the API key is fine even when it starts like a refused one.
    expect(one({ auth: "header", headerName: "X-Connection-Key" }).connections).toHaveLength(1);
    expect(c?.headerName).toBe("x-api-key");
    expect(one({ auth: "basic", headerName: "X-Ignored" }).connections[0]?.headerName).toBeNull();
    expect(one({ auth: "authorization", headerName: "X-Ignored" }).connections[0]).toMatchObject({ auth: "authorization", headerName: null });
  });
  it("requires a secret_ref object, refusing a bare string", () => {
    expect(problemOf({ secret: undefined })).not.toBe("none");
    expect(problemOf({ secret: "11111111-1111-4111-8111-111111111111" })).not.toBe("none");
    expect(problemOf({ secret: { type: "other" } })).not.toBe("none");
  });
  it("checks methods", () => {
    expect(one({ methods: "read-write" }).connections[0]?.methods).toBe("read-write");
    expect(one({ methods: undefined }).connections[0]?.methods).toBe("read");
    expect(problemOf({ methods: "write" })).not.toBe("none");
  });
  it("uses the raw array index in configPath, counting invalid items", () => {
    const r = parseConnections({ connections: [good({ name: "a" }), good({ name: "BAD" }), good({ name: "c" })] });
    expect(r.connections.map((c) => c.configPath)).toEqual(["connections.0.secret", "connections.2.secret"]);
    expect(r.problems[0]?.index).toBe(1);
  });
  it("reports non-object items", () => {
    expect(parseConnections({ connections: [null] }).problems[0]).toMatchObject({ index: 0, name: null });
  });
});

describe("validateConnectionsConfig", () => {
  it("is ok for valid or empty config", () => {
    expect(validateConnectionsConfig({})).toEqual({ ok: true });
    expect(validateConnectionsConfig({ connections: [good()] })).toEqual({ ok: true });
  });
  it("returns problems as errors", () => {
    const r = validateConnectionsConfig({ connections: [good({ baseUrl: "http://x.com" })] });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]).toContain("stripe");
  });
});

describe("merged manifest schema", () => {
  it("keeps the decisions fields and adds connections", () => {
    const props = (manifest.instanceConfigSchema as { properties: Record<string, unknown> }).properties;
    for (const key of Object.keys(DECISIONS_CONFIG_SCHEMA.properties)) expect(props).toHaveProperty(key);
    expect(props.connections).toEqual(CONNECTIONS_CONFIG_SCHEMA.properties.connections);
  });
});

describe("hop-by-hop header names", () => {
  it.each(["transfer-encoding", "Connection", "TE", "upgrade", "Expect", "keep-alive", "Trailer"])("refuses %s for header auth", (headerName) => {
    const { connections, problems } = parseConnections({
      connections: [{ name: "x", baseUrl: "https://a.example/", auth: "header", headerName, secret: { type: "secret_ref" } }],
    });
    expect(connections).toEqual([]);
    expect(problems[0]?.problem).toContain("cannot be used for a secret");
  });
});

describe("header names that are object prototype keys", () => {
  it.each(["__proto__", "Constructor", "PROTOTYPE"])("refuses %s for header auth", (headerName) => {
    const { connections, problems } = parseConnections({
      connections: [{ name: "x", baseUrl: "https://a.example/", auth: "header", headerName, secret: { type: "secret_ref" } }],
    });
    expect(connections).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe("base URL normalisation", () => {
  it.each(["https://api.example.com/v1/?", "https://api.example.com/v1/#", "https://api.example.com/v1?", "https://api.example.com/v1"])(
    "stores %s without a stray ? or #", (baseUrl) => {
      const { connections } = parseConnections({ connections: [{ name: "x", baseUrl, auth: "bearer", secret: { type: "secret_ref" } }] });
      expect(connections[0]?.baseUrl).toBe("https://api.example.com/v1/");
    },
  );
});
