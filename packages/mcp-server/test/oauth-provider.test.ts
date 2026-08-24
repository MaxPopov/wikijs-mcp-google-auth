import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { GoogleBackedOAuthProvider } from '../src/oauth/provider.js'
import { MemoryStore } from '../src/store/store.js'
import type { GoogleOIDC } from '../src/oauth/google.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-1',
  redirect_uris: ['http://localhost:9999/callback'],
  token_endpoint_auth_method: 'none'
}

function makeProvider (): { provider: GoogleBackedOAuthProvider, store: MemoryStore } {
  const store = new MemoryStore()
  const google = {
    buildAuthUrl: ({ state }: { state: string }) => `https://google.test/auth?state=${state}`,
    exchangeCode: async () => 'fake-id-token',
    verifyIdToken: async () => ({
      sub: 'sub-1', email: 'john@example.com', name: 'John', issuer: 'https://accounts.google.com'
    })
  } as unknown as GoogleOIDC
  const provider = new GoogleBackedOAuthProvider(store, google, {
    publicUrl: 'http://localhost:8000',
    accessTokenTtlSeconds: 60
  })
  return { provider, store }
}

/** Minimal express Response double capturing redirect + html body + status. */
function fakeRes (): { res: Response, redirected: () => string | null, html: () => string | null, status: () => number } {
  let redirect: string | null = null
  let html: string | null = null
  let statusCode = 200
  const res = {
    redirect: (url: string) => { redirect = url },
    status: (code: number) => { statusCode = code; return res },
    type: () => res,
    send: (body: string) => { html = body }
  }
  return {
    res: res as unknown as Response,
    redirected: () => redirect,
    html: () => html,
    status: () => statusCode
  }
}

async function authorizeToGoogleCallback (provider: GoogleBackedOAuthProvider, client = CLIENT, redirectUri = CLIENT.redirect_uris[0]!): Promise<ReturnType<typeof fakeRes>> {
  const authRes = fakeRes()
  await provider.authorize(client, { redirectUri, codeChallenge: 'challenge', state: 'client-state' }, authRes.res)
  const pendingId = new URL(authRes.redirected()!).searchParams.get('state')!
  const cbRes = fakeRes()
  await provider.handleGoogleCallback({ query: { code: 'google-code', state: pendingId } } as never, cbRes.res)
  return cbRes
}

/** Full leg including auto-approving the consent interstitial. */
async function runAuthLeg (provider: GoogleBackedOAuthProvider): Promise<string> {
  const cbRes = await authorizeToGoogleCallback(provider)
  let clientRedirect: string | null = cbRes.redirected()
  if (!clientRedirect) {
    // Consent page shown — approve it.
    const html = cbRes.html()!
    const consentId = /name="consent_id" value="([^"]+)"/.exec(html)![1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]
    const consentRes = fakeRes()
    provider.handleConsent({ body: { consent_id: consentId, csrf, approve: 'yes' } } as never, consentRes.res)
    clientRedirect = consentRes.redirected()
  }
  const url = new URL(clientRedirect!)
  expect(url.origin + url.pathname).toBe(CLIENT.redirect_uris[0])
  expect(url.searchParams.get('state')).toBe('client-state')
  return url.searchParams.get('code')!
}

describe('GoogleBackedOAuthProvider', () => {
  it('issues tokens for a valid code and verifies the access token', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe('challenge')
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)
    expect(tokens.access_token).toMatch(/^mcp_at_/)
    expect(tokens.refresh_token).toMatch(/^mcp_rt_/)

    const info = await provider.verifyAccessToken(tokens.access_token)
    expect(info.clientId).toBe('client-1')
    expect(info.extra?.email).toBe('john@example.com')
    expect(info.extra?.sub).toBe('sub-1')
  })

  it('rejects code reuse', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    await provider.exchangeAuthorizationCode(CLIENT, code)
    await expect(provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow(/invalid or expired/i)
  })

  it('rejects a code presented by a different client', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    await expect(provider.exchangeAuthorizationCode({ ...CLIENT, client_id: 'other' }, code))
      .rejects.toThrow(/invalid or expired/i)
  })

  it('rejects a mismatched redirect_uri at token exchange', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    await expect(provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'http://evil/callback'))
      .rejects.toThrow(/redirect_uri/i)
  })

  it('rotates refresh tokens', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)
    const next = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)
    expect(next.access_token).not.toBe(tokens.access_token)
    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!))
      .rejects.toThrow(/invalid or expired/i)
  })

  it('expires access tokens', async () => {
    vi.useFakeTimers()
    try {
      const { provider } = makeProvider()
      const code = await runAuthLeg(provider)
      const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)
      vi.setSystemTime(Date.now() + 61_000)
      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/invalid or expired/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('revoking a session kills its tokens', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)
    const info = await provider.verifyAccessToken(tokens.access_token)
    provider.revokeSession(String(info.extra?.sessionId))
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow()
    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)).rejects.toThrow()
  })

  it('does not release a code before the user consents (confused-deputy defense)', async () => {
    const { provider } = makeProvider()
    const cbRes = await authorizeToGoogleCallback(provider)
    // No redirect with a code yet: an HTML consent page instead.
    expect(cbRes.redirected()).toBeNull()
    const html = cbRes.html()!
    expect(html).toMatch(/Approve/)
    expect(html).toContain(CLIENT.redirect_uris[0])
  })

  it('denying consent redirects with access_denied and issues no token', async () => {
    const { provider } = makeProvider()
    const cbRes = await authorizeToGoogleCallback(provider)
    const html = cbRes.html()!
    const consentId = /name="consent_id" value="([^"]+)"/.exec(html)![1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]
    const denyRes = fakeRes()
    provider.handleConsent({ body: { consent_id: consentId, csrf, approve: 'no' } } as never, denyRes.res)
    const url = new URL(denyRes.redirected()!)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('code')).toBeNull()
  })

  it('rejects consent with a wrong CSRF token', async () => {
    const { provider } = makeProvider()
    const cbRes = await authorizeToGoogleCallback(provider)
    const consentId = /name="consent_id" value="([^"]+)"/.exec(cbRes.html()!)![1]
    const res = fakeRes()
    provider.handleConsent({ body: { consent_id: consentId, csrf: 'wrong', approve: 'yes' } } as never, res.res)
    expect(res.status()).toBe(400)
    expect(res.redirected()).toBeNull()
  })

  it('remembers approval per client so the second authorization skips consent', async () => {
    const { provider } = makeProvider()
    await runAuthLeg(provider) // first time: approves
    const second = await authorizeToGoogleCallback(provider)
    // Same user + client + redirect: straight to a code, no consent page.
    expect(second.html()).toBeNull()
    expect(new URL(second.redirected()!).searchParams.get('code')).toBeTruthy()
  })

  it('revokeToken removes the presented token only for its client', async () => {
    const { provider } = makeProvider()
    const code = await runAuthLeg(provider)
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code)
    await provider.revokeToken({ ...CLIENT, client_id: 'other' }, { token: tokens.access_token })
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy()
    await provider.revokeToken(CLIENT, { token: tokens.access_token })
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow()
  })
})
