import express, { type Express, type Request, type Response } from 'express'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { GoogleBackedOAuthProvider } from './oauth/provider.js'
import { buildMcpServer, type McpDeps } from './mcp.js'

export interface AppOptions {
  publicUrl: string
  provider: GoogleBackedOAuthProvider
  mcpDeps: McpDeps
  /** Max MCP requests per access token per minute (0 = unlimited). */
  mcpRateLimitPerMinute?: number
}

/** Small sliding-window limiter keyed by access token. */
function mcpRateLimiter (limitPerMinute: number) {
  const hits = new Map<string, number[]>()
  return (req: Request, res: Response, next: () => void): void => {
    const token = req.auth?.token ?? req.ip ?? 'anonymous'
    const now = Date.now()
    const windowStart = now - 60_000
    const list = (hits.get(token) ?? []).filter(t => t > windowStart)
    if (list.length >= limitPerMinute) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Rate limit exceeded, retry later' },
        id: null
      })
      return
    }
    list.push(now)
    hits.set(token, list)
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (!v.some(t => t > windowStart)) hits.delete(k)
      }
    }
    next()
  }
}

/**
 * Assembles the express app:
 *
 *   /.well-known/oauth-authorization-server   OAuth AS metadata
 *   /.well-known/oauth-protected-resource/mcp Protected-resource metadata
 *   /authorize /token /register /revoke       OAuth endpoints (SDK router)
 *   /oauth/google/callback                    Upstream Google redirect URI
 *   /mcp                                      Streamable HTTP MCP endpoint
 *   /healthz                                  Liveness probe
 */
export function createApp (opts: AppOptions): Express {
  const { publicUrl, provider, mcpDeps } = opts
  const app = express()
  // Trust exactly one hop (the TLS-terminating reverse proxy). `true`
  // would let clients spoof X-Forwarded-For and bypass IP rate limits.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    next()
  })

  // Minimal CORS for browser-based MCP clients (e.g. MCP Inspector).
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-protocol-version, mcp-session-id')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, WWW-Authenticate')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(publicUrl),
    resourceName: 'Wiki.js MCP',
    resourceServerUrl: new URL(`${publicUrl}/mcp`),
    scopesSupported: ['wikijs']
  }))

  app.get('/oauth/google/callback', (req, res) => {
    void provider.handleGoogleCallback(req, res)
  })

  app.post('/oauth/consent', express.urlencoded({ extended: false }), (req, res) => {
    provider.handleConsent(req, res)
  })

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`
  })

  const rateLimit = mcpRateLimiter(opts.mcpRateLimitPerMinute ?? 120)

  // Stateless Streamable HTTP: a fresh server+transport pair per request.
  app.post('/mcp', bearer, rateLimit, express.json({ limit: '4mb' }), (req: Request, res: Response) => {
    void (async () => {
      const server = buildMcpServer(mcpDeps)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    })().catch(err => {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal server error: ${(err as Error).message}` },
          id: null
        })
      }
    })
  })

  // Stateless mode has no server-initiated streams or sessions to manage.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null
    })
  }
  app.get('/mcp', bearer, methodNotAllowed)
  app.delete('/mcp', bearer, methodNotAllowed)

  return app
}
