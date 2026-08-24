// Live ACL matrix through the DELEGATION flow (blueprint §19, Phase 1).
//
// Requires the dev stand: Wiki.js (seeded via deploy/seed/seed.mjs)
// reachable at WIKIJS_URL (default http://127.0.0.1:3000) and the dev
// keypair in deploy/keys/.
//
// Every operation here runs under a NATIVE Wiki.js JWT obtained by
// exchanging a signed delegation assertion — exactly what the MCP
// server does for a Google-authenticated user.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { AssertionSigner } from '../../src/wikijs/assertion.js'
import { WikijsClient, WikijsOperationError, rateLimitRetryDelay } from '../../src/wikijs/client.js'
import { WikijsTokenBroker } from '../../src/wikijs/broker.js'

/**
 * Runs a login attempt, transparently waiting out the Wiki.js per-IP
 * login rate limit (5/min) so repeated e2e runs stay deterministic.
 * `sign` is re-invoked per attempt because assertions are short-lived.
 */
async function loginAttempt (
  sign: () => Promise<{ email: string, assertion: string }>,
  wikiClient: WikijsClient = client
): Promise<{ ok: true, jwt: string } | { ok: false, message: string }> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { email, assertion } = await sign()
    try {
      const jwt = await wikiClient.loginDelegation('mcpdelegation', email, assertion)
      return { ok: true, jwt }
    } catch (err) {
      const waitSec = rateLimitRetryDelay(err)
      if (waitSec === null) return { ok: false, message: (err as Error).message }
      await new Promise(r => setTimeout(r, waitSec * 1000))
    }
  }
  throw new Error('rate limit never cleared')
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const WIKIJS_URL = process.env.WIKIJS_URL ?? 'http://127.0.0.1:3000'

const client = new WikijsClient(WIKIJS_URL)
const signer = new AssertionSigner({
  privateKeyPem: readFileSync(join(ROOT, 'deploy', 'keys', 'mcp-assertion-key.pem'), 'utf8'),
  issuer: 'urn:wikijs-mcp-google-auth',
  audience: 'urn:wikijs:mcp-delegation'
})
const broker = new WikijsTokenBroker(client, signer, 'mcpdelegation')

const JOHN = { sub: 'google-sub-john', email: 'john@example.com' }
const KATE = { sub: 'google-sub-kate', email: 'kate@example.com' }

async function readPage (jwt: string, path: string): Promise<{ id: number, title: string }> {
  const data = await client.graphql<{ pages: { singleByPath: { id: number, title: string } } }>(`
    query ($path: String!, $locale: String!) {
      pages { singleByPath(path: $path, locale: $locale) { id title } }
    }`, { path, locale: 'en' }, jwt)
  return data.pages.singleByPath
}

async function updatePage (jwt: string, id: number, content: string): Promise<void> {
  // NOTE: Wiki.js 2.5 updatePage crashes server-side when `tags` is
  // omitted (tags.map in associateTags), so always send it.
  const data = await client.graphql<{ pages: { update: { responseResult: { succeeded: boolean, message: string } } } }>(`
    mutation ($id: Int!, $content: String!) {
      pages { update(id: $id, content: $content, isPublished: true, tags: []) {
        responseResult { succeeded message }
      } }
    }`, { id, content }, jwt)
  const rr = data.pages.update.responseResult
  if (!rr.succeeded) throw new WikijsOperationError(rr.message)
}

async function search (jwt: string, query: string): Promise<string[]> {
  const data = await client.graphql<{ pages: { search: { results: Array<{ path: string }> } } }>(`
    query ($q: String!) { pages { search(query: $q) { results { path } } } }`,
  { q: query }, jwt)
  return data.pages.search.results.map(r => r.path)
}

describe('delegation ACL matrix (live Wiki.js)', () => {
  let johnJwt = ''
  let kateJwt = ''

  beforeAll(async () => {
    johnJwt = await broker.getToken(JOHN)
    kateJwt = await broker.getToken(KATE)
  })

  it('issues distinct native JWTs per delegated user', () => {
    expect(johnJwt).not.toEqual(kateJwt)
    const payload = JSON.parse(Buffer.from(johnJwt.split('.')[1]!, 'base64url').toString())
    expect(payload.email).toBe(JOHN.email)
    expect(payload.iss).toBe('urn:wiki.js')
    expect(payload.permissions).toContain('read:pages')
  })

  it('john can read an engineering page', async () => {
    const page = await readPage(johnJwt, 'engineering/onboarding')
    expect(page.title).toBe('Engineering Onboarding')
  })

  it('john is denied reading the management page', async () => {
    await expect(readPage(johnJwt, 'management/salaries'))
      .rejects.toThrow(/not authorized/i)
  })

  it('john can update an engineering page', async () => {
    const page = await readPage(johnJwt, 'engineering/onboarding')
    await updatePage(johnJwt, page.id, `# Engineering Onboarding\n\nUpdated by delegation e2e at ${Date.now()}.`)
  })

  it('john is denied updating the management page', async () => {
    const salaries = await readPage(kateJwt, 'management/salaries')
    await expect(updatePage(johnJwt, salaries.id, 'hacked'))
      .rejects.toThrow(/not authorized|forbidden/i)
  })

  it('search is ACL-filtered: john does not see confidential results', async () => {
    const paths = await search(johnJwt, 'salaries')
    expect(paths).not.toContain('management/salaries')
  })

  it('search works for kate: she sees the confidential page', async () => {
    const paths = await search(kateJwt, 'salaries')
    expect(paths).toContain('management/salaries')
  })

  it('kate can read and update the management page', async () => {
    const page = await readPage(kateJwt, 'management/salaries')
    expect(page.title).toBe('Salaries 2026')
    await updatePage(kateJwt, page.id, `# Salaries 2026\n\nCONFIDENTIAL: salary bands. Touched by e2e at ${Date.now()}.`)
  })

  it('rejects assertions signed with an unknown key', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    const rogueSigner = new AssertionSigner({
      privateKeyPem: privateKey,
      issuer: 'urn:wikijs-mcp-google-auth',
      audience: 'urn:wikijs:mcp-delegation'
    })
    const res = await loginAttempt(async () => ({
      email: JOHN.email,
      assertion: await rogueSigner.sign(JOHN)
    }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/login|failed|invalid/i)
  })

  it('rejects unknown users when self-registration is disabled', async () => {
    const res = await loginAttempt(async () => ({
      email: 'mallory@example.com',
      assertion: await signer.sign({ sub: 'google-sub-mallory', email: 'mallory@example.com' })
    }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/registration|disabled|failed/i)
  })

  it('rejects a replayed assertion', async () => {
    // First use must succeed, second use of the SAME assertion must fail
    // with a login failure (not a rate-limit artifact).
    let reused = ''
    const first = await loginAttempt(async () => {
      reused = await signer.sign(JOHN)
      return { email: JOHN.email, assertion: reused }
    })
    expect(first.ok).toBe(true)
    const replay = await loginAttempt(async () => ({ email: JOHN.email, assertion: reused }))
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.message).toMatch(/login|failed|invalid/i)
  })
})
