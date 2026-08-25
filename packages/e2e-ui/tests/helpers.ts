import { createHash, randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const MCP_URL = (process.env.MCP_URL ?? 'http://localhost:8000').replace(/\/+$/, '')
export const IDP_URL = (process.env.IDP_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
export const CLIENT_REDIRECT = `${IDP_URL}/callback-sink`

export interface Pkce { verifier: string, challenge: string }

export function pkce (): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Dynamic client registration against the MCP OAuth server. */
export async function registerClient (): Promise<string> {
  const res = await fetch(`${MCP_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'e2e-ui-client',
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`DCR failed: HTTP ${res.status} ${await res.text()}`)
  }
  const body = await res.json() as { client_id: string }
  return body.client_id
}

export function authorizeUrl (clientId: string, challenge: string, state: string): string {
  const url = new URL(`${MCP_URL}/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', CLIENT_REDIRECT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'wikijs')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return url.toString()
}

export interface FlowOutcome {
  code: string | null
  error: string | null
  errorDescription: string | null
  sawConsent: boolean
}

/**
 * Drives the interactive browser OAuth flow as a role:
 *   MCP /authorize -> IdP login page (pick role) -> MCP google callback
 *   -> (consent page) -> IdP callback-sink with code or error.
 * Returns what landed on the sink.
 */
export async function loginAs (
  page: Page,
  clientId: string,
  role: 'john' | 'kate' | 'evil',
  challenge: string,
  state: string,
  consent: 'approve' | 'deny' = 'approve'
): Promise<FlowOutcome> {
  await page.goto(authorizeUrl(clientId, challenge, state))
  // On the IdP login page: choose the role.
  await page.getByTestId(`login-${role}`).click()

  // Either the MCP consent page appears, or (for denied identities) we go
  // straight to the sink with an error.
  await page.waitForLoadState('domcontentloaded')
  const approveButton = page.getByRole('button', { name: 'Approve' })
  let sawConsent = false
  if (await approveButton.isVisible().catch(() => false)) {
    sawConsent = true
    await page.getByRole('button', { name: consent === 'approve' ? 'Approve' : 'Deny' }).click()
  }

  await page.waitForURL(/callback-sink/, { timeout: 15_000 })
  const code = (await page.locator('#code').textContent())?.trim() || null
  const error = (await page.locator('#error').textContent())?.trim() || null
  const errorDescription = (await page.locator('#error_description').textContent())?.trim() || null
  return { code: code || null, error: error || null, errorDescription: errorDescription || null, sawConsent }
}

/** Exchange an authorization code (with PKCE) for tokens at the MCP server. */
export async function exchangeCode (clientId: string, code: string, verifier: string): Promise<string> {
  const res = await fetch(`${MCP_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT
    })
  })
  const body = await res.json() as { access_token?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${JSON.stringify(body)}`)
  }
  return body.access_token
}

/** MCP SDK client bound to an access token. */
export async function mcpClient (accessToken: string): Promise<Client> {
  const client = new Client({ name: 'e2e-ui', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  })
  await client.connect(transport)
  return client
}

export async function callTool (client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean, text: string, json: () => any }> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
  const text = (res.content as Array<{ type: string, text: string }>).map(c => c.text).join('\n')
  return { isError: res.isError === true, text, json: () => JSON.parse(text) }
}
