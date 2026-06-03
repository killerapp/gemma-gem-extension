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
  selectorExists(selector: string): Promise<boolean> | boolean
  value(logicalTabId: number, selector: string): Promise<string> | string
  clicked(selector: string): Promise<boolean> | boolean
  scrollY(logicalTabId: number): Promise<number> | number
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
  ]

  constructor(private readonly port: number) {
    this.values.set('103:#source-name', 'Ada Lovelace')
    this.values.set('103:#source-email', 'ada@example.test')
    this.values.set('104:#dest-name', '')
    this.values.set('104:#dest-email', '')
    this.values.set('104:#dest-role', '')
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

  selectorExists(selector: string): boolean {
    const knownSelectors = new Set([
      '#download-receipt',
      '#download-invoice',
      '#payment-settings',
      '#source-name',
      '#source-email',
      '#dest-name',
      '#dest-email',
      '#dest-role',
      '#save-profile',
      '#save-result',
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

    return [
      {
        type: 'bridge:chunk',
        requestId: request.requestId,
        text: '[Thinking] The receipt download is the proof of last payment.',
      },
      this.response(request.requestId, {
        text: 'SUCCESS: selected #download-receipt and downloaded receipt for INV-2026-041',
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
        this.values.set(`${tabId}:${selector}`, text)
        return this.response(request.requestId, { typed: text, into: selector })
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
        const label = selector === '#download-receipt' ? 'button: Receipt PDF' : selector
        return this.response(request.requestId, { clicked: label, selector })
      }
      case 'select_option': {
        const selector = String(args.selector)
        if (!this.selectorExists(selector)) {
          return this.response(request.requestId, { error: `No select element found for selector: ${selector}` })
        }
        const selected = args.value === 'reviewer' || args.label === 'Reviewer'
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
      if (selector === '.plan[data-plan="team"]') return 'Team $49/month'
      return ['Starter $19/month', 'Team $49/month'].join('\n')
    }
    if (tabId === 103) {
      return this.value(103, selector)
    }
    if (tabId === 104) {
      if (selector === 'body' && format === 'html') {
        return [
          '<main>',
          '<label>Name <input id="dest-name" name="name"></label>',
          '<label>Email <input id="dest-email" name="email"></label>',
          '<label>Role <select id="dest-role" name="role"><option value="">Choose role</option><option value="admin">Administrator</option><option value="reviewer">Reviewer</option></select></label>',
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
          'Save profile',
          this.value(104, '#save-result'),
        ].filter(Boolean).join('\n')
      }
      return this.value(104, selector)
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

  async selectorExists(selector: string): Promise<boolean> {
    const session = await this.pageSessionForLogicalTab(101)
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
      const selectorExists = await harness.selectorExists(expect.selector)
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

async function appendResults(summary: ReturnType<typeof summarize>, mode: string): Promise<void> {
  const file = resolve(REPO_ROOT, 'results.web.tsv')
  const columns = [
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
  const header = columns.join('\t')
  await migrateResultsLedger(file, header)

  const requestedStatus = process.env.BENCHMARK_STATUS ?? 'baseline'
  const status = summary.successRate < 1 && requestedStatus === 'keep' ? 'discard' : requestedStatus
  const row = [
    await gitShortHash(),
    mode,
    String(summary.tasks),
    summary.successRate.toFixed(4),
    summary.strictSuccessRate.toFixed(4),
    summary.jsonValidRate.toFixed(4),
    summary.selectorHitRate.toFixed(4),
    summary.actionsPerSuccess.toFixed(2),
    summary.p50TaskSeconds.toFixed(3),
    summary.p95TaskSeconds.toFixed(3),
    summary.timeoutRate.toFixed(4),
    summary.modelLoadSeconds.toFixed(3),
    status,
    process.env.BENCHMARK_DESCRIPTION ?? `${mode} benchmark run`,
  ].join('\t')

  const content = `${existsSync(file) ? '' : `${header}\n`}${row}\n`
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

async function writeReport(results: TaskResult[], summary: ReturnType<typeof summarize>, mode: string): Promise<void> {
  const reportPath = resolve(BENCH_ROOT, 'report.md')
  const modelReadyLines = [
    `- model_ready_status: ${summary.modelReady.status}`,
    `- model_load_seconds: ${summary.modelLoadSeconds.toFixed(3)}`,
    ...(summary.modelReady.modelId ? [`- model_ready_model_id: ${summary.modelReady.modelId}`] : []),
    ...(summary.modelReady.phase ? [`- model_ready_phase: ${summary.modelReady.phase}`] : []),
    ...(typeof summary.modelReady.progress === 'number' ? [`- model_ready_progress: ${summary.modelReady.progress}`] : []),
    ...(summary.modelReady.error ? [`- model_ready_error: ${summary.modelReady.error}`] : []),
  ]
  const lines = [
    '# Web Control Plane Benchmark',
    '',
    'This report is generated by `pnpm benchmark:web`.',
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
    mode === 'local-fake-extension'
      ? 'This mode uses the real MCP sidecar and a deterministic fake extension WebSocket. It validates sidecar tool contracts, bridge request shape, JSON/tool result handling, and deterministic helper orchestration.'
      : 'This mode launches Chrome for Testing with the built Gemma Gem extension, serves fixture pages locally, configures the extension bridge through a development-only service-worker hook, and runs the deterministic task subset through the real extension/content-script path.',
    '',
    'Install/update the local browser runtime with `pnpm browser:install`. Launch a persistent manual debug profile with `pnpm browser:debug`.',
    '',
    'Run `pnpm benchmark:web -- --real --include-agent` to include model-backed `gemma_model_ready`, `gemma_agent`, `gemma_observe`, and `gemma_extract` tasks. That mode may spend time loading/running the local Gemma model.',
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
  const tasks = REAL_MODE && !INCLUDE_AGENT_TASKS
    ? allTasks.filter(task => !REAL_SMOKE_EXCLUDED_TOOLS.has(task.tool))
    : allTasks
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
      await writeJsonl(results, modelReady)
      await writeReport(results, summary, harness.mode)
      await appendResults(summary, harness.mode)

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
