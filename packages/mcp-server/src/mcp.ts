import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { decodeJwt } from 'jose'
import type { WikijsTokenBroker, DelegatedIdentity } from './wikijs/broker.js'
import type { WikijsClient } from './wikijs/client.js'
import { registerWikiTools } from './tools/wiki.js'

export interface McpDeps {
  broker: WikijsTokenBroker
  wikiClient: WikijsClient
}

export class NotAuthenticatedError extends Error {
  constructor () {
    super('Request is not authenticated')
  }
}

/** Extracts the delegated Google identity attached by the OAuth layer. */
export function identityFromAuthInfo (authInfo: AuthInfo | undefined): DelegatedIdentity {
  const extra = authInfo?.extra
  const sub = typeof extra?.sub === 'string' ? extra.sub : ''
  const email = typeof extra?.email === 'string' ? extra.email : ''
  if (!sub || !email) {
    throw new NotAuthenticatedError()
  }
  return {
    sub,
    email,
    name: typeof extra?.name === 'string' ? extra.name : undefined
  }
}

/**
 * Builds a per-request MCP server instance. Cheap to construct — the
 * expensive state (token broker cache, OAuth store) lives in deps.
 */
export function buildMcpServer (deps: McpDeps): McpServer {
  const server = new McpServer({
    name: 'wikijs-mcp',
    version: '0.1.0'
  })

  server.registerTool('whoami', {
    title: 'Who am I',
    description: 'Shows the authenticated user identity and their Wiki.js account: groups and global permissions. Useful to diagnose access issues.',
    inputSchema: {}
  }, async (_args, extra) => {
    const identity = identityFromAuthInfo(extra.authInfo)
    const jwt = await deps.broker.getToken(identity)
    const claims = decodeJwt(jwt) as {
      id?: number
      email?: string
      name?: string
      groups?: number[]
      permissions?: string[]
    }
    let groupNames: string[] | undefined
    try {
      const data = await deps.wikiClient.graphql<{ users: { profile: { groups: string[] } } }>(
        '{ users { profile { groups } } }', {}, jwt)
      groupNames = data.users.profile.groups
    } catch {
      // Group names are cosmetic; JWT group ids are still reported.
    }
    const result = {
      identity: { email: identity.email, sub: identity.sub, name: identity.name },
      wikijs: {
        userId: claims.id,
        email: claims.email,
        name: claims.name,
        groups: groupNames ?? claims.groups,
        permissions: claims.permissions
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  registerWikiTools(server, deps)

  return server
}
