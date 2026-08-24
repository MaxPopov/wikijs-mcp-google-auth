import type { WikijsClient } from '../wikijs/client.js'

export interface SearchResultItem {
  id: string
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
    const data = await this.client.graphql<{ pages: { search: SearchResponse } }>(`
      query ($q: String!, $locale: String) {
        pages { search(query: $q, locale: $locale) {
          results { id title description path locale }
          suggestions
          totalHits
        } }
      }`, { q: query, locale: ctx.locale ?? null }, ctx.wikijsJwt)
    return data.pages.search
  }
}
