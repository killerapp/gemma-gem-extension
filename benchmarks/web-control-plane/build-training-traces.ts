import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_POSITIVE_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.jsonl')
const DEFAULT_NEGATIVE_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'counterfactual-actions.json')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.training.jsonl')

type TrainingRecord = {
  recordType: 'web-control-action'
  sourceFile: string
  task: {
    id: string
    suite: string
    title: string
    tool: string
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

type CounterfactualAction = {
  task: TrainingRecord['task']
  action: Omit<TrainingRecord['action'], 'index'>
}

function parseArgs(): { positiveInput: string; negativeInput: string; output: string } {
  const args = process.argv.slice(2)
  let positiveInput = process.env.GEMMA_GEM_TRACE_POSITIVE_INPUT
    ? resolve(process.env.GEMMA_GEM_TRACE_POSITIVE_INPUT)
    : DEFAULT_POSITIVE_INPUT
  let negativeInput = process.env.GEMMA_GEM_TRACE_NEGATIVE_INPUT
    ? resolve(process.env.GEMMA_GEM_TRACE_NEGATIVE_INPUT)
    : DEFAULT_NEGATIVE_INPUT
  let output = process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT
    ? resolve(process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT)
    : DEFAULT_OUTPUT

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--positive-input') {
      if (!value) throw new Error('--positive-input requires a path')
      positiveInput = resolve(value)
      i += 1
    } else if (arg.startsWith('--positive-input=')) {
      positiveInput = resolve(arg.slice('--positive-input='.length))
    } else if (arg === '--negative-input') {
      if (!value) throw new Error('--negative-input requires a path')
      negativeInput = resolve(value)
      i += 1
    } else if (arg.startsWith('--negative-input=')) {
      negativeInput = resolve(arg.slice('--negative-input='.length))
    } else if (arg === '--output') {
      if (!value) throw new Error('--output requires a path')
      output = resolve(value)
      i += 1
    } else if (arg.startsWith('--output=')) {
      output = resolve(arg.slice('--output='.length))
    } else {
      throw new Error(`Unknown argument ${arg}. Use --positive-input <path>, --negative-input <path>, and --output <path>.`)
    }
  }

  return { positiveInput, negativeInput, output }
}

function sourcePath(path: string): string {
  return path.replace(REPO_ROOT, '.').replaceAll('\\', '/')
}

async function readJsonl(path: string): Promise<TrainingRecord[]> {
  if (!existsSync(path)) throw new Error(`Trace source not found: ${path}`)
  return (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as TrainingRecord)
}

function negativeRecord(candidate: CounterfactualAction, index: number, sourceFile: string): TrainingRecord {
  return {
    recordType: 'web-control-action',
    sourceFile,
    task: candidate.task,
    outcome: {
      success: false,
      strict: false,
      jsonValid: false,
      selectorHitRate: 0,
      timeout: false,
      toolErrors: 0,
    },
    action: {
      index,
      status: candidate.action.status,
      toolName: candidate.action.toolName,
      selector: candidate.action.selector,
      text: candidate.action.text,
      title: candidate.action.title,
    },
    label: 'negative',
  }
}

async function main(): Promise<void> {
  const { positiveInput, negativeInput, output } = parseArgs()
  const positiveRecords = await readJsonl(positiveInput)
  if (!existsSync(negativeInput)) throw new Error(`Counterfactual source not found: ${negativeInput}`)

  const candidates = JSON.parse(await readFile(negativeInput, 'utf8')) as CounterfactualAction[]
  const negatives = candidates.map((candidate, index) =>
    negativeRecord(candidate, index, sourcePath(negativeInput)),
  )
  const records = [...positiveRecords, ...negatives]

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''))

  console.log(`Wrote training trace records: ${sourcePath(output)}`)
  console.log(`Positive records: ${positiveRecords.length}`)
  console.log(`Negative records: ${negatives.length}`)
  console.log(`Total records: ${records.length}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
