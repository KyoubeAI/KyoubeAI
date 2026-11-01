export const MAX_CONNECTIONS = 20;
export const CONNECTION_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export type ConnectionAuth = "bearer" | "header" | "basic" | "authorization";
export type ConnectionMethods = "read" | "read-write";

export interface Connection {
  name: string;
  /** Normalised: https, no credentials/query/fragment, ends with "/". */
  baseUrl: string;
  auth: ConnectionAuth;
  /** Lower-cased; only for `header` auth. */
  headerName: string | null;
  methods: ConnectionMethods;
  /** The saved `{ type: "secret_ref", ... }`. */
  secretRef: unknown;
  /** Where the core binds this connection's secret: `connections.<index>.secret`, with the raw array index. */
  configPath: string;
}

const AUTHS: readonly string[] = ["bearer", "header", "basic", "authorization"];
const METHODS: readonly string[] = ["read", "read-write"];
const HEADER_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// The credentials and framing headers, plus the hop-by-hop ones: a secret sent as one of those would
// change how the request is framed or forwarded rather than authenticate it.
const FORBIDDEN_HEADERS = new Set([
  "authorization", "cookie", "host", "content-length", "content-type",
  "transfer-encoding", "connection", "te", "upgrade", "expect", "keep-alive", "trailer",
]);

const CONNECTIONS_PROPERTY = {
  type: "array",
  title: "Connections",
  description: "External APIs that apps and agents can call with a company secret, without ever seeing the key.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", title: "Name", description: "Lower-case letters, digits, - and _; what apps and agents use, e.g. stripe." },
      baseUrl: { type: "string", title: "Base URL", description: "https:// only, e.g. https://api.stripe.com/v1/. Calls can only reach paths under it." },
      auth: { type: "string", title: "Auth", enum: ["bearer", "header", "basic", "authorization"], description: "bearer: Authorization: Bearer <secret>. header: the secret in the header named below. basic: the secret is user:password. authorization: Authorization: <secret>, for APIs that take the bare key." },
      headerName: { type: "string", title: "Header name (auth = header)", description: "e.g. X-API-Key" },
      // ajv validates the saved { type: "secret_ref" } object against this; the form keys on `format`.
      secret: { type: ["string", "object"], format: "secret-ref", title: "Secret", description: "A company secret holding the key." },
      methods: { type: "string", title: "Methods", enum: ["read", "read-write"], description: "read: GET only. read-write: GET, POST, PUT, PATCH, DELETE." },
    },
  },
};

/** `properties` is what the manifest merges into `instanceConfigSchema`; `connections` is the same field on its own. */
export const CONNECTIONS_CONFIG_SCHEMA = {
  connections: CONNECTIONS_PROPERTY,
  properties: { connections: CONNECTIONS_PROPERTY },
};

export interface ConnectionProblem { index: number; name: string | null; problem: string }

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseOne(item: unknown, index: number, seen: Set<string>): Connection | string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "the entry is not an object";
  const row = item as Record<string, unknown>;
  const name = str(row.name);
  if (!CONNECTION_NAME_RE.test(name)) return "the name must be lower-case letters, digits, - and _, start with a letter, and be at most 40 characters";
  if (seen.has(name)) return `the name "${name}" is already used by another connection`;

  const rawUrl = str(row.baseUrl);
  let url: URL;
  try { url = new URL(rawUrl); } catch { return "the base URL is not a URL"; }
  if (url.protocol !== "https:") return "the base URL must start with https://";
  if (url.username || url.password || url.search || url.hash) return "the base URL must not carry credentials, a query or a fragment";
  const joined = url.origin + url.pathname; // drops a bare "?" or "#"
  const baseUrl = joined.endsWith("/") ? joined : `${joined}/`;

  const auth = row.auth;
  if (typeof auth !== "string" || !AUTHS.includes(auth)) return "auth must be bearer, header, basic or authorization";
  let headerName: string | null = null;
  if (auth === "header") {
    const header = str(row.headerName);
    if (!header) return "auth \"header\" needs a header name";
    if (!HEADER_TOKEN_RE.test(header)) return `"${header}" is not a valid header name`;
    const lower = header.toLowerCase();
    if (lower === "__proto__" || lower === "constructor" || lower === "prototype") return `"${header}" is not a usable header name`;
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-")) return `the header "${header}" cannot be used for a secret`;
    headerName = lower;
  }

  const secret = row.secret;
  if (secret === undefined || secret === null || secret === "") return "pick the secret";
  if (typeof secret !== "object" || Array.isArray(secret) || (secret as { type?: unknown }).type !== "secret_ref") {
    return "the secret must be picked from the company secrets";
  }

  const methods = row.methods === undefined || row.methods === null || row.methods === "" ? "read" : row.methods;
  if (typeof methods !== "string" || !METHODS.includes(methods)) return "methods must be read or read-write";

  return {
    name, baseUrl, auth: auth as ConnectionAuth, headerName, methods: methods as ConnectionMethods,
    secretRef: secret, configPath: `connections.${index}.secret`,
  };
}

/** All connections, valid ones only; problems listed per index (shown on the admin page, never thrown). */
export function parseConnections(raw: Record<string, unknown>): { connections: Connection[]; problems: ConnectionProblem[] } {
  const list = raw?.connections;
  const connections: Connection[] = [];
  const problems: ConnectionProblem[] = [];
  if (!Array.isArray(list)) return { connections, problems };
  const seen = new Set<string>();
  list.forEach((item, index) => {
    const rawName = item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
      ? (item as { name: string }).name.trim() : "";
    const name = rawName || null;
    if (index >= MAX_CONNECTIONS) {
      problems.push({ index, name, problem: `at most ${MAX_CONNECTIONS} connections are allowed` });
      return;
    }
    const result = parseOne(item, index, seen);
    if (typeof result === "string") {
      problems.push({ index, name, problem: result });
      return;
    }
    seen.add(result.name);
    connections.push(result);
  });
  return { connections, problems };
}

export function validateConnectionsConfig(raw: Record<string, unknown>): { ok: boolean; errors?: string[] } {
  const { problems } = parseConnections(raw);
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    errors: problems.map((p) => `connection ${p.index + 1}${p.name ? ` (${p.name})` : ""}: ${p.problem}`),
  };
}
