---
name: Security review checklist
about: Run before a release, before exposing a deployment publicly, or after a change to the terminal, data, or apps trust boundaries.
title: "Security review: "
labels: security
---

Run every item below against the current code and record the result (with the command output, where
one is given) before checking it off. See
[`SECURITY.md`](https://github.com/KyoubeAI/KyoubeAI/blob/main/SECURITY.md) for the trust model
these checks exist to protect. (An absolute link: a relative one resolves against the issue page,
not the repository, and is dead once this template is rendered into an issue.)

## Terminal

- [ ] Terminal gate and audit verified for **each** role currently in `allowedRoles`: an allowed role
      can open a session, a role outside `allowedRoles` is denied, and the denial (never a role-lookup
      failure) is what lands in the company's activity log — not the raw session content, ever.
- [ ] SSE channel names (`term-<24 random bytes, base64url>`) are unguessable and are never returned
      from a listing endpoint — only from `open()`/`attach()`, already scoped to the session's owner.

## Data

- [ ] `withCompany` is used for every path that touches a company's own tables. Grep for a raw
      `pool.query` outside `kyoube_meta` access and confirm every hit is metadata (schema/field/app/
      grant rows) or a trivial health probe, never a company table:
      ```sh
      grep -rn "pool.query" plugins/kyoube-apps/src | grep -v kyoube_meta
      ```
- [ ] `assertReadOnlySelect` covers CTE/union/window/function-allowlist cases: subqueries, `IN`,
      `EXISTS`, `OVER (PARTITION BY … / ORDER BY …)`, `FILTER (WHERE …)`, `DISTINCT ON`, a
      schema-qualified reference, a cast to any `reg*` OID alias type, and a disallowed catalog
      function, all still rejected in every clause the validator's own test suite enumerates.

## Apps

- [ ] Apps iframe: `sandbox` carries no `allow-same-origin`; the injected Content-Security-Policy is
      present and is the first thing in `<head>`; `event.source` is checked against the exact iframe
      window before a message is routed; the per-mount handshake nonce is checked and a mismatch is
      silently dropped (three in a row stop the app); a second frame `load` stops the app.

## Operational

- [ ] No secrets in logs:
      ```sh
      grep -ri "secret\|token" plugins/*/src docker/bootstrap/src | grep -i logger
      ```
      Expect no matches.
- [ ] Dependencies audited: `pnpm audit --prod` run and every finding triaged (fixed, or recorded here
      with a reason it doesn't apply).
- [ ] Backup/restore rehearsed: `scripts/smoke.sh`'s fresh-cluster disaster-recovery rehearsal (backup,
      `docker compose down -v`, restore onto an empty cluster) passed, and is still exercised in CI.
- [ ] `kyoube doctor` is clean on a public deployment: `docker compose exec app kyoube doctor` exits 0,
      including the `exposure` check (requires `PAPERCLIP_PUBLIC_URL` to be an `https://` address
      whenever `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`).

## Notes

<!-- Anything found above that couldn't be fixed as part of this review: what it is, why it's deferred, and a link to the follow-up issue. -->
