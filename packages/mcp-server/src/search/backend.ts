import type { WikijsClient } from '../wikijs/client.js'

export interface SearchResultItem {
  /**
   * Opaque, backend-specific reference — NOT a Wiki.js page id.
   *
   * Wiki.js `pages.search` fills this from the ACTIVE SEARCH INDEX, and
   * only the `db` engine happens to index the real `pages.id`: the
   * `postgres` engine returns the `pagesVector` row id (its own
   * sequence) and elasticsearch/algolia/solr return `page.hash`. Feeding
   * it to `get_page(id:)` therefore addresses an unrelated page.
   * Never surface it to the model as a page id — search results are
   * addressed by `path` + `locale`.
   */
  ref: string
  title: string
  description: string
  path: string
  locale: string
}

export interface SearchResponse {
  totalHits: number
  results: SearchResultItem[]
  suggestions: string[]
}

/**
 * Retrieval backend contract for the `search_wiki` tool.
 *
 * The context carries the CALLER'S native Wiki.js JWT: every backend —
 * including the future RAG service — must perform retrieval under that
 * user's authority so Wiki.js stays the single source of truth for ACL.
 * See docs/rag-integration.md.
 */
export interface SearchBackend {
  search (query: string, ctx: { wikijsJwt: string, locale?: string }): Promise<SearchResponse>
}

/** v1 backend: Wiki.js built-in search (ACL-filtered by Wiki.js itself). */
export class WikijsNativeSearch implements SearchBackend {
  constructor (private readonly client: WikijsClient) {}

  async search (query: string, ctx: { wikijsJwt: string, locale?: string }): Promise<SearchResponse> {
    const data = await this.client.graphql<{
      pages: { search: Omit<SearchResponse, 'results'> & { results: Array<Omit<SearchResultItem, 'ref'> & { id: string }> } }
    }>(`
      query ($q: String!, $locale: String) {
        pages { search(query: $q, locale: $locale) {
          results { id title description path locale }
          suggestions
          totalHits
        } }
      }`, { q: query, locale: ctx.locale ?? null }, ctx.wikijsJwt)
    const search = data.pages.search
    return {
      ...search,
      results: search.results.map(({ id, ...rest }) => ({ ...rest, ref: id }))
    }
  }
}
