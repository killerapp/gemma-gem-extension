import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.training.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-preferences.jsonl')
const CANDIDATE_TOOL_NAMES = new Set(['click_element', 'type_text', 'read_page_content'])

type TraceRecord = {
  recordType: 'web-control-action'
  sourceFile: string
  task: {
    id: string
    suite: string
    title: string
    tool: string
    targetSelector?: string
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

type PreferenceAction = TraceRecord['action'] & {
  sourceFile: string
}

type PreferenceRecord = {
  recordType: 'web-control-action-preference'
  sourceFile: string
  pairIndex: number
  bucket: {
    taskId: string
    toolName: string
  }
  task: TraceRecord['task']
  preferred: PreferenceAction
  rejected: PreferenceAction
}

function parseArgs(): { input: string; output: string } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT) : DEFAULT_OUTPUT

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--input') {
      if (!value) throw new Error('--input requires a path')
      input = resolve(value)
      i += 1
    } else if (arg.startsWith('--input=')) {
      input = resolve(arg.slice('--input='.length))
    } else if (arg === '--output') {
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

function sourcePath(path: string): string {
  return path.replace(REPO_ROOT, '.').replaceAll('\\', '/')
}

function candidateKey(record: TraceRecord): string | null {
  const toolName = record.action.toolName
  if (!toolName || !CANDIDATE_TOOL_NAMES.has(toolName)) return null
  if (!record.action.selector) return null
  return `${record.task.id}:${toolName}`
}

function preferenceAction(record: TraceRecord): PreferenceAction {
  return {
    sourceFile: record.sourceFile,
    index: record.action.index,
    status: record.action.status,
    toolName: record.action.toolName,
    selector: record.action.selector,
    text: record.action.text,
    title: record.action.title,
  }
}

function actionSurface(record: TraceRecord): string {
  return [
    record.action.toolName ?? '',
    record.action.selector ?? '',
    record.action.text ?? '',
    record.action.title ?? '',
  ].join('\u001f')
}

function actionIdentity(record: TraceRecord): string {
  if (record.action.toolName === 'click_element') {
    return [record.action.toolName, record.action.selector ?? ''].join('\u001f')
  }
  return actionSurface(record)
}

function actionSpecificity(record: TraceRecord): number {
  return (record.action.title?.length ?? 0) + (record.action.text?.length ?? 0)
}

function dedupeActions(records: TraceRecord[]): TraceRecord[] {
  const byIdentity = new Map<string, TraceRecord>()
  for (const record of records) {
    const identity = actionIdentity(record)
    const existing = byIdentity.get(identity)
    if (!existing || actionSpecificity(record) > actionSpecificity(existing)) {
      byIdentity.set(identity, record)
    }
  }
  return [...byIdentity.values()]
}

async function main(): Promise<void> {
  const { input, output } = parseArgs()
  if (!existsSync(input)) throw new Error(`Training trace source not found: ${input}`)

  const records = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as TraceRecord)

  const buckets = new Map<string, { positives: TraceRecord[]; negatives: TraceRecord[] }>()
  for (const record of records) {
    const key = candidateKey(record)
    if (!key) continue
    const bucket = buckets.get(key) ?? { positives: [], negatives: [] }
    if (record.label === 'positive') bucket.positives.push(record)
    if (record.label === 'negative') bucket.negatives.push(record)
    buckets.set(key, bucket)
  }

  const preferences: PreferenceRecord[] = []
  for (const [key, bucket] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (bucket.positives.length === 0 || bucket.negatives.length === 0) continue
    const [taskId, toolName] = key.split(':')
    const positives = dedupeActions(bucket.positives)
    const negatives = dedupeActions(bucket.negatives)
    for (const positive of positives) {
      for (const negative of negatives) {
        if (actionSurface(positive) === actionSurface(negative)) continue
        preferences.push({
          recordType: 'web-control-action-preference',
          sourceFile: sourcePath(input),
          pairIndex: preferences.length,
          bucket: { taskId, toolName },
          task: positive.task,
          preferred: preferenceAction(positive),
          rejected: preferenceAction(negative),
        })
      }
    }
  }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, preferences.map(record => JSON.stringify(record)).join('\n') + (preferences.length ? '\n' : ''))

  console.log(`Wrote preference pairs: ${sourcePath(output)}`)
  console.log(`Buckets: ${[...buckets.values()].filter(bucket => bucket.positives.length > 0 && bucket.negatives.length > 0).length}`)
  console.log(`Preference pairs: ${preferences.length}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
