#!/usr/bin/env node
// Seeds the ISOLATED dev Wiki.js stand with a reproducible ACL fixture:
//
//   admin@example.com  (Administrators)
//   john@example.com   (Engineering)  — no access to /management/*
//   kate@example.com   (Management)   — access to everything
//
//   /engineering/onboarding  — readable by both
//   /management/salaries     — readable by Management only
//
// Idempotent: safe to re-run. DEV CREDENTIALS ONLY — never point this
// script at a production Wiki.js.

import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WIKI_URL = process.env.WIKI_URL ?? 'http://127.0.0.1:3000'
const KEYS_DIR = process.env.MCP_KEYS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'keys')

export const DELEGATION = {
  strategyKey: 'mcpdelegation',
  audience: 'urn:wikijs:mcp-delegation',
  issuer: 'urn:wikijs-mcp-google-auth',
  providerPriority: 'google,oidc,local,mcpdelegation',
  maxTokenAge: 120
}
const ADMIN_EMAIL = process.env.WIKI_ADMIN_EMAIL ?? 'admin@example.com'
const ADMIN_PASS = process.env.WIKI_ADMIN_PASS ?? 'admin1234!'

export const FIXTURE = {
  users: {
    john: { email: 'john@example.com', name: 'John Doe', password: 'john1234!', group: 'Engineering' },
    kate: { email: 'kate@example.com', name: 'Kate Roe', password: 'kate1234!', group: 'Management' }
  },
  pages: {
    onboarding: {
      path: 'engineering/onboarding',
      title: 'Engineering Onboarding',
      content: '# Engineering Onboarding\n\nWelcome to the engineering team. Setup instructions live here.',
      description: 'How to get started in engineering'
    },
    salaries: {
      path: 'management/salaries',
      title: 'Salaries 2026',
      content: '# Salaries 2026\n\nCONFIDENTIAL: salary bands for all departments.',
      description: 'Confidential salary information'
    }
  }
}

const PAGE_ROLES = ['read:pages', 'write:pages', 'manage:pages', 'delete:pages']
const GROUPS = {
  Engineering: {
    permissions: [...PAGE_ROLES, 'read:assets', 'read:comments', 'write:comments'],
    pageRules: [
      { id: 'eng-all', deny: false, match: 'START', roles: PAGE_ROLES, path: '', locales: [] },
      { id: 'eng-deny-mgmt', deny: true, match: 'START', roles: PAGE_ROLES, path: 'management', locales: [] }
    ]
  },
  Management: {
    permissions: [...PAGE_ROLES, 'read:assets', 'read:comments', 'write:comments'],
    pageRules: [
      { id: 'mgmt-all', deny: false, match: 'START', roles: PAGE_ROLES, path: '', locales: [] }
    ]
  }
}

async function gql (query, variables = {}, jwt = null) {
  const res = await fetch(`${WIKI_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
    },
    body: JSON.stringify({ query, variables })
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON GraphQL response (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors.map(e => e.message).join('; ')}`)
  }
  return body.data
}

async function waitFor (fn, { label, timeoutMs = 180_000, intervalMs = 3000 }) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, intervalMs))
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastErr?.message}`)
}

async function login (username, password, strategy = 'local') {
  const data = await gql(`
    mutation ($username: String!, $password: String!, $strategy: String!) {
      authentication {
        login(username: $username, password: $password, strategy: $strategy) {
          responseResult { succeeded errorCode slug message }
          jwt
        }
      }
    }`, { username, password, strategy })
  const result = data.authentication.login
  if (!result.responseResult.succeeded || !result.jwt) {
    throw new Error(`Login failed for ${username}: ${result.responseResult.message}`)
  }
  return result.jwt
}

async function isSetupMode () {
  const res = await fetch(`${WIKI_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' })
  })
  // In setup mode /graphql does not exist and returns the setup HTML page / 404.
  if (!res.ok) return true
  const text = await res.text()
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

async function finalize () {
  console.log('Wiki.js is in setup mode — finalizing...')
  const res = await fetch(`${WIKI_URL}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASS,
      adminPasswordConfirm: ADMIN_PASS,
      siteUrl: WIKI_URL,
      telemetry: false
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok !== true) {
    throw new Error(`Finalize failed (HTTP ${res.status}): ${JSON.stringify(body)}`)
  }
  console.log('Finalize accepted, waiting for Wiki.js to restart...')
}

async function ensureGroups (adminJwt) {
  const data = await gql('{ groups { list { id name } } }', {}, adminJwt)
  const existing = new Map(data.groups.list.map(g => [g.name, g.id]))
  const ids = {}
  for (const [name, cfg] of Object.entries(GROUPS)) {
    let id = existing.get(name)
    if (!id) {
      const created = await gql(`
        mutation ($name: String!) {
          groups { create(name: $name) {
            responseResult { succeeded message }
            group { id }
          } }
        }`, { name }, adminJwt)
      if (!created.groups.create.responseResult.succeeded) {
        throw new Error(`Group create failed: ${created.groups.create.responseResult.message}`)
      }
      id = created.groups.create.group.id
      console.log(`Created group ${name} (#${id})`)
    }
    const updated = await gql(`
      mutation ($id: Int!, $name: String!, $redirectOnLogin: String!, $permissions: [String]!, $pageRules: [PageRuleInput]!) {
        groups { update(id: $id, name: $name, redirectOnLogin: $redirectOnLogin, permissions: $permissions, pageRules: $pageRules) {
          responseResult { succeeded message }
        } }
      }`, {
      id,
      name,
      redirectOnLogin: '/',
      permissions: cfg.permissions,
      pageRules: cfg.pageRules
    }, adminJwt)
    if (!updated.groups.update.responseResult.succeeded) {
      throw new Error(`Group update failed for ${name}: ${updated.groups.update.responseResult.message}`)
    }
    console.log(`Group ${name} (#${id}) permissions/pageRules ensured`)
    ids[name] = id
  }
  return ids
}

async function ensureUsers (adminJwt, groupIds) {
  const data = await gql('{ users { list { id email } } }', {}, adminJwt)
  const existing = new Map(data.users.list.map(u => [u.email.toLowerCase(), u.id]))
  for (const user of Object.values(FIXTURE.users)) {
    if (existing.has(user.email)) {
      console.log(`User ${user.email} already exists`)
      continue
    }
    const created = await gql(`
      mutation ($email: String!, $name: String!, $passwordRaw: String, $providerKey: String!, $groups: [Int]!, $mustChangePassword: Boolean, $sendWelcomeEmail: Boolean) {
        users { create(email: $email, name: $name, passwordRaw: $passwordRaw, providerKey: $providerKey, groups: $groups, mustChangePassword: $mustChangePassword, sendWelcomeEmail: $sendWelcomeEmail) {
          responseResult { succeeded message }
          user { id }
        } }
      }`, {
      email: user.email,
      name: user.name,
      passwordRaw: user.password,
      providerKey: 'local',
      groups: [groupIds[user.group]],
      mustChangePassword: false,
      sendWelcomeEmail: false
    }, adminJwt)
    if (!created.users.create.responseResult.succeeded) {
      throw new Error(`User create failed for ${user.email}: ${created.users.create.responseResult.message}`)
    }
    console.log(`Created user ${user.email} in ${user.group}`)
  }
}

async function ensurePages (adminJwt) {
  const data = await gql('{ pages { list { id path } } }', {}, adminJwt)
  const existing = new Set(data.pages.list.map(p => p.path))
  for (const page of Object.values(FIXTURE.pages)) {
    if (existing.has(page.path)) {
      console.log(`Page /${page.path} already exists`)
      continue
    }
    const created = await gql(`
      mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
        pages { create(content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags, title: $title) {
          responseResult { succeeded message }
          page { id path }
        } }
      }`, {
      content: page.content,
      description: page.description,
      editor: 'markdown',
      isPublished: true,
      isPrivate: false,
      locale: 'en',
      path: page.path,
      tags: [],
      title: page.title
    }, adminJwt)
    if (!created.pages.create.responseResult.succeeded) {
      throw new Error(`Page create failed for /${page.path}: ${created.pages.create.responseResult.message}`)
    }
    console.log(`Created page /${page.path}`)
  }
}

// Dev-only RSA keypair for MCP assertion signing. In production, generate
// keys yourself and configure them explicitly (see README).
export function ensureKeys () {
  const privPath = path.join(KEYS_DIR, 'mcp-assertion-key.pem')
  const pubPath = path.join(KEYS_DIR, 'mcp-assertion-key.pub.pem')
  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true })
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    fs.writeFileSync(privPath, privateKey, { mode: 0o600 })
    fs.writeFileSync(pubPath, publicKey)
    console.log(`Generated dev RSA keypair in ${KEYS_DIR}`)
  }
  return {
    privateKey: fs.readFileSync(privPath, 'utf8'),
    publicKey: fs.readFileSync(pubPath, 'utf8'),
    privPath,
    pubPath
  }
}

async function ensureDelegationStrategy (adminJwt, publicKey) {
  const data = await gql(`
    { authentication { activeStrategies(enabledOnly: false) {
      key
      strategy { key }
      displayName
      order
      isEnabled
      config { key value }
      selfRegistration
      domainWhitelist
      autoEnrollGroups
    } } }`, {}, adminJwt)

  // updateStrategies REPLACES the full set (it deletes strategies missing
  // from the input), so re-send every existing strategy along with ours.
  // activeStrategies returns config values as {..., "value": x} while
  // updateStrategies expects {"v": x} — convert accordingly.
  const strategies = data.authentication.activeStrategies
    .filter(s => s.key !== DELEGATION.strategyKey)
    .map(s => ({
      key: s.key,
      strategyKey: s.strategy.key,
      displayName: s.displayName,
      order: s.order,
      isEnabled: s.isEnabled,
      config: (s.config ?? []).map(({ key, value }) => ({
        key,
        value: JSON.stringify({ v: JSON.parse(value).value })
      })),
      selfRegistration: s.selfRegistration,
      domainWhitelist: s.domainWhitelist ?? [],
      autoEnrollGroups: s.autoEnrollGroups ?? []
    }))

  strategies.push({
    key: DELEGATION.strategyKey,
    strategyKey: DELEGATION.strategyKey,
    displayName: 'MCP Delegation',
    order: strategies.length,
    isEnabled: true,
    config: [
      { key: 'publicKey', value: JSON.stringify({ v: publicKey }) },
      { key: 'audience', value: JSON.stringify({ v: DELEGATION.audience }) },
      { key: 'issuer', value: JSON.stringify({ v: DELEGATION.issuer }) },
      { key: 'providerPriority', value: JSON.stringify({ v: DELEGATION.providerPriority }) },
      { key: 'maxTokenAge', value: JSON.stringify({ v: DELEGATION.maxTokenAge }) }
    ],
    selfRegistration: false,
    domainWhitelist: [],
    autoEnrollGroups: []
  })

  const res = await gql(`
    mutation ($strategies: [AuthenticationStrategyInput]!) {
      authentication { updateStrategies(strategies: $strategies) {
        responseResult { succeeded message }
      } }
    }`, { strategies }, adminJwt)
  const rr = res.authentication.updateStrategies.responseResult
  if (!rr.succeeded) {
    throw new Error(`updateStrategies failed: ${rr.message}`)
  }
  console.log('Delegation strategy "mcpdelegation" registered/updated')
}

export async function seed () {
  // Any HTTP response at all means the server is up. In setup mode without
  // built client assets GET / may legitimately return 500.
  await waitFor(async () => {
    await fetch(`${WIKI_URL}/`)
  }, { label: 'Wiki.js HTTP' })

  if (await isSetupMode()) {
    await finalize()
  }

  const adminJwt = await waitFor(() => login(ADMIN_EMAIL, ADMIN_PASS), { label: 'admin login' })
  console.log('Admin login OK')

  const groupIds = await ensureGroups(adminJwt)
  await ensureUsers(adminJwt, groupIds)
  await ensurePages(adminJwt)
  const keys = ensureKeys()
  await ensureDelegationStrategy(adminJwt, keys.publicKey)
  console.log('Seed complete.')
  return { adminJwt, groupIds, keys }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isMain) {
  seed().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
