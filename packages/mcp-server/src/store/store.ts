import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Minimal namespaced KV store used for OAuth state (registered clients,
 * sessions, tokens, pending authorizations). Single-instance oriented;
 * swap the implementation for Redis/Postgres when running more than one
 * MCP server replica.
 */
export interface KVStore {
  get<T>(ns: string, key: string): T | undefined
  set<T>(ns: string, key: string, value: T): void
  delete(ns: string, key: string): void
  entries<T>(ns: string): Array<[string, T]>
}

export class MemoryStore implements KVStore {
  protected readonly data = new Map<string, Map<string, unknown>>()

  private ns (ns: string): Map<string, unknown> {
    let m = this.data.get(ns)
    if (!m) {
      m = new Map()
      this.data.set(ns, m)
    }
    return m
  }

  get<T> (ns: string, key: string): T | undefined {
    return this.ns(ns).get(key) as T | undefined
  }

  set<T> (ns: string, key: string, value: T): void {
    this.ns(ns).set(key, value)
    this.persist()
  }

  delete (ns: string, key: string): void {
    this.ns(ns).delete(key)
    this.persist()
  }

  entries<T> (ns: string): Array<[string, T]> {
    return [...this.ns(ns).entries()] as Array<[string, T]>
  }

  protected persist (): void {}
}

/**
 * JSON-file-backed store with atomic, debounced writes. Survives MCP
 * server restarts so registered clients, sessions and refresh tokens
 * keep working.
 */
export class FileStore extends MemoryStore {
  private timer: NodeJS.Timeout | null = null

  constructor (private readonly filePath: string) {
    super()
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>>
      for (const [ns, values] of Object.entries(raw)) {
        this.data.set(ns, new Map(Object.entries(values)))
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true })
    }
  }

  protected override persist (): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 250)
    this.timer.unref?.()
  }

  flush (): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const obj: Record<string, Record<string, unknown>> = {}
    for (const [ns, values] of this.data.entries()) {
      obj[ns] = Object.fromEntries(values)
    }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }
}
