import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.preferences.jsonl')
const CANDIDATE_IDS = new Set(['candidate_a', 'candidate_b'])
const VOLATILE_KEYS = new Set([
  'requestId',
  'timestamp',
  'tabId',
  'durationMs',
  'taskOutputPreview',
])
const LABEL_LEAKAGE_PATTERN = /\b(wrong|negative|counterfactual|positive|preferred|rejected)\b/i

type RerankerAction = {
  sourceFile?: unknown
  index?: unknown
  status?: unknown
  toolName?: unknown
  selector?: unknown
  text?: unknown
  title?: unknown
}

type RerankerCandidate = {
  id?: unknown
  action?: RerankerAction
}

type RerankerPreferenceRecord = {
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
    targetSelector?: unknown
  }
  prompt?: unknown
  candidates?: unknown
  chosen?: RerankerCandidate
  rejected?: RerankerCandidate
  chosenCompletion?: unknown
  rejectedCompletion?: unknown
}

type RerankerCheckConfig = {
  input: string
  minPairs?: number
  minBuckets?: number
  minTasks?: number
  minChosenA?: number
  minChosenB?: number
  minTargetSelectorPairs?: number
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): RerankerCheckConfig {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT) : DEFAULT_INPUT
  let minPairs: number | undefined
  let minBuckets: number | undefined
  let minTasks: number | undefined
  let minChosenA: number | undefined
  let minChosenB: number | undefined
  let minTargetSelectorPairs: number | undefined

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
    } else if (arg === '--min-chosen-a') {
      minChosenA = parseNumber(value, '--min-chosen-a')
      i += 1
    } else if (arg.startsWith('--min-chosen-a=')) {
      minChosenA = parseNumber(arg.slice('--min-chosen-a='.length), '--min-chosen-a')
    } else if (arg === '--min-chosen-b') {
      minChosenB = parseNumber(value, '--min-chosen-b')
      i += 1
    } else if (arg.startsWith('--min-chosen-b=')) {
      minChosenB = parseNumber(arg.slice('--min-chosen-b='.length), '--min-chosen-b')
    } else if (arg === '--min-target-selector-pairs') {
      minTargetSelectorPairs = parseNumber(value, '--min-target-selector-pairs')
      i += 1
    } else if (arg.startsWith('--min-target-selector-pairs=')) {
      minTargetSelectorPairs = parseNumber(arg.slice('--min-target-selector-pairs='.length), '--min-target-selector-pairs')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path> and --min-* coverage options.`)
    }
  }

  return { input, minPairs, minBuckets, minTasks, minChosenA, minChosenB, minTargetSelectorPairs }
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

function actionSurface(action: RerankerAction): string {
  return [
    action.toolName ?? '',
    action.selector ?? '',
    action.text ?? '',
    action.title ?? '',
  ].join('\u001f')
}

function validateAction(action: RerankerAction | undefined, path: string): { toolName: string; surface: string } {
  assert(action && typeof action === 'object', `${path} must be an object`)
  assertString(action.sourceFile, `${path}.sourceFile`)
  assert(typeof action.index === 'number', `${path}.index must be number`)
  assertString(action.status, `${path}.status`)
  const toolName = assertString(action.toolName, `${path}.toolName`)
  assertString(action.selector, `${path}.selector`)
  assertNullableString(action.text, `${path}.text`)
  assertNullableString(action.title, `${path}.title`)
  assertNoLabelLeak(action.text, `${path}.text`)
  assertNoLabelLeak(action.title, `${path}.title`)
  return { toolName, surface: actionSurface(action) }
}

function validateCandidate(candidate: RerankerCandidate | undefined, path: string): { id: string; toolName: string; surface: string } {
  assert(candidate && typeof candidate === 'object', `${path} must be an object`)
  const id = assertString(candidate.id, `${path}.id`)
  assert(CANDIDATE_IDS.has(id), `${path}.id must be candidate_a or candidate_b`)
  const action = validateAction(candidate.action, `${path}.action`)
  return { id, ...action }
}

function completionChoice(value: unknown, path: string): string {
  const text = assertString(value, path)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} must parse as JSON`)
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${path} must be a JSON object`)
  const choice = (parsed as { choice?: unknown }).choice
  assert(typeof choice === 'string' && CANDIDATE_IDS.has(choice), `${path}.choice must be candidate_a or candidate_b`)
  return choice
}

function assertAtLeast(actual: number, minimum: number | undefined, label: string): void {
  if (minimum === undefined) return
  assert(actual >= minimum, `${label} ${actual} is below required floor ${minimum}`)
}

async function main(): Promise<void> {
  const { input, minPairs, minBuckets, minTasks, minChosenA, minChosenB, minTargetSelectorPairs } = parseArgs()
  if (!existsSync(input)) throw new Error(`Reranker preference export not found: ${input}`)

  const lines = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  assert(lines.length > 0, 'reranker preference export must contain at least one record')

  const buckets = new Set<string>()
  const tasks = new Set<string>()
  let chosenA = 0
  let chosenB = 0
  let targetSelectorPairs = 0

  for (let i = 0; i < lines.length; i += 1) {
    const record = JSON.parse(lines[i]) as RerankerPreferenceRecord
    const prefix = `line ${i + 1}`
    assert(record.recordType === 'web-control-action-reranker-preference', `${prefix}: recordType must be web-control-action-reranker-preference`)
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
    if (record.task.targetSelector !== undefined) {
      assertString(record.task.targetSelector, `${prefix}: task.targetSelector`)
      assertNoLabelLeak(record.task.targetSelector, `${prefix}: task.targetSelector`)
    }
    assert(taskId === bucketTaskId, `${prefix}: task.id must match bucket.taskId`)
    const prompt = assertString(record.prompt, `${prefix}: prompt`)
    assert(prompt.includes('browser action reranker'), `${prefix}: prompt must describe the reranker task`)
    assert(prompt.includes('candidate_a') && prompt.includes('candidate_b'), `${prefix}: prompt must include both candidates`)
    if (typeof record.task.targetSelector === 'string') {
      assert(prompt.includes(`target_selector: ${record.task.targetSelector}`), `${prefix}: prompt must include task.targetSelector`)
    }
    assertNoLabelLeak(prompt, `${prefix}: prompt`)

    assert(Array.isArray(record.candidates), `${prefix}: candidates must be an array`)
    assert(record.candidates.length === 2, `${prefix}: candidates must contain exactly two actions`)
    const first = validateCandidate(record.candidates[0] as RerankerCandidate, `${prefix}: candidates[0]`)
    const second = validateCandidate(record.candidates[1] as RerankerCandidate, `${prefix}: candidates[1]`)
    assert(first.id === 'candidate_a', `${prefix}: candidates[0].id must be candidate_a`)
    assert(second.id === 'candidate_b', `${prefix}: candidates[1].id must be candidate_b`)
    assert(first.toolName === bucketToolName, `${prefix}: candidates[0].action.toolName must match bucket.toolName`)
    assert(second.toolName === bucketToolName, `${prefix}: candidates[1].action.toolName must match bucket.toolName`)
    assert(first.surface !== second.surface, `${prefix}: candidate action surfaces must differ`)

    const chosen = validateCandidate(record.chosen, `${prefix}: chosen`)
    const rejected = validateCandidate(record.rejected, `${prefix}: rejected`)
    assert(chosen.id !== rejected.id, `${prefix}: chosen and rejected ids must differ`)
    assert(chosen.surface !== rejected.surface, `${prefix}: chosen and rejected action surfaces must differ`)
    assert(chosen.toolName === bucketToolName, `${prefix}: chosen.action.toolName must match bucket.toolName`)
    assert(rejected.toolName === bucketToolName, `${prefix}: rejected.action.toolName must match bucket.toolName`)
    assert(chosen.surface === first.surface || chosen.surface === second.surface, `${prefix}: chosen must match one candidate`)
    assert(rejected.surface === first.surface || rejected.surface === second.surface, `${prefix}: rejected must match one candidate`)
    assert(completionChoice(record.chosenCompletion, `${prefix}: chosenCompletion`) === chosen.id, `${prefix}: chosenCompletion must choose chosen.id`)
    assert(completionChoice(record.rejectedCompletion, `${prefix}: rejectedCompletion`) === rejected.id, `${prefix}: rejectedCompletion must choose rejected.id`)

    const volatileHits = hasVolatileKeys(record)
    assert(volatileHits.length === 0, `${prefix}: volatile fields are not allowed in reranker preferences: ${volatileHits.join(', ')}`)

    buckets.add(`${bucketTaskId}:${bucketToolName}`)
    tasks.add(taskId)
    if (chosen.id === 'candidate_a') chosenA += 1
    if (chosen.id === 'candidate_b') chosenB += 1
    if (typeof record.task.targetSelector === 'string') targetSelectorPairs += 1
  }

  assertAtLeast(lines.length, minPairs, 'reranker preference pairs')
  assertAtLeast(buckets.size, minBuckets, 'reranker buckets')
  assertAtLeast(tasks.size, minTasks, 'reranker tasks')
  assertAtLeast(chosenA, minChosenA, 'chosen candidate_a pairs')
  assertAtLeast(chosenB, minChosenB, 'chosen candidate_b pairs')
  assertAtLeast(targetSelectorPairs, minTargetSelectorPairs, 'target selector reranker pairs')

  console.log(`Checked ${lines.length} reranker preference pairs`)
  console.log(`Reranker buckets: ${buckets.size}`)
  console.log(`Reranker tasks: ${tasks.size}`)
  console.log(`Chosen candidate_a: ${chosenA}`)
  console.log(`Chosen candidate_b: ${chosenB}`)
  if (minTargetSelectorPairs !== undefined) console.log(`Target selector pairs: ${targetSelectorPairs}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
