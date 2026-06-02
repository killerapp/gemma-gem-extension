import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.jsonl')
const VOLATILE_KEYS = new Set([
  'requestId',
  'timestamp',
  'tabId',
  'durationMs',
  'taskOutputPreview',
])
const LABEL_LEAKAGE_PATTERN = /\b(wrong|negative|counterfactual|positive)\b/i

type TraceRecord = {
  recordType?: unknown
  sourceFile?: unknown
  task?: {
    id?: unknown
    suite?: unknown
    title?: unknown
    tool?: unknown
  }
  outcome?: {
    success?: unknown
    strict?: unknown
    jsonValid?: unknown
    selectorHitRate?: unknown
    timeout?: unknown
    toolErrors?: unknown
  }
  action?: {
    index?: unknown
    status?: unknown
    toolName?: unknown
    selector?: unknown
    text?: unknown
    title?: unknown
  }
  label?: unknown
}

function parseArgs(): { input: string; requireNegative: boolean; requireCandidatePairs: boolean } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_OUTPUT) : DEFAULT_INPUT
  let requireNegative = false
  let requireCandidatePairs = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--input') {
      const value = args[i + 1]
      if (!value) throw new Error('--input requires a path')
      input = resolve(value)
      i += 1
    } else if (arg.startsWith('--input=')) {
      input = resolve(arg.slice('--input='.length))
    } else if (arg === '--require-negative') {
      requireNegative = true
    } else if (arg === '--require-candidate-pairs') {
      requireCandidatePairs = true
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path>, --require-negative, and --require-candidate-pairs.`)
    }
  }

  return { input, requireNegative, requireCandidatePairs }
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

function assertBoolean(value: unknown, path: string): void {
  assert(typeof value === 'boolean', `${path} must be boolean`)
}

function assertNumberOrNull(value: unknown, path: string): void {
  assert(value === null || typeof value === 'number', `${path} must be number or null`)
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

function validateRecord(record: TraceRecord, lineNumber: number): { hasSelector: boolean; hasClick: boolean; label: string; candidateKey: string | null } {
  const prefix = `line ${lineNumber}`
  assert(record.recordType === 'web-control-action', `${prefix}: recordType must be web-control-action`)
  assertString(record.sourceFile, `${prefix}: sourceFile`)

  assert(record.task && typeof record.task === 'object', `${prefix}: task must be an object`)
  assertString(record.task.id, `${prefix}: task.id`)
  assertString(record.task.suite, `${prefix}: task.suite`)
  assertString(record.task.title, `${prefix}: task.title`)
  assertString(record.task.tool, `${prefix}: task.tool`)

  assert(record.outcome && typeof record.outcome === 'object', `${prefix}: outcome must be an object`)
  assertBoolean(record.outcome.success, `${prefix}: outcome.success`)
  assertBoolean(record.outcome.strict, `${prefix}: outcome.strict`)
  assertBoolean(record.outcome.jsonValid, `${prefix}: outcome.jsonValid`)
  assertNumberOrNull(record.outcome.selectorHitRate, `${prefix}: outcome.selectorHitRate`)
  assertBoolean(record.outcome.timeout, `${prefix}: outcome.timeout`)
  assert(typeof record.outcome.toolErrors === 'number', `${prefix}: outcome.toolErrors must be number`)

  assert(record.action && typeof record.action === 'object', `${prefix}: action must be an object`)
  assert(typeof record.action.index === 'number', `${prefix}: action.index must be number`)
  assertString(record.action.status, `${prefix}: action.status`)
  assertNullableString(record.action.toolName, `${prefix}: action.toolName`)
  assertNullableString(record.action.selector, `${prefix}: action.selector`)
  assertNullableString(record.action.text, `${prefix}: action.text`)
  assertNullableString(record.action.title, `${prefix}: action.title`)
  assertNoLabelLeak(record.action.text, `${prefix}: action.text`)
  assertNoLabelLeak(record.action.title, `${prefix}: action.title`)

  assert(record.label === 'positive' || record.label === 'negative', `${prefix}: label must be positive or negative`)

  const volatileHits = hasVolatileKeys(record)
  assert(volatileHits.length === 0, `${prefix}: volatile fields are not allowed in normalized traces: ${volatileHits.join(', ')}`)

  return {
    hasSelector: typeof record.action.selector === 'string' && record.action.selector.length > 0,
    hasClick: record.action.toolName === 'click_element' || String(record.action.text ?? '').includes('click_element'),
    label: record.label,
    candidateKey: record.action.toolName === 'click_element' || record.action.toolName === 'type_text'
      ? `${record.task.id}:${record.action.toolName}`
      : null,
  }
}

function assertPairedCandidates(candidateLabels: Map<string, Set<string>>): void {
  const unpaired: string[] = []
  for (const [key, labels] of candidateLabels.entries()) {
    if (labels.has('negative') && !labels.has('positive')) {
      unpaired.push(key)
    }
  }
  assert(unpaired.length === 0, `negative candidate actions must have same-task same-tool positives: ${unpaired.join(', ')}`)
  assert([...candidateLabels.values()].some(labels => labels.has('positive') && labels.has('negative')), 'trace export must contain at least one positive/negative candidate pair')
}

async function main(): Promise<void> {
  const { input, requireNegative, requireCandidatePairs } = parseArgs()
  if (!existsSync(input)) throw new Error(`Trace export not found: ${input}`)

  const lines = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  assert(lines.length > 0, 'trace export must contain at least one record')

  let selectors = 0
  let clicks = 0
  let positives = 0
  let negatives = 0
  const candidateLabels = new Map<string, Set<string>>()
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = JSON.parse(lines[i]) as TraceRecord
    const result = validateRecord(parsed, i + 1)
    if (result.hasSelector) selectors += 1
    if (result.hasClick) clicks += 1
    if (result.label === 'positive') positives += 1
    if (result.label === 'negative') negatives += 1
    if (result.candidateKey) {
      const labels = candidateLabels.get(result.candidateKey) ?? new Set<string>()
      labels.add(result.label)
      candidateLabels.set(result.candidateKey, labels)
    }
  }

  assert(positives > 0, 'trace export must contain at least one positive record')
  if (requireNegative) {
    assert(negatives > 0, 'trace export must contain at least one negative record')
  }
  assert(selectors > 0, 'trace export must contain at least one selector-bearing action')
  assert(clicks > 0, 'trace export must contain at least one click action')
  if (requireCandidatePairs) {
    assertPairedCandidates(candidateLabels)
  }

  console.log(`Checked ${lines.length} action trace records`)
  console.log(`Positive records: ${positives}`)
  console.log(`Negative records: ${negatives}`)
  console.log(`Selector records: ${selectors}`)
  console.log(`Click records: ${clicks}`)
  if (requireCandidatePairs) console.log(`Candidate pair buckets: ${candidateLabels.size}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
