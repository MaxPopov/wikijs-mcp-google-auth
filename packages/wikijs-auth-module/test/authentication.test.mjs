import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

const CONF = {
  key: 'mcpdelegation',
  publicKey,
  audience: 'urn:wikijs:mcp-delegation',
  issuer: 'urn:wikijs-mcp-google-auth',
  providerPriority: 'google,local,mcpdelegation',
  maxTokenAge: 120
}

class FakeAuthError extends Error {}

function makeWiki ({ users = [], processProfile } = {}) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    Error: {
      AuthLoginFailed: class AuthLoginFailed extends FakeAuthError {},
      AuthAccountBanned: class AuthAccountBanned extends FakeAuthError {},
      AuthAccountNotVerified: class AuthAccountNotVerified extends FakeAuthError {},
      AuthRegistrationDisabled: class AuthRegistrationDisabled extends FakeAuthError {}
    },
    auth: {
      strategies: {
        local: { strategyKey: 'local' },
        'google-instance-uuid': { strategyKey: 'google' },
        mcpdelegation: { strategyKey: 'mcpdelegation' }
      }
    },
    models: {
      users: {
        query: () => ({
          findOne: async filter => users.find(
            u => u.email === filter.email && u.providerKey === filter.providerKey
          ) ?? null
        }),
        processProfile: processProfile ?? (async () => { throw new globalThis.WIKI.Error.AuthRegistrationDisabled() })
      }
    }
  }
}

function signAssertion (claims = {}, { key = privateKey, ...opts } = {}) {
  const { expiresIn = '60s', ...jwtOpts } = opts
  const { sub, ...payloadClaims } = claims
  return jwt.sign({
    email: 'john@example.com',
    jti: randomUUID(),
    ...payloadClaims
  }, key, {
    algorithm: 'RS256',
    subject: sub ?? 'google-sub-john',
    audience: CONF.audience,
    issuer: CONF.issuer,
    expiresIn,
    ...jwtOpts
  })
}

// Drives the passport strategy exactly like Wiki.js users.login() does.
function authenticate (strategy, email, assertion) {
  return new Promise((resolve, reject) => {
    const instance = Object.create(strategy)
    instance.success = user => resolve({ outcome: 'success', user })
    instance.fail = () => resolve({ outcome: 'fail' })
    instance.error = err => resolve({ outcome: 'error', err })
    instance.authenticate({ body: { email, password: assertion } })
    setTimeout(() => reject(new Error('authenticate() never settled')), 5000)
  })
}

function loadStrategy (conf = CONF) {
  let strategy
  const passport = { use: (_name, stg) => { strategy = stg } }
  const modPath = require.resolve('../authentication.js')
  delete require.cache[modPath]
  require(modPath).init(passport, conf)
  return strategy
}

const JOHN = {
  id: 2,
  email: 'john@example.com',
  providerKey: 'local',
  isSystem: false,
  isActive: true,
  isVerified: true
}

describe('mcpdelegation authentication module', () => {
  beforeEach(() => {
    globalThis.WIKI = makeWiki({ users: [JOHN] })
  })

  it('accepts a valid assertion and returns the matched user', async () => {
    const res = await authenticate(loadStrategy(), 'john@example.com', signAssertion())
    expect(res.outcome).toBe('success')
    expect(res.user.id).toBe(2)
  })

  it('resolves module keys in providerPriority to instance keys', async () => {
    globalThis.WIKI = makeWiki({
      users: [{ ...JOHN, providerKey: 'google-instance-uuid' }]
    })
    const res = await authenticate(loadStrategy(), 'john@example.com', signAssertion())
    expect(res.outcome).toBe('success')
    expect(res.user.providerKey).toBe('google-instance-uuid')
  })

  it('rejects an assertion signed with the wrong key', async () => {
    const res = await authenticate(loadStrategy(), 'john@example.com', signAssertion({}, { key: wrongPrivateKey }))
    expect(res.outcome).toBe('error')
    expect(res.err).toBeInstanceOf(globalThis.WIKI.Error.AuthLoginFailed)
  })

  it('rejects a wrong audience', async () => {
    const res = await authenticate(loadStrategy(), 'john@example.com',
      signAssertion({}, { audience: 'urn:other' }))
    expect(res.outcome).toBe('error')
  })

  it('rejects an expired assertion', async () => {
    const res = await authenticate(loadStrategy(), 'john@example.com',
      signAssertion({}, { expiresIn: '-60s' }))
    expect(res.outcome).toBe('error')
  })

  it('rejects an assertion older than maxTokenAge even with a far-future exp', async () => {
    const past = Math.floor(Date.now() / 1000) - 600
    const token = jwt.sign({
      email: 'john@example.com',
      jti: randomUUID(),
      iat: past,
      exp: past + 3600
    }, privateKey, {
      algorithm: 'RS256',
      subject: 'google-sub-john',
      audience: CONF.audience,
      issuer: CONF.issuer
    })
    const res = await authenticate(loadStrategy(), 'john@example.com', token)
    expect(res.outcome).toBe('error')
  })

  it('rejects a replayed jti', async () => {
    const strategy = loadStrategy()
    const assertion = signAssertion()
    const first = await authenticate(strategy, 'john@example.com', assertion)
    expect(first.outcome).toBe('success')
    const replay = await authenticate(strategy, 'john@example.com', assertion)
    expect(replay.outcome).toBe('error')
  })

  it('rejects when the email claim does not match the login username', async () => {
    const res = await authenticate(loadStrategy(), 'kate@example.com', signAssertion())
    expect(res.outcome).toBe('error')
  })

  it('rejects a banned user with AuthAccountBanned', async () => {
    globalThis.WIKI = makeWiki({ users: [{ ...JOHN, isActive: false }] })
    const res = await authenticate(loadStrategy(), 'john@example.com', signAssertion())
    expect(res.outcome).toBe('error')
    expect(res.err).toBeInstanceOf(globalThis.WIKI.Error.AuthAccountBanned)
  })

  it('rejects system accounts', async () => {
    globalThis.WIKI = makeWiki({ users: [{ ...JOHN, isSystem: true }] })
    const res = await authenticate(loadStrategy(), 'john@example.com', signAssertion())
    expect(res.outcome).toBe('error')
  })

  it('falls back to processProfile for unknown users (self-registration)', async () => {
    const created = { id: 99, email: 'new@example.com' }
    globalThis.WIKI = makeWiki({
      users: [],
      processProfile: async ({ profile, providerKey }) => {
        expect(providerKey).toBe('mcpdelegation')
        expect(profile.email).toBe('new@example.com')
        return created
      }
    })
    const res = await authenticate(loadStrategy(), 'new@example.com',
      signAssertion({ email: 'new@example.com', sub: 'google-sub-new' }))
    expect(res.outcome).toBe('success')
    expect(res.user.id).toBe(99)
  })

  it('propagates AuthRegistrationDisabled when self-registration is off', async () => {
    globalThis.WIKI = makeWiki({ users: [] })
    const res = await authenticate(loadStrategy(), 'stranger@example.com',
      signAssertion({ email: 'stranger@example.com' }))
    expect(res.outcome).toBe('error')
    expect(res.err).toBeInstanceOf(globalThis.WIKI.Error.AuthRegistrationDisabled)
  })

  it('rejects everything when no public key is configured', async () => {
    const res = await authenticate(loadStrategy({ ...CONF, publicKey: '' }), 'john@example.com', signAssertion())
    expect(res.outcome).toBe('error')
  })
})
