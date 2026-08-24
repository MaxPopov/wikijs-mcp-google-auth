import { readFileSync } from 'node:fs'

export interface WikijsSettings {
  url: string
  strategyKey: string
  assertionPrivateKeyPem: string
  assertionIssuer: string
  assertionAudience: string
  assertionTtlSeconds: number
}

function env (name: string, fallback?: string): string {
  const v = process.env[name]
  if (v && v.length > 0) return v
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable ${name}`)
}

export interface ServerSettings {
  port: number
  publicUrl: string
  /** JSON file for OAuth/session state; empty = in-memory only. */
  sessionStoreFile: string
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
  logLevel: string
}

export function loadServerSettings (): ServerSettings {
  return {
    port: Number(env('PORT', '8000')),
    publicUrl: env('PUBLIC_URL').replace(/\/+$/, ''),
    sessionStoreFile: process.env.SESSION_STORE_FILE ?? '',
    accessTokenTtlSeconds: Number(env('ACCESS_TOKEN_TTL', '3600')),
    refreshTokenTtlSeconds: Number(env('REFRESH_TOKEN_TTL', String(30 * 24 * 3600))),
    logLevel: env('LOG_LEVEL', 'info')
  }
}

export function loadWikijsSettings (): WikijsSettings {
  let privateKeyPem = process.env.MCP_ASSERTION_PRIVATE_KEY ?? ''
  if (!privateKeyPem) {
    const file = env('MCP_ASSERTION_PRIVATE_KEY_FILE')
    privateKeyPem = readFileSync(file, 'utf8')
  }
  return {
    url: env('WIKIJS_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    strategyKey: env('WIKIJS_STRATEGY_KEY', 'mcpdelegation'),
    assertionPrivateKeyPem: privateKeyPem,
    assertionIssuer: env('MCP_ASSERTION_ISSUER', 'urn:wikijs-mcp-google-auth'),
    assertionAudience: env('MCP_ASSERTION_AUDIENCE', 'urn:wikijs:mcp-delegation'),
    assertionTtlSeconds: Number(env('MCP_ASSERTION_TTL', '60'))
  }
}
