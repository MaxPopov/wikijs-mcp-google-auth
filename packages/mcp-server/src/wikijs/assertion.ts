import { createPrivateKey } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { SignJWT, importPKCS8, type KeyLike } from 'jose'

export interface AssertionSignerOptions {
  privateKeyPem: string
  issuer: string
  audience: string
  ttlSeconds?: number
}

/**
 * Signs short-lived RS256 delegation assertions consumed by the
 * `mcpdelegation` Wiki.js authentication module.
 */
export class AssertionSigner {
  private key: KeyLike | null = null
  private readonly privateKeyPem: string
  readonly issuer: string
  readonly audience: string
  readonly ttlSeconds: number

  constructor (opts: AssertionSignerOptions) {
    this.privateKeyPem = opts.privateKeyPem
    this.issuer = opts.issuer
    this.audience = opts.audience
    this.ttlSeconds = opts.ttlSeconds ?? 60
  }

  private async getKey (): Promise<KeyLike> {
    if (!this.key) {
      // Accept both PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1
      // ("BEGIN RSA PRIVATE KEY") input; jose needs PKCS#8.
      const pem = this.privateKeyPem.includes('BEGIN RSA PRIVATE KEY')
        ? createPrivateKey(this.privateKeyPem).export({ type: 'pkcs8', format: 'pem' }).toString()
        : this.privateKeyPem
      this.key = await importPKCS8(pem, 'RS256')
    }
    return this.key
  }

  async sign (identity: { sub: string, email: string, name?: string }): Promise<string> {
    const key = await this.getKey()
    return await new SignJWT({
      email: identity.email.toLowerCase(),
      ...(identity.name ? { name: identity.name } : {})
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(identity.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setJti(randomUUID())
      .sign(key)
  }
}
