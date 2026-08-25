import { test, expect } from '@playwright/test'
import {
  registerClient, pkce, loginAs, exchangeCode, mcpClient, callTool, IDP_URL
} from './helpers.js'

// Browser UI e2e: the whole Google-login + consent flow driven through a
// real Chromium under different roles, against the fake IdP and the live
// Wiki.js in the e2e docker stack. Authorization outcomes are Wiki.js's.

test.describe('role-based UI flow', () => {
  test('the IdP login page offers the seeded roles', async ({ page }) => {
    const clientId = await registerClient()
    const { challenge } = pkce()
    await page.goto(`${process.env.MCP_URL ?? 'http://localhost:8000'}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(IDP_URL + '/callback-sink')}&response_type=code&scope=wikijs&code_challenge=${challenge}&code_challenge_method=S256&state=x`)
    await expect(page.getByTestId('login-john')).toBeVisible()
    await expect(page.getByTestId('login-kate')).toBeVisible()
    await expect(page.getByTestId('login-evil')).toBeVisible()
  })

  test('John (Engineering): consent names the client, then his role is scoped', async ({ page }) => {
    const clientId = await registerClient()
    const { verifier, challenge } = pkce()
    // The consent page must show the requesting client's redirect target.
    await page.goto(`${process.env.MCP_URL ?? 'http://localhost:8000'}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(IDP_URL + '/callback-sink')}&response_type=code&scope=wikijs&code_challenge=${challenge}&code_challenge_method=S256&state=s1`)
    await page.getByTestId('login-john').click()
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
    await expect(page.locator('body')).toContainText('callback-sink')
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.waitForURL(/callback-sink/)

    const code = (await page.locator('#code').textContent())!.trim()
    expect(code).toBeTruthy()

    const token = await exchangeCode(clientId, code, verifier)
    const client = await mcpClient(token)
    try {
      const who = await callTool(client, 'whoami', {})
      expect(who.json().identity.email).toBe('john@example.com')
      expect(who.json().wikijs.groups).toContain('Engineering')

      const list = await callTool(client, 'list_pages', {})
      const paths = (list.json().pages as Array<{ path: string }>).map(p => p.path)
      expect(paths).toContain('engineering/onboarding')
      expect(paths).not.toContain('management/salaries')

      const denied = await callTool(client, 'get_page', { path: 'management/salaries' })
      expect(denied.isError).toBe(true)
      expect(denied.text).toMatch(/denied|permission/i)
    } finally {
      await client.close()
    }
  })

  test('Kate (Management): sees the confidential page', async ({ page }) => {
    const clientId = await registerClient()
    const { verifier, challenge } = pkce()
    const out = await loginAs(page, clientId, 'kate', challenge, 's2')
    expect(out.sawConsent).toBe(true)
    expect(out.code).toBeTruthy()

    const client = await mcpClient(await exchangeCode(clientId, out.code!, verifier))
    try {
      const who = await callTool(client, 'whoami', {})
      expect(who.json().wikijs.groups).toContain('Management')
      const page1 = await callTool(client, 'get_page', { path: 'management/salaries' })
      expect(page1.isError).toBe(false)
      expect(page1.json().title).toBe('Salaries 2026')
    } finally {
      await client.close()
    }
  })

  test('denying consent returns access_denied and no code', async ({ page }) => {
    const clientId = await registerClient()
    const { challenge } = pkce()
    const out = await loginAs(page, clientId, 'john', challenge, 's3', 'deny')
    expect(out.sawConsent).toBe(true)
    expect(out.code).toBeFalsy()
    expect(out.error).toBe('access_denied')
  })

  test('an out-of-domain account is rejected before any consent', async ({ page }) => {
    const clientId = await registerClient()
    const { challenge } = pkce()
    const out = await loginAs(page, clientId, 'evil', challenge, 's4')
    expect(out.sawConsent).toBe(false)
    expect(out.code).toBeFalsy()
    expect(out.error).toBe('access_denied')
    expect(out.errorDescription ?? '').toMatch(/domain/i)
  })
})
