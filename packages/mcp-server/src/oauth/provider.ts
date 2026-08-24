import { randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { KVStore } from '../store/store.js'
import type { GoogleOIDC, GoogleIdentity } from './google.js'

const NS = {
  clients: 'oauth.clients',
  pending: 'oauth.pending',
  consentPending: 'oauth.consentPending',
  approvals: 'oauth.approvals',
  codes: 'oauth.codes',
  access: 'oauth.accessTokens',
  refresh: 'oauth.refreshTokens',
  sessions: 'sessions'
} as const

interface PendingAuth {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scopes?: string[]
  resource?: string
  createdAt: number
}

interface ConsentPending {
  sessionId: string
  csrf: string
  pending: PendingAuth
  createdAt: number
}

interface CodeRecord {
  clientId: string
  codeChallenge: string
  sessionId: string
  redirectUri: string
  scopes?: string[]
  resource?: string
  expiresAt: number
}

interface TokenRecord {
  sessionId: string
  clientId: string
  scopes: string[]
  resource?: string
  expiresAt: number
}

export interface SessionRecord {
  id: string
  sub: string
  email: string
  name?: string
  issuer: string
  createdAt: number
  lastLoginAt: number
}

export interface ProviderOptions {
  publicUrl: string
  accessTokenTtlSeconds?: number
  refreshTokenTtlSeconds?: number
  pendingAuthTtlSeconds?: number
  /**
   * Require an authenticated per-client consent step before releasing an
   * authorization code (defends against the OAuth confused-deputy attack
   * that open DCR + a static upstream client would otherwise enable).
   * Defaults to true; only disable for trusted first-party-only setups.
   */
  requireConsent?: boolean
  onLogin?: (identity: GoogleIdentity) => void
  onRevokeSession?: (session: SessionRecord) => void
}

function escapeHtml (value: string): string {
  return value.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!
  ))
}

function opaqueToken (prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('hex')}`
}

function nowSec (): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * OAuth 2.1 authorization server for MCP clients, backed by Google OIDC.
 *
 * Google does not support Dynamic Client Registration, so this provider
 * IS the authorization server that MCP clients (claude.ai, Claude
 * Desktop, MCP Inspector) register with and get tokens from; Google is
 * only used to authenticate the human. Google tokens never leave this
 * process, and the tokens issued here are opaque random strings bound
 * to a server-side session.
 */
export class GoogleBackedOAuthProvider implements OAuthServerProvider {
  private readonly accessTtl: number
  private readonly refreshTtl: number
  private readonly pendingTtl: number
  private readonly requireConsent: boolean

  constructor (
    private readonly store: KVStore,
    private readonly google: GoogleOIDC,
    private readonly opts: ProviderOptions
  ) {
    this.accessTtl = opts.accessTokenTtlSeconds ?? 3600
    this.refreshTtl = opts.refreshTokenTtlSeconds ?? 30 * 24 * 3600
    this.pendingTtl = opts.pendingAuthTtlSeconds ?? 10 * 60
    this.requireConsent = opts.requireConsent ?? true
  }

  private get googleCallbackUrl (): string {
    return `${this.opts.publicUrl}/oauth/google/callback`
  }

  private get consentUrl (): string {
    return `${this.opts.publicUrl}/oauth/consent`
  }

  get clientsStore (): OAuthRegisteredClientsStore {
    const store = this.store
    return {
      getClient: (clientId: string) =>
        store.get<OAuthClientInformationFull>(NS.clients, clientId),
      registerClient: (client: OAuthClientInformationFull) => {
        store.set(NS.clients, client.client_id, client)
        return client
      }
    }
  }

  // ---- Authorization leg -------------------------------------------------

  async authorize (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pendingId = randomUUID()
    const pending: PendingAuth = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource?.href,
      createdAt: nowSec()
    }
    this.store.set(NS.pending, pendingId, pending)
    this.prunePending()
    res.redirect(this.google.buildAuthUrl({
      redirectUri: this.googleCallbackUrl,
      state: pendingId
    }))
  }

  /**
   * Express handler for the Google redirect URI. Completes the upstream
   * OIDC flow, establishes the server-side session, and redirects back
   * to the MCP client with OUR authorization code.
   */
  handleGoogleCallback = async (req: Request, res: Response): Promise<void> => {
    const pendingId = String(req.query.state ?? '')
    const pending = pendingId ? this.store.get<PendingAuth>(NS.pending, pendingId) : undefined
    if (!pending) {
      res.status(400).send('Unknown or expired authorization request. Please retry connecting.')
      return
    }
    this.store.delete(NS.pending, pendingId)

    const fail = (description: string): void => {
      const url = new URL(pending.redirectUri)
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('error_description', description)
      if (pending.state) url.searchParams.set('state', pending.state)
      res.redirect(url.toString())
    }

    if (req.query.error) {
      fail(String(req.query.error_description ?? req.query.error))
      return
    }
    const googleCode = String(req.query.code ?? '')
    if (!googleCode) {
      fail('Missing authorization code from Google')
      return
    }

    let identity: GoogleIdentity
    try {
      const idToken = await this.google.exchangeCode(googleCode, this.googleCallbackUrl)
      identity = await this.google.verifyIdToken(idToken)
    } catch (err) {
      fail((err as Error).message)
      return
    }

    // One session per Google account (iss+sub): reuse and refresh it.
    const sessionKey = `${identity.issuer}|${identity.sub}`
    const existing = this.store.get<SessionRecord>(NS.sessions, sessionKey)
    const session: SessionRecord = existing
      ? { ...existing, email: identity.email, name: identity.name, lastLoginAt: nowSec() }
      : {
          id: sessionKey,
          sub: identity.sub,
          email: identity.email,
          name: identity.name,
          issuer: identity.issuer,
          createdAt: nowSec(),
          lastLoginAt: nowSec()
        }
    this.store.set(NS.sessions, sessionKey, session)
    this.opts.onLogin?.(identity)

    // Confused-deputy defense: before releasing a code to a (possibly
    // attacker-registered) redirect URI, require the AUTHENTICATED user to
    // approve this specific client + redirect URI. Approval is remembered
    // per user+client+redirect, so it is a one-time prompt per client and
    // never carries across users.
    const approvalKey = `${sessionKey}|${pending.clientId}|${pending.redirectUri}`
    if (this.requireConsent && !this.store.get<boolean>(NS.approvals, approvalKey)) {
      const consentId = randomUUID()
      const csrf = opaqueToken('csrf')
      this.store.set<ConsentPending>(NS.consentPending, consentId, {
        sessionId: sessionKey,
        csrf,
        pending,
        createdAt: nowSec()
      })
      this.pruneConsent()
      res.status(200).type('html').send(this.renderConsentPage(consentId, csrf, pending))
      return
    }

    this.issueCodeAndRedirect(pending, sessionKey, res)
  }

  /** POST handler for the consent interstitial. */
  handleConsent = (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const consentId = String(body.consent_id ?? '')
    const csrf = String(body.csrf ?? '')
    const approve = String(body.approve ?? '')

    const record = consentId ? this.store.get<ConsentPending>(NS.consentPending, consentId) : undefined
    if (!record) {
      res.status(400).send('Consent request is unknown or expired. Please retry connecting.')
      return
    }
    // Constant-time-ish CSRF check; the id itself is an unguessable secret
    // known only to the authenticated user's browser.
    if (csrf !== record.csrf || nowSec() - record.createdAt > this.pendingTtl) {
      this.store.delete(NS.consentPending, consentId)
      res.status(400).send('Consent request is invalid or expired. Please retry connecting.')
      return
    }
    this.store.delete(NS.consentPending, consentId)

    if (!this.store.get<SessionRecord>(NS.sessions, record.sessionId)) {
      res.status(400).send('Your session no longer exists. Please retry connecting.')
      return
    }

    const { pending } = record
    if (approve !== 'yes') {
      const url = new URL(pending.redirectUri)
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('error_description', 'User denied the authorization request')
      if (pending.state) url.searchParams.set('state', pending.state)
      res.redirect(url.toString())
      return
    }

    this.store.set<boolean>(NS.approvals, `${record.sessionId}|${pending.clientId}|${pending.redirectUri}`, true)
    this.issueCodeAndRedirect(pending, record.sessionId, res)
  }

  private issueCodeAndRedirect (pending: PendingAuth, sessionId: string, res: Response): void {
    const code = opaqueToken('mcp_code')
    const record: CodeRecord = {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      sessionId,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: nowSec() + 120
    }
    this.store.set(NS.codes, code, record)

    const url = new URL(pending.redirectUri)
    url.searchParams.set('code', code)
    if (pending.state) url.searchParams.set('state', pending.state)
    res.redirect(url.toString())
  }

  private renderConsentPage (consentId: string, csrf: string, pending: PendingAuth): string {
    const client = this.store.get<OAuthClientInformationFull>(NS.clients, pending.clientId)
    const clientName = escapeHtml(client?.client_name ?? pending.clientId)
    const redirectHost = escapeHtml(new URL(pending.redirectUri).host)
    const redirectUri = escapeHtml(pending.redirectUri)
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
.card{border:1px solid #ddd;border-radius:10px;padding:1.5rem}
.warn{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:.75rem 1rem;margin:1rem 0;font-size:.9rem}
code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px;word-break:break-all}
button{font-size:1rem;padding:.6rem 1.2rem;border-radius:8px;border:0;cursor:pointer;margin-right:.5rem}
.ok{background:#1971c2;color:#fff}.no{background:#e9ecef}</style></head>
<body><div class="card">
<h2>Authorize access to the wiki</h2>
<p>The application <strong>${clientName}</strong> is requesting access to Wiki.js on your behalf.</p>
<p>If you approve, authorization data will be sent to:</p>
<p><code>${redirectUri}</code></p>
<div class="warn">Only approve if you started this and recognize <strong>${redirectHost}</strong>. Approving lets this application read and modify wiki pages using your permissions.</div>
<form method="post" action="${escapeHtml(this.consentUrl)}">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="ok" type="submit" name="approve" value="yes">Approve</button>
<button class="no" type="submit" name="approve" value="no">Deny</button>
</form>
</div></body></html>`
  }

  // ---- Token leg ---------------------------------------------------------

  async challengeForAuthorizationCode (client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.store.get<CodeRecord>(NS.codes, authorizationCode)
    if (!record || record.clientId !== client.client_id || record.expiresAt < nowSec()) {
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    return record.codeChallenge
  }

  async exchangeAuthorizationCode (
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.store.get<CodeRecord>(NS.codes, authorizationCode)
    if (!record || record.clientId !== client.client_id || record.expiresAt < nowSec()) {
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    this.store.delete(NS.codes, authorizationCode)
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request')
    }
    if (record.resource && resource && record.resource !== resource.href) {
      throw new InvalidGrantError('resource does not match the authorization request')
    }
    return this.issueTokens(record.sessionId, client.client_id, record.scopes ?? [], record.resource)
  }

  async exchangeRefreshToken (
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.store.get<TokenRecord>(NS.refresh, refreshToken)
    if (!record || record.clientId !== client.client_id || record.expiresAt < nowSec()) {
      throw new InvalidGrantError('Invalid or expired refresh token')
    }
    if (!this.store.get<SessionRecord>(NS.sessions, record.sessionId)) {
      throw new InvalidGrantError('Session no longer exists')
    }
    if (resource && record.resource && record.resource !== resource.href) {
      throw new InvalidGrantError('resource does not match the original grant')
    }
    if (scopes?.some(s => !record.scopes.includes(s))) {
      throw new InvalidGrantError('Requested scopes exceed the original grant')
    }
    // OAuth 2.1 refresh token rotation.
    this.store.delete(NS.refresh, refreshToken)
    return this.issueTokens(record.sessionId, client.client_id, scopes ?? record.scopes, record.resource)
  }

  private issueTokens (sessionId: string, clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = opaqueToken('mcp_at')
    const refreshToken = opaqueToken('mcp_rt')
    const now = nowSec()
    this.store.set<TokenRecord>(NS.access, accessToken, {
      sessionId, clientId, scopes, resource, expiresAt: now + this.accessTtl
    })
    this.store.set<TokenRecord>(NS.refresh, refreshToken, {
      sessionId, clientId, scopes, resource, expiresAt: now + this.refreshTtl
    })
    this.pruneTokens()
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.accessTtl,
      refresh_token: refreshToken,
      ...(scopes.length ? { scope: scopes.join(' ') } : {})
    }
  }

  async verifyAccessToken (token: string): Promise<AuthInfo> {
    const record = this.store.get<TokenRecord>(NS.access, token)
    if (!record || record.expiresAt < nowSec()) {
      throw new InvalidTokenError('Invalid or expired access token')
    }
    const session = this.store.get<SessionRecord>(NS.sessions, record.sessionId)
    if (!session) {
      throw new InvalidTokenError('Session no longer exists')
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      ...(record.resource ? { resource: new URL(record.resource) } : {}),
      extra: {
        sessionId: session.id,
        sub: session.sub,
        email: session.email,
        name: session.name,
        issuer: session.issuer
      }
    }
  }

  async revokeToken (client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    for (const ns of [NS.access, NS.refresh]) {
      const record = this.store.get<TokenRecord>(ns, request.token)
      if (record && record.clientId === client.client_id) {
        this.store.delete(ns, request.token)
      }
    }
  }

  /** Removes a session and every token attached to it (logout / kill-switch). */
  revokeSession (sessionId: string): void {
    const session = this.store.get<SessionRecord>(NS.sessions, sessionId)
    this.store.delete(NS.sessions, sessionId)
    for (const ns of [NS.access, NS.refresh]) {
      for (const [token, record] of this.store.entries<TokenRecord>(ns)) {
        if (record.sessionId === sessionId) {
          this.store.delete(ns, token)
        }
      }
    }
    // Drop remembered client approvals so a re-login re-prompts for consent.
    for (const [key] of this.store.entries<boolean>(NS.approvals)) {
      if (key.startsWith(`${sessionId}|`)) this.store.delete(NS.approvals, key)
    }
    if (session) this.opts.onRevokeSession?.(session)
  }

  private prunePending (): void {
    const cutoff = nowSec() - this.pendingTtl
    for (const [id, pending] of this.store.entries<PendingAuth>(NS.pending)) {
      if (pending.createdAt < cutoff) this.store.delete(NS.pending, id)
    }
  }

  private pruneConsent (): void {
    const cutoff = nowSec() - this.pendingTtl
    for (const [id, record] of this.store.entries<ConsentPending>(NS.consentPending)) {
      if (record.createdAt < cutoff) this.store.delete(NS.consentPending, id)
    }
  }

  private pruneTokens (): void {
    const now = nowSec()
    for (const ns of [NS.access, NS.refresh, NS.codes] as const) {
      for (const [key, record] of this.store.entries<{ expiresAt: number }>(ns)) {
        if (record.expiresAt < now) this.store.delete(ns, key)
      }
    }
  }
}
