import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export interface GoogleSettings {
  clientId: string
  clientSecret: string
  /** Google Workspace domain users must belong to (verified via `hd` claim). Empty = any Google account (NOT recommended). */
  allowedDomain: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  /** Expected `iss` of ID tokens. */
  issuer: string
}

export interface GoogleIdentity {
  /** Stable Google account id — the canonical identity. */
  sub: string
  email: string
  name?: string
  hd?: string
  issuer: string
}

export function loadGoogleSettings (): GoogleSettings {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required')
  }
  return {
    clientId,
    clientSecret,
    allowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN ?? '',
    authorizationEndpoint: process.env.GOOGLE_AUTHORIZATION_ENDPOINT ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: process.env.GOOGLE_TOKEN_ENDPOINT ?? 'https://oauth2.googleapis.com/token',
    jwksUri: process.env.GOOGLE_JWKS_URI ?? 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: process.env.GOOGLE_ISSUER ?? 'https://accounts.google.com'
  }
}

export class GoogleAuthError extends Error {
  override name = 'GoogleAuthError'
}

/**
 * Relying-party client for Google OIDC. The MCP server is registered at
 * Google as ONE OAuth client; MCP clients never see Google directly.
 */
export class GoogleOIDC {
  private jwks: JWTVerifyGetKey | null = null

  constructor (readonly settings: GoogleSettings) {}

  buildAuthUrl (opts: { redirectUri: string, state: string }): string {
    const url = new URL(this.settings.authorizationEndpoint)
    url.searchParams.set('client_id', this.settings.clientId)
    url.searchParams.set('redirect_uri', opts.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', opts.state)
    url.searchParams.set('prompt', 'select_account')
    if (this.settings.allowedDomain) {
      // Advisory only — the hd CLAIM check below is what enforces it.
      url.searchParams.set('hd', this.settings.allowedDomain)
    }
    return url.toString()
  }

  async exchangeCode (code: string, redirectUri: string): Promise<string> {
    const res = await fetch(this.settings.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        redirect_uri: redirectUri
      })
    })
    const body = await res.json().catch(() => ({})) as { id_token?: string, error?: string, error_description?: string }
    if (!res.ok || !body.id_token) {
      throw new GoogleAuthError(`Google code exchange failed: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim())
    }
    return body.id_token
  }

  async verifyIdToken (idToken: string): Promise<GoogleIdentity> {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(this.settings.jwksUri))
    }
    let payload
    try {
      const result = await jwtVerify(idToken, this.jwks, {
        // Google historically uses both forms of the issuer.
        issuer: [this.settings.issuer, this.settings.issuer.replace(/^https:\/\//, '')],
        audience: this.settings.clientId
      })
      payload = result.payload
    } catch (err) {
      throw new GoogleAuthError(`ID token verification failed: ${(err as Error).message}`)
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : ''
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    if (!sub || !email) {
      throw new GoogleAuthError('ID token is missing sub or email')
    }
    if (payload.email_verified !== true) {
      throw new GoogleAuthError('Google account email is not verified')
    }
    const hd = typeof payload.hd === 'string' ? payload.hd : undefined
    if (this.settings.allowedDomain && hd !== this.settings.allowedDomain) {
      throw new GoogleAuthError(`Account is not in the allowed Workspace domain (${this.settings.allowedDomain})`)
    }
    return {
      sub,
      email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      hd,
      issuer: String(payload.iss)
    }
  }
}
