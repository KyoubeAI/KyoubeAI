# LinkedIn through Postiz

`docker-compose.postiz.yml` runs [Postiz](https://github.com/gitroomhq/postiz-app), an open-source
social media scheduler, next to the app. Postiz holds the LinkedIn sign-in and renews it; agents call
Postiz through a KyoubeAI [connection](connections.md) and never see a LinkedIn token. Self-hosted
Postiz is free (AGPL-3.0) and needs no Postiz account.

This replaces the core's Composio connector broker, which upstream removed (see
[upgrading.md](upgrading.md)).

## How it fits together

```
agent ──connections_call──▶ KyoubeAI ──Authorization: <key>──▶ Postiz /api/public/v1 ──▶ LinkedIn
person's browser ─────────────────────────────────────────────▶ Postiz web UI (connect, calendar)
```

- **Postiz** keeps its own Postgres, Redis and Temporal (Postiz uses Temporal to run scheduled posts
  and token refreshes; Temporal in turn needs its own Postgres and Elasticsearch). They sit on a
  private `postiz` network. Only the `postiz` service joins the app's network, so agents in the app
  container cannot reach Postiz's database or Temporal.
- **The connection** is a company connection named `postiz` with the `authorization` auth style:
  Postiz's public API takes the bare API key as the `Authorization` header, without `Bearer`.
  Connections only call `https://` URLs, so it calls Postiz through its public hostname.
- **Who approves a post.** With the guardrail on ([decisions.md](decisions.md#the-guardrail)), an
  agent's POST to Postiz is checked by the model first. It goes straight out when the model finds the
  task asks for it and it is not dangerous; otherwise it waits for a confirmation card on the task.
  With no provider set, the check cannot run and every such call waits for a person. With the
  guardrail off, nothing is checked. The card names the connection, method and path but not the body,
  so the agent shows the post text in the task first. To keep every post in a person's hands whatever
  the guardrail does, have the agent create posts as `draft`; a person then schedules them in Postiz.

This page sets up the **KyoubeAI company Page** (Postiz's `linkedin-page` provider). Postiz signs in
one LinkedIn account for the whole company, so it does not fit posting from each person's own
profile, where every post should go out as that person.

## Setting it up

### 1. LinkedIn developer app

1. Create an app at <https://www.linkedin.com/developers/apps>. LinkedIn asks for the company Page the
   app belongs to; pick the KyoubeAI Page and have a Page admin verify the app.
2. Under **Products**, add **Share on LinkedIn**, **Sign In with LinkedIn using OpenID Connect** and
   **Advertising API**. The first two are self-serve. Advertising API is free but LinkedIn reviews
   the request form first. Postiz needs its scopes for both LinkedIn providers and for refreshing
   tokens.
3. Under **Auth**, check that the OAuth 2.0 scopes include `openid`, `profile`, `w_member_social`,
   `r_basicprofile`, `rw_organization_admin`, `w_organization_social` and `r_organization_social`.
   If one is missing, LinkedIn still signs in but Postiz refuses the channel with `NotEnoughScopes`.
4. Add the redirect URL `<POSTIZ_PUBLIC_URL>/integrations/social/linkedin-page` (and
   `.../linkedin` if you later connect a personal profile).
5. Note the client ID and client secret from the **Auth** tab.

### 2. The server

Add to `.env`:

```sh
POSTIZ_PUBLIC_URL=https://postiz.example.com
POSTIZ_JWT_SECRET=...            # openssl rand -hex 32
POSTIZ_DB_PASSWORD=...           # openssl rand -hex 24; letters and digits only
POSTIZ_TEMPORAL_DB_PASSWORD=...  # openssl rand -hex 24
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml:docker-compose.postiz.yml
```

and run `docker compose up -d`. Postiz is ready when `docker compose ps postiz` says healthy; the
first start takes about a minute.

| Setting | Default | What it does |
|---|---|---|
| `POSTIZ_VERSION` | `v2.25.3` | Postiz image tag |
| `POSTIZ_PORT` | `4007` | Port on 127.0.0.1 for the web UI, for checks from this machine |
| `POSTIZ_API_LIMIT` | `30` | Public API requests an hour |

Changing `LINKEDIN_CLIENT_ID` or `LINKEDIN_CLIENT_SECRET` later needs `docker compose up -d postiz`.

### 3. Cloudflare

In the tunnel's **Public hostnames**, add `POSTIZ_PUBLIC_URL`'s host pointing at
`http://postiz:5000`. That is all Postiz needs: it has its own sign-in, and sign-up closes after the
first account, so create that account as soon as the hostname is live.

Putting the hostname behind Cloudflare Access as well is optional. It is fine for people, because
LinkedIn's sign-in returns through their own signed-in browser. Two paths are reached by servers,
though, and then need an Access application of their own with a **Bypass** policy:

| Path | Who calls it | What protects it |
|---|---|---|
| `/api/public/` | KyoubeAI, for agents' connection calls | Postiz's API key |
| `/uploads/` | Postiz itself, reading its media back while publishing | Unguessable file names; the media is about to be public anyway |

Without the `/uploads/` bypass, text posts work but posts with images fail.

### 4. Postiz

1. Open `POSTIZ_PUBLIC_URL` and create the first account. `DISABLE_REGISTRATION` is on, so only this
   first sign-up is allowed; add other people from inside Postiz.
2. **Add Channel**, then **LinkedIn Page**. Sign in with a LinkedIn account that is an admin of the
   KyoubeAI Page and pick the Page.
3. **Settings**, then **Public API**: copy the API key.

### 5. KyoubeAI

1. Under **Company, then Secrets**, store the Postiz API key (for example as `postiz-api-key`).
2. Under **Settings, then Plugins, then Kyoube Data & Apps**, add a connection:

   | Field | Value |
   |---|---|
   | `name` | `postiz` |
   | `baseUrl` | `<POSTIZ_PUBLIC_URL>/api/public/v1/` |
   | `auth` | `authorization` |
   | `secret` | the secret from step 1 |
   | `methods` | `read-write` |

   Company Settings, then Data access, then Connections should show it as "ready".
3. On the same page, give the marketing agent a `read-write` grant on `postiz`.
4. Decide who approves posts (see "Who approves a post" above): switch the guardrail on under
   Company Settings, then Data access, then Typed decisions, and tell the agent in its instructions
   whether to post as `draft`.

## What an agent does

List the channels and find the Page's integration id:

```sh
K="$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api"
A="Authorization: Bearer $PAPERCLIP_API_KEY"
curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/connections/postiz/call" \
  -d "{\"companyId\":\"$PAPERCLIP_COMPANY_ID\",\"path\":\"integrations\"}"
```

Create a post. `type` is `draft` (kept in Postiz for a person to schedule), `schedule` (at `date`) or
`now`:

```json
{
  "companyId": "…", "issueId": "…", "method": "POST", "path": "posts",
  "body": {
    "type": "schedule",
    "date": "2026-11-03T09:00:00.000Z",
    "shortLink": false,
    "tags": [],
    "posts": [{
      "integration": { "id": "<linkedin-page integration id>" },
      "value": [{ "content": "Post text", "image": [] }],
      "settings": { "__type": "linkedin-page" }
    }]
  }
}
```

If the guardrail holds the call, it answers `held` with a confirmation id; once a person allows it on
the task, the agent sends the same call again with `confirmationId`. Posts, analytics and the other endpoints are listed in the
[Postiz public API](https://docs.postiz.com/public-api/introduction).

## Things to know

- **Token renewal.** Postiz refreshes LinkedIn tokens itself once Advertising API is approved. If
  LinkedIn revokes access (a password change, the app losing a product), Postiz marks the channel
  as needing reconnection; reconnect it from the Postiz UI.
- **What is stored where.** LinkedIn tokens stay in Postiz's database (`postiz-pgdata`). The Postiz
  API key is a company secret in KyoubeAI. Uploaded media is in `postiz-uploads`. None of Postiz's
  volumes are in `scripts/backup.sh`; a lost Postiz database means connecting the Page again and
  losing the scheduled-post calendar.
- **Upgrading Postiz.** Set `POSTIZ_VERSION` and run `docker compose up -d postiz`. Postiz migrates
  its own database at start.
- **Temporal's dynamic config** in `docker/postiz/dynamicconfig/` is Postiz's upstream file as it is.
