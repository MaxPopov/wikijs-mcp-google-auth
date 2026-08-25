/**
 * Thin Wiki.js GraphQL client. No authorization logic lives here —
 * every request runs under the caller's Wiki.js JWT and Wiki.js itself
 * decides what is allowed.
 */

export class WikijsGraphQLError extends Error {
  constructor (
    message: string,
    readonly errorCode?: number,
    readonly slug?: string
  ) {
    super(message)
    this.name = 'WikijsGraphQLError'
  }
}

/** Thrown when responseResult.succeeded === false on a mutation. */
export class WikijsOperationError extends WikijsGraphQLError {
  override name = 'WikijsOperationError'
}

export interface ResponseResult {
  succeeded: boolean
  errorCode: number
  slug: string
  message: string
}

/**
 * Returns how many seconds to wait before retrying, when the error is
 * the Wiki.js login rate limit ("Too many requests, please try again in
 * N seconds."); null for any other error.
 */
export function rateLimitRetryDelay (err: unknown): number | null {
  if (!(err instanceof WikijsGraphQLError)) return null
  const match = /too many requests.*?(\d+)\s*seconds/i.exec(err.message)
  if (!match) return null
  return Math.min(Number(match[1]) + 1, 90)
}

export class WikijsClient {
  constructor (readonly baseUrl: string) {}

  async graphql<T = Record<string, unknown>> (
    query: string,
    variables: Record<string, unknown> = {},
    jwt?: string
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
        },
        body: JSON.stringify({ query, variables })
      })
    } catch (err) {
      throw new WikijsGraphQLError(`Wiki.js is unreachable at ${this.baseUrl}: ${(err as Error).message}`)
    }
    const text = await res.text()
    let body: { data?: T, errors?: Array<{ message: string }> }
    try {
      body = JSON.parse(text)
    } catch {
      throw new WikijsGraphQLError(`Wiki.js returned a non-GraphQL response (HTTP ${res.status})`)
    }
    if (body.errors?.length) {
      throw new WikijsGraphQLError(body.errors.map(e => e.message).join('; '))
    }
    if (!body.data) {
      throw new WikijsGraphQLError('Wiki.js returned an empty GraphQL response')
    }
    return body.data
  }

  /**
   * Exchange a signed delegation assertion for a NATIVE Wiki.js JWT via
   * the standard login mutation and the `mcpdelegation` strategy.
   *
   * NOTE: Wiki.js rate-limits the login mutation to 5 calls/minute PER
   * SOURCE IP — and every delegation login originates from this MCP
   * server's IP. The token broker caches JWTs to keep the login rate
   * low and retries with a freshly signed assertion when the limit is
   * hit (see WikijsTokenBroker and rateLimitRetryDelay below).
   */
  async loginDelegation (strategyKey: string, email: string, assertion: string): Promise<string> {
    const data = await this.graphql<{
      authentication: {
        login: {
          responseResult: ResponseResult
          jwt: string | null
          mustChangePwd: boolean | null
          mustProvideTFA: boolean | null
        }
      }
    }>(`
      mutation ($username: String!, $password: String!, $strategy: String!) {
        authentication {
          login(username: $username, password: $password, strategy: $strategy) {
            responseResult { succeeded errorCode slug message }
            jwt
            mustChangePwd
            mustProvideTFA
          }
        }
      }`, { username: email, password: assertion, strategy: strategyKey })

    const login = data.authentication.login
    if (!login.responseResult.succeeded) {
      throw new WikijsOperationError(
        `Delegation login failed: ${login.responseResult.message}`,
        login.responseResult.errorCode,
        login.responseResult.slug
      )
    }
    if (login.mustProvideTFA) {
      throw new WikijsOperationError('This Wiki.js account requires TFA, which is not supported for MCP delegation. Disable TFA for this account or use a different one.')
    }
    if (login.mustChangePwd) {
      throw new WikijsOperationError('This Wiki.js account requires a password change before it can be used.')
    }
    if (!login.jwt) {
      throw new WikijsOperationError('Delegation login returned no JWT')
    }
    return login.jwt
  }
}
