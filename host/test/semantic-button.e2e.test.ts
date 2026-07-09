import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'
import type { BridgeEvent, BridgeRequest } from '../../shared/bridge-messages'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const TOKEN = 'test-token-semantic-button'
let fakeExtractAttempts = 0
let fakeAgentRuntimeError = false
let fakeAgentRuntimeErrorAfterClick = false

async function getFreePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not allocate a test port')
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

async function connectFakeExtension(port: number): Promise<{ ws: WebSocket; requests: BridgeRequest[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${TOKEN}`)
  await once(ws, 'open')
  const requests: BridgeRequest[] = []

  ws.on('message', data => {
    const request = JSON.parse(data.toString('utf8')) as BridgeRequest | { type: string }
    if (request.type === 'bridge:keepalive') return

    requests.push(request as BridgeRequest)
    const response = handleFakeBridgeRequest(request as BridgeRequest)
    if (Array.isArray(response)) {
      for (const event of response) {
        ws.send(JSON.stringify(event))
      }
    } else {
      ws.send(JSON.stringify(response))
    }
  })

  return { ws, requests }
}

function handleFakeBridgeRequest(request: BridgeRequest): BridgeEvent | BridgeEvent[] {
  switch (request.type) {
    case 'bridge:list_tabs':
      return {
        type: 'bridge:response',
        requestId: request.requestId,
        result: [{
          id: 7,
          active: true,
          title: 'Billing sandbox',
          url: 'http://127.0.0.1:4173/semantic-button.html',
        }],
      }

    case 'bridge:get_active_tab':
      return {
        type: 'bridge:response',
        requestId: request.requestId,
        result: {
          id: 7,
          title: 'Billing sandbox',
          url: 'http://127.0.0.1:4173/semantic-button.html',
        },
      }

    case 'bridge:ensure_model_ready':
      return {
        type: 'bridge:response',
        requestId: request.requestId,
        result: {
          modelId: 'gemma-4-e2b',
          status: 'ready',
          loadMs: 0,
          phase: 'fake-ready',
          progress: 100,
        },
      }

    case 'bridge:run_agent': {
      assert.equal(request.tabId, 7)
      if (request.prompt.includes('gemma_extract')) {
        fakeExtractAttempts += 1
        assert.match(request.prompt, /Requested schema:/)
        if (fakeExtractAttempts === 1) {
          return {
            type: 'bridge:response',
            requestId: request.requestId,
            result: {
              text: '{"plans":[{"name":"Starter"},{"name":"Team","price":"$49/month"}]}',
            },
          }
        }

        assert.match(request.prompt, /failed the requested schema validation/)
        assert.match(request.prompt, /\$\.plans\[0\]\.price is required/)
        return {
          type: 'bridge:response',
          requestId: request.requestId,
          result: {
            text: '{"plans":[{"name":"Starter","price":"$19/month"},{"name":"Team","price":"$49/month"}]}',
          },
        }
      }

      assert.match(request.prompt, /collaborating with another AI model over MCP/)
      assert.match(request.prompt, /get proof of last payment/i)
      if (fakeAgentRuntimeError) {
        fakeAgentRuntimeError = false
        return {
          type: 'bridge:response',
          requestId: request.requestId,
          result: {
            text: 'Something went wrong: operation does not support unaligned accesses',
          },
        }
      }
      if (fakeAgentRuntimeErrorAfterClick) {
        fakeAgentRuntimeErrorAfterClick = false
        return [
          {
            type: 'bridge:chunk',
            requestId: request.requestId,
            text: '[Tool] click_element({"selector":"#download-receipt"})',
          },
          {
            type: 'bridge:response',
            requestId: request.requestId,
            result: {
              text: 'Something went wrong: operation does not support unaligned accesses',
            },
          },
        ]
      }
      return [
        {
          type: 'bridge:chunk',
          requestId: request.requestId,
          text: '[Thinking] The receipt download is the proof of last payment.',
        },
        {
          type: 'bridge:response',
          requestId: request.requestId,
          result: {
            text: 'SUCCESS: selected #download-receipt and downloaded receipt for INV-2026-041',
          },
        },
      ]
    }

    case 'bridge:execute_tool':
      if (request.name === 'read_page_content') {
        return {
          type: 'bridge:response',
          requestId: request.requestId,
          result: {
            content: [
              'Invoice INV-2026-041',
              'Last payment: paid',
              '<button id="download-invoice">Invoice PDF</button>',
              '<button id="download-receipt">Receipt PDF</button>',
              '<button id="payment-settings">Payment settings</button>',
            ].join('\n'),
          },
        }
      }
      if (request.name === 'click_element') {
        assert.equal(request.arguments.selector, '#download-receipt')
        return {
          type: 'bridge:response',
          requestId: request.requestId,
          result: { clicked: 'button: Receipt PDF' },
        }
      }
      return {
        type: 'bridge:response',
        requestId: request.requestId,
        result: { ok: true },
      }

    case 'bridge:stop':
      return {
        type: 'bridge:response',
        requestId: request.requestId,
        result: { stopped: true },
      }
  }
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  if ('toolResult' in result) return JSON.stringify(result.toolResult)
  return result.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
}

test('HTTP sidecar delegates semantic button task through the bridge', async (t) => {
  fakeExtractAttempts = 0
  fakeAgentRuntimeError = false
  fakeAgentRuntimeErrorAfterClick = false
  const port = await getFreePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'host/src/index.ts', '--http'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GEMMA_GEM_BRIDGE_TOKEN: TOKEN,
      GEMMA_GEM_BRIDGE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    child.kill()
  })

  await waitForOutput(child, /HTTP MCP listening/)
  const fakeExtension = await connectFakeExtension(port)
  t.after(() => {
    fakeExtension.ws.close()
  })

  const badOriginResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      origin: 'https://example.invalid',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(badOriginResponse.status, 403)

  const preflightResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  })
  assert.equal(preflightResponse.status, 204)
  assert.equal(preflightResponse.headers.get('access-control-allow-origin'), 'http://127.0.0.1')

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${TOKEN}`,
      },
    },
  })
  const client = new Client({ name: 'semantic-button-e2e', version: '0.0.0' })
  t.after(async () => {
    await client.close()
  })

  await client.connect(transport)
  const observeResult = await client.callTool({
    name: 'gemma_observe',
    arguments: {
      tabId: 7,
      instruction: 'download payment document',
    },
  })
  const observedActions = JSON.parse(toolText(observeResult)) as Array<{
    description: string
    method: string
    arguments: unknown[]
    selector: string
  }>
  assert.equal(observedActions[0].selector, '#download-receipt')
  assert.equal(observedActions[0].method, 'click')

  const actResult = await client.callTool({
    name: 'gemma_act',
    arguments: {
      tabId: 7,
      action: observedActions[0],
    },
  })
  assert.match(toolText(actResult), /Receipt PDF/)

  const rankResult = await client.callTool({
    name: 'gemma_rank_actions',
    arguments: {
      task: {
        id: 'semantic-observe-json',
        title: 'Find proof of last payment',
        tool: 'gemma_observe',
      },
      candidates: [
        {
          description: 'Receipt PDF (#download-receipt)',
          method: 'click',
          arguments: ['#download-receipt'],
          selector: '#download-receipt',
        },
        {
          description: 'Invoice PDF (#download-invoice)',
          method: 'click',
          arguments: ['#download-invoice'],
          selector: '#download-invoice',
        },
        {
          description: 'Payment settings (#payment-settings)',
          method: 'click',
          arguments: ['#payment-settings'],
          selector: '#payment-settings',
        },
      ],
    },
  })
  const rankPayload = JSON.parse(toolText(rankResult)) as {
    best: { score: number; candidate: { selector: string } }
    ranked: Array<{ score: number; candidate: { selector: string } }>
  }
  assert.equal(rankPayload.best.candidate.selector, '#download-receipt')
  assert.ok(rankPayload.ranked[0].score > rankPayload.ranked[1].score)

  const extractResult = await client.callTool({
    name: 'gemma_extract',
    arguments: {
      tabId: 7,
      instruction: 'extract pricing plans',
      schema: {
        type: 'object',
        properties: {
          plans: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'string' },
              },
              required: ['name', 'price'],
            },
          },
        },
        required: ['plans'],
      },
    },
  })
  const extractPayload = JSON.parse(toolText(extractResult)) as { plans: Array<{ name: string; price: string }> }
  assert.equal(fakeExtractAttempts, 2)
  assert.equal(extractPayload.plans[0].price, '$19/month')
  assert.equal(extractPayload.plans[1].price, '$49/month')

  const multiActResult = await client.callTool({
    name: 'gemma_act',
    arguments: {
      tabId: 7,
      instruction: 'click the receipt button and then open payment settings',
    },
  })
  assert.match(toolText(multiActResult), /ERROR_MULTIPLE_ACTIONS/)
  assert.match(toolText(multiActResult), /gemma_agent/)

  const result = await client.callTool({
    name: 'gemma_agent',
    arguments: {
      tabId: 7,
      task: 'get proof of last payment',
      thinking: false,
      maxIterations: 3,
    },
  })

  assert.match(toolText(result), /#download-receipt/)
  assert.match(toolText(result), /INV-2026-041/)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:run_agent').length, 3)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:run_agent' && request.prompt.includes('collaborating with another AI model over MCP')).length, 1)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:execute_tool' && request.name === 'click_element').length, 1)

  fakeAgentRuntimeError = true
  const recoveredResult = await client.callTool({
    name: 'gemma_agent',
    arguments: {
      tabId: 7,
      task: 'get proof of last payment',
      thinking: false,
      maxIterations: 3,
    },
  })

  assert.match(toolText(recoveredResult), /Recovered from transient model runtime error/)
  assert.match(toolText(recoveredResult), /#download-receipt/)
  assert.match(toolText(recoveredResult), /INV-2026-041/)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:run_agent').length, 4)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:run_agent' && request.prompt.includes('collaborating with another AI model over MCP')).length, 2)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:execute_tool' && request.name === 'click_element').length, 2)

  fakeAgentRuntimeErrorAfterClick = true
  const recoveredAfterClickResult = await client.callTool({
    name: 'gemma_agent',
    arguments: {
      tabId: 7,
      task: 'get proof of last payment',
      thinking: false,
      maxIterations: 3,
    },
  })

  assert.match(toolText(recoveredAfterClickResult), /already executed/)
  assert.match(toolText(recoveredAfterClickResult), /#download-receipt/)
  assert.match(toolText(recoveredAfterClickResult), /INV-2026-041/)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:run_agent').length, 5)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:run_agent' && request.prompt.includes('collaborating with another AI model over MCP')).length, 3)
  assert.equal(fakeExtension.requests.filter(request => request.type === 'bridge:execute_tool' && request.name === 'click_element').length, 2)
})
