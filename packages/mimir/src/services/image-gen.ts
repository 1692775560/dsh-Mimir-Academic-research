/**
 * AI illustration service for meeting decks: an OpenAI-compatible
 * `/images/generations` client plus its workspace-level configuration
 * (`<workspaceDir>/image-gen.json`, atomic writes, the key never leaves the
 * host — the panel only ever sees a masked preview). Generated illustrations
 * are filed into the project's paper directory under `figures/ai-deck/`
 * with a caption row, so the Figures tab manages them like any other figure
 * and later decks can reuse them.
 * @module dsh-mimir/src/services/image-gen
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { rejected, success } from './common.ts'
import type { ResearchGetImageGenConfigResult, ResearchSetImageGenConfigResult } from '../types.ts'

/** The workspace-relative file the image-gen config persists in. */
export const IMAGE_GEN_CONFIG_FILE = 'image-gen.json'
/** Default endpoint family the client speaks (OpenAI-compatible images API). */
export const IMAGE_GEN_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const IMAGE_GEN_DEFAULT_MODEL = 'gpt-image-1'
/** Landscape default: deck slides are 16:9. */
export const IMAGE_GEN_DEFAULT_SIZE = '1536x1024'
/** One generation request's timeout. */
export const IMAGE_GEN_TIMEOUT_MS = 120_000
/** Illustrations per deck: one cover plus up to this many paper concept art. */
export const IMAGE_GEN_MAX_PER_DECK = 5

/** Persisted image-gen configuration (the apiKey stays host-side only). */
export interface ImageGenConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly size: string
}

/** Panel-safe view: the key only as a masked preview. */
export interface ImageGenConfigView {
  readonly configured: boolean
  readonly baseUrl: string
  readonly model: string
  readonly size: string
  /** Masked key preview (`sk-ab…yz`), '' when unset. */
  readonly apiKeyPreview: string
}

function maskKey(apiKey: string): string {
  if (apiKey === '') return ''
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}…`
  return `${apiKey.slice(0, 5)}…${apiKey.slice(-2)}`
}

/** Read the persisted config; a missing/invalid file reads as unconfigured defaults. */
export async function readImageGenConfig(workspaceDir: string): Promise<ImageGenConfig> {
  let raw: string
  try {
    raw = await readFile(join(workspaceDir, IMAGE_GEN_CONFIG_FILE), 'utf8')
  } catch {
    return { baseUrl: IMAGE_GEN_DEFAULT_BASE_URL, apiKey: '', model: IMAGE_GEN_DEFAULT_MODEL, size: IMAGE_GEN_DEFAULT_SIZE }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ImageGenConfig>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl !== '' ? parsed.baseUrl : IMAGE_GEN_DEFAULT_BASE_URL,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : IMAGE_GEN_DEFAULT_MODEL,
      size: typeof parsed.size === 'string' && parsed.size !== '' ? parsed.size : IMAGE_GEN_DEFAULT_SIZE,
    }
  } catch {
    return { baseUrl: IMAGE_GEN_DEFAULT_BASE_URL, apiKey: '', model: IMAGE_GEN_DEFAULT_MODEL, size: IMAGE_GEN_DEFAULT_SIZE }
  }
}

/** `getImageGenConfig` verb: the masked view; `configured` means an apiKey is set. */
export async function getImageGenConfig(
  workspaceDir: string,
): Promise<ResearchGetImageGenConfigResult> {
  const config = await readImageGenConfig(workspaceDir)
  return success({
    configured: config.apiKey !== '',
    baseUrl: config.baseUrl,
    model: config.model,
    size: config.size,
    apiKeyPreview: maskKey(config.apiKey),
  })
}

/**
 * `setImageGenConfig` verb. An absent `apiKey` keeps the stored one (the
 * panel round-trips only the masked preview); an explicit '' clears it.
 */
export async function setImageGenConfig(
  workspaceDir: string,
  request: { baseUrl?: string | undefined; apiKey?: string | undefined; model?: string | undefined; size?: string | undefined },
): Promise<ResearchSetImageGenConfigResult> {
  const current = await readImageGenConfig(workspaceDir)
  const next: ImageGenConfig = {
    baseUrl: request.baseUrl?.trim() || current.baseUrl,
    apiKey: request.apiKey === undefined ? current.apiKey : request.apiKey.trim(),
    model: request.model?.trim() || current.model,
    size: request.size?.trim() || current.size,
  }
  if (!/^https?:\/\//.test(next.baseUrl)) {
    return rejected({ code: 'invalid-input', message: 'baseUrl must be an http(s) URL' })
  }
  await writeFileAtomic(join(workspaceDir, IMAGE_GEN_CONFIG_FILE), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return getImageGenConfig(workspaceDir)
}

/** Injectable fetch seam for tests (same subset of fetch the client uses). */
export type ImageGenFetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/**
 * One image generation against the configured endpoint. Returns the png
 * bytes; throws on any HTTP/protocol failure (callers treat it as
 * "no illustration", never as a deck failure). Each fetch races the
 * caller's cancellation signal against the per-request timeout (#247).
 * @param config - the resolved image-gen configuration.
 * @param prompt - the illustration prompt.
 * @param fetchImpl - injectable fetch seam for tests.
 * @param signal - caller cancellation (the deck's linked long-task signal).
 */
export async function generateImage(
  config: ImageGenConfig,
  prompt: string,
  fetchImpl?: ImageGenFetch,
  signal?: AbortSignal,
): Promise<Buffer> {
  const fetcher = fetchImpl ?? (fetch as unknown as ImageGenFetch)
  const race = (timeout: AbortSignal): AbortSignal =>
    signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  const response = await fetcher(`${config.baseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, prompt, n: 1, size: config.size, response_format: 'b64_json' }),
    signal: race(AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS)),
  })
  if (!response.ok) throw new Error(`image generation failed: HTTP ${String(response.status)}`)
  const payload = await response.json() as { data?: { b64_json?: string; url?: string }[] }
  const first = payload.data?.[0]
  if (first?.b64_json !== undefined && first.b64_json !== '') return Buffer.from(first.b64_json, 'base64')
  if (first?.url !== undefined && first.url !== '') {
    const image = await fetch(first.url, { signal: race(AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS)) })
    if (!image.ok) throw new Error(`image fetch failed: HTTP ${String(image.status)}`)
    return Buffer.from(await image.arrayBuffer())
  }
  throw new Error('image generation returned no image payload')
}

/** House prompts: text-free illustrations render far better than labeled diagrams. */
export function coverPrompt(projectTitle: string): string {
  return `Minimalist scientific presentation cover illustration about "${projectTitle}". Abstract geometric composition, soft indigo-blue palette on white, clean modern academic style, absolutely no text or letters.`
}

export function paperArtPrompt(paperTitle: string, summary: string): string {
  const gist = summary.replace(/\s+/g, ' ').slice(0, 220)
  return `Clean scientific concept illustration for the paper "${paperTitle}". ${gist}. Flat vector style, white background, indigo and slate accents, absolutely no text, letters, or numbers.`
}

/**
 * Generate one illustration and file it under the project's
 * `figures/ai-deck/` with a caption row, so the Figures tab manages it.
 * @returns the paper-dir-relative path of the saved png.
 */
export async function saveDeckIllustration(
  deps: { readonly workspaceDir: string; readonly domain: import('./wiki-admin.ts').WikiAdminDeps['domain'] },
  projectId: string,
  paperDir: string,
  fileStem: string,
  caption: string,
  image: Buffer,
): Promise<string> {
  const relPath = `figures/ai-deck/${fileStem}.png`
  const absolute = join(deps.workspaceDir, paperDir, relPath)
  await mkdir(join(deps.workspaceDir, paperDir, 'figures', 'ai-deck'), { recursive: true })
  await writeFile(absolute, image)
  const id = `${projectId}:${relPath}`
  const existing = deps.domain.table('figures').get(id)
  await deps.domain.table('figures').put(id, {
    id,
    projectId,
    relPath,
    caption,
    ...(existing?.experimentId === undefined ? {} : { experimentId: existing.experimentId }),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  })
  return relPath
}
