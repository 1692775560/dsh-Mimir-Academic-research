import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getSxngConfig,
  readSxngConfig,
  setSxngConfig,
} from '../src/services/sxng-config.ts'

const paths: string[] = []
afterEach(() => { delete process.env.MIMIR_SXNG_CONFIG_FILE })

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mimir-sxng-'))
  const path = join(dir, 'sxng.config.json')
  paths.push(path)
  process.env.MIMIR_SXNG_CONFIG_FILE = path
  return path
}

describe('sxng config', () => {
  it('round-trips the native config, masks its key, and preserves unknown fields', async () => {
    const path = await configPath()
    await writeFile(path, JSON.stringify({ custom: 'keep' }))
    const initial = await getSxngConfig()
    expect(initial.ok && initial.value.defaultFormat).toBe('md')
    const saved = await setSxngConfig({
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

    await setSxngConfig({ defaultLimit: 5 })
    expect((await readSxngConfig()).ollamaApiKey).toBe('ollama-abcdefgh1234')
    await setSxngConfig({ ollamaApiKey: '' })
    expect((await readSxngConfig()).ollamaApiKey).toBe('')
  })

  it('rejects invalid values without replacing the file', async () => {
    const path = await configPath()
    const result = await setSxngConfig({ defaultLimit: 0 })
    expect(result.ok).toBe(false)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })
})
