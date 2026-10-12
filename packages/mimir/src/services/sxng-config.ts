/**
 * Host-side persistence for sxng-cli's native global configuration: the
 * panel-facing get/set verbs over `~/sxng-cli/sxng.config.json` (atomic
 * writes, cross-process file lock, the key masked before it leaves the
 * host). Reads are fail-open — a missing or malformed file reads as the
 * documented defaults; writes validate before touching the disk.
 * @module dsh-mimir/src/services/sxng-config
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { rejected, success } from './common.ts'
import type { ResearchGetSxngConfigResult, ResearchSetSxngConfigResult } from '../types.ts'

export const SXNG_CONFIG_FILE = 'sxng.config.json'
export const SXNG_DEFAULT_BASE_URL = 'http://localhost:8080'
export const SXNG_DEFAULT_LIMIT = 10
export const SXNG_DEFAULT_FORMAT = 'md'
export const SXNG_DEFAULT_TIMEOUT = 30_000
export const SXNG_DEFAULT_REDUNDANCY_THRESHOLD = 0.7
export const SXNG_DEFAULT_BIGRAM_THRESHOLD = 0.5

export interface SxngConfig {
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

export interface SxngConfigView extends Omit<SxngConfig, 'ollamaApiKey'> {
  readonly configured: boolean
  readonly ollamaApiKeyPreview: string
}

const CONFIG_PATH_ENV = 'MIMIR_SXNG_CONFIG_FILE'

function configPath(): string {
  return process.env[CONFIG_PATH_ENV] ?? join(homedir(), 'sxng-cli', SXNG_CONFIG_FILE)
}

export function sxngConfigPath(): string {
  return configPath()
}

const DEFAULTS: SxngConfig = {
  baseUrl: SXNG_DEFAULT_BASE_URL,
  defaultEngine: '',
  allowedEngines: [],
  defaultLimit: SXNG_DEFAULT_LIMIT,
  defaultFormat: SXNG_DEFAULT_FORMAT,
  useProxy: false,
  proxyUrl: '',
  timeout: SXNG_DEFAULT_TIMEOUT,
  ollamaApiKey: '',
  redundancyThreshold: SXNG_DEFAULT_REDUNDANCY_THRESHOLD,
  redundancyBigramThreshold: SXNG_DEFAULT_BIGRAM_THRESHOLD,
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function readConfig(value: unknown): SxngConfig {
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

export async function readSxngConfig(): Promise<SxngConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8')
    return readConfig(JSON.parse(raw))
  } catch {
    return DEFAULTS
  }
}

function maskKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 5)}…${key.slice(-2)}`
}

function viewOf(config: SxngConfig): SxngConfigView {
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

export async function getSxngConfig(): Promise<ResearchGetSxngConfigResult> {
  return success(viewOf(await readSxngConfig()))
}

export async function setSxngConfig(request: {
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
}): Promise<ResearchSetSxngConfigResult> {
  const current = await readSxngConfig()
  const next: SxngConfig = {
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
  // saves (panel + sxng-cli) cannot silently drop each other's fields.
  await withFileLock(path, async () => {
    let existing: Record<string, unknown> = {}
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
    } catch { /* replace malformed/missing config with the documented fields */ }
    await writeFileAtomic(path, `${JSON.stringify({ ...existing, ...next }, null, 2)}\n`, { mode: 0o600 })
  })
  return getSxngConfig()
}
