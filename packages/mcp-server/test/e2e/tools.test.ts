// Phase 3 e2e: the full ACL matrix exercised THROUGH MCP TOOLS by two
// OAuth-authenticated users against live Wiki.js. Every allow/deny below
// is decided by Wiki.js page rules — the MCP server holds no ACL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHarness, type TestHarness } from './helpers/app.js'

const JOHN = { sub: 'google-sub-john', email: 'john@example.com', hd: 'example.com' }
const KATE = { sub: 'google-sub-kate', email: 'kate@example.com', hd: 'example.com' }

interface ToolCallResult {
  isError?: boolean
  text: string
  json: () => Record<string, unknown>
}

async function connect (harness: TestHarness, user: typeof JOHN, clientId: string): Promise<Client> {
  const tokens = await harness.oauthFlow(clientId, user)
  const client = new Client({ name: 'tools-e2e', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${String(tokens.access_token)}` } }
  })
  await client.connect(transport)
  return client
}

async function call (client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  // Generous timeout: the server may be waiting out the Wiki.js login
  // rate limit before it can mint the delegated JWT.
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
  const text = (res.content as Array<{ type: string, text: string }>).map(c => c.text).join('\n')
  return {
    isError: res.isError === true,
    text,
    json: () => JSON.parse(text) as Record<string, unknown>
  }
}

describe('MCP tools ACL matrix (live Wiki.js)', () => {
  let harness: TestHarness
  let john: Client
  let kate: Client

  beforeAll(async () => {
    harness = await startHarness()
    const clientId = (await harness.registerClient()).client_id
    john = await connect(harness, JOHN, clientId)
    kate = await connect(harness, KATE, clientId)
  })

  afterAll(async () => {
    await john?.close()
    await kate?.close()
    await harness?.stop()
  })

  it('exposes the expected tools', async () => {
    const tools = await john.listTools()
    const names = tools.tools.map(t => t.name).sort()
    expect(names).toEqual(['create_page', 'delete_page', 'get_page', 'list_pages', 'search_wiki', 'update_page', 'whoami'])
  })

  it('john reads an engineering page by path', async () => {
    const res = await call(john, 'get_page', { path: 'engineering/onboarding' })
    expect(res.isError).toBe(false)
    expect(res.json().title).toBe('Engineering Onboarding')
    expect(String(res.json().content)).toContain('Engineering Onboarding')
  })

  it('john is denied the management page with a readable error', async () => {
    const res = await call(john, 'get_page', { path: 'management/salaries' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/denied|permission/i)
  })

  it('search through tools is ACL-filtered per user', async () => {
    const johnSearch = await call(john, 'search_wiki', { query: 'salaries' })
    expect(johnSearch.isError).toBe(false)
    expect(JSON.stringify(johnSearch.json().results)).not.toContain('management/salaries')

    const kateSearch = await call(kate, 'search_wiki', { query: 'salaries' })
    expect(kateSearch.isError).toBe(false)
    expect(JSON.stringify(kateSearch.json().results)).toContain('management/salaries')
  })

  it('list_pages hides pages the user cannot read', async () => {
    const johnList = await call(john, 'list_pages', {})
    expect(johnList.isError).toBe(false)
    const johnPaths = (johnList.json().pages as Array<{ path: string }>).map(p => p.path)
    expect(johnPaths).toContain('engineering/onboarding')
    expect(johnPaths).not.toContain('management/salaries')

    const kateList = await call(kate, 'list_pages', {})
    const katePaths = (kateList.json().pages as Array<{ path: string }>).map(p => p.path)
    expect(katePaths).toContain('management/salaries')
  })

  it('john can create, update and delete a page in his area', async () => {
    const path = `engineering/e2e-tools-${Date.now()}`
    const created = await call(john, 'create_page', {
      path, title: 'Tools e2e', content: '# Tools e2e\n\ncreated via MCP'
    })
    expect(created.isError).toBe(false)
    const id = created.json().id as number
    expect(id).toBeGreaterThan(0)

    const updated = await call(john, 'update_page', { id, content: '# Tools e2e\n\nupdated via MCP' })
    expect(updated.isError).toBe(false)

    const roundTrip = await call(john, 'get_page', { id })
    expect(String(roundTrip.json().content)).toContain('updated via MCP')

    const deleted = await call(john, 'delete_page', { id })
    expect(deleted.isError).toBe(false)

    const gone = await call(john, 'get_page', { id })
    expect(gone.isError).toBe(true)
  })

  it('john cannot create a page under management/', async () => {
    const res = await call(john, 'create_page', {
      path: `management/e2e-intrusion-${Date.now()}`, title: 'Nope', content: 'nope'
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/denied|permission/i)
  })

  it('john cannot update or delete the management page', async () => {
    const kateView = await call(kate, 'get_page', { path: 'management/salaries' })
    const salariesId = kateView.json().id as number

    const upd = await call(john, 'update_page', { id: salariesId, content: 'hacked' })
    expect(upd.isError).toBe(true)
    expect(upd.text).toMatch(/denied|permission/i)

    const del = await call(john, 'delete_page', { id: salariesId })
    expect(del.isError).toBe(true)
    expect(del.text).toMatch(/denied|permission/i)
  })

  it('kate can update the management page through tools', async () => {
    const res = await call(kate, 'update_page', {
      path: 'management/salaries',
      content: `# Salaries 2026\n\nCONFIDENTIAL: salary bands. Tools e2e touch at ${Date.now()}.`
    })
    expect(res.isError).toBe(false)
  })

  it('update_page validates its input', async () => {
    const noTarget = await call(john, 'update_page', { content: 'x' })
    expect(noTarget.isError).toBe(true)
    const noChanges = await call(john, 'update_page', { path: 'engineering/onboarding' })
    expect(noChanges.isError).toBe(true)
  })
})
