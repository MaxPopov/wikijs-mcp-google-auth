import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { identityFromAuthInfo, type McpDeps } from '../mcp.js'
import { WikijsGraphQLError } from '../wikijs/client.js'
import { WikijsNativeSearch } from '../search/backend.js'

type ToolResult = {
  content: Array<{ type: 'text', text: string }>
  isError?: boolean
}

function ok (payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail (message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/**
 * Runs a tool operation under the caller's delegated Wiki.js JWT and
 * converts Wiki.js authorization failures into readable tool errors.
 * MCP performs NO permission checks of its own — a denial here is
 * Wiki.js (groups / page rules) speaking.
 */
async function withWikiJwt (
  deps: McpDeps,
  authInfo: AuthInfo | undefined,
  tool: string,
  op: (jwt: string) => Promise<ToolResult>
): Promise<ToolResult> {
  const identity = identityFromAuthInfo(authInfo)
  const audit = (outcome: 'ok' | 'denied' | 'error', detail?: string): void => {
    deps.audit?.({ tool, user: identity.email, outcome, detail })
  }
  try {
    const jwt = await deps.broker.getToken(identity)
    const result = await op(jwt)
    audit(result.isError ? 'denied' : 'ok', result.isError ? result.content[0]?.text : undefined)
    return result
  } catch (err) {
    if (err instanceof WikijsGraphQLError) {
      if (/not authorized|forbidden/i.test(err.message)) {
        audit('denied', err.message)
        return fail('Wiki.js denied this operation: you do not have permission for this page or action. This is enforced by Wiki.js groups/page rules, not by the MCP server.')
      }
      audit('error', err.message)
      return fail(`Wiki.js error: ${err.message}`)
    }
    audit('error', (err as Error).message)
    throw err
  }
}

interface PageFull {
  id: number
  path: string
  locale: string
  title: string
  description: string
  content: string
  editor: string
  isPublished: boolean
  updatedAt: string
  authorName: string
  tags: Array<{ tag: string }>
}

const PAGE_FIELDS = 'id path locale title description content editor isPublished updatedAt authorName tags { tag }'

function renderPage (page: PageFull): Record<string, unknown> {
  return {
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title,
    description: page.description,
    isPublished: page.isPublished,
    updatedAt: page.updatedAt,
    authorName: page.authorName,
    tags: page.tags.map(t => t.tag),
    editor: page.editor,
    content: page.content
  }
}

/**
 * Why a denial by id and a success by path are NOT an ACL inconsistency.
 *
 * `pages.single(id)` and `pages.singleByPath(path, locale)` load the row
 * through the same `getPageFromDb` and then run the SAME check —
 * `checkAccess(user, ['manage:pages', 'delete:pages'], { path, locale })`
 * (Wiki.js 2.5.296+, where `singleByPath` was introduced). There is no
 * admin-only resolver and no second rights cache on the id side.
 *
 * When the two disagree they are simply looking at DIFFERENT PAGES: the
 * `id` did not belong to the page the caller meant. The usual source of
 * such an id is a search hit — see `SearchResultItem.ref`.
 *
 * The second trap is that BOTH resolvers demand `manage:pages` or
 * `delete:pages`, while `list_pages` / `search_wiki` are filtered with
 * `read:pages`. A reader-only user therefore sees a page listed and is
 * refused its source here — by id and by path alike. Both messages below
 * say so instead of reporting a bare "no permission".
 */
const ID_PROVENANCE_HINT =
  'Ids are only valid if they came from list_pages, create_page, or a previous get_page. ' +
  'The "ref" in a search_wiki hit is a search-index reference, not a page id — ' +
  'address search hits by their path + locale instead.'

const SOURCE_PERMISSION_HINT =
  'Reading page source over the API needs "manage:pages" or "delete:pages" on that path; ' +
  '"read:pages" alone shows the page in the wiki UI, list_pages and search_wiki but is not enough here.'

function isForbidden (message: string): boolean {
  return /not authorized|forbidden/i.test(message)
}

function isMissing (message: string): boolean {
  return /does not exist|not found/i.test(message)
}

type PageLookup = { page: PageFull } | { error: ToolResult }

/**
 * Resolves a page by id or by path+locale, turning Wiki.js lookup
 * failures into messages that name WHICH of the two traps above applies.
 */
async function lookupPage (deps: McpDeps, jwt: string, args: { id?: number, path?: string, locale: string }): Promise<PageLookup> {
  const byId = args.id !== undefined
  let page: PageFull | null
  try {
    if (byId) {
      const data = await deps.wikiClient.graphql<{ pages: { single: PageFull | null } }>(
        `query ($id: Int!) { pages { single(id: $id) { ${PAGE_FIELDS} } } }`, { id: args.id }, jwt)
      page = data.pages.single
    } else {
      const data = await deps.wikiClient.graphql<{ pages: { singleByPath: PageFull | null } }>(
        `query ($path: String!, $locale: String!) { pages { singleByPath(path: $path, locale: $locale) { ${PAGE_FIELDS} } } }`,
        { path: args.path, locale: args.locale }, jwt)
      page = data.pages.singleByPath
    }
  } catch (err) {
    if (!(err instanceof WikijsGraphQLError)) throw err
    return { error: lookupFailure(err.message, args) }
  }
  if (!page) return { error: lookupFailure('This page does not exist.', args) }
  return { page }
}

function lookupFailure (message: string, args: { id?: number, path?: string, locale: string }): ToolResult {
  const target = args.id !== undefined
    ? `id ${args.id}`
    : `path "${args.path}" (locale "${args.locale}")`

  if (isMissing(message)) {
    return fail(args.id !== undefined
      ? `No page with ${target}. ${ID_PROVENANCE_HINT}`
      : `No page at ${target}.`)
  }
  if (isForbidden(message)) {
    const base = `Wiki.js denied ${target}: you do not have permission for this page or action. ` +
      'This is enforced by Wiki.js groups/page rules, not by the MCP server.'
    return fail(args.id !== undefined
      ? `${base} Two different causes look identical here: the id may address a page you cannot touch — ` +
        `${ID_PROVENANCE_HINT} Retry by path before concluding the permissions are wrong. ${SOURCE_PERMISSION_HINT}`
      : `${base} ${SOURCE_PERMISSION_HINT}`)
  }
  return fail(`Wiki.js error while resolving ${target}: ${message}`)
}

interface MutationResponse {
  responseResult: { succeeded: boolean, errorCode: number, slug: string, message: string }
  page?: { id: number, path: string } | null
}

function mutationFail (rr: MutationResponse['responseResult']): ToolResult {
  if (/not authorized|forbidden/i.test(rr.message) || /Forbidden/i.test(rr.slug)) {
    return fail(`Wiki.js denied this operation (${rr.slug}): you do not have permission for this page or action.`)
  }
  return fail(`Wiki.js rejected the operation (${rr.slug}): ${rr.message}`)
}

export function registerWikiTools (server: McpServer, deps: McpDeps): void {
  server.registerTool('search_wiki', {
    title: 'Search the wiki',
    description: 'Full-text search across Wiki.js pages. Results are filtered by the current user\'s permissions — pages they cannot read are never returned. Each hit is addressed by path + locale; pass those to get_page. Hits carry no page id on purpose — the underlying search index does not know it.',
    inputSchema: {
      query: z.string().min(1).describe('Search terms'),
      locale: z.string().optional().describe('Locale filter, e.g. "en"')
    }
  }, async ({ query, locale }, extra) => withWikiJwt(deps, extra.authInfo, 'search_wiki', async jwt => {
    const backend = deps.searchBackend ?? new WikijsNativeSearch(deps.wikiClient)
    const s = await backend.search(query, { wikijsJwt: jwt, locale })
    // `ref` is dropped deliberately: it is a search-index reference, not a
    // page id (see SearchResultItem). Emitting it invites get_page(id: ref),
    // which silently addresses an unrelated page.
    const results = s.results.map(({ path, locale: hitLocale, title, description }) => ({
      path, locale: hitLocale, title, description
    }))
    return ok({ totalHits: s.totalHits, results, suggestions: s.suggestions })
  }))

  server.registerTool('get_page', {
    title: 'Get a wiki page',
    description: 'Fetches a single Wiki.js page (metadata + full source content) by path (e.g. "engineering/onboarding") OR by numeric id. Provide exactly one of path/id. Prefer path: an id is only meaningful if it came from list_pages, create_page or an earlier get_page — a wrong id resolves to a different page, not to an error about the one you meant.',
    inputSchema: {
      id: z.number().int().positive().optional().describe('Page id from list_pages/create_page/get_page. Not a search_wiki result reference.'),
      path: z.string().optional().describe('Page path without leading slash, e.g. "engineering/onboarding"'),
      locale: z.string().default('en').describe('Page locale (used with path)')
    }
  }, async ({ id, path, locale }, extra) => withWikiJwt(deps, extra.authInfo, 'get_page', async jwt => {
    if ((id === undefined) === (path === undefined)) {
      return fail('Provide exactly one of "id" or "path".')
    }
    const found = await lookupPage(deps, jwt, { id, path, locale })
    if ('error' in found) return found.error
    return ok(renderPage(found.page))
  }))

  server.registerTool('list_pages', {
    title: 'List wiki pages',
    description: 'Lists Wiki.js pages visible to the current user (permission-filtered by Wiki.js). Optionally filter by path prefix and limit the count.',
    inputSchema: {
      pathPrefix: z.string().optional().describe('Only pages whose path starts with this prefix, e.g. "engineering/"'),
      limit: z.number().int().positive().max(500).default(100).describe('Maximum number of pages to return'),
      orderBy: z.enum(['PATH', 'TITLE', 'CREATED', 'UPDATED']).default('PATH')
    }
  }, async ({ pathPrefix, limit, orderBy }, extra) => withWikiJwt(deps, extra.authInfo, 'list_pages', async jwt => {
    const data = await deps.wikiClient.graphql<{ pages: { list: Array<{ id: number, path: string, locale: string, title: string | null, description: string | null, isPublished: boolean, updatedAt: string }> } }>(
      `query ($orderBy: PageOrderBy) { pages { list(orderBy: $orderBy) {
        id path locale title description isPublished updatedAt } } }`,
      { orderBy }, jwt)
    let pages = data.pages.list
    if (pathPrefix) {
      const prefix = pathPrefix.replace(/^\/+/, '')
      pages = pages.filter(p => p.path.startsWith(prefix))
    }
    const total = pages.length
    pages = pages.slice(0, limit)
    return ok({ total, returned: pages.length, pages })
  }))

  server.registerTool('create_page', {
    title: 'Create a wiki page',
    description: 'Creates a new Wiki.js page (markdown). Wiki.js enforces whether the user may create pages at the given path.',
    inputSchema: {
      path: z.string().min(1).describe('New page path without leading slash, e.g. "engineering/new-guide"'),
      title: z.string().min(1),
      content: z.string().min(1).describe('Markdown content'),
      description: z.string().default(''),
      locale: z.string().default('en'),
      tags: z.array(z.string()).default([]),
      isPublished: z.boolean().default(true)
    }
  }, async ({ path, title, content, description, locale, tags, isPublished }, extra) => withWikiJwt(deps, extra.authInfo, 'create_page', async jwt => {
    const data = await deps.wikiClient.graphql<{ pages: { create: MutationResponse } }>(
      `mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
        pages { create(content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags, title: $title) {
          responseResult { succeeded errorCode slug message }
          page { id path }
        } }
      }`, {
        content,
        description,
        editor: 'markdown',
        isPublished,
        isPrivate: false,
        locale,
        path: path.replace(/^\/+/, ''),
        tags,
        title
      }, jwt)
    const res = data.pages.create
    if (!res.responseResult.succeeded) return mutationFail(res.responseResult)
    return ok({ created: true, id: res.page?.id, path: res.page?.path })
  }))

  server.registerTool('update_page', {
    title: 'Update a wiki page',
    description: 'Updates an existing Wiki.js page. Only the provided fields change; the rest is preserved. Identify the page by id, or by path+locale. Wiki.js enforces edit permissions.',
    inputSchema: {
      id: z.number().int().positive().optional().describe('Page id from list_pages/create_page/get_page. Not a search_wiki result reference.'),
      path: z.string().optional().describe('Page path — preferred, and the only safe way to address a page found via search_wiki'),
      locale: z.string().default('en'),
      content: z.string().optional().describe('New full markdown content'),
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      isPublished: z.boolean().optional()
    }
  }, async ({ id, path, locale, content, title, description, tags, isPublished }, extra) => withWikiJwt(deps, extra.authInfo, 'update_page', async jwt => {
    if (id === undefined && path === undefined) {
      return fail('Provide "id" or "path" to identify the page.')
    }
    if (content === undefined && title === undefined && description === undefined && tags === undefined && isPublished === undefined) {
      return fail('Nothing to update: provide at least one of content, title, description, tags, isPublished.')
    }
    // Read-merge-write: also verifies the user can read the page, and
    // works around Wiki.js requiring `tags`/`content` on every update.
    const found = await lookupPage(deps, jwt, { id, path, locale })
    if ('error' in found) return found.error
    const current = found.page
    const data = await deps.wikiClient.graphql<{ pages: { update: MutationResponse } }>(
      `mutation ($id: Int!, $content: String!, $title: String!, $description: String!, $tags: [String]!, $isPublished: Boolean!) {
        pages { update(id: $id, content: $content, title: $title, description: $description, tags: $tags, isPublished: $isPublished) {
          responseResult { succeeded errorCode slug message }
          page { id path }
        } }
      }`, {
        id: current.id,
        content: content ?? current.content,
        title: title ?? current.title,
        description: description ?? current.description,
        tags: tags ?? current.tags.map(t => t.tag),
        isPublished: isPublished ?? current.isPublished
      }, jwt)
    const res = data.pages.update
    if (!res.responseResult.succeeded) return mutationFail(res.responseResult)
    return ok({ updated: true, id: current.id, path: current.path })
  }))

  server.registerTool('delete_page', {
    title: 'Delete a wiki page',
    description: 'Permanently deletes a Wiki.js page, identified by path (preferred) or by id. Destructive and irreversible — confirm with the user before calling. Passing BOTH id and path makes the server verify they name the same page and refuse otherwise. Wiki.js enforces delete permissions.',
    inputSchema: {
      id: z.number().int().positive().optional().describe('Page id from list_pages/create_page/get_page. Not a search_wiki result reference.'),
      path: z.string().optional().describe('Page path — preferred, and the only safe way to address a page found via search_wiki'),
      locale: z.string().default('en').describe('Page locale (used with path)')
    },
    annotations: {
      destructiveHint: true
    }
  }, async ({ id, path, locale }, extra) => withWikiJwt(deps, extra.authInfo, 'delete_page', async jwt => {
    if (id === undefined && path === undefined) {
      return fail('Provide "path" (preferred) or "id" to identify the page to delete.')
    }
    // Resolve before destroying: an id that addresses a page other than the
    // intended one deletes that other page silently. Resolving first names
    // the victim in the result, and lets an id+path pair cross-check itself.
    const found = await lookupPage(deps, jwt, id !== undefined ? { id, locale } : { path, locale })
    if ('error' in found) return found.error
    const target = found.page
    if (id !== undefined && path !== undefined) {
      const wanted = path.replace(/^\/+/, '')
      if (target.path.toLowerCase() !== wanted.toLowerCase()) {
        return fail(
          `Refusing to delete: id ${id} is "${target.path}", not "${wanted}". ` +
          `${ID_PROVENANCE_HINT} Re-run with only the path if that is the page you meant.`)
      }
    }
    const data = await deps.wikiClient.graphql<{ pages: { delete: MutationResponse } }>(
      `mutation ($id: Int!) {
        pages { delete(id: $id) { responseResult { succeeded errorCode slug message } } }
      }`, { id: target.id }, jwt)
    const res = data.pages.delete
    if (!res.responseResult.succeeded) return mutationFail(res.responseResult)
    return ok({ deleted: true, id: target.id, path: target.path, locale: target.locale })
  }))
}
