import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-preferences.jsonl')
const VOLATILE_KEYS = new Set([
  'requestId',
  'timestamp',
  'tabId',
  'durationMs',
  'taskOutputPreview',
])
const LABEL_LEAKAGE_PATTERN = /\b(wrong|negative|counterfactual|positive)\b/i

type PreferenceAction = {
  sourceFile?: unknown
  index?: unknown
  status?: unknown
  toolName?: unknown
  selector?: unknown
  text?: unknown
  title?: unknown
}

type PreferenceRecord = {
  recordType?: unknown
  sourceFile?: unknown
  pairIndex?: unknown
  bucket?: {
    taskId?: unknown
    toolName?: unknown
  }
  task?: {
    id?: unknown
    suite?: unknown
    title?: unknown
    tool?: unknown
  }
  preferred?: PreferenceAction
  rejected?: PreferenceAction
}

type PreferenceCheckConfig = {
  input: string
  minPairs?: number
  minBuckets?: number
  minTasks?: number
  minReadPairs?: number
  minClickPairs?: number
  minTypePairs?: number
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): PreferenceCheckConfig {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT) : DEFAULT_INPUT
  let minPairs: number | undefined
  let minBuckets: number | undefined
  let minTasks: number | undefined
  let minReadPairs: number | undefined
  let minClickPairs: number | undefined
  let minTypePairs: number | undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--input') {
      if (!value) throw new Error('--input requires a path')
      input = resolve(value)
      i += 1
    } else if (arg.startsWith('--input=')) {
      input = resolve(arg.slice('--input='.length))
    } else if (arg === '--min-pairs') {
      minPairs = parseNumber(value, '--min-pairs')
      i += 1
    } else if (arg.startsWith('--min-pairs=')) {
      minPairs = parseNumber(arg.slice('--min-pairs='.length), '--min-pairs')
    } else if (arg === '--min-buckets') {
      minBuckets = parseNumber(value, '--min-buckets')
      i += 1
    } else if (arg.startsWith('--min-buckets=')) {
      minBuckets = parseNumber(arg.slice('--min-buckets='.length), '--min-buckets')
    } else if (arg === '--min-tasks') {
      minTasks = parseNumber(value, '--min-tasks')
      i += 1
    } else if (arg.startsWith('--min-tasks=')) {
      minTasks = parseNumber(arg.slice('--min-tasks='.length), '--min-tasks')
    } else if (arg === '--min-read-pairs') {
      minReadPairs = parseNumber(value, '--min-read-pairs')
      i += 1
    } else if (arg.startsWith('--min-read-pairs=')) {
      minReadPairs = parseNumber(arg.slice('--min-read-pairs='.length), '--min-read-pairs')
    } else if (arg === '--min-click-pairs') {
      minClickPairs = parseNumber(value, '--min-click-pairs')
      i += 1
    } else if (arg.startsWith('--min-click-pairs=')) {
      minClickPairs = parseNumber(arg.slice('--min-click-pairs='.length), '--min-click-pairs')
    } else if (arg === '--min-type-pairs') {
      minTypePairs = parseNumber(value, '--min-type-pairs')
      i += 1
    } else if (arg.startsWith('--min-type-pairs=')) {
      minTypePairs = parseNumber(arg.slice('--min-type-pairs='.length), '--min-type-pairs')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path> and --min-* coverage options.`)
    }
  }

  return { input, minPairs, minBuckets, minTasks, minReadPairs, minClickPairs, minTypePairs }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertString(value: unknown, path: string): string {
  assert(typeof value === 'string' && value.length > 0, `${path} must be a non-empty string`)
  return value
}

function assertNullableString(value: unknown, path: string): void {
  assert(value === null || typeof value === 'string', `${path} must be string or null`)
}

function assertNoLabelLeak(value: unknown, path: string): void {
  if (value === null || value === undefined) return
  assert(typeof value === 'string', `${path} must be string or null`)
  assert(!LABEL_LEAKAGE_PATTERN.test(value), `${path} must not contain label leakage terms`)
}

function hasVolatileKeys(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return []
  const hits: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (VOLATILE_KEYS.has(key)) hits.push(childPath)
    hits.push(...hasVolatileKeys(child, childPath))
  }
  return hits
}

function validateAction(action: PreferenceAction | undefined, path: string): { toolName: string; selector: string; text: string | null } {
  assert(action && typeof action === 'object', `${path} must be an object`)
  assertString(action.sourceFile, `${path}.sourceFile`)
  assert(typeof action.index === 'number', `${path}.index must be number`)
  assertString(action.status, `${path}.status`)
  const toolName = assertString(action.toolName, `${path}.toolName`)
  const selector = assertString(action.selector, `${path}.selector`)
  assertNullableString(action.text, `${path}.text`)
  assertNullableString(action.title, `${path}.title`)
  assertNoLabelLeak(action.text, `${path}.text`)
  assertNoLabelLeak(action.title, `${path}.title`)
  return { toolName, selector, text: typeof action.text === 'string' ? action.text : null }
}

function assertAtLeast(actual: number, minimum: number | undefined, label: string): void {
  if (minimum === undefined) return
  assert(actual >= minimum, `${label} ${actual} is below required floor ${minimum}`)
}

async function main(): Promise<void> {
  const { input, minPairs, minBuckets, minTasks, minReadPairs, minClickPairs, minTypePairs } = parseArgs()
  if (!existsSync(input)) throw new Error(`Preference export not found: ${input}`)

  const lines = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  assert(lines.length > 0, 'preference export must contain at least one record')

  const buckets = new Set<string>()
  const tasks = new Set<string>()
  let readPairs = 0
  let clickPairs = 0
  let typePairs = 0

  for (let i = 0; i < lines.length; i += 1) {
    const record = JSON.parse(lines[i]) as PreferenceRecord
    const prefix = `line ${i + 1}`
    assert(record.recordType === 'web-control-action-preference', `${prefix}: recordType must be web-control-action-preference`)
    assertString(record.sourceFile, `${prefix}: sourceFile`)
    assert(typeof record.pairIndex === 'number', `${prefix}: pairIndex must be number`)
    assert(record.pairIndex === i, `${prefix}: pairIndex must match line order`)
    assert(record.bucket && typeof record.bucket === 'object', `${prefix}: bucket must be an object`)
    const bucketTaskId = assertString(record.bucket.taskId, `${prefix}: bucket.taskId`)
    const bucketToolName = assertString(record.bucket.toolName, `${prefix}: bucket.toolName`)
    assert(record.task && typeof record.task === 'object', `${prefix}: task must be an object`)
    const taskId = assertString(record.task.id, `${prefix}: task.id`)
    assertString(record.task.suite, `${prefix}: task.suite`)
    assertString(record.task.title, `${prefix}: task.title`)
    assertString(record.task.tool, `${prefix}: task.tool`)
    assert(taskId === bucketTaskId, `${prefix}: task.id must match bucket.taskId`)

    const preferred = validateAction(record.preferred, `${prefix}: preferred`)
    const rejected = validateAction(record.rejected, `${prefix}: rejected`)
    assert(preferred.toolName === bucketToolName, `${prefix}: preferred.toolName must match bucket.toolName`)
    assert(rejected.toolName === bucketToolName, `${prefix}: rejected.toolName must match bucket.toolName`)
    assert(preferred.selector !== rejected.selector || preferred.text !== rejected.text, `${prefix}: preferred and rejected actions must differ`)

    const volatileHits = hasVolatileKeys(record)
    assert(volatileHits.length === 0, `${prefix}: volatile fields are not allowed in preference pairs: ${volatileHits.join(', ')}`)

    buckets.add(`${bucketTaskId}:${bucketToolName}`)
    tasks.add(taskId)
    if (bucketToolName === 'read_page_content') readPairs += 1
    if (bucketToolName === 'click_element') clickPairs += 1
    if (bucketToolName === 'type_text') typePairs += 1
  }

  assertAtLeast(lines.length, minPairs, 'preference pairs')
  assertAtLeast(buckets.size, minBuckets, 'preference buckets')
  assertAtLeast(tasks.size, minTasks, 'preference tasks')
  assertAtLeast(readPairs, minReadPairs, 'read preference pairs')
  assertAtLeast(clickPairs, minClickPairs, 'click preference pairs')
  assertAtLeast(typePairs, minTypePairs, 'type preference pairs')

  console.log(`Checked ${lines.length} preference pairs`)
  console.log(`Preference buckets: ${buckets.size}`)
  console.log(`Preference tasks: ${tasks.size}`)
  console.log(`Read pairs: ${readPairs}`)
  console.log(`Click pairs: ${clickPairs}`)
  console.log(`Type pairs: ${typePairs}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
