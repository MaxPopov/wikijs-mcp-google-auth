# wikijs-mcp-google-auth

**An MCP layer on top of an existing Wiki.js 2.5.x**: a corporate user signs in
with Google Workspace and works with the wiki through an LLM (claude.ai, Claude
Desktop, any MCP client) — **strictly within their own Wiki.js permissions**.

Core principle: **Wiki.js is the single source of truth for authorization.**
The MCP server has no users/groups/permissions of its own and no global API key.
Every operation runs under the individual user's native Wiki.js JWT, and Wiki.js
itself decides allow/deny (Groups / Permissions / Page Rules).

```
Google Workspace ──OAuth/OIDC──▶ MCP Server ──signed assertion──▶ Wiki.js
                                     │         auth module "mcpdelegation"
                                     │         → refreshToken() → native JWT
                                     │
 MCP client (claude.ai / Desktop) ◀──┴── tools: search / get / list /
                                          create / update / delete / whoami
                                          (all via GraphQL with the user's JWT)
```

## Components

| Directory | What it is |
|---|---|
| `packages/wikijs-auth-module/` | Custom authentication module for Wiki.js 2.5.x — verifies RS256 assertions signed by the MCP server and returns a native Wiki.js JWT ([details](packages/wikijs-auth-module/README.md)) |
| `packages/mcp-server/` | Remote MCP server (Streamable HTTP): an OAuth 2.1 authorization server for MCP clients on top of Google OIDC + token broker + tools |
| `packages/e2e-ui/` | Test-only: browser UI e2e (Playwright) and a standalone fake Google IdP emulator |
| `deploy/docker-compose.dev.yml` | Isolated test stand (Wiki.js 2.5.303 + Postgres + ACL seed) — **for development/CI only** |
| `deploy/docker-compose.e2e.yml` | Full UI e2e stack (fake IdP + Wiki.js + MCP + Playwright) — **test-only** |
| `deploy/docker-compose.prod.yml` | Production deploy: only the MCP server, pointing at your existing Wiki.js |
| `deploy/seed/run.mjs` | Entry point to seed the test stand (`seed.mjs` is the library) |

## How it works

1. The MCP client connects to `https://mcp.company.com/mcp` and runs OAuth 2.1
   (Dynamic Client Registration + PKCE). Google does not support DCR, so the MCP
   server is itself the authorization server for clients, and Google is used only
   to authenticate the human. Google tokens never leave the server; clients
   receive the MCP server's own opaque tokens. After the Google login the user
   sees a **consent screen** naming the application and its redirect URI — a
   confused-deputy defense (so a third-party registered client cannot obtain the
   user's token without their knowledge); the approval is remembered per user
   per client.
2. Google's `id_token` is verified (signature, `iss`, `aud`, `email_verified`,
   **`hd` = your Workspace domain**).
3. The MCP server's token broker exchanges the Google identity for a **native
   Wiki.js JWT**: it signs a short-lived RS256 assertion (TTL 60 s, unique `jti`)
   and calls the standard GraphQL mutation `authentication.login` with the
   `mcpdelegation` strategy. The Wiki.js module verifies the assertion, resolves
   the user by email, and returns a JWT via the standard `refreshToken()` flow.
   The JWT is cached and refreshed before it expires.
4. Every tool call goes to Wiki.js GraphQL with `Authorization: Bearer <user's
   JWT>`. A forbidden page cannot be read or changed and **does not appear in
   search or listings** — verified by e2e tests (allow/forbidden matrix for two
   users in different groups).

## Tools

| Tool | Description |
|---|---|
| `whoami` | The user's identity + their Wiki.js groups and permissions (access diagnostics) |
| `search_wiki` | Full-text search; results are filtered by the user's permissions and addressed by `path` + `locale` (no page id — see below) |
| `get_page` | A page by path (preferred) or id (metadata + full markdown) |
| `list_pages` | Pages visible to the user (filter by path prefix) |
| `create_page` | Create a page (markdown) |
| `update_page` | Update: read-merge-write, unspecified fields are preserved |
| `delete_page` | Delete by path or id (destructive, Wiki.js enforces `delete:pages`); passing both cross-checks them |

### Addressing a page: prefer `path`

`get_page`, `update_page` and `delete_page` accept a numeric `id`, but an id is
only trustworthy when it came from `list_pages`, `create_page`, or an earlier
`get_page`.

**`search_wiki` deliberately returns no id.** Wiki.js fills the `id` of a search
hit from the *active search index*, not from the `pages` table: only the `db`
engine happens to index the real `pages.id` — the `postgres` engine returns the
`pagesVector` row id (its own sequence) and elasticsearch/algolia/solr return
`page.hash`. Passing such a value to `get_page(id:)` addresses **an unrelated
page**, which surfaces either as a bogus "you do not have permission" or —
worse — as the wrong page's content returned under the title you searched for.
The tool therefore drops it rather than tempting a caller into using it.

### Why a denial by `id` next to a success by `path` is not an ACL bug

`pages.single(id)` and `pages.singleByPath(path, locale)` load the row through
the same `getPageFromDb` and then run the **identical** check —
`checkAccess(user, ['manage:pages', 'delete:pages'], { path, locale })` (Wiki.js
2.5.296+, where `singleByPath` was added). There is no admin-only resolver and
no second permission cache on the id side. If the two disagree, they are looking
at **different pages**.

Note the permission list: reading page *source* through the API needs
`manage:pages` or `delete:pages` on that path. `read:pages` alone is enough to
open the page in the wiki UI and to see it in `list_pages` / `search_wiki`, but
not to fetch it here — so a reader-only user gets a denial from `get_page` by id
*and* by path. The tool errors say which of the two traps applies instead of
reporting a bare "no permission".

---

# Integrating with your Wiki.js: step-by-step

You need: Wiki.js **2.5.x** (tested on 2.5.303) with access to its file
system / Docker configuration; a host for the MCP server with a public HTTPS
endpoint; admin access to your Workspace's Google Cloud Console.

## Step 1. Install the auth module in Wiki.js

**Docker:** add a volume to the wiki service and restart the container:

```yaml
services:
  wiki:
    image: ghcr.io/requarks/wiki:2.5.303
    volumes:
      - /opt/wikijs-mcp/wikijs-auth-module:/wiki/server/modules/authentication/mcpdelegation:ro
```

(the contents of this repo's `packages/wikijs-auth-module/` go into
`/opt/wikijs-mcp/wikijs-auth-module`; the destination directory name must be
exactly `mcpdelegation`)

**Bare metal:** copy `packages/wikijs-auth-module/` into
`<wiki>/server/modules/authentication/mcpdelegation/` and restart Wiki.js.

After configuration (step 3) the Wiki.js log will show:
`Authentication Strategy MCP Delegation: [ OK ]`.

## Step 2. Generate the assertion keys

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out mcp-assertion-key.pem
openssl pkey -in mcp-assertion-key.pem -pubout -out mcp-assertion-key.pub.pem
```

The private key (`mcp-assertion-key.pem`) stays **only** on the MCP server host.
The public key goes into Wiki.js in the next step.

## Step 3. Configure the strategy in Wiki.js Admin

Administration → **Auth** → Add Strategy → **MCP Delegation**:

- **Assertion Public Key (PEM)** — the contents of `mcp-assertion-key.pub.pem`;
- **Expected Audience / Issuer** — keep the defaults
  (`urn:wikijs:mcp-delegation` / `urn:wikijs-mcp-google-auth`);
- **User Lookup Provider Priority** — the order of providers to look up the user
  by email. If your people sign in to the wiki via Google/OIDC, put that
  provider first (module keys are accepted too: `google`, `oidc`, `local`);
- (optional) **Self-registration** + domain whitelist + auto-enroll groups — so
  that new Workspace users are created automatically on their first request
  through MCP;
- Save.

The strategy instance key is shown in the list (this is `WIKIJS_STRATEGY_KEY`
for the MCP server; if you created it manually via the UI, Wiki.js generates a
uuid — copy it).

> Accounts with TFA enabled cannot be used through delegation — the MCP server
> returns a clear error.

## Step 4. Create a Google OAuth client

Google Cloud Console → APIs & Services → Credentials → **Create credentials →
OAuth client ID**:

- Application type: **Web application**;
- Authorized redirect URI: `https://mcp.company.com/oauth/google/callback`
  (your `PUBLIC_URL` + `/oauth/google/callback`);
- OAuth consent screen: type **Internal** (your Workspace only).

Save the Client ID and Client Secret.

## Step 5. Deploy the MCP server

```bash
cd deploy
cp .env.example .env        # fill in the values
mkdir -p keys && cp /path/to/mcp-assertion-key.pem keys/
chmod 644 keys/mcp-assertion-key.pem   # the container runs as non-root node (uid 1000)
docker compose -f docker-compose.prod.yml up -d
```

> The container runs as the non-root `node` user — the mounted key file must be
> readable by it (`chmod 644`); the private key itself stays protected by the
> permissions of the host `keys/` directory.

`.env` variables:

| Variable | Value |
|---|---|
| `MCP_IMAGE` | Tagged image (the `Release on main` workflow auto-publishes `ghcr.io/<owner>/wikijs-mcp-server:vX.Y.Z` when a version bump is merged to `main`, or build locally: `docker build -f packages/mcp-server/Dockerfile -t wikijs-mcp-server:local .`) |
| `PUBLIC_URL` | The public HTTPS URL of the MCP server |
| `WIKIJS_URL` | Your Wiki.js URL (internal preferred) |
| `WIKIJS_STRATEGY_KEY` | The strategy instance key from step 3 (`mcpdelegation` if you named it so) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From step 4 |
| `GOOGLE_ALLOWED_DOMAIN` | Your Workspace domain, e.g. `company.com` — accounts outside it are rejected |

Put a TLS reverse proxy in front of port 8000. Minimal nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name mcp.company.com;
  # ssl_certificate ...; ssl_certificate_key ...;
  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Host $host;
    proxy_buffering off;          # streamable HTTP
  }
}
```

Check: `curl https://mcp.company.com/healthz` → `{"ok":true}`;
`curl https://mcp.company.com/.well-known/oauth-authorization-server` →
OAuth metadata.

## Step 6. Connect clients

**claude.ai (Team/Enterprise):** Settings → Connectors → **Add custom
connector** → URL: `https://mcp.company.com/mcp`. On first use the client runs
OAuth: client registration → Google login → done.

**Claude Desktop:** Settings → Connectors → Add custom connector with the same
URL (or via `mcp-remote` for older versions).

**MCP Inspector (diagnostics):**
`npx @modelcontextprotocol/inspector` → Transport: Streamable HTTP →
URL `https://mcp.company.com/mcp` → Open Auth → walk through the flow.

## Step 7. Verify

In the LLM chat:

1. "Who am I in the wiki?" → the `whoami` tool should show your email, groups
   and permissions from Wiki.js.
2. Ask to find/open a page you have access to → OK.
3. Ask for a page you have no rights to → a clear refusal ("Wiki.js denied this
   operation…"), and that page is also **absent** from search/listing results.

---

## Local development

```bash
npm ci
npm run stand:up      # Wiki.js 2.5.303 + Postgres (docker)
npm run stand:seed    # finalize + groups/users/pages + strategy + dev keys
npm test              # unit tests (auth module + OAuth provider)
npm run build && npm run e2e   # in-process e2e: delegation, OAuth, tools — against a live stand
npm run stand:down
```

Test stand: `admin@example.com/admin1234!`, `john@example.com` (Engineering, no
access to `/management/*`), `kate@example.com` (Management). Every PR runs the
fast checks (`CI`: lint + unit + build); the heavy docker e2e (`e2e`) and
browser `ui-e2e` run only on pushes to `dev`/`main` (i.e. before merge), so they
don't slow down PR iterations.

### Browser UI e2e (Playwright) under roles

A separate docker stack `deploy/docker-compose.e2e.yml` brings up a **fake
Google IdP emulator** (`packages/e2e-ui/idp/` — a login page with a role picker
instead of real Google), Wiki.js, the MCP server and a **Playwright runner**
that drives the whole browser OAuth+consent flow under different roles
(John/Kate/out-of-domain). The emulator and Playwright come up **only** in this
e2e stack — they never end up in the prod/dev images.

```bash
C=deploy/docker-compose.e2e.yml
docker compose -f $C build mcp
docker compose -f $C up -d db wiki idp   # no --wait on wiki: the seed script is the readiness gate
docker compose -f $C run --rm seed
docker compose -f $C up -d --wait mcp
docker compose -f $C run --rm playwright     # exit code = test result
docker compose -f $C down -v
```

It checks: login as a role → the consent screen names the client → approve →
whoami and pages scoped to the role (John cannot see `management/*`, Kate can);
deny → `access_denied`; an out-of-domain account is rejected before consent. A
separate CI workflow (`ui-e2e`) does this on pushes to `dev`/`main`.

Running the MCP server against the stand manually:

```bash
PUBLIC_URL=http://localhost:8000 \
WIKIJS_URL=http://127.0.0.1:3000 \
MCP_ASSERTION_PRIVATE_KEY_FILE=deploy/keys/mcp-assertion-key.pem \
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_ALLOWED_DOMAIN=example.com \
npm run dev -w @wikijs-mcp/server
```

## Releases

Releases are automatic. Bump `version` in the root `package.json` on `dev`,
open a `dev` → `main` PR, and merge it. The `Release on main` workflow then,
on the push to `main`, builds and pushes
`ghcr.io/<owner>/wikijs-mcp-server:vX.Y.Z` (+ `:latest`) and creates the git
tag `vX.Y.Z` and a GitHub Release — all in one run, using only the built-in
`GITHUB_TOKEN` (no PAT/secret to configure). If the version is unchanged the
run is a no-op, so ordinary merges to `main` don't create releases.

> One-time repo settings for this to work: Settings → Actions → General →
> Workflow permissions = **Read and write permissions**; and if you protect
> tags with a ruleset, allow GitHub Actions to create `v*` tags.

## Security notes

- **Assertion**: RS256, TTL 60 s, unique `jti`, replay protection; the private
  key lives only on the MCP server. A compromised key means the ability to sign
  in as any wiki user — treat it as a root secret and rotate it (new pair +
  update the public key in the strategy).
- **Google identity**: the canonical identifier is `iss`+`sub`; email is a
  lookup. The `hd` domain is verified from the signed id_token, not from
  parameters.
- **Confused-deputy defense**: before an authorization code is released the user
  goes through a per-client consent screen (can be disabled via `requireConsent`
  only for a trusted first-party scenario). This prevents an attacker who
  registered their own OAuth client via DCR from silently obtaining the victim's
  token.
- **Wiki.js rate limit**: `authentication.login` is 5 calls/min per IP, and all
  delegation logins come from the MCP server's IP. The broker caches JWTs (30
  min by default) and waits-and-retries on the limit, so it is invisible in
  normal operation; during mass onboarding delays of up to a minute are
  possible.
- **Revocation**: standard OAuth `/revoke` (per token); deactivating a user in
  Wiki.js breaks delegation at the next JWT refresh (≤30 min); deleting
  `SESSION_STORE_FILE` + restarting the MCP server drops all sessions at once.
- **Audit**: every tool call is logged in a structured form (who, which tool,
  ok/denied) without page content.
- **MCP endpoint**: bearer-only, 120 requests/min per token, security headers;
  the OAuth endpoints are protected by the SDK's built-in rate limiting.

## Limitations and plans

- RAG/semantic search is a **separate future service**. The plug point is ready:
  `search_wiki` works through the `SearchBackend` interface (`src/search/` — v1
  = native Wiki.js search; the RAG service will receive the user's Wiki.js JWT
  and preserve the ACL model). See `docs/rag-integration.md`.
- Single MCP server instance (FileStore + in-memory replay cache). HA needs a
  shared store (Redis) — the `KVStore` interface is already extracted.
- Wiki.js 3.x has a different auth mechanism — the module targets 2.5.x.

## License

Apache-2.0
