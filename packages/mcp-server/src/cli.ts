#!/usr/bin/env node
// Dev/ops utility for the delegation flow, e.g.:
//
//   MCP_ASSERTION_PRIVATE_KEY_FILE=deploy/keys/mcp-assertion-key.pem \
//     npm run cli -w @wikijs-mcp/server -- login john@example.com
//
// Prints the native Wiki.js JWT and its decoded claims, proving the
// whole Google-identity -> Wiki.js JWT delegation path works.

import { decodeJwt } from 'jose'
import { loadWikijsSettings } from './config.js'
import { AssertionSigner } from './wikijs/assertion.js'
import { WikijsClient } from './wikijs/client.js'
import { WikijsTokenBroker } from './wikijs/broker.js'

async function main (): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command !== 'login' || rest.length < 1) {
    console.error('Usage: cli login <email> [sub]')
    process.exit(2)
  }
  const email = rest[0]!
  const sub = rest[1] ?? `dev-sub:${email}`

  const settings = loadWikijsSettings()
  const client = new WikijsClient(settings.url)
  const signer = new AssertionSigner({
    privateKeyPem: settings.assertionPrivateKeyPem,
    issuer: settings.assertionIssuer,
    audience: settings.assertionAudience,
    ttlSeconds: settings.assertionTtlSeconds
  })
  const broker = new WikijsTokenBroker(client, signer, settings.strategyKey)

  const jwt = await broker.getToken({ sub, email })
  console.log('Wiki.js JWT obtained via delegation:\n')
  console.log(jwt)
  console.log('\nDecoded claims:')
  console.log(JSON.stringify(decodeJwt(jwt), null, 2))
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
