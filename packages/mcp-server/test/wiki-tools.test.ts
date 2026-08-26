// Regression tests for the id-vs-path addressing traps in the wiki tools.
//
// Background: `pages.single(id)` and `pages.singleByPath(path, locale)`
// run the IDENTICAL Wiki.js permission check, so a denial by id next to a
// success by path never means the ACL disagrees with itself — it means the
// id addressed a different page. The usual source of such an id is a
// search hit, whose `id` field comes from the search index rather than
// from `pages`. These tests pin the mitigations for both.

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerWikiTools } from '../src/tools/wiki.js'
import type { McpDeps } from '../src/mcp.js'
import { WikijsClient, WikijsGraphQLError } from '../src/wikijs/client.js'
import type { WikijsTokenBroker } from '../src/wikijs/broker.js'

interface ToolResult {
  content: Array<{ type: string, text: string }>
  isError?: boolean
}

type Graphql = (query: string, variables: Record<string, unknown>, jwt?: string) => Promise<unknown>

const AUTH = { extra: { sub: 'google-sub-1', email: 'user@example.com' } }

const FORBIDDEN = 'You are not authorized to view this page.'
const NOT_FOUND = 'This page does not exist.'

function page (over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    path: 'handbook/reward-policy',
    locale: 'en',
    title: 'Reward Policy',
    description: '',
    content: '# Reward Policy',
    editor: 'markdown',
    isPublished: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    authorName: 'Author',
    tags: [],
    ...over
  }
}

/** Registers the tools against a stub server and returns a caller that
 *  applies the real zod input schema (defaults included) before dispatch. */
function harness (graphql: Graphql): (tool: string, args: Record<string, unknown>) => Promise<ToolResult> {
  const tools = new Map<string, { schema: z.ZodTypeAny, handler: Function }>()
  const server = {
    registerTool (name: string, config: { inputSchema: z.ZodRawShape }, handler: Function) {
      tools.set(name, { schema: z.object(config.inputSchema), handler })
    }
  } as unknown as McpServer

  const deps: McpDeps = {
    broker: { getToken: async () => 'delegated-jwt' } as unknown as WikijsTokenBroker,
    wikiClient: { graphql } as unknown as WikijsClient
  }
  registerWikiTools(server, deps)

  return async (tool, args) => {
    const entry = tools.get(tool)
    if (!entry) throw new Error(`tool not registered: ${tool}`)
    return await entry.handler(entry.schema.parse(args), { authInfo: AUTH }) as ToolResult
  }
}

const text = (r: ToolResult): string => r.content.map(c => c.text).join('\n')
const json = (r: ToolResult): Record<string, unknown> => JSON.parse(text(r)) as Record<string, unknown>

describe('search_wiki', () => {
  it('never emits the search-index reference as a page id', async () => {
    const call = harness(async () => ({
      pages: {
        search: {
          // `id` here is the search index's own row id (postgres engine) —
          // NOT pages.id. Handing it to the model invites get_page(id: 66).
          results: [{ id: '66', title: 'Reward Policy', description: 'pay', path: 'handbook/reward-policy', locale: 'en' }],
          suggestions: [],
          totalHits: 1
        }
      }
    }))

    const res = await call('search_wiki', { query: 'reward' })
    expect(res.isError).toBeFalsy()
    const results = json(res).results as Array<Record<string, unknown>>
    expect(results).toEqual([
      { path: 'handbook/reward-policy', locale: 'en', title: 'Reward Policy', description: 'pay' }
    ])
    expect(results[0]).not.toHaveProperty('id')
    expect(results[0]).not.toHaveProperty('ref')
  })
})

describe('get_page', () => {
  it('reads by path through singleByPath', async () => {
    const graphql = vi.fn(async (query: string) => {
      expect(query).toContain('singleByPath')
      return { pages: { singleByPath: page() } }
    })
    const res = await harness(graphql)('get_page', { path: 'handbook/reward-policy' })
    expect(res.isError).toBeFalsy()
    expect(json(res).content).toContain('Reward Policy')
  })

  it('tells the caller a denial by id may be a wrong id, and to retry by path', async () => {
    const call = harness(async () => { throw new WikijsGraphQLError(FORBIDDEN) })
    const res = await call('get_page', { id: 66 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('id 66')
    expect(text(res)).toMatch(/retry by path/i)
    expect(text(res)).toMatch(/search_wiki hit is a search-index reference/i)
  })

  it('explains the source-permission requirement on a denial by path', async () => {
    const call = harness(async () => { throw new WikijsGraphQLError(FORBIDDEN) })
    const res = await call('get_page', { path: 'management/salaries' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('management/salaries')
    expect(text(res)).toMatch(/manage:pages.*delete:pages/)
    // The id-specific advice must not leak into a path lookup.
    expect(text(res)).not.toMatch(/retry by path/i)
  })

  it('flags id provenance when no page carries that id', async () => {
    const call = harness(async () => { throw new WikijsGraphQLError(NOT_FOUND) })
    const res = await call('get_page', { id: 66 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('No page with id 66')
    expect(text(res)).toMatch(/not a page id/i)
  })

  it('still requires exactly one of id/path', async () => {
    const call = harness(async () => ({}))
    expect((await call('get_page', {})).isError).toBe(true)
    expect((await call('get_page', { id: 1, path: 'a' })).isError).toBe(true)
  })
})

describe('delete_page', () => {
  it('refuses when the id and the path name different pages', async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes('single(')) return { pages: { single: page({ id: 66, path: 'engineering/onboarding' }) } }
      throw new Error('delete must not be attempted')
    })
    const res = await harness(graphql)('delete_page', { id: 66, path: 'handbook/reward-policy' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('engineering/onboarding')
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('deletes and reports the resolved path when id and path agree', async () => {
    const graphql = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('single(')) return { pages: { single: page({ id: 66 }) } }
      expect(variables.id).toBe(66)
      return { pages: { delete: { responseResult: { succeeded: true, errorCode: 0, slug: 'ok', message: '' } } } }
    })
    const res = await harness(graphql)('delete_page', { id: 66, path: '/handbook/reward-policy' })
    expect(res.isError).toBeFalsy()
    expect(json(res)).toMatchObject({ deleted: true, id: 66, path: 'handbook/reward-policy' })
  })

  it('accepts a path alone and deletes the id it resolves to', async () => {
    const graphql = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('singleByPath')) return { pages: { singleByPath: page({ id: 12 }) } }
      expect(variables.id).toBe(12)
      return { pages: { delete: { responseResult: { succeeded: true, errorCode: 0, slug: 'ok', message: '' } } } }
    })
    const res = await harness(graphql)('delete_page', { path: 'handbook/reward-policy' })
    expect(res.isError).toBeFalsy()
    expect(json(res)).toMatchObject({ deleted: true, id: 12 })
  })

  it('requires an identifier', async () => {
    const res = await harness(async () => ({}))('delete_page', {})
    expect(res.isError).toBe(true)
  })
})
