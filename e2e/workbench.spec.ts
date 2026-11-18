/**
 * Build-and-run E2E for the Mimir workbench (#240).
 *
 * The suite boots a dsh Web instance serving THIS checkout — built from the
 * commit under test, recorded in every failure's attachments, running against a
 * repo-local DSH home that a fresh clone can create — and drives the real panel
 * through the browser. `DSH_E2E_URL` still wins when set, so anyone keeping a
 * long-lived instance can point at it, but nothing REQUIRES one: the browser
 * path is covered on every run instead of only when a CI variable happens to be
 * configured.
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
 * Open the workbench from wherever this commit hangs its entry — the sidebar's
 * panel row (a `main` panel), or the footer toggle it used to be — and return
 * the workbench itself.
 *
 * The entry can enter the DOM before the panel it selects is mounted, and the
 * press that lands in that window is swallowed, so the click is retried until
 * the panel actually appears rather than assumed to have taken. The panel is
 * located by role, not by name alone: both the row and the panel answer to
 * "Mimir".
 */
async function openWorkbench(page: import('@playwright/test').Page) {
  const entry = page.getByRole('button', { name: /Mimir/ }).first()
  const workbench = page.locator('[role="dialog"][aria-label="Mimir"], [role="region"][aria-label="Mimir"]').first()
  await expect(entry).toBeVisible({ timeout: 45_000 })

  // A hand-rolled retry rather than `expect.poll`/`toPass`: those report their own
  // timeout, which loses the one thing worth knowing. Here the LAST failure is
  // what the test throws, so a first-run modal says so by name and a panel that
  // never mounts says that instead.
  const deadline = Date.now() + 30_000
  let lastError: unknown = new Error('the workbench never opened')
  while (Date.now() < deadline) {
    try {
      // Both first-run modals mount a beat after the shell and cover it with a
      // mask; see instance.ts for why they are seeded away instead of clicked.
      await expect(page.getByRole('dialog', { name: 'Preview Notice' })).toHaveCount(0, { timeout: 1_000 })
      await expect(page.getByRole('dialog', { name: /Get started|开始使用/ })).toHaveCount(0, { timeout: 1_000 })
      if (!(await workbench.isVisible().catch(() => false))) await entry.click({ timeout: 5_000 })
      await expect(workbench).toBeVisible({ timeout: 5_000 })
      return workbench
    } catch (error) {
      lastError = error
      await page.waitForTimeout(250)
    }
  }
  throw lastError
}

test('the panel boots against this checkout and renders every view', async ({ page }, testInfo) => {
  const workbench = await openWorkbench(page)
  // The low-frequency views live behind the rail's More disclosure (#243);
  // expanding it keeps every tab reachable for this walk.
  const more = workbench.getByRole('tab', { name: /更多|More/ }).first()
  if (await more.count() > 0) await more.click()
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
