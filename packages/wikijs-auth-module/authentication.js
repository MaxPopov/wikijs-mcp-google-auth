/* global WIKI */

// ------------------------------------
// MCP Delegation Authentication
// ------------------------------------
//
// Server-to-server delegation strategy for the Wiki.js MCP layer.
//
// The MCP server authenticates the end user against Google Workspace,
// then calls the standard GraphQL login mutation with:
//
//   username = user email
//   password = short-lived RS256 JWT assertion signed by the MCP server
//
// This strategy verifies the assertion (signature, issuer, audience,
// expiry, age, replay), resolves the Wiki.js user by email across the
// configured provider priority list, and returns that user. The regular
// Wiki.js auth flow then issues a NATIVE Wiki.js JWT via refreshToken(),
// so all authorization stays inside Wiki.js.
//
// Uses only dependencies bundled with Wiki.js itself (jsonwebtoken).

const jwt = require('jsonwebtoken')

// Replay protection: jti values of accepted assertions, kept until expiry.
// Single-instance in-memory cache — assertions are short-lived (<= maxTokenAge).
const seenJti = new Map()

function pruneSeenJti () {
  const now = Math.floor(Date.now() / 1000)
  for (const [jti, exp] of seenJti.entries()) {
    if (exp <= now) {
      seenJti.delete(jti)
    }
  }
}

// Minimal Passport strategy. Passport decorates the instance with
// success() / fail() / error() before calling authenticate().
class MCPDelegationStrategy {
  constructor (name, verify) {
    this.name = name
    this._verify = verify
  }

  authenticate (req) {
    Promise.resolve()
      .then(() => this._verify(req))
      .then(user => {
        if (user) {
          this.success(user)
        } else {
          this.fail()
        }
      })
      .catch(err => this.error(err))
  }
}

// Resolve providerPriority entries (instance keys OR module keys) to the
// ordered list of strategy instance keys to search users under.
function resolveProviderKeys (providerPriority) {
  const entries = String(providerPriority || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const keys = []
  for (const entry of entries) {
    for (const [instanceKey, stg] of Object.entries(WIKI.auth.strategies || {})) {
      if ((instanceKey === entry || stg.strategyKey === entry) && !keys.includes(instanceKey)) {
        keys.push(instanceKey)
      }
    }
  }
  return keys
}

async function verifyDelegation (req, conf) {
  const email = String(req.body.email || '').trim().toLowerCase()
  const assertion = String(req.body.password || '')

  if (!conf.publicKey || !String(conf.publicKey).includes('PUBLIC KEY')) {
    WIKI.logger.warn('(MCPDELEGATION) Strategy is not configured: missing assertion public key.')
    throw new WIKI.Error.AuthLoginFailed()
  }
  if (!email || !assertion) {
    throw new WIKI.Error.AuthLoginFailed()
  }

  // 1. Verify the assertion cryptographically and structurally.
  let payload
  try {
    payload = jwt.verify(assertion, conf.publicKey, {
      algorithms: ['RS256'],
      audience: conf.audience,
      issuer: conf.issuer,
      maxAge: Number(conf.maxTokenAge) > 0 ? Number(conf.maxTokenAge) : 120,
      clockTolerance: 10
    })
  } catch (err) {
    WIKI.logger.warn(`(MCPDELEGATION) Assertion rejected: ${err.message}`)
    throw new WIKI.Error.AuthLoginFailed()
  }
  if (!payload.exp || !payload.jti || !payload.sub || !payload.email) {
    WIKI.logger.warn('(MCPDELEGATION) Assertion rejected: missing required claims (exp, jti, sub, email).')
    throw new WIKI.Error.AuthLoginFailed()
  }
  if (String(payload.email).trim().toLowerCase() !== email) {
    WIKI.logger.warn('(MCPDELEGATION) Assertion rejected: email claim does not match login username.')
    throw new WIKI.Error.AuthLoginFailed()
  }

  // 2. Replay protection.
  pruneSeenJti()
  if (seenJti.has(payload.jti)) {
    WIKI.logger.warn('(MCPDELEGATION) Assertion rejected: replayed jti.')
    throw new WIKI.Error.AuthLoginFailed()
  }
  seenJti.set(payload.jti, payload.exp)

  // 3. Resolve the Wiki.js user by email across provider priority.
  const providerKeys = resolveProviderKeys(conf.providerPriority)
  let user = null
  for (const providerKey of providerKeys) {
    user = await WIKI.models.users.query().findOne({ email, providerKey })
    if (user) break
  }

  if (user) {
    if (user.isSystem) {
      WIKI.logger.warn(`(MCPDELEGATION) Rejected delegation for system account ${email}.`)
      throw new WIKI.Error.AuthLoginFailed()
    }
    if (!user.isActive) {
      throw new WIKI.Error.AuthAccountBanned()
    }
    if (!user.isVerified) {
      throw new WIKI.Error.AuthAccountNotVerified()
    }
    return user
  }

  // 4. Optional auto-provisioning under THIS strategy instance.
  //    processProfile() honors the instance's Self Registration settings
  //    (selfRegistration, domainWhitelist, autoEnrollGroups) and throws
  //    AuthRegistrationDisabled when self-registration is off.
  return WIKI.models.users.processProfile({
    profile: {
      id: payload.sub,
      email,
      displayName: payload.name || email.split('@')[0]
    },
    providerKey: conf.key
  })
}

module.exports = {
  init (passport, conf) {
    passport.use(conf.key,
      new MCPDelegationStrategy(conf.key, req => verifyDelegation(req, conf))
    )
  }
}
