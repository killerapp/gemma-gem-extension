#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { WebSocketServer, type WebSocket } from 'ws'
import * as z from 'zod/v4'
import type { BridgeEvent, BridgeRequest, BridgeToolName, ObservedAction } from '../../shared/bridge-messages'
import { BRIDGE_DEFAULT_PORT } from '../../shared/bridge-settings'
import {
  normalizeObservedAction,
  parseRerankerWeights,
  rankActionCandidates,
  type ActionRerankerTask,
  type RerankerActionInput,
  type RerankerWeightsArtifact,
} from '../../shared/action-reranker'
import { jsonSchemaErrors, normalizeJsonText } from '../../shared/json-schema'

const BRIDGE_TOKEN = process.env.GEMMA_GEM_BRIDGE_TOKEN
const BRIDGE_PORT = parsePort(process.env.GEMMA_GEM_BRIDGE_PORT)
const HTTP_MODE = process.argv.includes('--http') || process.env.GEMMA_GEM_MCP_TRANSPORT === 'http'
const REQUEST_TIMEOUT_MS = 300_000
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_RERANKER_WEIGHTS_PATH = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.weights.json')

if (!BRIDGE_TOKEN) {
  console.error('GEMMA_GEM_BRIDGE_TOKEN is required. Copy it from Gemma Gem settings and set it before starting the MCP sidecar.')
  process.exit(1)
}

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type BridgeRequestInput = BridgeRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never

let extensionSocket: WebSocket | null = null
const pending = new Map<string, PendingRequest>()

function parsePort(value: string | undefined): number {
  if (!value) return BRIDGE_DEFAULT_PORT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid GEMMA_GEM_BRIDGE_PORT: ${value}`)
  }
  return parsed
}

function createRequestId(): string {
  return `host_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function requireExtension(): WebSocket {
  if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
    throw new Error('Gemma Gem extension is not connected. Enable Local agent bridge in Gemma Gem and keep this sidecar running.')
  }
  return extensionSocket
}

function sendBridgeRequest(request: BridgeRequestInput): Promise<unknown> {
  const socket = requireExtension()
  const requestId = createRequestId()
  const payload = { ...request, requestId } as BridgeRequest

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Bridge request timed out after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)

    pending.set(requestId, { resolve, reject, timeout })
    socket.send(JSON.stringify(payload), (error) => {
      if (error) {
        clearTimeout(timeout)
        pending.delete(requestId)
        reject(error)
      }
    })
  })
}

function handleBridgeEvent(event: BridgeEvent): void {
  if (event.type === 'bridge:chunk' || event.type === 'bridge:tool_call') {
    return
  }

  const entry = pending.get(event.requestId)
  if (!entry) return

  clearTimeout(entry.timeout)
  pending.delete(event.requestId)

  if (event.error) {
    entry.reject(new Error(event.error))
  } else {
    entry.resolve(event.result)
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'gemma-gem',
    version: '0.3.0',
  })
  registerTools(server)
  return server
}

function isAuthorized(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization
  if (authorization === `Bearer ${BRIDGE_TOKEN}`) return true

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  return url.searchParams.get('token') === BRIDGE_TOKEN
}

function allowedOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin
  if (!origin) return undefined

  try {
    const parsed = new URL(origin)
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    return isLoopback && ['http:', 'https:'].includes(parsed.protocol) ? origin : undefined
  } catch {
    return undefined
  }
}

function writeCorsHeaders(request: IncomingMessage, res: ServerResponse): void {
  const origin = allowedOrigin(request)
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  writeCorsHeaders(req, res)

  if (url.pathname !== '/mcp') {
    writeJson(res, 404, { error: 'Not found' })
    return
  }

  if (req.headers.origin && !allowedOrigin(req)) {
    writeJson(res, 403, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Forbidden origin' },
      id: null,
    })
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization, mcp-session-id',
    })
    res.end()
    return
  }

  if (!isAuthorized(req)) {
    writeJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized' },
      id: null,
    })
    return
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    })
    return
  }

  const mcpServer = createMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  try {
    await mcpServer.connect(transport)
    const body = await readJsonBody(req)
    await transport.handleRequest(req, res, body)
    res.on('close', () => {
      transport.close()
      mcpServer.close()
    })
  } catch (error) {
    console.error('Gemma Gem HTTP MCP request failed:', error)
    transport.close()
    mcpServer.close()
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
}

function startRelayServer(enableHttpMcp: boolean): void {
  const server = createServer((req, res) => {
    if (!enableHttpMcp) {
      writeJson(res, 404, { error: 'Not found' })
      return
    }
    handleMcpHttpRequest(req, res).catch(error => {
      console.error('Gemma Gem HTTP MCP handler failed:', error)
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      }
    })
  })
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (url.pathname !== '/extension') {
      socket.destroy()
      return
    }
    if (url.searchParams.get('token') !== BRIDGE_TOKEN) {
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws) => {
    if (extensionSocket) {
      extensionSocket.close()
    }
    extensionSocket = ws
    console.error(`Gemma Gem extension connected on ws://127.0.0.1:${BRIDGE_PORT}/extension`)

    ws.on('message', data => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      const parsed = JSON.parse(text) as BridgeEvent | { type: string }
      if (parsed.type === 'bridge:keepalive') return
      handleBridgeEvent(parsed as BridgeEvent)
    })

    ws.on('close', () => {
      if (extensionSocket === ws) extensionSocket = null
      for (const [requestId, entry] of pending.entries()) {
        clearTimeout(entry.timeout)
        pending.delete(requestId)
        entry.reject(new Error('Gemma Gem extension disconnected'))
      }
      console.error('Gemma Gem extension disconnected')
    })
  })

  server.on('error', error => {
    console.error(`Gemma Gem bridge relay failed on 127.0.0.1:${BRIDGE_PORT}:`, error)
    process.exit(1)
  })

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.error(`Gemma Gem bridge relay listening on ws://127.0.0.1:${BRIDGE_PORT}/extension`)
    if (enableHttpMcp) {
      console.error(`Gemma Gem HTTP MCP listening on http://127.0.0.1:${BRIDGE_PORT}/mcp`)
    }
  })
}

function asTextResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}

function objectResult(value: unknown) {
  return asTextResult(value)
}

function parseToolResult(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : { value }
}

function contentFromToolResult(value: unknown): string {
  const parsed = parseToolResult(value)
  return typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed)
}

async function pageSnapshotFor(
  tabId: number | undefined,
  format: 'text' | 'html',
  maxChars = 8000,
  selector = 'body',
): Promise<string> {
  const result = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'read_page_content',
    arguments: {
      selector,
      format,
    },
  })
  const content = contentFromToolResult(result).trim()
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n...(truncated)` : content
}

type InteractiveControlSummary = {
  selector: string
  label: string
  tag: string
  id?: string
  name?: string
  value?: string
  ariaLabel?: string
}

async function pageContextFor(tabId: number | undefined, selector = 'body'): Promise<string> {
  const [text, html] = await Promise.all([
    pageSnapshotFor(tabId, 'text', 6000, selector),
    pageSnapshotFor(tabId, 'html', 6000, selector),
  ])
  const controls = interactiveControlsFromHtml(html)
  return [
    `Snapshot selector: ${selector}`,
    '',
    'Visible text:',
    text,
    '',
    'Interactive controls:',
    controls.length ? controls.join('\n') : '(none detected)',
    '',
    'Body HTML:',
    html,
  ].join('\n')
}

function attributeValue(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1]
}

function textFromHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function interactiveControlSummariesFromHtml(html: string): InteractiveControlSummary[] {
  const labelByFor = new Map<string, string>()
  const wrappedLabelBySelector = new Map<string, string>()
  for (const labelMatch of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const attrs = labelMatch[1] || ''
    const body = labelMatch[2] || ''
    const labelText = textFromHtml(body)
    const forId = attributeValue(attrs, 'for')
    if (forId && labelText) labelByFor.set(forId, labelText)

    const controlMatch = body.match(/<(input|select|textarea)\b([^>]*)/i)
    if (!controlMatch || !labelText) continue
    const tag = controlMatch[1]
    const controlAttrs = controlMatch[2] || ''
    const id = attributeValue(controlAttrs, 'id')
    const name = attributeValue(controlAttrs, 'name')
    const selector = id ? `#${id}` : name ? `${tag}[name="${name}"]` : tag
    wrappedLabelBySelector.set(selector, labelText)
  }

  const controls: InteractiveControlSummary[] = []
  const pattern = /<(button|a|input|select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/gi
  for (const match of html.matchAll(pattern)) {
    const tag = match[1] || match[4]
    const attrs = match[2] || match[5] || ''
    const body = textFromHtml(match[3] || '')
    const id = attributeValue(attrs, 'id')
    const aria = attributeValue(attrs, 'aria-label')
    const name = attributeValue(attrs, 'name')
    const value = attributeValue(attrs, 'value')
    const selector = id ? `#${id}` : name ? `${tag}[name="${name}"]` : tag
    const label = body || aria || (id ? labelByFor.get(id) : undefined) || wrappedLabelBySelector.get(selector) || value || name || tag
    controls.push({ selector, label, tag, id, name, value, ariaLabel: aria })
    if (controls.length >= 30) break
  }
  return controls
}

function interactiveControlsFromHtml(html: string): string[] {
  return interactiveControlSummariesFromHtml(html).map(control => {
    const metadata = [
      `tag=${control.tag}`,
      control.id ? `id=${control.id}` : undefined,
      control.name ? `name=${control.name}` : undefined,
      control.value ? `value=${control.value}` : undefined,
      control.ariaLabel ? `aria-label=${control.ariaLabel}` : undefined,
    ].filter(Boolean).join(', ')
    return `- ${control.selector}: ${control.label}${metadata ? ` (${metadata})` : ''}`
  })
}

function textFromAgentResult(result: unknown): string {
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') {
    return result.text
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}

function withVisiblePageIdentifiers(text: string, pageSnapshot: string): string {
  const identifiers = [...new Set(pageSnapshot.match(/\b[A-Z]{2,}-\d{4}-\d{3,}\b/g) ?? [])]
    .filter(identifier => !text.includes(identifier))
  if (identifiers.length === 0) return text
  return `${text}\nVisible page identifiers: ${identifiers.join(', ')}`
}

function isTransientModelRuntimeError(text: string): boolean {
  return text.startsWith('Something went wrong:')
    && /(OrtRun|onnxruntime|WebGPU|GPUBuffer|mapAsync|Failed to download data from buffer)/i.test(text)
}

function deterministicObservedActions(instruction: string, pageSnapshot: string): ObservedAction[] {
  const controls = [...pageSnapshot.matchAll(/^- ([^:\n]+): ([^\n]+)/gm)].map(match => ({
    selector: match[1].trim(),
    label: match[2].replace(/\s+\([^)]*\)$/, '').trim(),
  }))
  if (controls.length === 0) return []

  const stopWords = new Set(['a', 'an', 'and', 'as', 'for', 'of', 'on', 'or', 'the', 'that', 'to', 'with'])
  const words = (value: string) => value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(word => word.length > 1 && !stopWords.has(word))
  const instructionWords = new Set(words(instruction))

  return controls
    .map(control => {
      const haystack = `${control.selector} ${control.label}`.toLowerCase()
      const controlWords = new Set(words(haystack))
      let score = 0
      for (const word of instructionWords) {
        if (controlWords.has(word) || haystack.includes(word)) score += 1
      }
      if (instructionWords.has('proof') && instructionWords.has('payment') && haystack.includes('receipt')) score += 4
      if (instructionWords.has('download') && haystack.includes('download')) score += 2
      if (instructionWords.has('invoice') && haystack.includes('invoice')) score += 2
      if (instructionWords.has('settings') && haystack.includes('settings')) score += 2
      return { control, score }
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ control, score }) => ({
      description: `${control.label} (${control.selector})`,
      method: 'click',
      arguments: [control.selector],
      selector: control.selector,
      confidence: Math.min(0.99, 0.55 + score * 0.08),
    }))
}

type RankableActionCandidate = RerankerActionInput & Partial<ObservedAction> & {
  description?: string
  arguments?: unknown[]
}

type LoadedRerankerWeights = {
  path: string
  artifact: RerankerWeightsArtifact
  weights: Map<string, number>
}

let actionRerankerWeightsCache: LoadedRerankerWeights | null = null

function loadActionRerankerWeights(): LoadedRerankerWeights {
  const path = process.env.GEMMA_GEM_ACTION_RERANKER_WEIGHTS
    ? resolve(process.env.GEMMA_GEM_ACTION_RERANKER_WEIGHTS)
    : DEFAULT_RERANKER_WEIGHTS_PATH
  if (actionRerankerWeightsCache?.path === path) return actionRerankerWeightsCache
  if (!existsSync(path)) {
    throw new Error(`Gemma Gem action reranker weights not found: ${path}`)
  }

  const artifact = JSON.parse(readFileSync(path, 'utf8')) as RerankerWeightsArtifact
  const weights = parseRerankerWeights(artifact)
  if (weights.size === 0) {
    throw new Error(`Gemma Gem action reranker weights are empty: ${path}`)
  }

  actionRerankerWeightsCache = { path, artifact, weights }
  return actionRerankerWeightsCache
}

function actionForRankCandidate(candidate: RankableActionCandidate): RerankerActionInput {
  if (candidate.toolName) {
    return {
      status: candidate.status ?? 'candidate',
      toolName: candidate.toolName,
      selector: candidate.selector ?? null,
      text: candidate.text ?? candidate.description ?? null,
      title: candidate.title ?? candidate.description ?? null,
    }
  }

  if (!candidate.method) {
    throw new Error('Each candidate must include either toolName or an observed action method')
  }

  return normalizeObservedAction({
    description: candidate.description ?? '',
    method: candidate.method,
    arguments: candidate.arguments ?? [],
    selector: candidate.selector,
    ref: candidate.ref,
    confidence: candidate.confidence,
  })
}

function rankObservedActions(instruction: string, observedActions: ObservedAction[]): ObservedAction[] {
  if (observedActions.length < 2) return observedActions

  try {
    const loaded = loadActionRerankerWeights()
    return rankActionCandidates(
      { title: instruction, tool: 'gemma_observe' },
      observedActions,
      loaded.weights,
      normalizeObservedAction,
    ).map(item => item.candidate)
  } catch (error) {
    console.error('Gemma Gem action reranker unavailable for gemma_observe:', error)
    return observedActions
  }
}

function observedActionSelector(action: ObservedAction): string {
  const selector = action.selector ?? (typeof action.arguments[0] === 'string' ? action.arguments[0] : undefined)
  if (!selector) {
    throw new Error(`Observed ${action.method} action requires a selector`)
  }
  return selector
}

function observedStringArgument(action: ObservedAction, index: number, name: string): string {
  const value = action.arguments[index]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Observed ${action.method} action requires ${name}`)
  }
  return value
}

function observedNumberArgument(action: ObservedAction, index: number): number | undefined {
  const value = action.arguments[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bridgeToolForObservedAction(action: ObservedAction): { name: BridgeToolName; arguments: Record<string, unknown> } {
  switch (action.method) {
    case 'click':
      return {
        name: 'click_element',
        arguments: { selector: observedActionSelector(action) },
      }

    case 'type':
      return {
        name: 'type_text',
        arguments: {
          selector: observedActionSelector(action),
          text: observedStringArgument(action, 1, 'text at arguments[1]'),
        },
      }

    case 'select': {
      const option = observedStringArgument(action, 1, 'option value or label at arguments[1]')
      return {
        name: 'select_option',
        arguments: {
          selector: observedActionSelector(action),
          value: option,
          label: option,
        },
      }
    }

    case 'scroll': {
      const direction = action.arguments[0] === 'up' ? 'up' : 'down'
      return {
        name: 'scroll_page',
        arguments: {
          direction,
          amount: observedNumberArgument(action, 1) ?? 500,
        },
      }
    }

    case 'navigate':
      throw new Error('Observed navigate actions are not executed by gemma_act; use gemma_agent for navigation workflows')

    case 'wait':
      throw new Error('Observed wait actions are handled without a bridge tool')
  }
}

async function executeObservedAction(action: ObservedAction, tabId: number | undefined): Promise<unknown> {
  if (action.method === 'wait') {
    const waitMs = Math.min(Math.max(observedNumberArgument(action, 0) ?? 1000, 0), 10_000)
    await new Promise(resolve => setTimeout(resolve, waitMs))
    return { waitedMs: waitMs }
  }

  const tool = bridgeToolForObservedAction(action)
  return sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: tool.name,
    arguments: tool.arguments,
  })
}

function toolResultError(value: unknown): string | undefined {
  const parsed = parseToolResult(value)
  return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : undefined
}

function looksLikeTextSelector(selector: string): boolean {
  return /:has-text\(|(?:^|\s)text\s*=/.test(selector)
}

async function recoverClickSelector(tabId: number | undefined, selector: string): Promise<ObservedAction | undefined> {
  const pageSnapshot = await pageContextFor(tabId)
  return deterministicObservedActions(selector, pageSnapshot)
    .find(action => action.method === 'click' && action.selector && action.selector !== selector)
}

async function clickWithSelectorRecovery(tabId: number | undefined, selector: string): Promise<unknown> {
  const preflightRecovery = looksLikeTextSelector(selector)
    ? await recoverClickSelector(tabId, selector)
    : undefined
  if (preflightRecovery?.selector) {
    const result = await sendBridgeRequest({
      type: 'bridge:execute_tool',
      tabId,
      name: 'click_element',
      arguments: { selector: preflightRecovery.selector },
    })
    return {
      recovered: true,
      originalSelector: selector,
      recoveredSelector: preflightRecovery.selector,
      recoveryDescription: preflightRecovery.description,
      result,
    }
  }

  const firstResult = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'click_element',
    arguments: { selector },
  })
  const error = toolResultError(firstResult)
  if (!error) return firstResult

  const recovered = await recoverClickSelector(tabId, selector)
  if (!recovered?.selector) {
    return {
      error,
      selector,
      recovered: false,
      message: 'Click selector failed and no matching interactive control was found.',
    }
  }

  const retryResult = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'click_element',
    arguments: { selector: recovered.selector },
  })
  return {
    recovered: true,
    originalSelector: selector,
    recoveredSelector: recovered.selector,
    recoveryDescription: recovered.description,
    firstError: error,
    result: retryResult,
  }
}

async function typeTextWithSelectorRecovery(tabId: number | undefined, selector: string, text: string, clear: boolean): Promise<unknown> {
  const preflightRecovery = looksLikeTextSelector(selector)
    ? await recoverClickSelector(tabId, selector)
    : undefined
  if (preflightRecovery?.selector) {
    const result = await sendBridgeRequest({
      type: 'bridge:execute_tool',
      tabId,
      name: 'type_text',
      arguments: { selector: preflightRecovery.selector, text, clear },
    })
    return {
      recovered: true,
      originalSelector: selector,
      recoveredSelector: preflightRecovery.selector,
      recoveryDescription: preflightRecovery.description,
      result,
    }
  }

  const firstResult = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'type_text',
    arguments: { selector, text, clear },
  })
  const error = toolResultError(firstResult)
  if (!error) return firstResult

  const recovered = await recoverClickSelector(tabId, selector)
  if (!recovered?.selector) {
    return {
      error,
      selector,
      recovered: false,
      message: 'Type selector failed and no matching form control was found.',
    }
  }

  const retryResult = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'type_text',
    arguments: { selector: recovered.selector, text, clear },
  })
  return {
    recovered: true,
    originalSelector: selector,
    recoveredSelector: recovered.selector,
    recoveryDescription: recovered.description,
    firstError: error,
    result: retryResult,
  }
}

async function selectOptionWithSelectorRecovery(
  tabId: number | undefined,
  selector: string,
  value: string | undefined,
  label: string | undefined,
): Promise<unknown> {
  const preflightRecovery = looksLikeTextSelector(selector)
    ? await recoverClickSelector(tabId, selector)
    : undefined
  const optionArguments = { value, label }
  if (preflightRecovery?.selector) {
    const result = await sendBridgeRequest({
      type: 'bridge:execute_tool',
      tabId,
      name: 'select_option',
      arguments: { selector: preflightRecovery.selector, ...optionArguments },
    })
    return {
      recovered: true,
      originalSelector: selector,
      recoveredSelector: preflightRecovery.selector,
      recoveryDescription: preflightRecovery.description,
      result,
    }
  }

  const firstResult = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'select_option',
    arguments: { selector, ...optionArguments },
  })
  const error = toolResultError(firstResult)
  if (!error) return firstResult

  const recovered = await recoverClickSelector(tabId, selector)
  if (!recovered?.selector) {
    return {
      error,
      selector,
      recovered: false,
      message: 'Select selector failed and no matching select control was found.',
    }
  }

  const retryResult = await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'select_option',
    arguments: { selector: recovered.selector, ...optionArguments },
  })
  return {
    recovered: true,
    originalSelector: selector,
    recoveredSelector: recovered.selector,
    recoveryDescription: recovered.description,
    firstError: error,
    result: retryResult,
  }
}

const MULTI_ACTION_SEQUENCER_PATTERN = /\b(?:and\s+then|then|after\s+that|next|followed\s+by)\b/i
const ACTION_VERBS = new Set([
  'click',
  'choose',
  'download',
  'enter',
  'fill',
  'go',
  'navigate',
  'open',
  'press',
  'scroll',
  'select',
  'submit',
  'tap',
  'type',
])

function clauseHasActionVerb(clause: string): boolean {
  return clause
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .some(token => ACTION_VERBS.has(token.toLowerCase()))
}

function looksLikeMultiActionInstruction(instruction: string): boolean {
  if (MULTI_ACTION_SEQUENCER_PATTERN.test(instruction)) return true

  let actionClauses = 0
  for (const clause of instruction.split(/\s*(?:;|,|\band\b|\bplus\b)\s*/i)) {
    if (!clauseHasActionVerb(clause)) continue
    actionClauses += 1
    if (actionClauses > 1) return true
  }
  return false
}

function multiActionValidationResult(instruction: string) {
  return asTextResult({
    error: 'ERROR_MULTIPLE_ACTIONS',
    message: 'gemma_act performs exactly one browser action. Use gemma_agent for multi-step workflows.',
    instruction,
  })
}

async function sendJsonAgentRequest(request: BridgeRequestInput): Promise<unknown> {
  const result = await sendBridgeRequest(request)
  const text = textFromAgentResult(result)
  if (!isTransientModelRuntimeError(text)) return result

  await new Promise(resolve => setTimeout(resolve, 1000))
  return sendBridgeRequest(request)
}

function screenshotResult(value: unknown) {
  const screenshot = value && typeof value === 'object' && 'screenshot' in value ? value.screenshot : undefined
  if (typeof screenshot !== 'string') return asTextResult(value)

  const match = screenshot.match(/^data:(image\/png);base64,(.+)$/)
  if (!match) return asTextResult({ screenshot })

  return {
    content: [{
      type: 'image' as const,
      mimeType: match[1],
      data: match[2],
    }],
  }
}

function registerTools(server: McpServer): void {
  server.registerTool('gemma_tabs', {
    description: 'List browser tabs that Gemma Gem can address.',
    inputSchema: {},
  }, async () => asTextResult(await sendBridgeRequest({ type: 'bridge:list_tabs' })))

  server.registerTool('gemma_active_tab', {
    description: 'Return the active browser tab id, title, and URL.',
    inputSchema: {},
  }, async () => asTextResult(await sendBridgeRequest({ type: 'bridge:get_active_tab' })))

  server.registerTool('gemma_model_ready', {
    description: 'Ensure the local Gemma model is loaded and ready without running a generation. Returns model readiness timing for diagnostics.',
    inputSchema: {
      timeoutMs: z.number().int().positive().optional().describe('Optional readiness timeout in milliseconds. Defaults to the bridge agent timeout.'),
    },
  }, async ({ timeoutMs }) => asTextResult(await sendBridgeRequest({ type: 'bridge:ensure_model_ready', timeoutMs })))

  server.registerTool('gemma_observe', {
    description: 'Discover relevant page actions or extraction targets from natural language. Returns candidate actions that can be passed to gemma_act.',
    inputSchema: {
      instruction: z.string().describe('What to find on the page, e.g. "find the login button" or "find all pricing cards".'),
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
    },
  }, async ({ instruction, tabId }) => {
    const pageSnapshot = await pageContextFor(tabId)
    const observedActions = deterministicObservedActions(instruction, pageSnapshot)
    if (observedActions.length > 0) {
      return asTextResult(JSON.stringify(rankObservedActions(instruction, observedActions)))
    }

    const prompt = [
      'You are implementing gemma_observe, a Stagehand-style browser observation primitive.',
      'The active browser tab is already selected. Do not ask for a URL, screenshot, or HTML.',
      'Inspect the current page and return ONLY a valid JSON array of candidate actions or targets.',
      'Each array item must have: description, method, arguments, and optionally selector, ref, confidence.',
      'Allowed methods: click, type, scroll, select, navigate, wait.',
      '',
      'Current page snapshot and HTML:',
      pageSnapshot,
      '',
      `Observation request: ${instruction}`,
    ].join('\n')

    const result = await sendJsonAgentRequest({
      type: 'bridge:run_agent',
      tabId,
      prompt,
      settings: { thinking: false, maxIterations: 6 },
    })
    return asTextResult(normalizeJsonText(textFromAgentResult(result)))
  })

  server.registerTool('gemma_rank_actions', {
    description: 'Rank observed or proposed browser action candidates with the checked Gemma Gem action-reranker weights. Use after gemma_observe or when choosing among selectors before gemma_act.',
    inputSchema: {
      task: z.object({
        id: z.string().optional().describe('Stable task id, if known.'),
        suite: z.string().optional().describe('Task suite/category, if known.'),
        title: z.string().optional().describe('Natural-language task title or instruction.'),
        tool: z.string().optional().describe('Calling Gemma Gem tool, such as gemma_observe, gemma_extract, gemma_page_brief, gemma_agent, or gemma_transfer_fields.'),
      }).optional().describe('Task context used by the reranker feature model.'),
      instruction: z.string().optional().describe('Fallback task instruction when task.title is not provided.'),
      tool: z.string().optional().describe('Fallback calling Gemma Gem tool when task.tool is not provided.'),
      candidates: z.array(z.object({
        description: z.string().optional().describe('Human-readable action description, usually from gemma_observe.'),
        method: z.enum(['click', 'type', 'scroll', 'select', 'navigate', 'wait']).optional().describe('ObservedAction method from gemma_observe.'),
        arguments: z.array(z.unknown()).optional().describe('ObservedAction arguments from gemma_observe.'),
        selector: z.string().optional().describe('CSS selector for this candidate.'),
        ref: z.string().optional().describe('Optional observed action ref.'),
        confidence: z.number().optional().describe('Optional observed action confidence.'),
        status: z.string().optional().describe('Optional trace status. Defaults to candidate.'),
        toolName: z.string().optional().describe('Explicit browser tool name such as read_page_content, click_element, or type_text. Overrides method mapping.'),
        text: z.string().nullable().optional().describe('Optional compact action text for feature scoring.'),
        title: z.string().nullable().optional().describe('Optional candidate title/label for feature scoring.'),
      })).min(1).describe('Candidate actions to rank.'),
    },
  }, async ({ task, instruction, tool, candidates }) => {
    const loaded = loadActionRerankerWeights()
    const taskContext: ActionRerankerTask = {
      id: task?.id,
      suite: task?.suite,
      title: task?.title ?? instruction,
      tool: task?.tool ?? tool,
    }
    const ranked = rankActionCandidates(
      taskContext,
      candidates as RankableActionCandidate[],
      loaded.weights,
      actionForRankCandidate,
    )

    return objectResult({
      model: {
        type: loaded.artifact.model?.type,
        featureSet: loaded.artifact.model?.featureSet,
        weightCount: loaded.weights.size,
        artifactPath: loaded.path.replace(REPO_ROOT, '.').replaceAll('\\', '/'),
      },
      task: taskContext,
      best: ranked[0] ?? null,
      ranked,
    })
  })

  server.registerTool('gemma_act', {
    description: 'Perform exactly one natural-language browser action, or execute one action returned by gemma_observe.',
    inputSchema: {
      instruction: z.string().optional().describe('Single action to perform, e.g. "click the login button".'),
      action: z.object({
        description: z.string(),
        method: z.enum(['click', 'type', 'scroll', 'select', 'navigate', 'wait']),
        arguments: z.array(z.unknown()),
        selector: z.string().optional(),
        ref: z.string().optional(),
        confidence: z.number().optional(),
      }).optional().describe('A single ObservedAction returned by gemma_observe.'),
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
    },
  }, async ({ instruction, action, tabId }) => {
    if (!instruction && !action) {
      throw new Error('gemma_act requires either instruction or action')
    }
    if (action) {
      return asTextResult(await executeObservedAction(action satisfies ObservedAction, tabId))
    }

    const actionText = (instruction ?? '').trim()
    if (looksLikeMultiActionInstruction(actionText)) {
      return multiActionValidationResult(actionText)
    }

    const prompt = [
      'You are implementing gemma_act, a Stagehand-style single-action browser primitive.',
      'Perform exactly one browser action. Do not perform a multi-step workflow.',
      'If the request requires multiple browser actions, respond with ERROR_MULTIPLE_ACTIONS and do not act.',
      `Action request: ${actionText}`,
    ].join('\n')

    const result = await sendJsonAgentRequest({
      type: 'bridge:run_agent',
      tabId,
      prompt,
      settings: { thinking: false, maxIterations: 4 },
    })
    return asTextResult(textFromAgentResult(result))
  })

  server.registerTool('gemma_extract', {
    description: 'Extract structured data from the active page, optionally constrained by selector and JSON schema.',
    inputSchema: {
      instruction: z.string().describe('What data to extract.'),
      schema: z.record(z.string(), z.unknown()).optional().describe('Optional JSON Schema-like object describing the expected output shape.'),
      selector: z.string().optional().describe('Optional CSS selector or observed target selector to scope extraction.'),
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
    },
  }, async ({ instruction, schema, selector, tabId }) => {
    const pageSnapshot = await pageContextFor(tabId, selector ?? 'body')
    const prompt = [
      'You are implementing gemma_extract, a Stagehand-style structured extraction primitive.',
      'The active browser tab is already selected. Do not ask for a URL, screenshot, or HTML.',
      'Return ONLY valid JSON. Do not include markdown fences or commentary.',
      selector ? `Scope selector: ${selector}` : '',
      schema ? `Requested schema: ${JSON.stringify(schema)}` : '',
      '',
      'Current page snapshot and HTML:',
      pageSnapshot,
      '',
      `Extraction request: ${instruction}`,
    ].filter(Boolean).join('\n')

    const result = await sendJsonAgentRequest({
      type: 'bridge:run_agent',
      tabId,
      prompt,
      settings: { thinking: false, maxIterations: 6 },
    })
    let normalized = normalizeJsonText(textFromAgentResult(result))

    if (schema) {
      const errors = jsonSchemaErrors(normalized, schema)
      if (errors.length > 0) {
        const retryPrompt = [
          prompt,
          '',
          'The previous extraction JSON failed the requested schema validation.',
          'Return ONLY corrected valid JSON for the same extraction request.',
          'Validation errors:',
          ...errors.slice(0, 12).map(error => `- ${error}`),
        ].join('\n')
        const retryResult = await sendJsonAgentRequest({
          type: 'bridge:run_agent',
          tabId,
          prompt: retryPrompt,
          settings: { thinking: false, maxIterations: 4 },
        })
        normalized = normalizeJsonText(textFromAgentResult(retryResult))
      }
    }

    return asTextResult(normalized)
  })

  server.registerTool('gemma_agent', {
    description: 'Delegate a multi-step browser task to the local Gemma Gem extension agent. This is model-to-model: provide explicit goals, constraints, and expected output shape so Gemma Gem can report back to the caller model.',
    inputSchema: {
      task: z.string().describe('The browser task to perform.'),
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      thinking: z.boolean().optional().describe('Enable Gemma thinking chunks during the task.'),
      maxIterations: z.number().int().min(1).max(50).optional().describe('Maximum tool loop iterations. Defaults to 10.'),
    },
  }, async ({ task, tabId, thinking, maxIterations }) => {
    const pageSnapshot = await pageContextFor(tabId)
    const prompt = [
      'You are Gemma Gem, collaborating with another AI model over MCP.',
      'The active browser tab is already selected. Do not ask for a URL, screenshot, HTML, selectors, or data that is visible in the current page snapshot.',
      'Use the page snapshot and your browser tools to complete the delegated task.',
      'When choosing among controls, use the Interactive controls list and prefer the selector whose label semantically matches the task. For proof of payment, the receipt control is the target action; invoice controls are not proof-of-payment controls.',
      'In the final response, include the exact selector you used and copy any visible invoice, order, receipt, or payment identifier from the page snapshot as context when available.',
      'Treat the caller as a peer agent: be concise, report exact actions and blockers, and ask for missing selectors/data instead of guessing.',
      'When useful, return structured JSON or compact bullet points that another model can parse.',
      '',
      'Current page snapshot and HTML:',
      pageSnapshot,
      '',
      `Delegated task: ${task}`,
    ].join('\n')

    const result = await sendBridgeRequest({
      type: 'bridge:run_agent',
      tabId,
      prompt,
      settings: { thinking: thinking ?? true, maxIterations: maxIterations ?? 10 },
    })
    return asTextResult(withVisiblePageIdentifiers(textFromAgentResult(result), pageSnapshot))
  })

  server.registerTool('gemma_screenshot', {
    description: 'Capture the visible area of the target browser tab.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
    },
  }, async ({ tabId }) => screenshotResult(await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'take_screenshot',
    arguments: {},
  })))

  server.registerTool('gemma_stop', {
    description: 'Stop the active Gemma Gem browser task.',
    inputSchema: {
      runId: z.string().optional().describe('Optional run id. Current implementation stops the active extension run.'),
    },
  }, async ({ runId }) => asTextResult(await sendBridgeRequest({ type: 'bridge:stop', runId })))

  server.registerTool('gemma_read_page', {
    description: 'Read text or HTML from the target browser tab using Gemma Gem content tools.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      selector: z.string().optional().describe('Optional CSS selector to scope the read. Defaults to body.'),
      format: z.enum(['text', 'html']).optional().describe('Read as visible text or HTML. Defaults to text.'),
    },
  }, async ({ tabId, selector, format }) => asTextResult(await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'read_page_content',
    arguments: {
      selector: selector ?? 'body',
      format: format ?? 'text',
    },
  })))

  server.registerTool('gemma_click', {
    description: 'Click one element in the target browser tab by CSS selector.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      selector: z.string().describe('CSS selector for the element to click.'),
    },
  }, async ({ tabId, selector }) => asTextResult(await clickWithSelectorRecovery(tabId, selector)))

  server.registerTool('gemma_type_text', {
    description: 'Type text into an input or textarea in the target browser tab by CSS selector.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      selector: z.string().describe('CSS selector for the input or textarea.'),
      text: z.string().describe('Text to type.'),
      clear: z.boolean().optional().describe('Clear the existing field value before typing. Defaults to true.'),
    },
  }, async ({ tabId, selector, text, clear }) => asTextResult(await typeTextWithSelectorRecovery(tabId, selector, text, clear ?? true)))

  server.registerTool('gemma_select_option', {
    description: 'Select an option from a dropdown in the target browser tab by option value or visible label.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      selector: z.string().describe('CSS selector for the select element.'),
      value: z.string().optional().describe('Exact option value to select.'),
      label: z.string().optional().describe('Exact visible option label to select.'),
    },
  }, async ({ tabId, selector, value, label }) => {
    if (!value && !label) {
      throw new Error('gemma_select_option requires either value or label')
    }
    return asTextResult(await selectOptionWithSelectorRecovery(tabId, selector, value, label))
  })

  server.registerTool('gemma_scroll', {
    description: 'Scroll the target browser tab by a pixel amount.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      amount: z.number().describe('Pixels to scroll. Positive scrolls down, negative scrolls up.'),
    },
  }, async ({ tabId, amount }) => asTextResult(await sendBridgeRequest({
    type: 'bridge:execute_tool',
    tabId,
    name: 'scroll_page',
    arguments: { direction: amount < 0 ? 'up' : 'down', amount: Math.abs(amount) },
  })))

  server.registerTool('gemma_page_brief', {
    description: 'Return a model-friendly brief of a tab: title, URL, selected text/HTML content, and guidance for a caller model planning next actions.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Optional target tab id from gemma_tabs. Defaults to the active tab.'),
      selector: z.string().optional().describe('Optional CSS selector to scope the brief. Defaults to body.'),
      format: z.enum(['text', 'html']).optional().describe('Read as text or HTML. Defaults to text.'),
      maxChars: z.number().int().min(200).max(64000).optional().describe('Maximum content characters to return. Defaults to 8000.'),
    },
  }, async ({ tabId, selector, format, maxChars }) => {
    const [tabsValue, activeValue] = await Promise.all([
      sendBridgeRequest({ type: 'bridge:list_tabs' }),
      tabId == null ? sendBridgeRequest({ type: 'bridge:get_active_tab' }) : Promise.resolve(undefined),
    ])

    const tabs = Array.isArray(tabsValue) ? tabsValue as Array<{ id: number; title?: string; url?: string; active?: boolean }> : []
    const targetTabId = tabId ?? (parseToolResult(activeValue).id as number | undefined)
    const tab = tabs.find(item => item.id === targetTabId)
    const requestedSelector = selector ?? 'body'
    const requestedFormat = format ?? 'text'
    const readResult = await sendBridgeRequest({
      type: 'bridge:execute_tool',
      tabId: targetTabId,
      name: 'read_page_content',
      arguments: {
        selector: requestedSelector,
        format: requestedFormat,
      },
    })
    const content = contentFromToolResult(readResult)
    const limit = maxChars ?? 8000
    const html = requestedFormat === 'html'
      ? content
      : await pageSnapshotFor(targetTabId, 'html', 16000, requestedSelector)
    const interactiveControls = interactiveControlSummariesFromHtml(html)

    return objectResult({
      tab: {
        id: targetTabId,
        title: tab?.title,
        url: tab?.url,
        active: tab?.active,
      },
      selector: requestedSelector,
      format: requestedFormat,
      content: content.length > limit ? `${content.slice(0, limit)}\n...(truncated)` : content,
      truncated: content.length > limit,
      interactiveControls,
      peerGuidance: [
        'Use gemma_read_page for exact selector reads.',
        'Use gemma_transfer_fields when copying values from one tab into another tab.',
        'Use gemma_type_text and gemma_click for deterministic form operations.',
        'Use gemma_agent only when page interpretation or judgment is needed.',
      ],
    })
  })

  server.registerTool('gemma_transfer_fields', {
    description: 'Copy data from selectors in one tab to selectors in another tab, optionally clicking a submit/save selector. Designed for model-to-model workflows where the caller model plans the mapping and Gemma Gem executes it.',
    inputSchema: {
      sourceTabId: z.number().int().describe('Tab id to read values from.'),
      destinationTabId: z.number().int().describe('Tab id to type values into.'),
      mappings: z.array(z.object({
        label: z.string().optional().describe('Human-readable field label for trace output.'),
        fromSelector: z.string().describe('CSS selector to read from in the source tab.'),
        toSelector: z.string().describe('CSS selector to type into in the destination tab.'),
        format: z.enum(['text', 'html']).optional().describe('Read source value as text or HTML. Defaults to text.'),
      })).min(1).describe('Source-to-destination selector mappings.'),
      submitSelector: z.string().optional().describe('Optional CSS selector to click in the destination tab after all fields are typed.'),
      resultSelector: z.string().optional().describe('Optional CSS selector to read from the destination tab after submit.'),
    },
  }, async ({ sourceTabId, destinationTabId, mappings, submitSelector, resultSelector }) => {
    const copiedFields: Array<{
      label?: string
      fromSelector: string
      toSelector: string
      value: string
      readResult: Record<string, unknown>
      writeResult: Record<string, unknown>
    }> = []

    for (const mapping of mappings) {
      const readResult = await sendBridgeRequest({
        type: 'bridge:execute_tool',
        tabId: sourceTabId,
        name: 'read_page_content',
        arguments: {
          selector: mapping.fromSelector,
          format: mapping.format ?? 'text',
        },
      })
      const value = contentFromToolResult(readResult).trim()
      const writeResult = await sendBridgeRequest({
        type: 'bridge:execute_tool',
        tabId: destinationTabId,
        name: 'type_text',
        arguments: {
          selector: mapping.toSelector,
          text: value,
          clear: true,
        },
      })

      copiedFields.push({
        label: mapping.label,
        fromSelector: mapping.fromSelector,
        toSelector: mapping.toSelector,
        value,
        readResult: parseToolResult(readResult),
        writeResult: parseToolResult(writeResult),
      })
    }

    let submitResult: Record<string, unknown> | undefined
    if (submitSelector) {
      submitResult = parseToolResult(await sendBridgeRequest({
        type: 'bridge:execute_tool',
        tabId: destinationTabId,
        name: 'click_element',
        arguments: { selector: submitSelector },
      }))
    }

    let destinationResult: Record<string, unknown> | undefined
    if (resultSelector) {
      const result = await sendBridgeRequest({
        type: 'bridge:execute_tool',
        tabId: destinationTabId,
        name: 'read_page_content',
        arguments: {
          selector: resultSelector,
          format: 'text',
        },
      })
      destinationResult = parseToolResult(result)
    }

    return objectResult({
      ok: true,
      sourceTabId,
      destinationTabId,
      copiedFields,
      submitSelector,
      submitResult,
      resultSelector,
      destinationResult,
      peerSummary: {
        action: 'Copied mapped source fields into destination fields',
        fieldCount: copiedFields.length,
        submitted: !!submitSelector,
      },
    })
  })
}

async function main(): Promise<void> {
  startRelayServer(HTTP_MODE)

  if (HTTP_MODE) {
    console.error('Gemma Gem MCP sidecar running in Streamable HTTP mode')
    return
  }

  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Gemma Gem MCP sidecar running on stdio')
}

main().catch(error => {
  console.error('Gemma Gem MCP sidecar failed:', error)
  process.exit(1)
})
