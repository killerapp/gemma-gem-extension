import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'
import type { BridgeEvent, BridgeRequest } from '../../shared/bridge-messages'
import type { BridgeActivityMessage } from '../../shared/messages'
import { jsonSchemaErrors, parseJsonText } from '../../shared/json-schema'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const BENCH_ROOT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane')
const TOKEN = 'benchmark-web-control-plane'
const DEFAULT_TASK_TIMEOUT_MS = 120_000
const REAL_MODE = process.argv.includes('--real')
const INCLUDE_AGENT_TASKS = process.argv.includes('--include-agent')
const FRESH_PROFILE = process.argv.includes('--fresh-profile') || process.env.GEMMA_GEM_FRESH_CHROME_PROFILE === '1'
const EXTENSION_DIR = resolve(REPO_ROOT, '.output', 'chrome-mv3-dev')
const BROWSER_MARKER = resolve(REPO_ROOT, '.browsers', 'chrome-for-testing', 'chrome-path.txt')
const DEFAULT_AGENT_PROFILE = resolve(REPO_ROOT, '.browsers', 'gemma-gem-benchmark-profile')
const MODEL_DRIVEN_TOOLS = new Set(['gemma_agent', 'gemma_observe', 'gemma_extract'])
const REAL_SMOKE_EXCLUDED_TOOLS = new Set([...MODEL_DRIVEN_TOOLS, 'gemma_model_ready'])
const AGENT_TASK_TIMEOUT_MS = positiveIntEnv('GEMMA_GEM_AGENT_TASK_TIMEOUT_MS', 180_000)
const MODEL_READY_TIMEOUT_MS = positiveIntEnv('GEMMA_GEM_MODEL_READY_TIMEOUT_MS', AGENT_TASK_TIMEOUT_MS)

type BenchmarkTask = {
  id: string
  suite: string
  title: string
  tool: string
  arguments: Record<string, unknown>
  expect: Record<string, unknown>
  modes?: string[]
  skipModes?: string[]
}

type TaskResult = {
  id: string
  suite: string
  title: string
  tool: string
  success: boolean
  strict: boolean
  jsonRequired: boolean
  jsonValid: boolean
  selectorChecks: number
  selectorHits: number
  actions: number
  actionTrace: ActionTraceEvent[]
  durationMs: number
  timeout: boolean
  toolErrors: number
  outputPreview?: string
  notes: string[]
}

type ActionTraceEvent = {
  status: string
  toolName?: string
  requestId?: string
  tabId?: number
  title?: string
  text?: string
  timestamp?: number
}

type ModelReadyPreflight = {
  status: 'skipped' | 'ready' | 'error'
  durationMs: number
  modelId?: string
  phase?: string
  progress?: number
  error?: string
  outputPreview?: string
}

type ResultsLedgerRow = {
  commit: string
  suite: string
  tasks: string
  successRate: string
  strictSuccessRate: string
  jsonValidRate: string
  selectorHitRate: string
  actionsPerSuccess: string
  p50TaskSeconds: string
  p95TaskSeconds: string
  timeoutRate: string
  modelLoadSeconds: string
  status: string
  description: string
}

type FakeTab = {
  id: number
  active: boolean
  title: string
  url: string
}

type HarnessProbe = {
  readonly mode: string
  readonly supportsBridgeRequestLog: boolean
  remapTask(task: BenchmarkTask): BenchmarkTask
  activateTab(logicalTabId: number): Promise<void> | void
  selectorExists(selector: string, logicalTabId?: number): Promise<boolean> | boolean
  value(logicalTabId: number, selector: string): Promise<string> | string
  clicked(selector: string): Promise<boolean> | boolean
  scrollY(logicalTabId: number): Promise<number> | number
  urlPath(logicalTabId: number): Promise<string> | string
  requestCount(): number
  requestsSince(start: number): BridgeRequest[]
  actionCount(): Promise<number> | number
  actionTraceSince(start: number): Promise<ActionTraceEvent[]> | ActionTraceEvent[]
  toolErrorCount(): number
  diagnostics(): Promise<Record<string, unknown>> | Record<string, unknown>
  close(): Promise<void> | void
}

async function getFreePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not allocate a benchmark port')
  }
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<void> {
  if (!child.stderr || !child.stdout) {
    throw new Error('Sidecar process was not started with piped stdout/stderr')
  }
  const stderr = child.stderr
  const stdout = child.stdout

  return new Promise((resolveWait, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output}`))
    }, 10_000)

    function cleanup(): void {
      clearTimeout(timeout)
      stderr.off('data', onData)
      stdout.off('data', onData)
      child.off('exit', onExit)
    }

    function onData(chunk: Buffer): void {
      output += chunk.toString('utf8')
      if (pattern.test(output)) {
        cleanup()
        resolveWait()
      }
    }

    function onExit(code: number | null): void {
      cleanup()
      reject(new Error(`Sidecar exited before ready with code ${code}. Output:\n${output}`))
    }

    stderr.on('data', onData)
    stdout.on('data', onData)
    child.on('exit', onExit)
  })
}

function toolText(result: any): string {
  if (result?.toolResult) return JSON.stringify(result.toolResult)
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .filter((item: any) => item.type === 'text')
    .map((item: any) => item.text)
    .join('\n')
}

function hasImage(result: any, mimeType: string): boolean {
  const content = Array.isArray(result?.content) ? result.content : []
  return content.some((item: any) => item.type === 'image' && item.mimeType === mimeType)
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function jsonPathValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current == null) return undefined
    if (/^\d+$/.test(segment) && Array.isArray(current)) return current[Number(segment)]
    if (typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[segment]
  }, value)
}

function modeExpectationMap(
  expect: Record<string, unknown>,
  baseKey: string,
  modeKey: string,
  mode: string,
): Record<string, unknown> {
  const base = expect[baseKey]
  const modeValues = expect[modeKey]
  const selectedModeValues =
    modeValues && typeof modeValues === 'object' && !Array.isArray(modeValues)
      ? (modeValues as Record<string, unknown>)[mode]
      : undefined

  return {
    ...(base && typeof base === 'object' && !Array.isArray(base)
      ? base as Record<string, unknown>
      : {}),
    ...(selectedModeValues && typeof selectedModeValues === 'object' && !Array.isArray(selectedModeValues)
      ? selectedModeValues as Record<string, unknown>
      : {}),
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

function actionTraceToolName(event: ActionTraceEvent): string {
  if (event.toolName) return event.toolName
  if (event.status === 'started') return 'gemma_agent'
  return event.status
}

function modeExpectationValue(
  expect: Record<string, unknown>,
  baseKey: string,
  modeKey: string,
  mode: string,
): unknown {
  const modeValues = expect[modeKey]
  if (modeValues && typeof modeValues === 'object' && !Array.isArray(modeValues)) {
    const byMode = modeValues as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(byMode, mode)) return byMode[mode]
  }
  return expect[baseKey]
}

function taskEnabledForMode(task: BenchmarkTask, mode: string): boolean {
  if (Array.isArray(task.modes) && task.modes.length > 0 && !task.modes.includes(mode)) return false
  if (Array.isArray(task.skipModes) && task.skipModes.includes(mode)) return false
  return true
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function truncateTraceText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 300 ? `${normalized.slice(0, 300)}...(truncated)` : normalized
}

function sanitizeActionTraceEvent(activity: BridgeActivityMessage): ActionTraceEvent {
  return {
    status: activity.status,
    toolName: activity.toolName,
    requestId: activity.requestId,
    tabId: activity.tabId,
    title: activity.title,
    text: truncateTraceText(activity.text),
    timestamp: activity.timestamp,
  }
}

function compactBenchmarkToolText(name: string, args: Record<string, unknown>): string {
  const selector = typeof args.selector === 'string' ? args.selector : undefined
  const parts = [name]

  if (selector) parts.push(`selector=${selector}`)

  if (name === 'read_page_content' && typeof args.format === 'string') {
    parts.push(`format=${args.format}`)
  } else if (name === 'type_text') {
    const textLength = typeof args.text === 'string' ? args.text.length : 0
    parts.push(`textLength=${textLength}`)
    if (args.clear === false) parts.push('clear=false')
  } else if (name === 'select_option') {
    if (typeof args.value === 'string') parts.push(`value=${args.value}`)
    if (typeof args.label === 'string') parts.push(`label=${args.label}`)
  } else if (name === 'scroll_page') {
    if (typeof args.direction === 'string') parts.push(`direction=${args.direction}`)
    if (typeof args.amount === 'number') parts.push(`amount=${args.amount}`)
  } else if (name === 'run_javascript') {
    const codeLength = typeof args.code === 'string' ? args.code.length : 0
    parts.push(`codeLength=${codeLength}`)
  }

  return parts.join(' ')
}

async function resolveBrowserExecutable(): Promise<string> {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }

  if (existsSync(BROWSER_MARKER)) {
    const installed = (await readFile(BROWSER_MARKER, 'utf8')).trim()
    if (installed && existsSync(installed)) return installed
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found) return found

  throw new Error('No Chrome-compatible browser found. Run `pnpm browser:install` or set CHROME_PATH.')
}

async function readTasks(): Promise<BenchmarkTask[]> {
  const taskDir = resolve(BENCH_ROOT, 'tasks')
  const files = (await readdir(taskDir)).filter(file => file.endsWith('.json')).sort()
  const tasks: BenchmarkTask[] = []
  for (const file of files) {
    const parsed = JSON.parse(await readFile(resolve(taskDir, file), 'utf8')) as BenchmarkTask[]
    tasks.push(...parsed)
  }
  return tasks
}

class FakeExtension implements HarnessProbe {
  readonly mode = 'local-fake-extension'
  readonly supportsBridgeRequestLog = true
  readonly requests: BridgeRequest[] = []
  readonly toolErrors: string[] = []
  readonly clickedSelectors: string[] = []
  private ws: WebSocket | null = null
  private readonly values = new Map<string, string>()
  private readonly scrollPositions = new Map<number, number>()
  private readonly tabs: FakeTab[] = [
    { id: 101, active: true, title: 'Billing sandbox', url: 'http://127.0.0.1:4173/semantic-buttons.html' },
    { id: 102, active: false, title: 'Pricing sandbox', url: 'http://127.0.0.1:4173/extraction.html' },
    { id: 103, active: false, title: 'Profile source', url: 'http://127.0.0.1:4173/forms-source.html' },
    { id: 104, active: false, title: 'Profile destination', url: 'http://127.0.0.1:4173/forms-destination.html' },
    { id: 105, active: false, title: 'Navigation sandbox', url: 'http://127.0.0.1:4173/navigation.html' },
    { id: 106, active: false, title: 'Navigation sandbox', url: 'http://127.0.0.1:4173/navigation-billing.html' },
  ]

  constructor(private readonly port: number) {
    this.values.set('103:#source-name', 'Ada Lovelace')
    this.values.set('103:#source-email', 'ada@example.test')
    this.values.set('104:#dest-name', '')
    this.values.set('104:#dest-email', '')
    this.values.set('104:#dest-role', '')
    this.values.set('104:#dest-updates', 'unchecked')
    this.values.set('104:#dest-priority-low', 'unchecked')
    this.values.set('104:#dest-priority-high', 'unchecked')
    this.values.set('104:#dest-notes', '')
    this.values.set('104:#save-result', '')
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/extension?token=${TOKEN}`)
    await once(this.ws, 'open')
    this.ws.on('message', data => {
      const parsed = JSON.parse(data.toString('utf8')) as BridgeRequest | { type: string }
      if (parsed.type === 'bridge:keepalive') return
      const request = parsed as BridgeRequest
      this.requests.push(request)
      const response = this.handle(request)
      this.send(response)
    })
  }

  close(): void {
    this.ws?.close()
  }

  remapTask(task: BenchmarkTask): BenchmarkTask {
    return task
  }

  activateTab(logicalTabId: number): void {
    for (const tab of this.tabs) {
      tab.active = tab.id === logicalTabId
    }
  }

  requestCount(): number {
    return this.requests.length
  }

  actionCount(): number {
    return this.requests.filter(request => request.type === 'bridge:run_agent' || request.type === 'bridge:execute_tool').length
  }

  actionTraceSince(start: number): ActionTraceEvent[] {
    return this.requests
      .filter(request => request.type === 'bridge:run_agent' || request.type === 'bridge:execute_tool')
      .slice(start)
      .map(request => ({
        status: request.type === 'bridge:run_agent' ? 'started' : 'tool',
        toolName: request.type === 'bridge:execute_tool' ? request.name : 'gemma_agent',
        requestId: request.requestId,
        tabId: 'tabId' in request ? request.tabId : undefined,
        title: request.type,
        text: request.type === 'bridge:execute_tool'
          ? compactBenchmarkToolText(request.name, request.arguments)
          : truncateTraceText(request.prompt),
      }))
  }

  requestsSince(start: number): BridgeRequest[] {
    return this.requests.slice(start)
  }

  toolErrorCount(): number {
    return this.toolErrors.length
  }

  diagnostics(): Record<string, unknown> {
    return { mode: this.mode, bridgeRequests: this.requests.length, toolErrors: this.toolErrors.length }
  }

  selectorExists(selector: string, _logicalTabId?: number): boolean {
    const knownSelectors = new Set([
      '#download-receipt',
      '#download-invoice',
      '#payment-settings',
      '#source-name',
      '#source-email',
      '#dest-name',
      '#dest-email',
      '#dest-role',
      '#dest-updates',
      '#dest-priority-low',
      '#dest-priority-high',
      '#dest-notes',
      '#save-profile',
      '#save-result',
      '#settings-link',
      '#billing-link',
      '#scroll-target',
      'body',
    ])
    return knownSelectors.has(selector)
  }

  value(tabId: number, selector: string): string {
    return this.values.get(`${tabId}:${selector}`) ?? ''
  }

  clicked(selector: string): boolean {
    return this.clickedSelectors.includes(selector)
  }

  scrollY(tabId: number): number {
    return this.scrollPositions.get(tabId) ?? 0
  }

  urlPath(tabId: number): string {
    return new URL(this.tabs.find(tab => tab.id === tabId)?.url ?? 'http://127.0.0.1/').pathname
  }

  private send(event: BridgeEvent | BridgeEvent[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const events = Array.isArray(event) ? event : [event]
    for (const item of events) {
      this.ws.send(JSON.stringify(item))
    }
  }

  private handle(request: BridgeRequest): BridgeEvent | BridgeEvent[] {
    try {
      switch (request.type) {
        case 'bridge:list_tabs':
          return this.response(request.requestId, this.tabs)
        case 'bridge:get_active_tab':
          return this.response(request.requestId, this.tabs.find(tab => tab.active))
        case 'bridge:ensure_model_ready':
          return this.response(request.requestId, {
            modelId: 'gemma-4-e2b',
            status: 'ready',
            loadMs: 0,
            phase: 'fake-ready',
            progress: 100,
          })
        case 'bridge:run_agent':
          return this.runAgent(request)
        case 'bridge:execute_tool':
          return this.executeTool(request)
        case 'bridge:stop':
          return this.response(request.requestId, { stopped: true, runId: request.runId })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.toolErrors.push(message)
      return { type: 'bridge:response', requestId: request.requestId, error: message }
    }
  }

  private response(requestId: string, result: unknown): BridgeEvent {
    return { type: 'bridge:response', requestId, result }
  }

  private runAgent(request: Extract<BridgeRequest, { type: 'bridge:run_agent' }>): BridgeEvent | BridgeEvent[] {
    if (request.prompt.includes('gemma_observe')) {
      return this.response(request.requestId, JSON.stringify([
        {
          description: 'Download receipt PDF for invoice INV-2026-041',
          method: 'click',
          arguments: ['#download-receipt'],
          selector: '#download-receipt',
          confidence: 0.97,
        },
      ]))
    }

    if (request.prompt.includes('gemma_extract')) {
      if (request.prompt.includes('Scope selector: .plan[data-plan="starter"]')) {
        return this.response(request.requestId, JSON.stringify({
          plan: { name: 'Starter', price: '$19/month' },
        }))
      }

      if (request.prompt.includes('Scope selector: .plan[data-plan="team"]')) {
        return this.response(request.requestId, JSON.stringify({
          plan: { name: 'Team', price: '$49/month' },
        }))
      }

      return this.response(request.requestId, JSON.stringify({
        plans: [
          { name: 'Starter', price: '$19/month' },
          { name: 'Team', price: '$49/month' },
        ],
      }))
    }

    const wantsSettings = /open payment settings/i.test(request.prompt)
    const wantsInvoice = /download the invoice PDF/i.test(request.prompt)
    const targetSelector = wantsSettings ? '#payment-settings' : wantsInvoice ? '#download-invoice' : '#download-receipt'
    const targetKind = wantsSettings ? 'payment settings' : wantsInvoice ? 'invoice' : 'receipt'
    if (/simulate transient runtime error after clicking receipt/i.test(request.prompt)) {
      return [
        {
          type: 'bridge:chunk',
          requestId: request.requestId,
          text: '[Tool] click_element({"selector":"#download-receipt"})',
        },
        this.response(request.requestId, {
          text: 'Something went wrong: operation does not support unaligned accesses',
        }),
      ]
    }
    if (/simulate transient runtime error after clicking invoice/i.test(request.prompt)) {
      return [
        {
          type: 'bridge:chunk',
          requestId: request.requestId,
          text: '[Tool] click_element({"selector":"#download-invoice"})',
        },
        this.response(request.requestId, {
          text: 'Something went wrong: operation does not support unaligned accesses',
        }),
      ]
    }
    if (/simulate transient runtime error after clicking settings/i.test(request.prompt)) {
      return [
        {
          type: 'bridge:chunk',
          requestId: request.requestId,
          text: '[Tool] click_element({"selector":"#payment-settings"})',
        },
        this.response(request.requestId, {
          text: 'Something went wrong: operation does not support unaligned accesses',
        }),
      ]
    }
    if (/simulate transient runtime error before clicking receipt/i.test(request.prompt)) {
      return this.response(request.requestId, {
        text: 'Something went wrong: operation does not support unaligned accesses',
      })
    }
    if (/simulate transient runtime error before clicking invoice/i.test(request.prompt)) {
      return this.response(request.requestId, {
        text: 'Something went wrong: operation does not support unaligned accesses',
      })
    }
    if (/simulate transient runtime error before clicking settings/i.test(request.prompt)) {
      return this.response(request.requestId, {
        text: 'Something went wrong: operation does not support unaligned accesses',
      })
    }

    return [
      {
        type: 'bridge:chunk',
        requestId: request.requestId,
        text: `[Thinking] The ${targetKind} control is the right billing control.`,
      },
      this.response(request.requestId, {
        text: `SUCCESS: selected ${targetSelector} for ${targetKind} on INV-2026-041`,
      }),
    ]
  }

  private executeTool(request: Extract<BridgeRequest, { type: 'bridge:execute_tool' }>): BridgeEvent {
    const tabId = request.tabId ?? 101
    const args = request.arguments
    switch (request.name) {
      case 'read_page_content':
        return this.response(request.requestId, { content: this.read(tabId, String(args.selector ?? 'body'), String(args.format ?? 'text')) })
      case 'type_text': {
        const selector = String(args.selector)
        const text = String(args.text ?? '')
        if (!this.selectorExists(selector)) {
          return this.response(request.requestId, { error: `No element found for selector: ${selector}` })
        }
        const value = args.clear === false ? `${this.value(tabId, selector)}${text}` : text
        this.values.set(`${tabId}:${selector}`, value)
        return this.response(request.requestId, { typed: text, into: selector, value })
      }
      case 'click_element': {
        const selector = String(args.selector)
        if (!this.selectorExists(selector)) {
          return this.response(request.requestId, { error: `No element found for selector: ${selector}` })
        }
        this.clickedSelectors.push(selector)
        if (selector === '#save-profile') {
          const name = this.value(104, '#dest-name')
          const email = this.value(104, '#dest-email')
          this.values.set('104:#save-result', `Saved ${name} <${email}>`)
        }
        if (selector === '#dest-updates') {
          this.values.set('104:#dest-updates', this.value(104, '#dest-updates') === 'checked' ? 'unchecked' : 'checked')
        }
        if (selector === '#dest-priority-low' || selector === '#dest-priority-high') {
          this.values.set('104:#dest-priority-low', selector === '#dest-priority-low' ? 'checked' : 'unchecked')
          this.values.set('104:#dest-priority-high', selector === '#dest-priority-high' ? 'checked' : 'unchecked')
        }
        if (selector === '#settings-link' || selector === '#billing-link') {
          const tab = this.tabs.find(item => item.id === tabId)
          if (tab) tab.url = `http://127.0.0.1:4173/${selector === '#settings-link' ? 'settings' : 'billing'}`
        }
        const label = selector === '#download-receipt'
          ? 'button: Receipt PDF'
          : selector === '#download-invoice'
            ? 'button: Invoice PDF'
            : selector === '#payment-settings'
              ? 'button: Payment settings'
          : selector === '#settings-link'
            ? 'a: Settings'
            : selector === '#billing-link'
              ? 'a: Billing'
              : selector === '#dest-updates'
                ? 'input: '
                : selector === '#dest-priority-low' || selector === '#dest-priority-high'
                  ? 'input: '
                  : selector
        return this.response(request.requestId, { clicked: label, selector })
      }
      case 'select_option': {
        const selector = String(args.selector)
        if (!this.selectorExists(selector)) {
          return this.response(request.requestId, { error: `No select element found for selector: ${selector}` })
        }
        const selected = args.value === 'admin' || args.label === 'Administrator'
          ? { label: 'Administrator', value: 'admin' }
          : args.value === 'reviewer' || args.label === 'Reviewer'
            ? { label: 'Reviewer', value: 'reviewer' }
            : { label: String(args.label ?? args.value ?? ''), value: String(args.value ?? args.label ?? '') }
        this.values.set(`${tabId}:${selector}`, selected.value)
        return this.response(request.requestId, { selected: selected.label, value: selected.value, selector })
      }
      case 'scroll_page':
        const amount = Number(args.amount ?? 500)
        const delta = args.direction === 'up' ? -amount : amount
        const nextScrollY = Math.max(0, this.scrollY(tabId) + delta)
        this.scrollPositions.set(tabId, nextScrollY)
        return this.response(request.requestId, { scrolled: `${args.direction} ${amount}px`, scrollY: nextScrollY })
      case 'take_screenshot':
        return this.response(request.requestId, {
          screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        })
      case 'run_javascript':
        return this.response(request.requestId, { error: 'run_javascript is not part of this benchmark harness' })
    }
  }

  private read(tabId: number, selector: string, format = 'text'): string {
    if (tabId === 101) {
      if (selector === '#download-receipt') return 'Receipt PDF'
      if (selector === '#download-invoice') return 'Invoice PDF'
      if (selector === '#payment-settings') return 'Payment settings'
      if (format === 'html') {
        return [
          '<h1>Invoice INV-2026-041</h1>',
          '<p>Last payment: paid on May 20, 2026.</p>',
          '<button id="download-receipt">Receipt PDF</button>',
          '<button id="download-invoice">Invoice PDF</button>',
          '<button id="payment-settings">Payment settings</button>',
        ].join('\n')
      }
      return [
        'Invoice INV-2026-041',
        'Last payment: paid on May 20, 2026.',
        'Receipt PDF',
        'Invoice PDF',
        'Payment settings',
      ].join('\n')
    }
    if (tabId === 102) {
      if (selector === 'body' && format === 'html') {
        return [
          '<main>',
          '<section class="plan" data-plan="starter">',
          '<h2>Starter</h2>',
          '<p class="price">$19/month</p>',
          '</section>',
          '<section class="plan" data-plan="team">',
          '<h2>Team</h2>',
          '<p class="price">$49/month</p>',
          '</section>',
          '</main>',
        ].join('\n')
      }
      if (selector === '.plan[data-plan="starter"]') {
        if (format === 'html') {
          return [
            '<h2>Starter</h2>',
            '<p class="price">$19/month</p>',
          ].join('\n')
        }
        return 'Starter $19/month'
      }
      if (selector === '.plan[data-plan="team"]') {
        if (format === 'html') {
          return [
            '<h2>Team</h2>',
            '<p class="price">$49/month</p>',
          ].join('\n')
        }
        return 'Team $49/month'
      }
      return ['Starter $19/month', 'Team $49/month'].join('\n')
    }
    if (tabId === 103) {
      if (selector === 'body' && format === 'html') {
        return [
          '<main>',
          '<dl>',
          '<dt>Name</dt>',
          '<dd id="source-name">Ada Lovelace</dd>',
          '<dt>Email</dt>',
          '<dd id="source-email">ada@example.test</dd>',
          '</dl>',
          '</main>',
        ].join('\n')
      }
      if (selector === 'body') {
        return [
          'Name',
          'Ada Lovelace',
          'Email',
          'ada@example.test',
        ].join('\n')
      }
      return this.value(103, selector)
    }
    if (tabId === 104) {
      if (selector === 'body' && format === 'html') {
        return [
          '<main>',
          '<label>Name <input id="dest-name" name="name"></label>',
          '<label>Email <input id="dest-email" name="email"></label>',
          '<label>Role <select id="dest-role" name="role"><option value="">Choose role</option><option value="admin">Administrator</option><option value="reviewer">Reviewer</option></select></label>',
          '<label><input id="dest-updates" name="updates" type="checkbox" value="subscribe"> Subscribe updates</label>',
          '<label><input id="dest-priority-low" name="priority" type="radio" value="low"> Priority Low</label>',
          '<label><input id="dest-priority-high" name="priority" type="radio" value="high"> Priority High</label>',
          '<label>Notes <textarea id="dest-notes" name="notes"></textarea></label>',
          '<button id="save-profile">Save profile</button>',
          '<p id="save-result"></p>',
          '</main>',
        ].join('\n')
      }
      if (selector === 'body') {
        return [
          'Name',
          'Email',
          'Role',
          'Choose role',
          'Administrator',
          'Reviewer',
          'Subscribe updates',
          'Priority Low',
          'Priority High',
          'Notes',
          'Save profile',
          this.value(104, '#save-result'),
        ].filter(Boolean).join('\n')
      }
      if (selector === '#dest-role') {
        const selectedValue = this.value(104, '#dest-role')
        const selectedLabel = selectedValue === 'admin'
          ? 'Administrator'
          : selectedValue === 'reviewer'
            ? 'Reviewer'
            : 'Choose role'
        return [
          `selected: ${selectedLabel} (${selectedValue})`,
          'options:',
          'Choose role',
          'Administrator',
          'Reviewer',
        ].join('\n')
      }
      if (selector === '#save-profile') return 'Save profile'
      if (selector === '#save-result' && format === 'html') return escapeHtmlText(this.value(104, selector))
      return this.value(104, selector)
    }
    if (tabId === 105 || tabId === 106) {
      if (selector === 'body' && format === 'html') {
        return [
          '<main>',
          '<a id="settings-link" href="/settings">Settings</a>',
          '<a id="billing-link" href="/billing">Billing</a>',
          '<p id="scroll-target">Scroll target reached</p>',
          '</main>',
        ].join('\n')
      }
      if (selector === 'body') {
        return [
          'Settings',
          'Billing',
          'Scroll target reached',
        ].join('\n')
      }
      if (selector === '#settings-link') return 'Settings'
      if (selector === '#billing-link') return 'Billing'
      if (selector === '#scroll-target') return 'Scroll target reached'
    }
    return ''
  }
}

class CdpSession {
  private id = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(private readonly ws: WebSocket) {
    ws.on('message', data => {
      const message = JSON.parse(data.toString('utf8'))
      if (typeof message.id !== 'number') return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      } else {
        entry.resolve(message.result)
      }
    })
  }

  static async connect(url: string): Promise<CdpSession> {
    const ws = new WebSocket(url)
    await once(ws, 'open')
    return new CdpSession(ws)
  }

  send(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  close(): void {
    this.ws.close()
  }
}

type ChromeTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

class RealChromeHarness implements HarnessProbe {
  readonly mode = INCLUDE_AGENT_TASKS ? 'real-chrome-extension-agent' : 'real-chrome-extension-smoke'
  readonly supportsBridgeRequestLog = false
  readonly requests: BridgeRequest[] = []
  private readonly logicalToChromeTab = new Map<number, number>()
  private readonly logicalToTarget = new Map<number, string>()
  private browserSession: CdpSession | null = null
  private extensionWorkerSession: CdpSession | null = null
  private chromeOutput = ''
  private loadedExtensionId: string | undefined

  constructor(
    private readonly chrome: ChildProcess,
    private readonly browserExe: string,
    private readonly chromePort: number,
    private readonly userDataDir: string,
    private readonly cleanupUserDataDir: boolean,
    private readonly staticServer: HttpServer,
    private readonly staticPort: number,
    private readonly sidecarPort: number,
  ) {}

  static async launch(sidecarPort: number): Promise<RealChromeHarness> {
    const browserExe = await resolveBrowserExecutable()
    if (!existsSync(resolve(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error(`Built extension not found at ${EXTENSION_DIR}. Run pnpm build first.`)
    }

    const chromePort = await getFreePort()
    const staticServer = await startStaticServer()
    const staticAddress = staticServer.address()
    if (!staticAddress || typeof staticAddress === 'string') {
      staticServer.close()
      throw new Error('Could not determine static server port')
    }

    const { mkdtemp, mkdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const defaultPersistentProfile = INCLUDE_AGENT_TASKS && !FRESH_PROFILE
      ? DEFAULT_AGENT_PROFILE
      : undefined
    const persistentProfile = process.env.GEMMA_GEM_CHROME_PROFILE ?? defaultPersistentProfile
    const userDataDir = persistentProfile
      ? resolve(persistentProfile)
      : await mkdtemp(join(tmpdir(), 'gemma-gem-bench-'))
    if (persistentProfile) await mkdir(userDataDir, { recursive: true })
    const loadExtension = process.env.GEMMA_GEM_SKIP_LOAD_EXTENSION !== '1'
    const chromeArgs = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${chromePort}`,
      '--enable-extensions',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--window-size=1280,900',
      'about:blank',
    ]
    if (loadExtension) {
      chromeArgs.splice(4, 0, `--load-extension=${EXTENSION_DIR}`)
    }
    const chrome = spawn(browserExe, chromeArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    const harness = new RealChromeHarness(chrome, browserExe, chromePort, userDataDir, !persistentProfile, staticServer, staticAddress.port, sidecarPort)
    harness.chromeOutput += persistentProfile
      ? `\nBenchmark Chrome profile: persistent ${userDataDir}`
      : `\nBenchmark Chrome profile: temporary ${userDataDir}`
    console.log(`Chrome executable: ${browserExe}`)
    console.log(`Chrome profile: ${persistentProfile ? `persistent ${userDataDir}` : `temporary ${userDataDir}`}`)
    chrome.stderr?.on('data', chunk => {
      harness.chromeOutput += chunk.toString('utf8')
    })
    try {
      await harness.waitForBrowser()
      await harness.loadExtensionWithCdp()
      await harness.openFixtureTabs()
      await harness.configureExtensionBridge(sidecarPort)
      return harness
    } catch (error) {
      await harness.close()
      throw error
    }
  }

  remapTask(task: BenchmarkTask): BenchmarkTask {
    return {
      ...task,
      arguments: this.remapArguments(task.arguments),
    }
  }

  async activateTab(logicalTabId: number): Promise<void> {
    await this.activateLogicalTab(logicalTabId)
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  requestCount(): number {
    return this.requests.length
  }

  requestsSince(start: number): BridgeRequest[] {
    return this.requests.slice(start)
  }

  async actionCount(): Promise<number> {
    const activities = await this.bridgeActivityForDiagnostics()
    return activities.filter(activity => activity.status === 'started' || activity.status === 'tool').length
  }

  async actionTraceSince(start: number): Promise<ActionTraceEvent[]> {
    const activities = await this.bridgeActivityForDiagnostics()
    return activities
      .filter(activity => activity.status === 'started' || activity.status === 'tool')
      .slice(start)
      .map(activity => sanitizeActionTraceEvent(activity))
  }

  toolErrorCount(): number {
    return 0
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return {
      mode: this.mode,
      browserExecutable: this.browserExe,
      userDataDir: this.userDataDir,
      bridgeStatus: await this.bridgeStatusForDiagnostics(),
      modelStatus: await this.modelStatusForDiagnostics(),
      bridgeActivityCount: (await this.bridgeActivityForDiagnostics()).length,
      chromeOutputTail: this.chromeOutput.slice(-1000),
    }
  }

  async selectorExists(selector: string, logicalTabId = 101): Promise<boolean> {
    const session = await this.pageSessionForLogicalTab(logicalTabId)
    const value = await this.evaluate(session, `!!document.querySelector(${JSON.stringify(selector)})`)
    session.close()
    return value === true
  }

  async value(logicalTabId: number, selector: string): Promise<string> {
    const session = await this.pageSessionForLogicalTab(logicalTabId)
    const value = await this.evaluate(session, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return '';
        if ('value' in el) return el.value ?? '';
        return el.textContent ?? '';
      })()
    `)
    session.close()
    return String(value ?? '')
  }

  async clicked(selector: string): Promise<boolean> {
    if (selector === '#save-profile') {
      return (await this.value(104, '#save-result')).includes('Saved')
    }
    const activities = await this.bridgeActivityForDiagnostics()
    return activities.some(activity =>
      activity.status === 'tool' &&
      activity.toolName === 'click_element' &&
      typeof activity.text === 'string' &&
      (activity.text.includes(`"selector":"${selector}"`) || activity.text.includes(`selector=${selector}`))
    )
  }

  async scrollY(logicalTabId: number): Promise<number> {
    const session = await this.pageSessionForLogicalTab(logicalTabId)
    const value = await this.evaluate(session, 'window.scrollY')
    session.close()
    return typeof value === 'number' ? value : Number(value ?? 0)
  }

  async urlPath(logicalTabId: number): Promise<string> {
    const session = await this.pageSessionForLogicalTab(logicalTabId)
    const value = await this.evaluate(session, 'location.pathname')
    session.close()
    return String(value ?? '')
  }

  async close(): Promise<void> {
    this.extensionWorkerSession?.close()
    this.browserSession?.close()
    this.staticServer.close()
    if (!this.chrome.killed) this.chrome.kill()
    const { rm } = await import('node:fs/promises')
    if (this.cleanupUserDataDir) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private remapArguments(value: unknown): any {
    if (Array.isArray(value)) return value.map(item => this.remapArguments(item))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'tabId' || key === 'sourceTabId' || key === 'destinationTabId') && typeof item === 'number') {
          out[key] = this.logicalToChromeTab.get(item) ?? item
        } else {
          out[key] = this.remapArguments(item)
        }
      }
      return out
    }
    return value
  }

  private async waitForBrowser(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        const version = await fetch(`http://127.0.0.1:${this.chromePort}/json/version`).then(r => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
        this.browserSession = await CdpSession.connect(version.webSocketDebuggerUrl)
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    throw new Error('Timed out waiting for Chrome DevTools endpoint')
  }

  private async loadExtensionWithCdp(): Promise<void> {
    if (!this.browserSession) throw new Error('Browser session is not connected')
    const result = await this.browserSession.send('Extensions.loadUnpacked', {
      path: EXTENSION_DIR,
    }).catch(error => {
      this.chromeOutput += `\nExtensions.loadUnpacked failed: ${error instanceof Error ? error.message : String(error)}`
      return undefined
    })
    if (typeof result?.id === 'string') {
      this.loadedExtensionId = result.id
      this.chromeOutput += `\nExtensions.loadUnpacked loaded ${result.id}`
    }
  }

  private async openFixtureTabs(): Promise<void> {
    if (!this.browserSession) throw new Error('Browser session is not connected')
    const pages: Array<[number, string]> = [
      [101, 'semantic-buttons.html'],
      [102, 'extraction.html'],
      [103, 'forms-source.html'],
      [104, 'forms-destination.html'],
      [105, 'navigation.html'],
      [106, 'navigation-billing.html'],
    ]

    for (const [logicalId, page] of pages) {
      const url = `http://127.0.0.1:${this.staticPort}/${page}`
      const result = await this.browserSession.send('Target.createTarget', { url })
      this.logicalToTarget.set(logicalId, result.targetId)
    }
    const activeTarget = this.logicalToTarget.get(101)
    if (activeTarget) {
      await this.browserSession.send('Target.activateTarget', { targetId: activeTarget }).catch(() => {})
    }

    await new Promise(resolve => setTimeout(resolve, 1_000))
  }

  private async configureExtensionBridge(sidecarPort: number): Promise<void> {
    const extensionId = await this.waitForLoadedExtensionId()
    if (!this.browserSession) throw new Error('Browser session is not connected')
    await this.browserSession.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options.html`,
    }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const worker = await this.waitForExtensionWorker(extensionId)
    this.extensionWorkerSession = await CdpSession.connect(worker.webSocketDebuggerUrl!)
    await this.waitForBenchmarkHook(this.extensionWorkerSession)
    const hookResult = await this.extensionWorkerSession.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `
        globalThis.__gemmaGemBenchmarkConnectBridge?.({
          enabled: true,
          port: ${sidecarPort},
          token: ${JSON.stringify(TOKEN)}
        })
      `,
    })
    if (hookResult.exceptionDetails) {
      throw new Error(`Benchmark bridge hook failed: ${JSON.stringify(hookResult.exceptionDetails)}`)
    }
    if (!hookResult.result?.value) {
      throw new Error('Benchmark bridge hook is unavailable. Build the extension with pnpm build before running --real.')
    }
    await this.waitForBridgeConnected(this.extensionWorkerSession)
    await new Promise(resolve => setTimeout(resolve, 2_000))
    await this.mapChromeTabIds()
    await this.activateLogicalTab(101)
  }

  private async mapChromeTabIds(): Promise<void> {
    const deadline = Date.now() + 20_000
    let lastFailure = 'no attempts completed'
    while (Date.now() < deadline) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${this.sidecarPort}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        })
        const client = new Client({ name: 'gemma-gem-real-map', version: '0.0.0' })
        await client.connect(transport)
        try {
          const result = await client.callTool({ name: 'gemma_tabs', arguments: {} })
          const text = toolText(result)
          let tabs: Array<{ id: number; url?: string }>
          try {
            tabs = JSON.parse(text) as Array<{ id: number; url?: string }>
          } catch (error) {
            throw new Error(`gemma_tabs returned non-JSON text: ${text}`)
          }
          lastFailure = `mapped ${this.logicalToChromeTab.size}/${this.logicalToTarget.size}; tabs=${JSON.stringify(tabs.map(tab => ({ id: tab.id, url: tab.url })))}`
          for (const [logicalId, targetId] of this.logicalToTarget.entries()) {
            const target = await this.targetById(targetId)
            const tab = tabs.find(item => item.url === target?.url)
            if (tab) this.logicalToChromeTab.set(logicalId, tab.id)
          }
          if (this.logicalToChromeTab.size >= this.logicalToTarget.size) return
        } finally {
          await client.close()
        }
      } catch (error) {
        const status = await this.bridgeStatusForDiagnostics()
        lastFailure = `${error instanceof Error ? error.message : String(error)}; extensionStatus=${status}`
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    throw new Error(`Timed out waiting for Gemma Gem extension bridge tabs (${lastFailure})`)
  }

  private async waitForLoadedExtensionId(): Promise<string> {
    if (process.env.GEMMA_GEM_EXTENSION_ID) return process.env.GEMMA_GEM_EXTENSION_ID
    if (this.loadedExtensionId) return this.loadedExtensionId

    const prefsPath = resolve(this.userDataDir, 'Default', 'Preferences')
    const deadline = Date.now() + 30_000
    let lastSettings: Array<{ id: string; name?: string; path?: string }> = []
    while (Date.now() < deadline) {
      try {
        const prefs = JSON.parse(await readFile(prefsPath, 'utf8')) as {
          extensions?: { settings?: Record<string, { manifest?: { name?: string }; path?: string }> }
        }
        const settings = prefs.extensions?.settings ?? {}
        lastSettings = Object.entries(settings).map(([id, item]) => ({
          id,
          name: item.manifest?.name,
          path: item.path,
        }))
        for (const [id, item] of Object.entries(settings)) {
          const name = item.manifest?.name ?? ''
          const path = (item.path ?? '').replaceAll('\\', '/')
          if (name.includes('Gemma Gem') || path.endsWith('/.output/chrome-mv3-dev')) {
            return id
          }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Timed out waiting for Chrome to register Gemma Gem extension in ${prefsPath}. Registered extensions: ${JSON.stringify(lastSettings)}. Chrome output: ${this.chromeOutput.slice(-2000)}`)
  }

  private async waitForExtensionWorker(extensionId: string): Promise<ChromeTarget> {
    const deadline = Date.now() + 20_000
    let lastWorkers: ChromeTarget[] = []
    while (Date.now() < deadline) {
      const targets = await this.targets()
      lastWorkers = targets.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'))
      const worker = lastWorkers.find(target => target.url === `chrome-extension://${extensionId}/background.js`)
      if (worker?.webSocketDebuggerUrl) return worker
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out waiting for Gemma Gem service worker. Saw workers: ${JSON.stringify(lastWorkers.map(worker => worker.url))}. Chrome output: ${this.chromeOutput.slice(-2000)}`)
  }

  private async waitForBenchmarkHook(session: CdpSession): Promise<void> {
    const deadline = Date.now() + 10_000
    let lastValue = 'unknown'
    while (Date.now() < deadline) {
      const result = await session.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ href: location.href, hook: typeof globalThis.__gemmaGemBenchmarkConnectBridge, keys: Object.keys(globalThis).filter(k => k.includes("gemma") || k.includes("Gemma")) })',
        returnByValue: true,
      })
      lastValue = String(result.result?.value ?? result.exceptionDetails?.text ?? 'unknown')
      try {
        const parsed = JSON.parse(lastValue) as { hook?: string }
        if (parsed.hook === 'function') return
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Benchmark bridge hook is unavailable. Build the extension with pnpm build before running --real. Last worker state: ${lastValue}`)
  }

  private async waitForBridgeConnected(session: CdpSession): Promise<void> {
    const deadline = Date.now() + 15_000
    let lastStatus = 'unknown'
    while (Date.now() < deadline) {
      const result = await session.send('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__gemmaGemBenchmarkBridgeStatus?.())',
        returnByValue: true,
      })
      lastStatus = String(result.result?.value ?? result.exceptionDetails?.text ?? 'unknown')
      try {
        const parsed = JSON.parse(lastStatus) as { status?: string; error?: string }
        if (parsed.status === 'connected') return
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    throw new Error(`Timed out waiting for extension bridge connection. Last status: ${lastStatus}. Chrome output: ${this.chromeOutput.slice(-2000)}`)
  }

  private async bridgeStatusForDiagnostics(): Promise<string> {
    if (!this.extensionWorkerSession) return 'no-worker-session'
    try {
      const result = await this.extensionWorkerSession.send('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__gemmaGemBenchmarkBridgeStatus?.())',
        returnByValue: true,
      })
      return String(result.result?.value ?? result.exceptionDetails?.text ?? 'unknown')
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private async modelStatusForDiagnostics(): Promise<string> {
    if (!this.extensionWorkerSession) return 'no-worker-session'
    try {
      const result = await this.extensionWorkerSession.send('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__gemmaGemBenchmarkModelStatus?.())',
        returnByValue: true,
      })
      return String(result.result?.value ?? result.exceptionDetails?.text ?? 'unknown')
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private async bridgeActivityForDiagnostics(): Promise<BridgeActivityMessage[]> {
    if (!this.extensionWorkerSession) return []
    try {
      const result = await this.extensionWorkerSession.send('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__gemmaGemBenchmarkBridgeActivity?.() ?? [])',
        returnByValue: true,
      })
      const text = String(result.result?.value ?? '[]')
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private async targets(): Promise<ChromeTarget[]> {
    return fetch(`http://127.0.0.1:${this.chromePort}/json/list`).then(r => r.json() as Promise<ChromeTarget[]>)
  }

  private async targetById(targetId: string): Promise<ChromeTarget | undefined> {
    const targets = await this.targets()
    return targets.find(target => target.id === targetId)
  }

  private async pageSessionForLogicalTab(logicalTabId: number): Promise<CdpSession> {
    const targetId = this.logicalToTarget.get(logicalTabId)
    if (!targetId) throw new Error(`No target for logical tab ${logicalTabId}`)
    const target = await this.targetById(targetId)
    if (!target?.webSocketDebuggerUrl) throw new Error(`No CDP URL for logical tab ${logicalTabId}`)
    return CdpSession.connect(target.webSocketDebuggerUrl)
  }

  private async activateLogicalTab(logicalTabId: number): Promise<void> {
    if (!this.browserSession) throw new Error('Browser session is not connected')
    const targetId = this.logicalToTarget.get(logicalTabId)
    if (!targetId) throw new Error(`No target for logical tab ${logicalTabId}`)
    await this.browserSession.send('Target.activateTarget', { targetId }).catch(() => {})
  }

  private async evaluate(session: CdpSession, expression: string): Promise<unknown> {
    const result = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    return result.result?.value
  }
}

async function startStaticServer(): Promise<HttpServer> {
  const server = createHttpServer(async (req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const file = rawPath === '/' ? 'semantic-buttons.html' : rawPath.slice(1)
    const safeFile = file.replace(/[^a-zA-Z0-9_.-]/g, '')
    const path = resolve(BENCH_ROOT, 'pages', safeFile)
    if (!path.startsWith(resolve(BENCH_ROOT, 'pages')) || !existsSync(path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(await readFile(path))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

async function startSidecar(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'host/src/index.ts', '--http'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GEMMA_GEM_BRIDGE_TOKEN: TOKEN,
      GEMMA_GEM_BRIDGE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForOutput(child, /HTTP MCP listening/)
  return child
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timer])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function runModelReadyPreflight(client: Client): Promise<ModelReadyPreflight> {
  if (!(REAL_MODE && INCLUDE_AGENT_TASKS)) {
    return { status: 'skipped', durationMs: 0 }
  }

  const start = performance.now()
  try {
    const result = await withTimeout(client.callTool({
      name: 'gemma_model_ready',
      arguments: { timeoutMs: MODEL_READY_TIMEOUT_MS },
    }, undefined, { timeout: MODEL_READY_TIMEOUT_MS + 15_000 }), MODEL_READY_TIMEOUT_MS + 20_000)
    const text = toolText(result)
    const parsed = parseJsonText(text) as {
      modelId?: string
      status?: string
      loadMs?: number
      phase?: string
      progress?: number
      error?: string
    }
    const status = parsed.status === 'ready' ? 'ready' : 'error'
    return {
      status,
      durationMs: typeof parsed.loadMs === 'number' ? parsed.loadMs : performance.now() - start,
      modelId: parsed.modelId,
      phase: parsed.phase,
      progress: parsed.progress,
      error: parsed.error,
      outputPreview: text.slice(0, 1000),
    }
  } catch (error) {
    return {
      status: 'error',
      durationMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runTask(client: Client, harness: HarnessProbe, task: BenchmarkTask): Promise<TaskResult> {
  const start = performance.now()
  if (typeof task.expect.activateTabId === 'number') {
    await harness.activateTab(task.expect.activateTabId)
  }
  const taskForCall = harness.remapTask(task)
  const startRequestCount = harness.requestCount()
  const startActionCount = await harness.actionCount()
  const startErrorCount = harness.toolErrorCount()
  const notes: string[] = []
  let success = false
  let strict = false
  let jsonRequired = false
  let jsonValid = false
  let selectorChecks = 0
  let selectorHits = 0
  let timeout = false
  let outputPreview: string | undefined

  try {
    const timeoutMs = MODEL_DRIVEN_TOOLS.has(taskForCall.tool)
      ? AGENT_TASK_TIMEOUT_MS
      : DEFAULT_TASK_TIMEOUT_MS
    const result = await withTimeout(client.callTool({
      name: taskForCall.tool,
      arguments: taskForCall.arguments,
    }, undefined, { timeout: timeoutMs }), timeoutMs + 5_000)

    const text = toolText(result)
    outputPreview = text.slice(0, 1000)
    const expect = task.expect
    const modeContains =
      expect.containsByMode &&
      typeof expect.containsByMode === 'object' &&
      !Array.isArray(expect.containsByMode)
        ? (expect.containsByMode as Record<string, unknown>)[harness.mode]
        : undefined
    const contains = [
      ...(Array.isArray(expect.contains) ? expect.contains.map(String) : []),
      ...(Array.isArray(modeContains) ? modeContains.map(String) : []),
    ]
    const containsOk = contains.every(item => text.includes(item))
    if (!containsOk) {
      notes.push(`missing expected text in result: ${contains.filter(item => !text.includes(item)).join(', ')}`)
    }
    const notContains = Array.isArray(expect.notContains) ? expect.notContains.map(String) : []
    const absentOk = notContains.every(item => !text.includes(item))
    if (!absentOk) {
      notes.push(`unexpected text in result: ${notContains.filter(item => text.includes(item)).join(', ')}`)
    }

    let jsonOk = true
    let parsedJson: any
    if (typeof expect.json === 'string') {
      jsonRequired = true
      jsonOk = false
      try {
        parsedJson = parseJsonText(text)
        jsonValid = true
        jsonOk = expect.json === 'array' ? Array.isArray(parsedJson) : !Array.isArray(parsedJson) && typeof parsedJson === 'object'
      } catch (error) {
        notes.push(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (typeof expect.selector === 'string') {
      selectorChecks += 1
      const selectorTabId = typeof task.arguments.tabId === 'number' ? task.arguments.tabId : undefined
      const selectorExists = await harness.selectorExists(expect.selector, selectorTabId)
      selectorHits += selectorExists ? 1 : 0
      if (!selectorExists) notes.push(`selector not found: ${expect.selector}`)
      if (Array.isArray(parsedJson)) {
        const hasSelector = parsedJson.some(item => item?.selector === expect.selector)
        const hasMethod = typeof expect.method !== 'string' || parsedJson.some(item => item?.method === expect.method)
        jsonOk = jsonOk && hasSelector && hasMethod
        if (!hasSelector) notes.push(`JSON did not contain selector ${expect.selector}`)
        if (!hasMethod) notes.push(`JSON did not contain method ${expect.method}`)
      }
    }

    if (typeof expect.minPlans === 'number' && parsedJson?.plans?.length < expect.minPlans) {
      notes.push(`expected at least ${expect.minPlans} plans`)
      jsonOk = false
    }
    if (typeof expect.minItems === 'number' && Array.isArray(parsedJson) && parsedJson.length < expect.minItems) {
      notes.push(`expected at least ${expect.minItems} JSON array items`)
      jsonOk = false
    }
    const expectedItemCount = modeExpectationValue(expect, 'itemCount', 'itemCountByMode', harness.mode)
    if (typeof expectedItemCount === 'number' && Number.isFinite(expectedItemCount)) {
      if (!Array.isArray(parsedJson)) {
        notes.push(`expected JSON array with ${expectedItemCount} items, got ${JSON.stringify(parsedJson)}`)
        jsonOk = false
      } else if (parsedJson.length !== expectedItemCount) {
        notes.push(`expected ${expectedItemCount} JSON array items, got ${parsedJson.length}`)
        jsonOk = false
      }
    }
    if (typeof expect.bestSelector === 'string') {
      const bestSelector = parsedJson?.best?.candidate?.selector ?? parsedJson?.best?.action?.selector
      if (bestSelector !== expect.bestSelector) {
        notes.push(`expected best selector ${expect.bestSelector}, got ${JSON.stringify(bestSelector)}`)
        jsonOk = false
      }
    }
    const jsonFields = modeExpectationMap(expect, 'jsonFields', 'jsonFieldsByMode', harness.mode)
    for (const [path, expectedValue] of Object.entries(jsonFields)) {
      const actualValue = jsonPathValue(parsedJson, path)
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        notes.push(`expected JSON field ${path}=${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`)
        jsonOk = false
      }
    }

    const jsonFieldIncludes = modeExpectationMap(expect, 'jsonFieldIncludes', 'jsonFieldIncludesByMode', harness.mode)
    for (const [path, expectedValues] of Object.entries(jsonFieldIncludes)) {
      const actualValue = jsonPathValue(parsedJson, path)
      const expectedStrings = stringArray(expectedValues)
      if (typeof actualValue !== 'string') {
        notes.push(`expected JSON field ${path} to be a string, got ${JSON.stringify(actualValue)}`)
        jsonOk = false
        continue
      }
      const missing = expectedStrings.filter(expectedValue => !actualValue.includes(expectedValue))
      if (missing.length > 0) {
        notes.push(`expected JSON field ${path} to include ${missing.map(item => JSON.stringify(item)).join(', ')}`)
        jsonOk = false
      }
    }

    const jsonFieldExcludes = modeExpectationMap(expect, 'jsonFieldExcludes', 'jsonFieldExcludesByMode', harness.mode)
    for (const [path, expectedValues] of Object.entries(jsonFieldExcludes)) {
      const actualValue = jsonPathValue(parsedJson, path)
      const expectedStrings = stringArray(expectedValues)
      if (typeof actualValue !== 'string') {
        notes.push(`expected JSON field ${path} to be a string, got ${JSON.stringify(actualValue)}`)
        jsonOk = false
        continue
      }
      const present = expectedStrings.filter(expectedValue => actualValue.includes(expectedValue))
      if (present.length > 0) {
        notes.push(`expected JSON field ${path} to exclude ${present.map(item => JSON.stringify(item)).join(', ')}`)
        jsonOk = false
      }
    }

    const jsonFieldMinItems = modeExpectationMap(expect, 'jsonFieldMinItems', 'jsonFieldMinItemsByMode', harness.mode)
    for (const [path, expectedMinItems] of Object.entries(jsonFieldMinItems)) {
      const actualValue = jsonPathValue(parsedJson, path)
      if (!Array.isArray(actualValue)) {
        notes.push(`expected JSON field ${path} to be an array, got ${JSON.stringify(actualValue)}`)
        jsonOk = false
        continue
      }
      if (typeof expectedMinItems !== 'number' || !Number.isFinite(expectedMinItems)) {
        notes.push(`expected JSON field ${path} min item count must be numeric, got ${JSON.stringify(expectedMinItems)}`)
        jsonOk = false
        continue
      }
      if (actualValue.length < expectedMinItems) {
        notes.push(`expected JSON field ${path} to have at least ${expectedMinItems} items, got ${actualValue.length}`)
        jsonOk = false
      }
    }

    const jsonFieldItemCount = modeExpectationMap(expect, 'jsonFieldItemCount', 'jsonFieldItemCountByMode', harness.mode)
    for (const [path, expectedItemCount] of Object.entries(jsonFieldItemCount)) {
      const actualValue = jsonPathValue(parsedJson, path)
      if (!Array.isArray(actualValue)) {
        notes.push(`expected JSON field ${path} to be an array, got ${JSON.stringify(actualValue)}`)
        jsonOk = false
        continue
      }
      if (typeof expectedItemCount !== 'number' || !Number.isFinite(expectedItemCount)) {
        notes.push(`expected JSON field ${path} item count must be numeric, got ${JSON.stringify(expectedItemCount)}`)
        jsonOk = false
        continue
      }
      if (actualValue.length !== expectedItemCount) {
        notes.push(`expected JSON field ${path} to have ${expectedItemCount} items, got ${actualValue.length}`)
        jsonOk = false
      }
    }

    if (expect.schemaValid === true) {
      const schema = taskForCall.arguments.schema
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        notes.push('schemaValid expectation requires task arguments.schema')
        jsonOk = false
      } else {
        const schemaErrors = jsonSchemaErrors(text, schema as Record<string, unknown>)
        if (schemaErrors.length > 0) {
          notes.push(`schema validation failed: ${schemaErrors.slice(0, 4).join('; ')}`)
          jsonOk = false
        }
      }
    }

    if (expect.destinationValues && typeof expect.destinationValues === 'object') {
      for (const [selector, value] of Object.entries(expect.destinationValues as Record<string, string>)) {
        selectorChecks += 1
        const actual = await harness.value(104, selector)
        const hit = actual === value
        selectorHits += hit ? 1 : 0
        if (!hit) notes.push(`destination ${selector} was ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`)
      }
    }

    if (typeof expect.clicked === 'string' && !(await harness.clicked(expect.clicked))) {
      notes.push(`expected click ${expect.clicked}`)
    }

    if (typeof expect.bridgeExecuteTool === 'string' && harness.supportsBridgeRequestLog) {
      const sawTool = harness.requestsSince(startRequestCount).some(request =>
        request.type === 'bridge:execute_tool' && request.name === expect.bridgeExecuteTool
      )
      if (!sawTool) notes.push(`expected bridge tool ${expect.bridgeExecuteTool}`)
    }
    if (Array.isArray(expect.bridgeExecuteTools) && harness.supportsBridgeRequestLog) {
      const requests = harness.requestsSince(startRequestCount)
      for (const tool of expect.bridgeExecuteTools) {
        if (typeof tool !== 'string') continue
        const sawTool = requests.some(request => request.type === 'bridge:execute_tool' && request.name === tool)
        if (!sawTool) notes.push(`expected bridge tool ${tool}`)
      }
    }
    if (typeof expect.bridgeExecuteSelector === 'string' && harness.supportsBridgeRequestLog) {
      const sawSelector = harness.requestsSince(startRequestCount).some(request =>
        request.type === 'bridge:execute_tool' &&
        request.arguments &&
        typeof request.arguments === 'object' &&
        !Array.isArray(request.arguments) &&
        request.arguments.selector === expect.bridgeExecuteSelector
      )
      if (!sawSelector) notes.push(`expected bridge selector ${expect.bridgeExecuteSelector}`)
    }
    if (Array.isArray(expect.bridgeExecuteSelectors) && harness.supportsBridgeRequestLog) {
      const requests = harness.requestsSince(startRequestCount)
      for (const selector of expect.bridgeExecuteSelectors) {
        if (typeof selector !== 'string') continue
        const sawSelector = requests.some(request =>
          request.type === 'bridge:execute_tool' &&
          request.arguments &&
          typeof request.arguments === 'object' &&
          !Array.isArray(request.arguments) &&
          request.arguments.selector === selector
        )
        if (!sawSelector) notes.push(`expected bridge selector ${selector}`)
      }
    }

    if (expect.bridgeRunAgent === true && harness.supportsBridgeRequestLog) {
      const sawRunAgent = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:run_agent')
      if (!sawRunAgent) notes.push('expected bridge:run_agent request')
    }
    if (expect.bridgeRunAgent === false && harness.supportsBridgeRequestLog) {
      const sawRunAgent = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:run_agent')
      if (sawRunAgent) notes.push('unexpected bridge:run_agent request')
    }
    if (expect.bridgeStop === true && harness.supportsBridgeRequestLog) {
      const sawStop = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:stop')
      if (!sawStop) notes.push('expected bridge:stop request')
    }
    if (expect.bridgeStop === false && harness.supportsBridgeRequestLog) {
      const sawStop = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:stop')
      if (sawStop) notes.push('unexpected bridge:stop request')
    }
    if (expect.bridgeListTabs === true && harness.supportsBridgeRequestLog) {
      const sawListTabs = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:list_tabs')
      if (!sawListTabs) notes.push('expected bridge:list_tabs request')
    }
    if (expect.bridgeListTabs === false && harness.supportsBridgeRequestLog) {
      const sawListTabs = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:list_tabs')
      if (sawListTabs) notes.push('unexpected bridge:list_tabs request')
    }
    if (expect.bridgeGetActiveTab === true && harness.supportsBridgeRequestLog) {
      const sawGetActiveTab = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:get_active_tab')
      if (!sawGetActiveTab) notes.push('expected bridge:get_active_tab request')
    }
    if (expect.bridgeGetActiveTab === false && harness.supportsBridgeRequestLog) {
      const sawGetActiveTab = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:get_active_tab')
      if (sawGetActiveTab) notes.push('unexpected bridge:get_active_tab request')
    }
    if (expect.bridgeEnsureModelReady === true && harness.supportsBridgeRequestLog) {
      const sawEnsureModelReady = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:ensure_model_ready')
      if (!sawEnsureModelReady) notes.push('expected bridge:ensure_model_ready request')
    }
    if (expect.bridgeEnsureModelReady === false && harness.supportsBridgeRequestLog) {
      const sawEnsureModelReady = harness.requestsSince(startRequestCount).some(request => request.type === 'bridge:ensure_model_ready')
      if (sawEnsureModelReady) notes.push('unexpected bridge:ensure_model_ready request')
    }

    if (typeof expect.activeTabId === 'number') {
      const mappedActiveTask = harness.remapTask({ ...task, arguments: { tabId: expect.activeTabId } })
      const expectedActiveTabId = typeof mappedActiveTask.arguments.tabId === 'number'
        ? mappedActiveTask.arguments.tabId
        : expect.activeTabId
      const activeOk = text.includes(`"id": ${expectedActiveTabId}`) || text.includes(`"id":${expectedActiveTabId}`)
      if (!activeOk) notes.push(`expected active tab id ${expect.activeTabId}`)
    }

    if (typeof expect.scrollYAtLeast === 'number') {
      const targetTabId = typeof task.arguments.tabId === 'number' ? task.arguments.tabId : 101
      const scrollY = await harness.scrollY(targetTabId)
      if (scrollY < expect.scrollYAtLeast) {
        notes.push(`expected scrollY at least ${expect.scrollYAtLeast}, got ${scrollY}`)
      }
    }
    if (typeof expect.scrollYAtMost === 'number') {
      const targetTabId = typeof task.arguments.tabId === 'number' ? task.arguments.tabId : 101
      const scrollY = await harness.scrollY(targetTabId)
      if (scrollY > expect.scrollYAtMost) {
        notes.push(`expected scrollY at most ${expect.scrollYAtMost}, got ${scrollY}`)
      }
    }
    if (typeof expect.urlPath === 'string') {
      const targetTabId = typeof task.arguments.tabId === 'number' ? task.arguments.tabId : 101
      let path = await harness.urlPath(targetTabId)
      const deadline = Date.now() + 2_000
      while (path !== expect.urlPath && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
        path = await harness.urlPath(targetTabId)
      }
      if (path !== expect.urlPath) {
        notes.push(`expected URL path ${expect.urlPath}, got ${path}`)
      }
    }

    if (typeof expect.image === 'string' && !hasImage(result, expect.image)) {
      notes.push(`expected MCP image content ${expect.image}`)
    }

    const clickedOk = typeof expect.clicked === 'string' ? await harness.clicked(expect.clicked) : true
    const imageOk = typeof expect.image === 'string' ? hasImage(result, expect.image) : true
    const mappedActiveTask = typeof expect.activeTabId === 'number'
      ? harness.remapTask({ ...task, arguments: { tabId: expect.activeTabId } })
      : undefined
    const expectedActiveTabId = typeof mappedActiveTask?.arguments.tabId === 'number'
      ? mappedActiveTask.arguments.tabId
      : expect.activeTabId
    const activeOk = typeof expect.activeTabId === 'number'
      ? text.includes(`"id": ${expectedActiveTabId}`) || text.includes(`"id":${expectedActiveTabId}`)
      : true
    success = containsOk && absentOk && jsonOk && clickedOk && imageOk && activeOk && notes.length === 0
    strict = success
  } catch (error) {
    timeout = error instanceof Error && error.message.includes('timed out')
    notes.push(error instanceof Error ? error.message : String(error))
    try {
      notes.push(`diagnostics=${JSON.stringify(await harness.diagnostics())}`)
    } catch (diagnosticError) {
      notes.push(`diagnostics_error=${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`)
    }
  }

  const durationMs = performance.now() - start
  const requests = harness.requestsSince(startRequestCount)
  const endActionCount = await harness.actionCount()
  const actions = Math.max(
    0,
    endActionCount - startActionCount,
    requests.filter(request => request.type === 'bridge:run_agent' || request.type === 'bridge:execute_tool' || request.type === 'bridge:stop').length,
  )
  const expectedActions = modeExpectationValue(task.expect, 'actions', 'actionsByMode', harness.mode)
  if (typeof expectedActions === 'number' && Number.isFinite(expectedActions) && actions !== expectedActions) {
    notes.push(`expected ${expectedActions} actions, got ${actions}`)
    success = false
    strict = false
  }
  const actionTrace = await harness.actionTraceSince(startActionCount)
  const expectedActionTraceTools = stringArray(modeExpectationValue(task.expect, 'actionTraceTools', 'actionTraceToolsByMode', harness.mode))
  if (expectedActionTraceTools.length > 0) {
    const actualActionTraceTools = actionTrace.map(actionTraceToolName)
    if (JSON.stringify(actualActionTraceTools) !== JSON.stringify(expectedActionTraceTools)) {
      notes.push(`expected action trace tools ${JSON.stringify(expectedActionTraceTools)}, got ${JSON.stringify(actualActionTraceTools)}`)
      success = false
      strict = false
    }
  }
  const expectedActionTraceTextIncludes = stringArray(modeExpectationValue(task.expect, 'actionTraceTextIncludes', 'actionTraceTextIncludesByMode', harness.mode))
  if (expectedActionTraceTextIncludes.length > 0) {
    for (const [index, expectedText] of expectedActionTraceTextIncludes.entries()) {
      const actualText = actionTrace[index]?.text ?? ''
      if (!actualText.includes(expectedText)) {
        notes.push(`expected action trace ${index} text to include ${JSON.stringify(expectedText)}, got ${JSON.stringify(actualText)}`)
        success = false
        strict = false
      }
    }
  }
  const toolErrors = harness.toolErrorCount() - startErrorCount

  return {
    id: task.id,
    suite: task.suite,
    title: task.title,
    tool: task.tool,
    success,
    strict,
    jsonRequired,
    jsonValid,
    selectorChecks,
    selectorHits,
    actions,
    actionTrace,
    durationMs,
      timeout,
      toolErrors,
      outputPreview,
      notes,
    }
}

function summarize(results: TaskResult[], modelReady: ModelReadyPreflight) {
  const tasks = results.length
  const successes = results.filter(result => result.success).length
  const strict = results.filter(result => result.strict).length
  const jsonTasks = results.filter(result => result.jsonRequired)
  const jsonValid = jsonTasks.filter(result => result.jsonValid).length
  const selectorChecks = results.reduce((sum, result) => sum + result.selectorChecks, 0)
  const selectorHits = results.reduce((sum, result) => sum + result.selectorHits, 0)
  const successfulActions = results.filter(result => result.success).reduce((sum, result) => sum + result.actions, 0)
  const durations = results.map(result => result.durationMs / 1000)
  const modelDurations = results
    .filter(result => MODEL_DRIVEN_TOOLS.has(result.tool))
    .map(result => result.durationMs / 1000)
  const warmModelDurations = modelDurations.slice(1)
  const deterministicDurations = results
    .filter(result => !MODEL_DRIVEN_TOOLS.has(result.tool))
    .map(result => result.durationMs / 1000)
  const timeouts = results.filter(result => result.timeout).length
  const toolErrors = results.reduce((sum, result) => sum + result.toolErrors, 0)

  return {
    tasks,
    successRate: tasks ? successes / tasks : 0,
    strictSuccessRate: tasks ? strict / tasks : 0,
    jsonValidRate: jsonTasks.length ? jsonValid / jsonTasks.length : 1,
    selectorHitRate: selectorChecks ? selectorHits / selectorChecks : 1,
    actionsPerSuccess: successes ? successfulActions / successes : 0,
    p50TaskSeconds: percentile(durations, 50),
    p95TaskSeconds: percentile(durations, 95),
    firstModelTaskSeconds: modelDurations[0] ?? 0,
    warmModelP50TaskSeconds: percentile(warmModelDurations, 50),
    warmModelP95TaskSeconds: percentile(warmModelDurations, 95),
    deterministicP95TaskSeconds: percentile(deterministicDurations, 95),
    modelReady,
    modelLoadSeconds: modelReady.status === 'skipped' ? 0 : modelReady.durationMs / 1000,
    timeoutRate: tasks ? timeouts / tasks : 0,
    toolErrorRate: tasks ? toolErrors / tasks : 0,
  }
}

async function gitShortHash(): Promise<string> {
  const child = spawn('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const chunks: Buffer[] = []
  child.stdout.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
  await once(child, 'exit')
  return Buffer.concat(chunks).toString('utf8').trim() || 'unknown'
}

const RESULTS_LEDGER_COLUMNS = [
  'commit',
  'suite',
  'tasks',
  'success_rate',
  'strict_success_rate',
  'json_valid_rate',
  'selector_hit_rate',
  'actions_per_success',
  'p50_s',
  'p95_s',
  'timeout_rate',
  'model_load_s',
  'status',
  'description',
]
const RESULTS_LEDGER_HEADER = RESULTS_LEDGER_COLUMNS.join('\t')

async function buildResultsLedgerRow(summary: ReturnType<typeof summarize>, mode: string): Promise<ResultsLedgerRow> {
  const requestedStatus = process.env.BENCHMARK_STATUS ?? 'baseline'
  const status = summary.successRate < 1 && requestedStatus === 'keep' ? 'discard' : requestedStatus
  return {
    commit: await gitShortHash(),
    suite: mode,
    tasks: String(summary.tasks),
    successRate: summary.successRate.toFixed(4),
    strictSuccessRate: summary.strictSuccessRate.toFixed(4),
    jsonValidRate: summary.jsonValidRate.toFixed(4),
    selectorHitRate: summary.selectorHitRate.toFixed(4),
    actionsPerSuccess: summary.actionsPerSuccess.toFixed(2),
    p50TaskSeconds: summary.p50TaskSeconds.toFixed(3),
    p95TaskSeconds: summary.p95TaskSeconds.toFixed(3),
    timeoutRate: summary.timeoutRate.toFixed(4),
    modelLoadSeconds: summary.modelLoadSeconds.toFixed(3),
    status,
    description: process.env.BENCHMARK_DESCRIPTION ?? `${mode} benchmark run`,
  }
}

function formatResultsLedgerRow(row: ResultsLedgerRow): string {
  return [
    row.commit,
    row.suite,
    row.tasks,
    row.successRate,
    row.strictSuccessRate,
    row.jsonValidRate,
    row.selectorHitRate,
    row.actionsPerSuccess,
    row.p50TaskSeconds,
    row.p95TaskSeconds,
    row.timeoutRate,
    row.modelLoadSeconds,
    row.status,
    row.description,
  ].join('\t')
}

async function appendResults(row: ResultsLedgerRow): Promise<void> {
  const file = resolve(REPO_ROOT, 'results.web.tsv')
  await migrateResultsLedger(file, RESULTS_LEDGER_HEADER)

  const content = `${existsSync(file) ? '' : `${RESULTS_LEDGER_HEADER}\n`}${formatResultsLedgerRow(row)}\n`
  await writeFile(file, content, { flag: 'a' })
}

async function migrateResultsLedger(file: string, currentHeader: string): Promise<void> {
  if (!existsSync(file)) return

  const text = await readFile(file, 'utf8')
  const trimmed = text.trimEnd()
  if (!trimmed) return

  const lines = trimmed.split(/\r?\n/)
  if (lines[0] === currentHeader) return

  const oldHeader = [
    'commit',
    'suite',
    'tasks',
    'success_rate',
    'strict_success_rate',
    'json_valid_rate',
    'selector_hit_rate',
    'actions_per_success',
    'p50_s',
    'p95_s',
    'timeout_rate',
    'status',
    'description',
  ].join('\t')
  if (lines[0] !== oldHeader) {
    throw new Error(`Unexpected results.web.tsv header: ${lines[0]}`)
  }

  const migrated = [
    currentHeader,
    ...lines.slice(1).map(line => {
      const parts = line.split('\t')
      parts.splice(11, 0, '0.000')
      return parts.join('\t')
    }),
  ].join('\n') + '\n'
  await writeFile(file, migrated)
}

function parseResultsLedgerRow(line: string): ResultsLedgerRow | undefined {
  const parts = line.split('\t')
  if (parts.length < RESULTS_LEDGER_COLUMNS.length) return undefined

  return {
    commit: parts[0] ?? '',
    suite: parts[1] ?? '',
    tasks: parts[2] ?? '',
    successRate: parts[3] ?? '',
    strictSuccessRate: parts[4] ?? '',
    jsonValidRate: parts[5] ?? '',
    selectorHitRate: parts[6] ?? '',
    actionsPerSuccess: parts[7] ?? '',
    p50TaskSeconds: parts[8] ?? '',
    p95TaskSeconds: parts[9] ?? '',
    timeoutRate: parts[10] ?? '',
    modelLoadSeconds: parts[11] ?? '',
    status: parts[12] ?? '',
    description: parts.slice(13).join(' '),
  }
}

async function readResultsLedgerRows(pendingRow: ResultsLedgerRow): Promise<ResultsLedgerRow[]> {
  const file = resolve(REPO_ROOT, 'results.web.tsv')
  const rows: ResultsLedgerRow[] = []

  if (existsSync(file)) {
    const text = await readFile(file, 'utf8')
    const lines = text.trimEnd().split(/\r?\n/)
    if (lines[0] === RESULTS_LEDGER_HEADER) {
      for (const line of lines.slice(1)) {
        const parsed = parseResultsLedgerRow(line)
        if (parsed) rows.push(parsed)
      }
    }
  }

  rows.push(pendingRow)
  return rows
}

function numericLedgerValue(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isBetterKeptLedgerRow(candidate: ResultsLedgerRow, current: ResultsLedgerRow): boolean {
  const comparisons = [
    numericLedgerValue(candidate.successRate) - numericLedgerValue(current.successRate),
    numericLedgerValue(candidate.strictSuccessRate) - numericLedgerValue(current.strictSuccessRate),
    numericLedgerValue(candidate.jsonValidRate) - numericLedgerValue(current.jsonValidRate),
    numericLedgerValue(candidate.selectorHitRate) - numericLedgerValue(current.selectorHitRate),
    numericLedgerValue(current.timeoutRate) - numericLedgerValue(candidate.timeoutRate),
    numericLedgerValue(current.p95TaskSeconds) - numericLedgerValue(candidate.p95TaskSeconds),
    numericLedgerValue(current.actionsPerSuccess) - numericLedgerValue(candidate.actionsPerSuccess),
  ]

  for (const comparison of comparisons) {
    if (Math.abs(comparison) > 0.0005) return comparison > 0
  }
  return false
}

function bestKeptRowsBySuite(rows: ResultsLedgerRow[]): ResultsLedgerRow[] {
  const bestBySuite = new Map<string, ResultsLedgerRow>()

  for (const row of rows) {
    if (row.status !== 'keep') continue
    const current = bestBySuite.get(row.suite)
    if (!current || isBetterKeptLedgerRow(row, current)) {
      bestBySuite.set(row.suite, row)
    }
  }

  return [...bestBySuite.values()].sort((a, b) => a.suite.localeCompare(b.suite))
}

function latestKeptRowsBySuite(rows: ResultsLedgerRow[]): ResultsLedgerRow[] {
  const latestBySuite = new Map<string, ResultsLedgerRow>()

  for (const row of rows) {
    if (row.status !== 'keep') continue
    latestBySuite.set(row.suite, row)
  }

  return [...latestBySuite.values()].sort((a, b) => a.suite.localeCompare(b.suite))
}

function recentRowsWithStatus(rows: ResultsLedgerRow[], statuses: Set<string>, limit: number): ResultsLedgerRow[] {
  return rows.filter(row => statuses.has(row.status)).slice(-limit)
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, '/').trim()
}

function decisionTableRows(rows: ResultsLedgerRow[]): string[] {
  return rows.map(row => [
    row.commit,
    row.suite,
    row.status,
    row.successRate,
    row.p95TaskSeconds,
    row.timeoutRate,
    row.description,
  ].map(markdownTableCell).join(' | ')).map(row => `| ${row} |`)
}

function suiteSummaryTableLines(title: string, rows: ResultsLedgerRow[]): string[] {
  if (!rows.length) return []

  return [
    '',
    `## ${title}`,
    '',
    '| suite | commit | tasks | success | strict | json | selector | actions | p95_s | timeout | model_load_s | description |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(row => [
      row.suite,
      row.commit,
      row.tasks,
      row.successRate,
      row.strictSuccessRate,
      row.jsonValidRate,
      row.selectorHitRate,
      row.actionsPerSuccess,
      row.p95TaskSeconds,
      row.timeoutRate,
      row.modelLoadSeconds,
      row.description,
    ].map(markdownTableCell).join(' | ')).map(row => `| ${row} |`),
  ]
}

async function writeReport(results: TaskResult[], summary: ReturnType<typeof summarize>, mode: string, ledgerRow: ResultsLedgerRow): Promise<void> {
  const reportPath = resolve(BENCH_ROOT, 'report.md')
  const reportCommand = mode === 'local-fake-extension'
    ? 'pnpm benchmark:web'
    : mode === 'real-chrome-extension-agent'
      ? 'pnpm benchmark:web:real:agent'
      : 'pnpm benchmark:web:real'
  const modeDescription = mode === 'local-fake-extension'
    ? 'This mode uses the real MCP sidecar and a deterministic fake extension WebSocket. It validates sidecar tool contracts, bridge request shape, JSON/tool result handling, and deterministic helper orchestration.'
    : mode === 'real-chrome-extension-agent'
      ? 'This mode launches Chrome for Testing with the built Gemma Gem extension, serves fixture pages locally, runs the deterministic task subset through the real extension/content-script path, and includes model-backed `gemma_model_ready`, `gemma_agent`, `gemma_observe`, and `gemma_extract` tasks.'
      : 'This mode launches Chrome for Testing with the built Gemma Gem extension, serves fixture pages locally, configures the extension bridge through a development-only service-worker hook, and runs the deterministic task subset through the real extension/content-script path.'
  const modelReadyLines = [
    `- model_ready_status: ${summary.modelReady.status}`,
    `- model_load_seconds: ${summary.modelLoadSeconds.toFixed(3)}`,
    ...(summary.modelReady.modelId ? [`- model_ready_model_id: ${summary.modelReady.modelId}`] : []),
    ...(summary.modelReady.phase ? [`- model_ready_phase: ${summary.modelReady.phase}`] : []),
    ...(typeof summary.modelReady.progress === 'number' ? [`- model_ready_progress: ${summary.modelReady.progress}`] : []),
    ...(summary.modelReady.error ? [`- model_ready_error: ${summary.modelReady.error}`] : []),
  ]
  const ledgerRows = await readResultsLedgerRows(ledgerRow)
  const bestKeptRows = bestKeptRowsBySuite(ledgerRows)
  const latestKeptRows = latestKeptRowsBySuite(ledgerRows)
  const recentKeptRows = recentRowsWithStatus(ledgerRows, new Set(['keep']), 6)
  const recentFailedRows = recentRowsWithStatus(ledgerRows, new Set(['discard', 'crash', 'timeout']), 6)
  const bestKeptLines = suiteSummaryTableLines('Best Kept Runs By Suite', bestKeptRows)
  const latestKeptLines = suiteSummaryTableLines('Latest Kept Runs By Suite', latestKeptRows)
  const recentDecisionLines = [
    '',
    '## Recent Decisions',
    '',
    'Recent kept changes:',
    '',
    '| commit | suite | status | success | p95_s | timeout | description |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
    ...decisionTableRows(recentKeptRows),
    '',
    'Recent discarded, crashed, or timed-out hypotheses:',
    '',
    ...(recentFailedRows.length
      ? [
          '| commit | suite | status | success | p95_s | timeout | description |',
          '| --- | --- | --- | ---: | ---: | ---: | --- |',
          ...decisionTableRows(recentFailedRows),
        ]
      : ['No discarded, crashed, or timed-out hypotheses are present in the latest ledger window.']),
  ]
  const recentLedger = ledgerRows.slice(-8)
  const recentLedgerLines = [
    '',
    '## Recent Ledger',
    '',
    '| commit | suite | status | tasks | success | strict | json | selector | actions | p95_s | timeout | model_load_s | description |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...recentLedger.map(row => [
      row.commit,
      row.suite,
      row.status,
      row.tasks,
      row.successRate,
      row.strictSuccessRate,
      row.jsonValidRate,
      row.selectorHitRate,
      row.actionsPerSuccess,
      row.p95TaskSeconds,
      row.timeoutRate,
      row.modelLoadSeconds,
      row.description,
    ].map(markdownTableCell).join(' | ')).map(row => `| ${row} |`),
  ]
  const nextExperimentLines = summary.successRate < 1 || summary.timeoutRate > 0 || summary.modelReady.status === 'error'
    ? [
        '1. Classify the latest failed tasks from `benchmark.web.jsonl` and keep the frozen assertions unchanged.',
        '2. Reproduce the failing mode with the same direct command shown at the top of this report.',
        '3. Add the smallest diagnostic or recovery path that explains the failure before changing prompts.',
      ]
    : [
        '1. Re-run `pnpm benchmark:web:real` to keep deterministic real-extension smoke current.',
        '2. Re-run `pnpm benchmark:web:real:agent` to keep model-backed real-extension coverage current.',
        '3. Add the next frozen task or trace coverage target only after the current local, real-smoke, and real-agent suites stay green.',
      ]
  const lines = [
    '# Web Control Plane Benchmark',
    '',
    `This report is generated by \`${reportCommand}\`.`,
    '',
    '## Latest Summary',
    '',
    `- tasks: ${summary.tasks}`,
    `- task_success_rate: ${summary.successRate.toFixed(4)}`,
    `- strict_success_rate: ${summary.strictSuccessRate.toFixed(4)}`,
    `- json_valid_rate: ${summary.jsonValidRate.toFixed(4)}`,
    `- selector_hit_rate: ${summary.selectorHitRate.toFixed(4)}`,
    `- actions_per_success: ${summary.actionsPerSuccess.toFixed(2)}`,
    `- p50_task_seconds: ${summary.p50TaskSeconds.toFixed(3)}`,
    `- p95_task_seconds: ${summary.p95TaskSeconds.toFixed(3)}`,
    `- timeout_rate: ${summary.timeoutRate.toFixed(4)}`,
    `- tool_error_rate: ${summary.toolErrorRate.toFixed(4)}`,
    ...bestKeptLines,
    ...latestKeptLines,
    ...recentDecisionLines,
    ...recentLedgerLines,
    '',
    '## Latency Split',
    '',
    `- first_model_task_seconds: ${summary.firstModelTaskSeconds.toFixed(3)}`,
    `- warm_model_p50_task_seconds: ${summary.warmModelP50TaskSeconds.toFixed(3)}`,
    `- warm_model_p95_task_seconds: ${summary.warmModelP95TaskSeconds.toFixed(3)}`,
    `- deterministic_p95_task_seconds: ${summary.deterministicP95TaskSeconds.toFixed(3)}`,
    ...modelReadyLines,
    '',
    '## Tasks',
    '',
    '| suite | task | tool | success | strict | seconds | notes |',
    '| --- | --- | --- | --- | --- | ---: | --- |',
    ...results.map(result => [
      result.suite,
      result.id,
      result.tool,
      result.success ? 'yes' : 'no',
      result.strict ? 'yes' : 'no',
      (result.durationMs / 1000).toFixed(3),
      [
        ...result.notes,
        !result.success && result.outputPreview ? `output=${result.outputPreview}` : '',
      ].filter(Boolean).join('; ').replace(/\|/g, '/'),
    ].join(' | ')).map(row => `| ${row} |`),
    '',
    '## Runner Mode',
    '',
    `Current mode: \`${mode}\`.`,
    '',
    modeDescription,
    '',
    '## Recommended Commands',
    '',
    `- Reproduce this report: \`${reportCommand}\``,
    '- Fast sidecar contract suite: `pnpm benchmark:web`',
    '- Deterministic real-extension smoke: `pnpm benchmark:web:real`',
    '- Model-backed real-extension suite: `pnpm benchmark:web:real:agent`',
    '- Standard verification: `pnpm compile && pnpm test`',
    '',
    '## Artifacts',
    '',
    '- Latest report: `benchmarks/web-control-plane/report.md`',
    '- Full experiment ledger: `results.web.tsv`',
    '- Latest task JSONL log: `benchmark.web.jsonl`',
    '- Raw action traces: `benchmarks/web-control-plane/action-traces.jsonl`',
    '- Training action traces: `benchmarks/web-control-plane/action-traces.training.jsonl`',
    '- Saved reranker weights: `benchmarks/web-control-plane/action-reranker.weights.json`',
    '',
    '## Next Experiments',
    '',
    ...nextExperimentLines,
    '',
    'Install/update the local browser runtime with `pnpm browser:install`. Launch a persistent manual debug profile with `pnpm browser:debug`.',
    '',
    'Run `pnpm benchmark:web:real:agent` to include model-backed `gemma_model_ready`, `gemma_agent`, `gemma_observe`, and `gemma_extract` tasks. That mode may spend time loading/running the local Gemma model.',
    '',
  ]
  await writeFile(reportPath, lines.join('\n'))
}

async function writeJsonl(results: TaskResult[], modelReady: ModelReadyPreflight): Promise<void> {
  const logPath = resolve(REPO_ROOT, 'benchmark.web.jsonl')
  const rows = [
    JSON.stringify({ type: 'model_ready_preflight', ...modelReady }),
    ...results.map(result => JSON.stringify(result)),
  ]
  const content = rows.join('\n') + '\n'
  await writeFile(logPath, content)
}

async function main(): Promise<void> {
  await mkdir(dirname(resolve(BENCH_ROOT, 'report.md')), { recursive: true })
  const allTasks = await readTasks()
  const mode = REAL_MODE
    ? INCLUDE_AGENT_TASKS ? 'real-chrome-extension-agent' : 'real-chrome-extension-smoke'
    : 'local-fake-extension'
  const tasks = allTasks
    .filter(task => taskEnabledForMode(task, mode))
    .filter(task => !(REAL_MODE && !INCLUDE_AGENT_TASKS && REAL_SMOKE_EXCLUDED_TOOLS.has(task.tool)))
  const port = await getFreePort()
  const child = await startSidecar(port)
  const harness: HarnessProbe = REAL_MODE ? await RealChromeHarness.launch(port) : new FakeExtension(port)

  try {
    if (harness instanceof FakeExtension) {
      await harness.connect()
    }
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${TOKEN}`,
        },
      },
    })
    const client = new Client({ name: 'gemma-gem-web-benchmark', version: '0.0.0' })
    await client.connect(transport)

    try {
      const modelReady = await runModelReadyPreflight(client)
      if (modelReady.status !== 'skipped') {
        console.log(`${modelReady.status === 'ready' ? 'PASS' : 'FAIL'} model-ready ${modelReady.durationMs.toFixed(1)}ms`)
        if (modelReady.error) console.log(`  ${modelReady.error}`)
      }

      const results: TaskResult[] = []
      for (const task of tasks) {
        const result = await runTask(client, harness, task)
        results.push(result)
        console.log(`${result.success ? 'PASS' : 'FAIL'} ${task.suite}/${task.id} ${result.durationMs.toFixed(1)}ms`)
        if (result.notes.length) {
          console.log(`  ${result.notes.join('; ')}`)
        }
      }

      const summary = summarize(results, modelReady)
      const ledgerRow = await buildResultsLedgerRow(summary, harness.mode)
      await writeJsonl(results, modelReady)
      await writeReport(results, summary, harness.mode, ledgerRow)
      await appendResults(ledgerRow)

      console.log('---')
      console.log(`task_success_rate: ${summary.successRate.toFixed(4)}`)
      console.log(`strict_success_rate: ${summary.strictSuccessRate.toFixed(4)}`)
      console.log(`json_valid_rate: ${summary.jsonValidRate.toFixed(4)}`)
      console.log(`selector_hit_rate: ${summary.selectorHitRate.toFixed(4)}`)
      console.log(`actions_per_success: ${summary.actionsPerSuccess.toFixed(2)}`)
      console.log(`p50_task_seconds: ${summary.p50TaskSeconds.toFixed(3)}`)
      console.log(`p95_task_seconds: ${summary.p95TaskSeconds.toFixed(3)}`)
      console.log(`first_model_task_seconds: ${summary.firstModelTaskSeconds.toFixed(3)}`)
      console.log(`warm_model_p50_task_seconds: ${summary.warmModelP50TaskSeconds.toFixed(3)}`)
      console.log(`warm_model_p95_task_seconds: ${summary.warmModelP95TaskSeconds.toFixed(3)}`)
      console.log(`deterministic_p95_task_seconds: ${summary.deterministicP95TaskSeconds.toFixed(3)}`)
      console.log(`model_ready_status: ${summary.modelReady.status}`)
      console.log(`model_load_seconds: ${summary.modelLoadSeconds.toFixed(3)}`)
      console.log(`timeout_rate: ${summary.timeoutRate.toFixed(4)}`)
      console.log(`tool_error_rate: ${summary.toolErrorRate.toFixed(4)}`)

      if (summary.successRate < 1 || summary.modelReady.status === 'error') {
        process.exitCode = 1
      }
    } finally {
      await client.close()
    }
  } finally {
    await harness.close()
    child.kill()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
