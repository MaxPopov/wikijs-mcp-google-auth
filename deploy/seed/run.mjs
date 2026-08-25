#!/usr/bin/env node
// Explicit seed runner. Always invokes seed() regardless of how Node
// resolves the "main module" — the isMain guard in seed.mjs proved
// fragile on CI runners (it silently no-opped once, leaving the e2e key
// ungenerated). Used by CI and the docker-compose seed services.
import { seed } from './seed.mjs'

seed().catch(err => {
  console.error(err?.stack || err?.message || err)
  process.exit(1)
})
