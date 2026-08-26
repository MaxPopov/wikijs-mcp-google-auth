#!/usr/bin/env node
import pino from 'pino'
import { loadServerSettings, loadWikijsSettings } from './config.js'
import { loadGoogleSettings, GoogleOIDC } from './oauth/google.js'
import { GoogleBackedOAuthProvider } from './oauth/provider.js'
import { FileStore, MemoryStore } from './store/store.js'
import { AssertionSigner } from './wikijs/assertion.js'
import { WikijsClient } from './wikijs/client.js'
import { WikijsTokenBroker } from './wikijs/broker.js'
import { createApp } from './server.js'

export const VERSION = '0.2.0'

export function main (): void {
  const settings = loadServerSettings()
  const wikijs = loadWikijsSettings()
  const google = loadGoogleSettings()

  const logger = pino({ level: settings.logLevel })
  const store = settings.sessionStoreFile
    ? new FileStore(settings.sessionStoreFile)
    : new MemoryStore()

  const wikiClient = new WikijsClient(wikijs.url)
  const signer = new AssertionSigner({
    privateKeyPem: wikijs.assertionPrivateKeyPem,
    issuer: wikijs.assertionIssuer,
    audience: wikijs.assertionAudience,
    ttlSeconds: wikijs.assertionTtlSeconds
  })
  const broker = new WikijsTokenBroker(wikiClient, signer, wikijs.strategyKey)

  const provider = new GoogleBackedOAuthProvider(store, new GoogleOIDC(google), {
    publicUrl: settings.publicUrl,
    accessTokenTtlSeconds: settings.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: settings.refreshTokenTtlSeconds,
    onLogin: identity => logger.info({ email: identity.email }, 'user authenticated via Google'),
    onRevokeSession: session => {
      broker.invalidate(session.sub)
      logger.info({ email: session.email }, 'session revoked')
    }
  })

  const app = createApp({
    publicUrl: settings.publicUrl,
    provider,
    mcpDeps: {
      broker,
      wikiClient,
      audit: event => logger.info({ audit: event }, 'tool call')
    }
  })

  const server = app.listen(settings.port, () => {
    logger.info({ port: settings.port, publicUrl: settings.publicUrl, wikijs: wikijs.url }, 'wikijs-mcp server started')
  })

  const shutdown = (): void => {
    logger.info('shutting down')
    server.close(() => {
      if (store instanceof FileStore) store.flush()
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')
if (isMain) {
  main()
}
