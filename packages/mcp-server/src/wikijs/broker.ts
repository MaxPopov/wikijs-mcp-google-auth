import { decodeJwt } from 'jose'
import type { AssertionSigner } from './assertion.js'
import { rateLimitRetryDelay, type WikijsClient } from './client.js'

export interface DelegatedIdentity {
  /** Stable subject from the IdP (Google `sub`). */
  sub: string
  email: string
  name?: string
}

interface CacheEntry {
  jwt: string
  /** Unix seconds after which we proactively re-login. */
  refreshAfter: number
}

/**
 * Holds the mapping "delegated identity -> native Wiki.js JWT".
 *
 * Wiki.js JWTs are short-lived (30 min by default), so the broker
 * re-runs the delegation login shortly before expiry, and immediately
 * when a token is explicitly invalidated (e.g. after a 401-like error
 * or logout).
 */
export class WikijsTokenBroker {
  private readonly cache = new Map<string, CacheEntry>()

  constructor (
    private readonly client: WikijsClient,
    private readonly signer: AssertionSigner,
    private readonly strategyKey: string,
    private readonly refreshSkewSeconds = 120
  ) {}

  async getToken (identity: DelegatedIdentity): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const cached = this.cache.get(identity.sub)
    if (cached && cached.refreshAfter > now) {
      return cached.jwt
    }
    const jwt = await this.loginWithRetry(identity)

    let refreshAfter = now + 300
    try {
      const { exp } = decodeJwt(jwt)
      if (typeof exp === 'number') {
        refreshAfter = Math.max(now + 30, exp - this.refreshSkewSeconds)
      }
    } catch {
      // Not fatal: fall back to the conservative default above.
    }
    this.cache.set(identity.sub, { jwt, refreshAfter })
    return jwt
  }

  /**
   * Wiki.js limits logins to 5/minute per source IP (see WikijsClient).
   * On a rate-limit rejection, wait out the advertised delay and retry
   * with a FRESHLY signed assertion (the original would expire and its
   * jti must not be reused anyway).
   */
  private async loginWithRetry (identity: DelegatedIdentity, maxAttempts = 3): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const assertion = await this.signer.sign(identity)
      try {
        return await this.client.loginDelegation(this.strategyKey, identity.email, assertion)
      } catch (err) {
        const waitSec = rateLimitRetryDelay(err)
        if (waitSec === null || attempt >= maxAttempts) throw err
        await new Promise(r => setTimeout(r, waitSec * 1000))
      }
    }
  }

  invalidate (sub: string): void {
    this.cache.delete(sub)
  }

  clear (): void {
    this.cache.clear()
  }
}
