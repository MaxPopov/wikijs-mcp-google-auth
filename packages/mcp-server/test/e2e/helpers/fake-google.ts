import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { GoogleSettings } from '../../../src/oauth/google.js'

export interface FakeGoogleUser {
  sub: string
  email: string
  name?: string
  hd?: string
  emailVerified?: boolean
}

/**
 * Minimal fake Google OIDC IdP for e2e tests: /authorize immediately
 * redirects back with a code, /token returns an id_token for
 * `currentUser` signed with a per-run RSA key served at /jwks.
 */
export class FakeGoogle {
  currentUser: FakeGoogleUser = { sub: 'none', email: 'none@example.com' }
  readonly issuer = 'https://fake-google.test'
  readonly clientId = 'fake-google-client'
  readonly clientSecret = 'fake-google-secret'
  private server: Server | null = null
  private key!: CryptoKey
  private jwk!: Record<string, unknown>
  private readonly codes = new Map<string, FakeGoogleUser>()
  baseUrl = ''

  async start (): Promise<void> {
    const pair = await generateKeyPair('RS256')
    this.key = pair.privateKey as CryptoKey
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }

    const app = express()
    app.get('/authorize', (req, res) => {
      const code = randomUUID()
      this.codes.set(code, { ...this.currentUser })
      const redirect = new URL(String(req.query.redirect_uri))
      redirect.searchParams.set('code', code)
      redirect.searchParams.set('state', String(req.query.state ?? ''))
      res.redirect(redirect.toString())
    })
    app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
      void (async () => {
        const user = this.codes.get(String(req.body.code))
        if (!user || req.body.client_secret !== this.clientSecret) {
          res.status(400).json({ error: 'invalid_grant' })
          return
        }
        this.codes.delete(String(req.body.code))
        const idToken = await new SignJWT({
          email: user.email,
          email_verified: user.emailVerified ?? true,
          ...(user.name ? { name: user.name } : {}),
          ...(user.hd ? { hd: user.hd } : {})
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setSubject(user.sub)
          .setIssuer(this.issuer)
          .setAudience(this.clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(this.key)
        res.json({ id_token: idToken, access_token: 'fake-access', token_type: 'Bearer' })
      })()
    })
    app.get('/jwks', (_req, res) => {
      res.json({ keys: [this.jwk] })
    })

    await new Promise<void>(resolve => {
      this.server = createServer(app).listen(0, '127.0.0.1', resolve)
    })
    const addr = this.server!.address()
    if (typeof addr === 'object' && addr) {
      this.baseUrl = `http://127.0.0.1:${addr.port}`
    }
  }

  settings (): GoogleSettings {
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      allowedDomain: 'example.com',
      authorizationEndpoint: `${this.baseUrl}/authorize`,
      tokenEndpoint: `${this.baseUrl}/token`,
      jwksUri: `${this.baseUrl}/jwks`,
      issuer: this.issuer
    }
  }

  async stop (): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close(err => err ? reject(err) : resolve())
    })
  }
}
