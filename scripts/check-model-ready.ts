import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const EXTENSION_DIR = resolve(REPO_ROOT, '.output', 'chrome-mv3-dev')
const BENCH_ROOT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane')
const DEFAULT_PROFILE_DIR = resolve(REPO_ROOT, '.browsers', 'gemma-gem-debug-profile')
const BROWSER_MARKER = resolve(REPO_ROOT, '.browsers', 'chrome-for-testing', 'chrome-path.txt')
const TOKEN = 'gemma-gem-model-ready'

type Options = {
  keepOpen: boolean
  profileDir: string
  timeoutMs: number
  fixture?: string
  runTool?: 'gemma_page_brief' | 'gemma_agent'
  devtoolsPort?: number
  mcpPort?: number
  skipReady: boolean
}

type ChromeTarget = {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
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

function parseOptions(): Options {
  const args = process.argv.slice(2)
  let keepOpen = false
  let profileDir = process.env.GEMMA_GEM_CHROME_PROFILE
    ? resolve(process.env.GEMMA_GEM_CHROME_PROFILE)
    : DEFAULT_PROFILE_DIR
  let timeoutMs = positiveInt(process.env.GEMMA_GEM_MODEL_READY_TIMEOUT_MS ?? '180000', 'GEMMA_GEM_MODEL_READY_TIMEOUT_MS')
  let fixture: string | undefined
  let runTool: Options['runTool']
  let devtoolsPort: number | undefined
  let mcpPort: number | undefined
  let skipReady = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      continue
    } else if (arg === '--keep-open') {
      keepOpen = true
    } else if (arg === '--skip-ready') {
      skipReady = true
    } else if (arg === '--profile') {
      const value = args[i + 1]
      if (!value) throw new Error('--profile requires a path')
      profileDir = resolve(value)
      i += 1
    } else if (arg.startsWith('--profile=')) {
      profileDir = resolve(arg.slice('--profile='.length))
    } else if (arg === '--timeout-ms') {
      const value = args[i + 1]
      if (!value) throw new Error('--timeout-ms requires a positive integer')
      timeoutMs = positiveInt(value, '--timeout-ms')
      i += 1
    } else if (arg.startsWith('--timeout-ms=')) {
      timeoutMs = positiveInt(arg.slice('--timeout-ms='.length), '--timeout-ms')
    } else if (arg === '--fixture') {
      const value = args[i + 1]
      if (!value) throw new Error('--fixture requires a benchmark page name')
      fixture = normalizeFixture(value)
      i += 1
    } else if (arg.startsWith('--fixture=')) {
      fixture = normalizeFixture(arg.slice('--fixture='.length))
    } else if (arg === '--run-tool') {
      const value = args[i + 1]
      if (!value) throw new Error('--run-tool requires gemma_page_brief or gemma_agent')
      runTool = normalizeRunTool(value)
      i += 1
    } else if (arg.startsWith('--run-tool=')) {
      runTool = normalizeRunTool(arg.slice('--run-tool='.length))
    } else if (arg === '--devtools-port') {
      const value = args[i + 1]
      if (!value) throw new Error('--devtools-port requires a port')
      devtoolsPort = positivePort(value, '--devtools-port')
      i += 1
    } else if (arg.startsWith('--devtools-port=')) {
      devtoolsPort = positivePort(arg.slice('--devtools-port='.length), '--devtools-port')
    } else if (arg === '--mcp-port') {
      const value = args[i + 1]
      if (!value) throw new Error('--mcp-port requires a port')
      mcpPort = positivePort(value, '--mcp-port')
      i += 1
    } else if (arg.startsWith('--mcp-port=')) {
      mcpPort = positivePort(arg.slice('--mcp-port='.length), '--mcp-port')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --profile <path>, --timeout-ms <ms>, --fixture <page>, --run-tool <tool>, --devtools-port <port>, --mcp-port <port>, or --keep-open.`)
    }
  }

  if ((devtoolsPort || mcpPort) && !mcpPort) {
    throw new Error('--mcp-port is required when attaching to an existing debug session')
  }
  if (fixture && mcpPort && !devtoolsPort) {
    throw new Error('--devtools-port is required to open a fixture in an existing debug browser')
  }

  return { keepOpen, profileDir, timeoutMs, fixture, runTool, devtoolsPort, mcpPort, skipReady }
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function positivePort(value: string, name: string): number {
  const parsed = positiveInt(value, name)
  if (parsed > 65535) throw new Error(`${name} must be <= 65535, got ${parsed}`)
  return parsed
}

function normalizeFixture(value: string): string {
  const normalized = value.endsWith('.html') ? value : `${value}.html`
  if (!/^[a-zA-Z0-9_.-]+\.html$/.test(normalized)) {
    throw new Error(`Invalid fixture page ${JSON.stringify(value)}`)
  }
  return normalized
}

function normalizeRunTool(value: string): Options['runTool'] {
  if (value === 'gemma_page_brief' || value === 'page-brief') return 'gemma_page_brief'
  if (value === 'gemma_agent' || value === 'agent' || value === 'receipt-agent') return 'gemma_agent'
  throw new Error(`Unsupported --run-tool ${JSON.stringify(value)}. Use gemma_page_brief or gemma_agent.`)
}

async function getFreePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not allocate a free port')
  }
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

async function resolveBrowserExecutable(): Promise<string> {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH

  if (existsSync(BROWSER_MARKER)) {
    const value = (await readFile(BROWSER_MARKER, 'utf8')).trim()
    if (value && existsSync(value)) return value
  }

  throw new Error('No Chrome for Testing browser found. Run `pnpm browser:install -- --channel Stable` or set CHROME_PATH.')
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
      child.stderr?.off('data', onData)
      child.stdout?.off('data', onData)
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

async function startStaticServer(): Promise<{ server: HttpServer; port: number }> {
  const pagesRoot = resolve(BENCH_ROOT, 'pages')
  const server = createHttpServer(async (req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const file = rawPath === '/' ? 'semantic-buttons.html' : rawPath.slice(1)
    const safeFile = file.replace(/[^a-zA-Z0-9_.-]/g, '')
    const path = resolve(pagesRoot, safeFile)
    if (!path.startsWith(pagesRoot) || !existsSync(path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(await readFile(path))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not determine static server port')
  }
  return { server, port: address.port }
}

async function waitForBrowser(port: number): Promise<CdpSession> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
      return CdpSession.connect(version.webSocketDebuggerUrl)
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  throw new Error('Timed out waiting for Chrome DevTools endpoint')
}

async function targets(port: number): Promise<ChromeTarget[]> {
  return fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json() as Promise<ChromeTarget[]>)
}

async function waitForLoadedExtensionId(browserSession: CdpSession, profileDir: string, chromeOutput: () => string): Promise<string> {
  const result = await browserSession.send('Extensions.loadUnpacked', {
    path: EXTENSION_DIR,
  }).catch(error => {
    throw new Error(`Extensions.loadUnpacked failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (typeof result?.id === 'string') return result.id

  const prefsPath = resolve(profileDir, 'Default', 'Preferences')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const prefs = JSON.parse(await readFile(prefsPath, 'utf8')) as {
        extensions?: { settings?: Record<string, { manifest?: { name?: string }; path?: string }> }
      }
      for (const [id, item] of Object.entries(prefs.extensions?.settings ?? {})) {
        const name = item.manifest?.name ?? ''
        const path = (item.path ?? '').replaceAll('\\', '/')
        if (name.includes('Gemma Gem') || path.endsWith('/.output/chrome-mv3-dev')) return id
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  throw new Error(`Timed out waiting for Gemma Gem extension registration. Chrome output: ${chromeOutput().slice(-2000)}`)
}

async function waitForExtensionWorker(port: number, extensionId: string, chromeOutput: () => string): Promise<ChromeTarget> {
  const deadline = Date.now() + 20_000
  let lastWorkers: ChromeTarget[] = []
  while (Date.now() < deadline) {
    const currentTargets = await targets(port)
    lastWorkers = currentTargets.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'))
    const worker = lastWorkers.find(target => target.url === `chrome-extension://${extensionId}/background.js`)
    if (worker?.webSocketDebuggerUrl) return worker
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for Gemma Gem service worker. Saw workers: ${JSON.stringify(lastWorkers.map(worker => worker.url))}. Chrome output: ${chromeOutput().slice(-2000)}`)
}

async function connectExtensionWorker(port: number, extensionId: string, chromeOutput: () => string): Promise<CdpSession> {
  const deadline = Date.now() + 30_000
  let lastError = 'no attempts completed'
  while (Date.now() < deadline) {
    try {
      const worker = await waitForExtensionWorker(port, extensionId, chromeOutput)
      return await CdpSession.connect(worker.webSocketDebuggerUrl!)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  throw new Error(`Timed out attaching to Gemma Gem service worker. Last error: ${lastError}`)
}

async function waitForBenchmarkHook(session: CdpSession): Promise<void> {
  const deadline = Date.now() + 10_000
  let lastValue = 'unknown'
  while (Date.now() < deadline) {
    const result = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ hook: typeof globalThis.__gemmaGemBenchmarkConnectBridge })',
      returnByValue: true,
    })
    lastValue = String(result.result?.value ?? result.exceptionDetails?.text ?? 'unknown')
    try {
      const parsed = JSON.parse(lastValue) as { hook?: string }
      if (parsed.hook === 'function') return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Benchmark bridge hook is unavailable. Last worker state: ${lastValue}`)
}

async function connectBridge(session: CdpSession, sidecarPort: number): Promise<void> {
  await waitForBenchmarkHook(session)
  const hookResult = await session.send('Runtime.evaluate', {
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
    throw new Error('Benchmark bridge hook returned no status')
  }
}

async function waitForBridgeConnected(session: CdpSession): Promise<void> {
  const deadline = Date.now() + 15_000
  let lastStatus = 'unknown'
  while (Date.now() < deadline) {
    const result = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify(globalThis.__gemmaGemBenchmarkBridgeStatus?.())',
      returnByValue: true,
    })
    lastStatus = String(result.result?.value ?? result.exceptionDetails?.text ?? 'unknown')
    try {
      const parsed = JSON.parse(lastStatus) as { status?: string }
      if (parsed.status === 'connected') return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Timed out waiting for extension bridge connection. Last status: ${lastStatus}`)
}

async function callModelReady(sidecarPort: number, timeoutMs: number): Promise<string> {
  return callMcpTool(sidecarPort, 'gemma_model_ready', { timeoutMs }, timeoutMs)
}

async function callMcpTool(sidecarPort: number, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sidecarPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  })
  const client = new Client({ name: 'gemma-gem-model-ready-debug', version: '0.0.0' })
  await client.connect(transport)
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
    const content = Array.isArray(result.content) ? result.content : []
    return content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n')
  } finally {
    await client.close()
  }
}

async function openFixturePage(browserSession: CdpSession, staticPort: number, fixture: string): Promise<string> {
  const url = `http://127.0.0.1:${staticPort}/${fixture}`
  const result = await browserSession.send('Target.createTarget', { url })
  if (typeof result?.targetId === 'string') {
    await browserSession.send('Target.activateTarget', { targetId: result.targetId }).catch(() => {})
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
  return url
}

async function runVisibleTool(sidecarPort: number, tool: Options['runTool'], timeoutMs: number): Promise<string> {
  if (tool === 'gemma_page_brief') {
    return callMcpTool(sidecarPort, 'gemma_page_brief', {}, timeoutMs)
  }
  if (tool === 'gemma_agent') {
    return callMcpTool(sidecarPort, 'gemma_agent', {
      task: 'Get proof of the last payment. Use the visible billing page and report the selector and invoice identifier.',
      thinking: true,
      maxIterations: 8,
    }, timeoutMs)
  }
  return ''
}

async function waitForInterrupt(): Promise<void> {
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
}

async function main(): Promise<void> {
  const options = parseOptions()
  if (!existsSync(resolve(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`Built extension not found at ${EXTENSION_DIR}. Run pnpm build first.`)
  }

  const attachMode = options.mcpPort != null
  await mkdir(options.profileDir, { recursive: true })
  const browser = attachMode ? 'attached existing browser' : await resolveBrowserExecutable()
  const chromePort = options.devtoolsPort ?? await getFreePort()
  const sidecarPort = options.mcpPort ?? await getFreePort()
  const sidecar = attachMode ? undefined : await startSidecar(sidecarPort)
  const staticServer = options.fixture ? await startStaticServer() : undefined
  let chromeOutput = ''
  const chrome = attachMode
    ? undefined
    : spawn(browser, [
        `--user-data-dir=${options.profileDir}`,
        `--remote-debugging-port=${chromePort}`,
        '--enable-extensions',
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        `--load-extension=${EXTENSION_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
  chrome?.stderr?.on('data', chunk => {
    chromeOutput += chunk.toString('utf8')
  })

  let browserSession: CdpSession | null = null
  let workerSession: CdpSession | null = null
  try {
    browserSession = await waitForBrowser(chromePort)
    if (!attachMode) {
      const extensionId = await waitForLoadedExtensionId(browserSession, options.profileDir, () => chromeOutput)
      await browserSession.send('Target.createTarget', {
        url: `chrome-extension://${extensionId}/options.html`,
      }).catch(() => {})
      workerSession = await connectExtensionWorker(chromePort, extensionId, () => chromeOutput)
      await connectBridge(workerSession, sidecarPort)
      await waitForBridgeConnected(workerSession)
    }

    if (staticServer && options.fixture) {
      const fixtureUrl = await openFixturePage(browserSession, staticServer.port, options.fixture)
      console.log(`Fixture: ${fixtureUrl}`)
    }

    console.log(`Browser: ${browser}`)
    console.log(`Profile: ${options.profileDir}`)
    if (options.skipReady) {
      console.log('Model readiness: skipped')
    } else {
      const text = await callModelReady(sidecarPort, options.timeoutMs)
      let parsed: { modelId?: string; status?: string; loadMs?: number; phase?: string; progress?: number; error?: string }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch {
        throw new Error(`gemma_model_ready returned non-JSON output: ${text}`)
      }
      console.log(`Model: ${parsed.modelId ?? 'unknown'}`)
      console.log(`Status: ${parsed.status ?? 'unknown'}`)
      console.log(`Load seconds: ${typeof parsed.loadMs === 'number' ? (parsed.loadMs / 1000).toFixed(3) : 'unknown'}`)
      console.log(`Phase: ${parsed.phase ?? 'unknown'}`)
      console.log(`Progress: ${typeof parsed.progress === 'number' ? parsed.progress : 'unknown'}`)
      if (parsed.error) console.log(`Error: ${parsed.error}`)
      console.log(`Raw: ${text}`)
    }

    if (options.runTool) {
      const toolStartedAt = performance.now()
      const output = await runVisibleTool(sidecarPort, options.runTool, options.timeoutMs)
      console.log(`Tool: ${options.runTool}`)
      console.log(`Tool seconds: ${((performance.now() - toolStartedAt) / 1000).toFixed(3)}`)
      console.log(`Tool output: ${output}`)
    }

    if (options.keepOpen) {
      console.log(`DevTools endpoint: http://127.0.0.1:${chromePort}`)
      console.log(`MCP endpoint: http://127.0.0.1:${sidecarPort}/mcp`)
      if (staticServer) console.log(`Fixture server: http://127.0.0.1:${staticServer.port}`)
      console.log('Keeping browser and bridge open. Press Ctrl+C to stop.')
      await waitForInterrupt()
    }
  } finally {
    workerSession?.close()
    browserSession?.close()
    if (chrome && !chrome.killed) chrome.kill()
    sidecar?.kill()
    staticServer?.server.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
