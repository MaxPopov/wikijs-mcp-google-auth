#!/usr/bin/env node
// Standalone fake Google OIDC IdP — TEST ONLY.
//
// Stands in for Google Workspace in the e2e docker stack so Playwright
// can drive the whole browser login flow under different roles without
// touching real Google. It presents an actual HTML login page with one
// button per test user, then behaves like Google's OAuth/OIDC endpoints.
//
// Never deploy this. It is brought up only by docker-compose.e2e.yml.

import { randomUUID } from 'node:crypto'
import express from 'express'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const PORT = Number(process.env.PORT ?? 9000)
const ISSUER = (process.env.ISSUER ?? `http://localhost:${PORT}`).replace(/\/+$/, '')
const CLIENT_ID = process.env.CLIENT_ID ?? 'fake-google-client'
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? 'fake-google-secret'

// Test users. Roles/groups live in Wiki.js (seeded separately); the IdP
// only issues identity. Emails match deploy/seed/seed.mjs. "evil" is
// out-of-domain to exercise the hd (Workspace domain) check.
const USERS = JSON.parse(process.env.USERS_JSON ?? JSON.stringify([
  { key: 'john', sub: 'google-sub-john', email: 'john@example.com', name: 'John Doe', hd: 'example.com', label: 'John Doe — Engineering' },
  { key: 'kate', sub: 'google-sub-kate', email: 'kate@example.com', name: 'Kate Roe', hd: 'example.com', label: 'Kate Roe — Management' },
  { key: 'evil', sub: 'google-sub-evil', email: 'evil@evil.com', name: 'Mallory', hd: 'evil.com', label: 'Mallory — outside the Workspace domain' }
]))

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }

// Issued authorization codes: code -> { user, redirectUri }.
const codes = new Map()

const app = express()
app.use(express.urlencoded({ extended: false }))

app.get('/healthz', (_req, res) => res.json({ ok: true }))

app.get('/.well-known/openid-configuration', (_req, res) => {
  res.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256']
  })
})

app.get('/jwks', (_req, res) => res.json({ keys: [jwk] }))

// Login page with one button per test user.
app.get('/authorize', (req, res) => {
  const redirectUri = String(req.query.redirect_uri ?? '')
  const state = String(req.query.state ?? '')
  if (!redirectUri) {
    res.status(400).send('missing redirect_uri')
    return
  }
  const buttons = USERS.map(u => {
    const href = `/pick?user=${encodeURIComponent(u.key)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
    return `<a class="user" data-testid="login-${esc(u.key)}" href="${esc(href)}">${esc(u.label)}</a>`
  }).join('\n')
  res.status(200).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sign in (test IdP)</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}
h1{font-size:1.2rem}.user{display:block;padding:.8rem 1rem;margin:.5rem 0;border:1px solid #ccc;border-radius:8px;text-decoration:none;color:#1a1a1a}
.user:hover{background:#f2f6ff;border-color:#1971c2}.note{color:#888;font-size:.8rem;margin-top:1.5rem}</style></head>
<body><h1>Sign in (test identity provider)</h1>
<p>Choose a test account to continue:</p>
${buttons}
<p class="note">This is a fake Google IdP used only in the e2e docker stack.</p>
</body></html>`)
})

app.get('/pick', (req, res) => {
  const user = USERS.find(u => u.key === String(req.query.user))
  const redirectUri = String(req.query.redirect_uri ?? '')
  const state = String(req.query.state ?? '')
  if (!user || !redirectUri) {
    res.status(400).send('invalid selection')
    return
  }
  const code = randomUUID()
  codes.set(code, { user, redirectUri })
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  if (state) url.searchParams.set('state', state)
  res.redirect(url.toString())
})

app.post('/token', async (req, res) => {
  const record = codes.get(String(req.body.code))
  if (!record || req.body.client_secret !== CLIENT_SECRET) {
    res.status(400).json({ error: 'invalid_grant' })
    return
  }
  codes.delete(String(req.body.code))
  const { user } = record
  const idToken = await new SignJWT({
    email: user.email,
    email_verified: true,
    name: user.name,
    ...(user.hd ? { hd: user.hd } : {})
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(user.sub)
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
  res.json({ id_token: idToken, access_token: 'fake-access', token_type: 'Bearer', expires_in: 300 })
})

// The OAuth CLIENT's redirect landing, hosted here for convenience: it
// simply surfaces the code/error so Playwright and the test runner can
// read the outcome of the flow.
app.get('/callback-sink', (req, res) => {
  const code = req.query.code ? String(req.query.code) : ''
  const error = req.query.error ? String(req.query.error) : ''
  res.status(200).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>callback</title></head>
<body><h1>Callback</h1>
<pre id="code">${esc(code)}</pre>
<pre id="error">${esc(error)}</pre>
<pre id="error_description">${esc(req.query.error_description ?? '')}</pre>
</body></html>`)
})

app.listen(PORT, () => {
  console.log(`fake-google-idp listening on ${ISSUER}`)
})
