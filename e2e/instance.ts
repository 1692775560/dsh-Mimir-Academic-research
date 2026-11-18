/**
 * Boot and reachability helpers for the self-hosted E2E instance (#240).
 *
 * The suite must be able to start the dsh Web server serving THIS checkout
 * without anyone pre-configuring an external one, and it must be able to
 * authenticate: a bare `dsh web` mints a one-shot `?token=` URL, and every
 * unauthenticated request answers 401. Both facts live here so the spec files
 * stay about behaviour.
 */
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The commit under test, so a failure names exactly what was running. */
export async function commitUnderTest(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}

/** A free TCP port, or `DSH_E2E_PORT` when the caller pinned one. */
export async function freePort(): Promise<number> {
  const pinned = process.env.DSH_E2E_PORT
  if (pinned !== undefined && pinned !== '') return Number(pinned)
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}

/**
 * Make `dsh --profile web` able to `import 'dsh-mimir'`: dsh resolves patch
 * plugin names from the profile directory, not from the repo, so the package
 * has to be reachable from `<DSH_HOME>/profiles/web/node_modules`. Idempotent.
 */
export function linkPluginIntoProfile(repoRoot: string): string {
  const profile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web')
  const target = join(profile, 'node_modules', 'dsh-mimir')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  if (!existsSync(target)) {
    symlinkSync(join(repoRoot, 'packages', 'mimir'), target, 'dir')
    return target
  }
  return target
}

/** Poll until the instance answers, remembering everything it said meanwhile. */
async function waitForBoot(child: ChildProcess, deadlineMs = 180_000): Promise<string> {
  const started = Date.now()
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
  while (Date.now() < started + deadlineMs) {
    if (log.includes('http://127.0.0.1:')) return log
    if (child.exitCode !== null) throw new Error(`dsh web exited before it printed a URL (code ${String(child.exitCode)}):\n${log}`)
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  throw new Error(`dsh web printed no URL within ${String(deadlineMs)} ms:\n${log}`)
}

/** The token dsh puts in the boot URL; the browser session needs it once. */
export function bootToken(log: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(log)
  if (match === null) throw new Error(`dsh web printed no token:\n${log}`)
  return match[1] as string
}

export interface E2EInstance {
  readonly baseURL: string
  readonly token: string
  readonly commit: string
  readonly patch: string
  readonly stop: () => Promise<void>
}

/**
 * Start the instance (or adopt `DSH_E2E_URL`, which still wins for anyone who
 * keeps a long-lived one) and return everything the spec needs to reach it.
 */
export async function startInstance(repoRoot: string): Promise<E2EInstance> {
  const commit = await commitUnderTest()
  const patch = process.env.DSH_E2E_PATCH ?? join(repoRoot, 'e2e', 'mimir.cordis.yml')
  const external = process.env.DSH_E2E_URL
  if (external !== undefined && external !== '') {
    const token = process.env.DSH_E2E_TOKEN ?? ''
    return { baseURL: external, token, commit, patch, stop: () => Promise.resolve() }
  }

  const link = linkPluginIntoProfile(repoRoot)
  const port = await freePort()
  const command = process.env.DSH_E2E_BIN ?? (platform() === 'win32' ? 'dsh.cmd' : 'dsh')
  const args = ['--profile', 'web', '--patch', patch, '--port', String(port), '--no-open']
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, DSH_E2E_STARTED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log: string
  try {
    log = await waitForBoot(child)
  } catch (error) {
    child.kill('SIGKILL')
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n[plugin link: ${link}]`)
  }
  const baseURL = `http://127.0.0.1:${String(port)}`
  return {
    baseURL,
    token: bootToken(log),
    commit,
    patch,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

/** Forget this run's workspace leftovers so a suite run starts clean. */
export function cleanWorkspace(repoRoot: string): void {
  const workspace = join(repoRoot, '.research')
  rmSync(join(workspace, 'venue-deadlines.cache.json'), { force: true })
}
