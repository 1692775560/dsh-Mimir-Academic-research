import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDigdigConfig,
  readDigdigConfig,
  setDigdigConfig,
} from '../src/services/digdig-config.ts'

const paths: string[] = []
afterEach(() => { vi.unstubAllEnvs() })

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mimir-digdig-'))
  const path = join(dir, 'digdig.config.json')
  paths.push(path)
  process.env.MIMIR_DIGDIG_CONFIG_FILE = path
  return path
}

describe('digdig config', () => {
  it('round-trips the native config, masks its key, and preserves unknown fields', async () => {
    const path = await configPath()
    await writeFile(path, JSON.stringify({ custom: 'keep' }))
    const initial = await getDigdigConfig()
    expect(initial.ok && initial.value.defaultFormat).toBe('md')
    const saved = await setDigdigConfig({
      baseUrl: 'http://127.0.0.1:8080', defaultEngine: 'brave', allowedEngines: ['brave', 'google'],
      defaultLimit: 12, defaultFormat: 'json', useProxy: false, proxyUrl: '', timeout: 20_000,
      ollamaApiKey: 'ollama-abcdefgh1234', redundancyThreshold: 0.8, redundancyBigramThreshold: 0.6,
    })
    expect(saved.ok && saved.value.ollamaApiKeyPreview).toBe('ollam…34')
    expect(saved.ok && saved.value.ollamaApiKeyPreview).not.toContain('abcdefgh')
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(raw.custom).toBe('keep')
    expect(raw.ollamaApiKey).toBe('ollama-abcdefgh1234')
    // POSIX honors the 0o600 write mode; Windows maps it to ACLs and stat
    // always reports 0o666, so the permission assertion is POSIX-only.
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }

    await setDigdigConfig({ defaultLimit: 5 })
    expect((await readDigdigConfig()).ollamaApiKey).toBe('ollama-abcdefgh1234')
    await setDigdigConfig({ ollamaApiKey: '' })
    expect((await readDigdigConfig()).ollamaApiKey).toBe('')
  })

  it('rejects invalid values without replacing the file', async () => {
    const path = await configPath()
    const result = await setDigdigConfig({ defaultLimit: 0 })
    expect(result.ok).toBe(false)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  // os.homedir() follows $HOME on POSIX only; Windows resolves it from the
  // user profile, which a test cannot redirect.
  it.skipIf(process.platform === 'win32')('reads the legacy sxng-cli config when the digdig file is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mimir-digdig-legacy-'))
    vi.stubEnv('HOME', home)
    delete process.env.MIMIR_DIGDIG_CONFIG_FILE
    await mkdir(join(home, 'sxng-cli'), { recursive: true })
    await writeFile(join(home, 'sxng-cli', 'sxng.config.json'), JSON.stringify({ defaultLimit: 7, ollamaApiKey: 'legacy-key-1234' }))
    const read = await getDigdigConfig()
    expect(read.ok && read.value.defaultLimit).toBe(7)
    expect(read.ok && read.value.ollamaApiKeyPreview).toBe('legac…34')

    // A write lands on the new path and leaves the legacy file alone.
    await setDigdigConfig({ defaultEngine: 'brave' })
    const written = JSON.parse(await readFile(join(home, 'digdig', 'digdig.config.json'), 'utf8')) as Record<string, unknown>
    expect(written.defaultLimit).toBe(7)
    expect(written.defaultEngine).toBe('brave')
    expect(JSON.parse(await readFile(join(home, 'sxng-cli', 'sxng.config.json'), 'utf8'))).toEqual({ defaultLimit: 7, ollamaApiKey: 'legacy-key-1234' })
  })
})
