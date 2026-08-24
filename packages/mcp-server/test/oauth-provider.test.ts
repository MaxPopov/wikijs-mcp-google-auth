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

/** Runs authorize + google callback, returns the issued authorization code. */
async function runAuthLeg (provider: GoogleBackedOAuthProvider): Promise<string> {
  let googleRedirect = ''
  await provider.authorize(CLIENT, {
    redirectUri: CLIENT.redirect_uris[0]!,
    codeChallenge: 'challenge',
    state: 'client-state'
  }, { redirect: (url: string) => { googleRedirect = url } } as unknown as Response)
  const pendingId = new URL(googleRedirect).searchParams.get('state')!

  let clientRedirect = ''
  await provider.handleGoogleCallback(
    { query: { code: 'google-code', state: pendingId } } as never,
    { redirect: (url: string) => { clientRedirect = url }, status: () => ({ send: () => {} }) } as never
  )
  const url = new URL(clientRedirect)
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
