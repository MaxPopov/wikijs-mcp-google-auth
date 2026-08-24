import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleOIDC } from '../../../src/oauth/google.js'
import { GoogleBackedOAuthProvider } from '../../../src/oauth/provider.js'
import { MemoryStore } from '../../../src/store/store.js'
import { AssertionSigner } from '../../../src/wikijs/assertion.js'
import { WikijsClient } from '../../../src/wikijs/client.js'
import { WikijsTokenBroker } from '../../../src/wikijs/broker.js'
import { createApp } from '../../../src/server.js'
import { FakeGoogle, type FakeGoogleUser } from './fake-google.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const WIKIJS_URL = process.env.WIKIJS_URL ?? 'http://127.0.0.1:3000'
const CLIENT_CALLBACK = 'http://127.0.0.1:59999/oauth/callback'

export interface TestHarness {
  baseUrl: string
  fakeGoogle: FakeGoogle
  provider: GoogleBackedOAuthProvider
  broker: WikijsTokenBroker
  registerClient: () => Promise<{ client_id: string }>
  /** Full OAuth dance for the given fake Google user; returns token response. */
  oauthFlow: (clientId: string, user: FakeGoogleUser) => Promise<Record<string, unknown>>
  stop: () => Promise<void>
}

export async function startHarness (): Promise<TestHarness> {
  const fakeGoogle = new FakeGoogle()
  await fakeGoogle.start()

  const httpServer: Server = createServer()
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  const store = new MemoryStore()
  const wikiClient = new WikijsClient(WIKIJS_URL)
  const signer = new AssertionSigner({
    privateKeyPem: readFileSync(join(ROOT, 'deploy', 'keys', 'mcp-assertion-key.pem'), 'utf8'),
    issuer: 'urn:wikijs-mcp-google-auth',
    audience: 'urn:wikijs:mcp-delegation'
  })
  const broker = new WikijsTokenBroker(wikiClient, signer, 'mcpdelegation')
  const provider = new GoogleBackedOAuthProvider(store, new GoogleOIDC(fakeGoogle.settings()), {
    publicUrl: baseUrl,
    onRevokeSession: session => broker.invalidate(session.sub)
  })

  const app = createApp({ publicUrl: baseUrl, provider, mcpDeps: { broker, wikiClient } })
  httpServer.on('request', app)

  async function registerClient (): Promise<{ client_id: string }> {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-test-client',
        redirect_uris: [CLIENT_CALLBACK],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    })
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`DCR failed: HTTP ${res.status} ${await res.text()}`)
    }
    return await res.json() as { client_id: string }
  }

  async function oauthFlow (clientId: string, user: FakeGoogleUser): Promise<Record<string, unknown>> {
    fakeGoogle.currentUser = user
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(8).toString('hex')

    const authorizeUrl = new URL(`${baseUrl}/authorize`)
    authorizeUrl.searchParams.set('client_id', clientId)
    authorizeUrl.searchParams.set('redirect_uri', CLIENT_CALLBACK)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('state', state)

    // 1. MCP server -> redirect to (fake) Google
    const r1 = await fetch(authorizeUrl, { redirect: 'manual' })
    if (r1.status !== 302) throw new Error(`authorize: HTTP ${r1.status} ${await r1.text()}`)
    const googleUrl = r1.headers.get('location')!

    // 2. Google -> redirect back to our /oauth/google/callback
    const r2 = await fetch(googleUrl, { redirect: 'manual' })
    if (r2.status !== 302) throw new Error(`fake google authorize: HTTP ${r2.status}`)
    const callbackUrl = r2.headers.get('location')!

    // 3. Our callback -> redirect to the MCP client's redirect_uri
    const r3 = await fetch(callbackUrl, { redirect: 'manual' })
    if (r3.status !== 302) throw new Error(`google callback: HTTP ${r3.status} ${await r3.text()}`)
    const clientRedirect = new URL(r3.headers.get('location')!)
    if (clientRedirect.searchParams.get('error')) {
      return Object.fromEntries(clientRedirect.searchParams.entries())
    }
    if (clientRedirect.searchParams.get('state') !== state) {
      throw new Error('state mismatch on client redirect')
    }

    // 4. Exchange the code (with PKCE verifier) for tokens
    const r4 = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: clientRedirect.searchParams.get('code')!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CLIENT_CALLBACK
      })
    })
    const tokens = await r4.json() as Record<string, unknown>
    if (!r4.ok) throw new Error(`token: HTTP ${r4.status} ${JSON.stringify(tokens)}`)
    return tokens
  }

  return {
    baseUrl,
    fakeGoogle,
    provider,
    broker,
    registerClient,
    oauthFlow,
    stop: async () => {
      await new Promise<void>((resolve, reject) => httpServer.close(err => err ? reject(err) : resolve()))
      await fakeGoogle.stop()
    }
  }
}
