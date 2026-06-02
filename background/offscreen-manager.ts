import type { Message, ModelStatusMessage } from '@/shared/messages'
import { DEFAULT_MODEL_ID, MODELS, STORAGE_KEY_MODEL, type ModelId } from '@/shared/models'

const OFFSCREEN_URL = 'offscreen.html'

let creating: Promise<void> | null = null

export async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })

  if (existingContexts.length > 0) return

  if (creating) {
    await creating
    return
  }

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run Gemma 4 model inference via WebGPU',
  })

  try {
    await creating
  } catch (e) {
    // If creation fails, make sure we reset the creating flag
    // so subsequent calls can retry
    throw e
  } finally {
    creating = null
  }
}

export async function getSelectedModelId(): Promise<ModelId> {
  const data = await chrome.storage.local.get(STORAGE_KEY_MODEL) as Record<string, unknown>
  const storedModelId = data[STORAGE_KEY_MODEL]
  return typeof storedModelId === 'string' && storedModelId in MODELS
    ? storedModelId as ModelId
    : DEFAULT_MODEL_ID
}

export async function ensureOffscreenModel(modelId?: ModelId): Promise<ModelId> {
  const targetModelId = modelId ?? await getSelectedModelId()
  await ensureOffscreenDocument()
  await chrome.runtime.sendMessage({
    type: 'model:load',
    modelId: targetModelId,
  } satisfies Message).catch(() => {})
  return targetModelId
}

export type ModelReadyResult = {
  modelId: ModelId
  status: 'ready' | 'error'
  loadMs: number
  phase?: string
  progress?: number
  error?: string
}

export async function ensureOffscreenModelReady(modelId?: ModelId, timeoutMs = 180_000): Promise<ModelReadyResult> {
  const targetModelId = modelId ?? await getSelectedModelId()
  const startedAt = performance.now()

  await ensureOffscreenDocument()

  return new Promise<ModelReadyResult>((resolve, reject) => {
    let settled = false
    const timeoutId = self.setTimeout(() => {
      settle(undefined, new Error(`Model readiness timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    function settle(status?: ModelStatusMessage, error?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      chrome.runtime.onMessage.removeListener(onMessage)

      if (error) {
        reject(error)
        return
      }

      if (!status) {
        reject(new Error('Model readiness completed without a status'))
        return
      }

      resolve({
        modelId: status.modelId ?? targetModelId,
        status: status.status === 'ready' ? 'ready' : 'error',
        loadMs: performance.now() - startedAt,
        phase: status.phase,
        progress: status.progress,
        error: status.error,
      })
    }

    function onMessage(message: Message): void {
      if (message.type !== 'model:status') return
      if (message.modelId && message.modelId !== targetModelId) return

      if (message.status === 'ready') {
        settle(message)
      } else if (message.status === 'error') {
        settle(message, new Error(message.error ?? 'Model failed to load'))
      }
    }

    chrome.runtime.onMessage.addListener(onMessage)
    chrome.runtime.sendMessage({
      type: 'model:load',
      modelId: targetModelId,
    } satisfies Message).catch(e => settle(undefined, e instanceof Error ? e : new Error(String(e))))
  })
}
