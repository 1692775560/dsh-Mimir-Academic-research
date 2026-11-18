/**
 * Build-and-run E2E for the Mimir workbench (#240).
 *
 * The suite boots a dsh Web instance serving THIS checkout — built from the
 * commit under test, recorded in every failure's attachments — and drives the
 * real panel through the browser. `DSH_E2E_URL` still wins when set, so anyone
 * keeping a long-lived instance can point at it, but nothing REQUIRES one:
 * the browser path is covered on every run instead of only when a CI variable
 * happens to be configured.
 */
import { expect, test } from '@playwright/test'
import { tmpdir } from 'node:os'
import { cleanWorkspace, startInstance } from './instance.ts'
import type { E2EInstance } from './instance.ts'

let instance: E2EInstance | undefined

test.beforeAll(async () => {
  const repoRoot = process.cwd()
  cleanWorkspace(repoRoot)
  instance = await startInstance(repoRoot)
})

test.afterAll(async () => {
  await instance?.stop()
})

test.beforeEach(async ({ page }, testInfo) => {
  if (instance === undefined) throw new Error('no instance')
  // Record what was tested where a human looks for it, not only in the log.
  await testInfo.attach('instance', {
    body: JSON.stringify({
      baseURL: instance.baseURL,
      commit: instance.commit,
      patch: instance.patch,
      workspace: `${tmpdir()}/dsh-e2e-${instance.commit.slice(0, 8)}`,
    }, null, 2),
    contentType: 'application/json',
  })
  // A fresh dsh Web mints a one-shot token URL; the redirect plants the
  // session cookie, after which `/` serves the app.
  const entry = instance.token === ''
    ? instance.baseURL
    : `${instance.baseURL}/?token=${instance.token}`
  await page.goto(entry)
  await expect(page.locator('body')).toBeVisible({ timeout: 60_000 })
})

/**
 * Open the workbench overlay from the sidebar-footer toggle.
 *
 * The button exists as soon as the client mounts, but the app paints a
 * boot/welcome mask over everything and only removes it once its own start-up
 * settles — so "visible" is not "clickable". Dismiss that layer first, then
 * click; waiting for the overlay is the real synchronization point.
 */
async function openWorkbench(page: import('@playwright/test').Page) {
  const toggle = page.getByRole('button', { name: /Mimir/ }).first()
  await expect(toggle).toBeVisible({ timeout: 60_000 })
  const mask = page.locator('div[aria-hidden="true"][class*="mask"]').first()
  if (await mask.isVisible().catch(() => false)) {
    // The mask itself swallows the first click; that press reaches the layer.
    await page.mouse.click(5, 5)
    await expect(mask).toBeHidden({ timeout: 30_000 })
  }
  await toggle.click()
  const dialog = page.getByRole('dialog', { name: /Mimir/ })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  return dialog
}

test('the panel boots against this checkout and renders every view', async ({ page }, testInfo) => {
  const workbench = await openWorkbench(page)
  // Tab labels carry live count suffixes ("文献 48"), so match prefixes.
  const tabs = [
    /总览|Overview/, /^论文|^Paper/, /^文献|^Library/,
    /^实验|^Experiments/, /^图表|^Figures/, /^服务器|^Servers/,
  ]
  for (const [index, label] of tabs.entries()) {
    await workbench.getByRole('tab', { name: label }).first().click()
    await expect(workbench).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`view-${String(index + 1)}.png`) })
  }
})

test('a saved project survives a full page reload (#240 business loop)', async ({ page }) => {
  const workbench = await openWorkbench(page)
  await workbench.getByRole('tab', { name: /总览|Overview/ }).first().click()

  const projectName = `e2e-${String(Date.now())}`
  // New project: the button only swaps in an input, so fill then confirm.
  await workbench.getByRole('button', { name: /新建项目|New project/ }).first().click()
  const nameField = workbench.getByRole('textbox', { name: /新建项目|New project/ }).first()
  await expect(nameField).toBeVisible({ timeout: 15_000 })
  await nameField.fill(projectName)
  await workbench.getByRole('button', { name: /^创建$|^Create$/ }).first().click()
  await expect(workbench.getByText(projectName).first()).toBeVisible({ timeout: 30_000 })

  // Reload: the read must come off disk, not out of the client's memory.
  await page.reload()
  const reloaded = await openWorkbench(page)
  await reloaded.getByRole('tab', { name: /总览|Overview/ }).first().click()
  await expect(reloaded.getByText(projectName).first()).toBeVisible({ timeout: 30_000 })
})
