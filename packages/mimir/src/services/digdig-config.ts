/**
 * Host-side persistence for digdig's native global configuration: the
 * panel-facing get/set verbs over `~/digdig/digdig.config.json` (atomic
 * writes, cross-process file lock, the key masked before it leaves the
 * host). Reads are fail-open — a missing or malformed file reads as the
 * documented defaults (and falls back to the legacy
 * `~/sxng-cli/sxng.config.json` when the new file is absent); writes
 * validate before touching the disk.
 * @module dsh-mimir/src/services/digdig-config
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { rejected, success } from './common.ts'
import type { ResearchGetDigdigConfigResult, ResearchSetDigdigConfigResult } from '../types.ts'

export const DIGDIG_CONFIG_FILE = 'digdig.config.json'
export const DIGDIG_DEFAULT_BASE_URL = 'http://localhost:8080'
export const DIGDIG_DEFAULT_LIMIT = 10
export const DIGDIG_DEFAULT_FORMAT = 'md'
export const DIGDIG_DEFAULT_TIMEOUT = 30_000
export const DIGDIG_DEFAULT_REDUNDANCY_THRESHOLD = 0.7
export const DIGDIG_DEFAULT_BIGRAM_THRESHOLD = 0.5

export interface DigdigConfig {
  readonly baseUrl: string
  readonly defaultEngine: string
  readonly allowedEngines: readonly string[]
  readonly defaultLimit: number
  readonly defaultFormat: 'md' | 'json'
  readonly useProxy: boolean
  readonly proxyUrl: string
  readonly timeout: number
  readonly ollamaApiKey: string
  readonly redundancyThreshold: number
  readonly redundancyBigramThreshold: number
}

export interface DigdigConfigView extends Omit<DigdigConfig, 'ollamaApiKey'> {
  readonly configured: boolean
  readonly ollamaApiKeyPreview: string
}

const CONFIG_PATH_ENV = 'MIMIR_DIGDIG_CONFIG_FILE'

function envOverride(): string | undefined {
  return process.env[CONFIG_PATH_ENV]
}

function configPath(): string {
  return envOverride() ?? join(homedir(), 'digdig', DIGDIG_CONFIG_FILE)
}

/** digdig's pre-rename config file; read-only fallback, never written. */
function legacyConfigPath(): string {
  return join(homedir(), 'sxng-cli', 'sxng.config.json')
}

export function digdigConfigPath(): string {
  return configPath()
}

const DEFAULTS: DigdigConfig = {
  baseUrl: DIGDIG_DEFAULT_BASE_URL,
  defaultEngine: '',
  allowedEngines: [],
  defaultLimit: DIGDIG_DEFAULT_LIMIT,
  defaultFormat: DIGDIG_DEFAULT_FORMAT,
  useProxy: false,
  proxyUrl: '',
  timeout: DIGDIG_DEFAULT_TIMEOUT,
  ollamaApiKey: '',
  redundancyThreshold: DIGDIG_DEFAULT_REDUNDANCY_THRESHOLD,
  redundancyBigramThreshold: DIGDIG_DEFAULT_BIGRAM_THRESHOLD,
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function readConfig(value: unknown): DigdigConfig {
  const parsed = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const format = parsed.defaultFormat === 'json' ? 'json' : 'md'
  const engines = Array.isArray(parsed.allowedEngines)
    ? parsed.allowedEngines.filter((engine): engine is string => typeof engine === 'string')
    : []
  return {
    baseUrl: stringOr(parsed.baseUrl, DEFAULTS.baseUrl),
    defaultEngine: stringOr(parsed.defaultEngine, DEFAULTS.defaultEngine),
    allowedEngines: engines,
    defaultLimit: numberOr(parsed.defaultLimit, DEFAULTS.defaultLimit),
    defaultFormat: format,
    useProxy: typeof parsed.useProxy === 'boolean' ? parsed.useProxy : DEFAULTS.useProxy,
    proxyUrl: stringOr(parsed.proxyUrl, DEFAULTS.proxyUrl),
    timeout: numberOr(parsed.timeout, DEFAULTS.timeout),
    ollamaApiKey: stringOr(parsed.ollamaApiKey, DEFAULTS.ollamaApiKey),
    redundancyThreshold: numberOr(parsed.redundancyThreshold, DEFAULTS.redundancyThreshold),
    redundancyBigramThreshold: numberOr(parsed.redundancyBigramThreshold, DEFAULTS.redundancyBigramThreshold),
  }
}

export async function readDigdigConfig(): Promise<DigdigConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8')
    return readConfig(JSON.parse(raw))
  } catch {
    return DEFAULTS
  }
}

/**
 * Read the config, falling back to the legacy `~/sxng-cli/sxng.config.json`
 * when the digdig file is absent. digdig itself still accepts the old path
 * (dropped in 0.5.0), so a user who has not migrated sees the same settings
 * here as the CLI does. Writes always target the new path.
 */
async function readConfigWithLegacy(): Promise<DigdigConfig> {
  if (envOverride() !== undefined || existsSync(configPath())) return readDigdigConfig()
  try {
    return readConfig(JSON.parse(await readFile(legacyConfigPath(), 'utf8')))
  } catch {
    return DEFAULTS
  }
}

function maskKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 5)}…${key.slice(-2)}`
}

function viewOf(config: DigdigConfig): DigdigConfigView {
  return {
    configured: config.baseUrl !== '',
    baseUrl: config.baseUrl,
    defaultEngine: config.defaultEngine,
    allowedEngines: config.allowedEngines,
    defaultLimit: config.defaultLimit,
    defaultFormat: config.defaultFormat,
    useProxy: config.useProxy,
    proxyUrl: config.proxyUrl,
    timeout: config.timeout,
    redundancyThreshold: config.redundancyThreshold,
    redundancyBigramThreshold: config.redundancyBigramThreshold,
    ollamaApiKeyPreview: maskKey(config.ollamaApiKey),
  }
}

export async function getDigdigConfig(): Promise<ResearchGetDigdigConfigResult> {
  return success(viewOf(await readConfigWithLegacy()))
}

export async function setDigdigConfig(request: {
  baseUrl?: string | undefined
  defaultEngine?: string | undefined
  allowedEngines?: readonly string[] | undefined
  defaultLimit?: number | undefined
  defaultFormat?: 'md' | 'json' | undefined
  useProxy?: boolean | undefined
  proxyUrl?: string | undefined
  timeout?: number | undefined
  ollamaApiKey?: string | undefined
  redundancyThreshold?: number | undefined
  redundancyBigramThreshold?: number | undefined
}): Promise<ResearchSetDigdigConfigResult> {
  const current = await readConfigWithLegacy()
  const next: DigdigConfig = {
    baseUrl: request.baseUrl?.trim() || current.baseUrl,
    defaultEngine: request.defaultEngine?.trim() ?? current.defaultEngine,
    allowedEngines: request.allowedEngines?.map(engine => engine.trim()).filter(Boolean) ?? current.allowedEngines,
    defaultLimit: request.defaultLimit ?? current.defaultLimit,
    defaultFormat: request.defaultFormat ?? current.defaultFormat,
    useProxy: request.useProxy ?? current.useProxy,
    proxyUrl: request.proxyUrl?.trim() ?? current.proxyUrl,
    timeout: request.timeout ?? current.timeout,
    ollamaApiKey: request.ollamaApiKey === undefined ? current.ollamaApiKey : request.ollamaApiKey.trim(),
    redundancyThreshold: request.redundancyThreshold ?? current.redundancyThreshold,
    redundancyBigramThreshold: request.redundancyBigramThreshold ?? current.redundancyBigramThreshold,
  }
  if (!/^https?:\/\//.test(next.baseUrl)) return rejected({ code: 'invalid-input', message: 'baseUrl must be an http(s) URL' })
  if (next.proxyUrl !== '' && !/^https?:\/\//.test(next.proxyUrl)) return rejected({ code: 'invalid-input', message: 'proxyUrl must be an http(s) URL' })
  if (!Number.isInteger(next.defaultLimit) || next.defaultLimit < 1) return rejected({ code: 'invalid-input', message: 'defaultLimit must be a positive integer' })
  if (next.defaultFormat !== 'md' && next.defaultFormat !== 'json') return rejected({ code: 'invalid-input', message: 'defaultFormat must be md or json' })
  if (typeof next.useProxy !== 'boolean') return rejected({ code: 'invalid-input', message: 'useProxy must be a boolean' })
  if (!Number.isInteger(next.timeout) || next.timeout < 1000) return rejected({ code: 'invalid-input', message: 'timeout must be at least 1000 ms' })
  if (!Number.isFinite(next.redundancyThreshold) || !Number.isFinite(next.redundancyBigramThreshold)
    || next.redundancyThreshold < 0 || next.redundancyThreshold > 1 || next.redundancyBigramThreshold < 0 || next.redundancyBigramThreshold > 1) {
    return rejected({ code: 'invalid-input', message: 'redundancy thresholds must be between 0 and 1' })
  }
  const path = configPath()
  await mkdir(join(path, '..'), { recursive: true })
  // The read-modify-write of the shared host-side config runs behind the same
  // cross-process file lock the rest of the codebase uses, so two concurrent
  // saves (panel + digdig) cannot silently drop each other's fields.
  await withFileLock(path, async () => {
    let existing: Record<string, unknown> = {}
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
    } catch { /* replace malformed/missing config with the documented fields */ }
    await writeFileAtomic(path, `${JSON.stringify({ ...existing, ...next }, null, 2)}\n`, { mode: 0o600 })
  })
  return getDigdigConfig()
}
