// Full-stack e2e: MCP client -> OAuth (DCR + PKCE, fake Google IdP) ->
// Streamable HTTP MCP -> whoami tool -> delegation -> LIVE Wiki.js.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHarness, type TestHarness } from './helpers/app.js'

const JOHN = { sub: 'google-sub-john', email: 'john@example.com', name: 'John Doe', hd: 'example.com' }
const KATE = { sub: 'google-sub-kate', email: 'kate@example.com', name: 'Kate Roe', hd: 'example.com' }

async function mcpClient (harness: TestHarness, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'e2e-client', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  })
  await client.connect(transport)
  return client
}

async function callWhoami (client: Client): Promise<{ identity: { email: string }, wikijs: { groups?: Array<string | number>, permissions?: string[] } }> {
  const res = await client.callTool({ name: 'whoami', arguments: {} })
  const text = (res.content as Array<{ type: string, text: string }>)[0]!.text
  return JSON.parse(text)
}

describe('OAuth + MCP e2e (fake Google, live Wiki.js)', () => {
  let harness: TestHarness
  let clientId = ''

  beforeAll(async () => {
    harness = await startHarness()
    clientId = (await harness.registerClient()).client_id
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('serves AS and protected-resource metadata', async () => {
    const as = await (await fetch(`${harness.baseUrl}/.well-known/oauth-authorization-server`)).json() as Record<string, string>
    expect(as.authorization_endpoint).toBe(`${harness.baseUrl}/authorize`)
    expect(as.token_endpoint).toBe(`${harness.baseUrl}/token`)
    expect(as.registration_endpoint).toBe(`${harness.baseUrl}/register`)

    const pr = await (await fetch(`${harness.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>
    expect(pr.resource).toBe(`${harness.baseUrl}/mcp`)
  })

  it('rejects unauthenticated MCP requests with WWW-Authenticate', async () => {
    const res = await fetch(`${harness.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata')
  })

  it('two users authenticate concurrently and each sees their own Wiki.js identity', async () => {
    const johnTokens = await harness.oauthFlow(clientId, JOHN)
    const kateTokens = await harness.oauthFlow(clientId, KATE)
    expect(johnTokens.access_token).toBeTruthy()
    expect(kateTokens.access_token).toBeTruthy()

    const john = await mcpClient(harness, String(johnTokens.access_token))
    const kate = await mcpClient(harness, String(kateTokens.access_token))
    try {
      const whoJohn = await callWhoami(john)
      const whoKate = await callWhoami(kate)
      expect(whoJohn.identity.email).toBe('john@example.com')
      expect(whoJohn.wikijs.groups).toContain('Engineering')
      expect(whoKate.identity.email).toBe('kate@example.com')
      expect(whoKate.wikijs.groups).toContain('Management')
    } finally {
      await john.close()
      await kate.close()
    }
  })

  it('refresh token rotation works end-to-end', async () => {
    const tokens = await harness.oauthFlow(clientId, JOHN)
    const res = await fetch(`${harness.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: String(tokens.refresh_token),
        client_id: clientId
      })
    })
    expect(res.ok).toBe(true)
    const next = await res.json() as Record<string, unknown>
    expect(next.access_token).not.toBe(tokens.access_token)

    const client = await mcpClient(harness, String(next.access_token))
    try {
      const who = await callWhoami(client)
      expect(who.identity.email).toBe('john@example.com')
    } finally {
      await client.close()
    }

    // Old refresh token must be dead (rotation).
    const reuse = await fetch(`${harness.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: String(tokens.refresh_token),
        client_id: clientId
      })
    })
    expect(reuse.status).toBeGreaterThanOrEqual(400)
  })

  it('denies accounts outside the allowed Workspace domain', async () => {
    const result = await harness.oauthFlow(clientId, {
      sub: 'google-sub-evil', email: 'evil@evil.com', hd: 'evil.com'
    })
    expect(result.error).toBe('access_denied')
    expect(String(result.error_description)).toMatch(/domain/i)
  })

  it('denies unverified Google emails', async () => {
    const result = await harness.oauthFlow(clientId, {
      sub: 'google-sub-unverified', email: 'shady@example.com', hd: 'example.com', emailVerified: false
    })
    expect(result.error).toBe('access_denied')
  })

  it('an attacker-registered redirect URI cannot silently steal a code (consent required)', async () => {
    // Attacker registers their own client with an evil redirect URI.
    const attacker = await harness.registerClient()
    // Victim (John) walks the flow up to our Google callback, but stops
    // at the consent page instead of a code being emitted to the attacker.
    const verifier = 'a'.repeat(43)
    const { createHash } = await import('node:crypto')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    harness.fakeGoogle.currentUser = JOHN
    const authorizeUrl = new URL(`${harness.baseUrl}/authorize`)
    authorizeUrl.searchParams.set('client_id', attacker.client_id)
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:59999/oauth/callback')
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('state', 'x')

    const r1 = await fetch(authorizeUrl, { redirect: 'manual' })
    const r2 = await fetch(r1.headers.get('location')!, { redirect: 'manual' })
    const r3 = await fetch(r2.headers.get('location')!, { redirect: 'manual' })
    // The callback must NOT 302 a code straight to the attacker; it must
    // render a consent page the victim has to actively approve.
    expect(r3.status).toBe(200)
    const html = await r3.text()
    expect(html).toMatch(/Approve/)
  })

  it('revoked session invalidates live access tokens', async () => {
    const tokens = await harness.oauthFlow(clientId, KATE)
    const info = await harness.provider.verifyAccessToken(String(tokens.access_token))
    harness.provider.revokeSession(String(info.extra?.sessionId))
    await expect(harness.provider.verifyAccessToken(String(tokens.access_token))).rejects.toThrow()
  })
})
