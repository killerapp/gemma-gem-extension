import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmark.web.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.jsonl')

type ActionTraceEvent = {
  status?: string
  toolName?: string
  title?: string
  text?: string
  timestamp?: number
}

type TaskTrace = {
  id?: string
  suite?: string
  title?: string
  tool?: string
  success?: boolean
  strict?: boolean
  jsonValid?: boolean
  selectorHits?: number
  selectorChecks?: number
  actions?: number
  timeout?: boolean
  toolErrors?: number
  notes?: string[]
  actionTrace?: ActionTraceEvent[]
}

type ExportRecord = {
  recordType: 'web-control-action'
  sourceFile: string
  task: {
    id: string
    suite: string
    title: string
    tool: string
    targetSelector?: string
  }
  outcome: {
    success: boolean
    strict: boolean
    jsonValid: boolean
    selectorHitRate: number | null
    timeout: boolean
    toolErrors: number
  }
  action: {
    index: number
    status: string
    toolName: string | null
    selector: string | null
    text: string | null
    title: string | null
  }
  label: 'positive' | 'negative'
}

function parseArgs(): { input: string; output: string } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_INPUT ? resolve(process.env.GEMMA_GEM_TRACE_INPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_TRACE_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_OUTPUT) : DEFAULT_OUTPUT

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--input') {
      const value = args[i + 1]
      if (!value) throw new Error('--input requires a path')
      input = resolve(value)
      i += 1
    } else if (arg.startsWith('--input=')) {
      input = resolve(arg.slice('--input='.length))
    } else if (arg === '--output') {
      const value = args[i + 1]
      if (!value) throw new Error('--output requires a path')
      output = resolve(value)
      i += 1
    } else if (arg.startsWith('--output=')) {
      output = resolve(arg.slice('--output='.length))
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path> and --output <path>.`)
    }
  }

  return { input, output }
}

function shortText(value: unknown, maxChars = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...(truncated)` : normalized
}

function selectorFromText(text: string | undefined): string | null {
  if (!text) return null

  const jsonSelector = text.match(/"selector"\s*:\s*"([^"]+)"/)
  if (jsonSelector) return jsonSelector[1]

  const compactSelector = text.match(/(?:^|\s)selector=([^\s]+)/)
  if (compactSelector) return compactSelector[1]

  const idSelector = text.match(/#[A-Za-z0-9_-]+/)
  if (idSelector) return idSelector[0]

  return null
}

function selectorHitRate(task: TaskTrace): number | null {
  if (typeof task.selectorChecks !== 'number' || task.selectorChecks <= 0) return null
  return (task.selectorHits ?? 0) / task.selectorChecks
}

function actionTitle(action: ActionTraceEvent): string | null {
  return shortText(action.title, 200) ?? (action.status === 'tool' ? 'bridge:execute_tool' : null)
}

function taskRecords(task: TaskTrace, sourceFile: string): ExportRecord[] {
  const actions = Array.isArray(task.actionTrace) ? task.actionTrace : []
  if (actions.length === 0) return []
  const scopedTaskText = `${task.id ?? ''} ${task.title ?? ''}`.toLowerCase()
  const targetSelector = scopedTaskText.includes('scoped')
    ? actions
      .map(action => selectorFromText(action.text))
      .find(selector => selector && selector !== 'body') ?? undefined
    : undefined

  return actions.map((action, index) => ({
    recordType: 'web-control-action',
    sourceFile,
    task: {
      id: task.id ?? 'unknown',
      suite: task.suite ?? 'unknown',
      title: task.title ?? 'unknown',
      tool: task.tool ?? 'unknown',
      ...(targetSelector ? { targetSelector } : {}),
    },
    outcome: {
      success: task.success === true,
      strict: task.strict === true,
      jsonValid: task.jsonValid === true,
      selectorHitRate: selectorHitRate(task),
      timeout: task.timeout === true,
      toolErrors: task.toolErrors ?? 0,
    },
    action: {
      index,
      status: action.status ?? 'unknown',
      toolName: action.toolName ?? null,
      selector: selectorFromText(action.text),
      text: shortText(action.text),
      title: actionTitle(action),
    },
    label: task.success === true && task.strict === true && task.timeout !== true ? 'positive' : 'negative',
  }))
}

async function main(): Promise<void> {
  const { input, output } = parseArgs()
  if (!existsSync(input)) throw new Error(`Trace source not found: ${input}`)

  const lines = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const records: ExportRecord[] = []
  for (const line of lines) {
    const parsed = JSON.parse(line) as TaskTrace & { type?: string }
    if (parsed.type === 'model_ready_preflight') continue
    records.push(...taskRecords(parsed, input.replace(REPO_ROOT, '.').replaceAll('\\', '/')))
  }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''))

  const uniqueTasks = new Set(records.map(record => record.task.id))
  const positives = records.filter(record => record.label === 'positive').length
  console.log(`Exported ${records.length} action trace records from ${uniqueTasks.size} tasks`)
  console.log(`Positive records: ${positives}`)
  console.log(`Output: ${output}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
