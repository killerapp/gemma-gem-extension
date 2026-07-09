import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_POSITIVE_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.jsonl')
const DEFAULT_EXPECTED_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'expected-actions.json')
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

type CounterfactualAction = {
  task: TrainingRecord['task']
  action: Omit<TrainingRecord['action'], 'index'>
}

function parseArgs(): { positiveInput: string; expectedInput: string; negativeInput: string; output: string } {
  const args = process.argv.slice(2)
  let positiveInput = process.env.GEMMA_GEM_TRACE_POSITIVE_INPUT
    ? resolve(process.env.GEMMA_GEM_TRACE_POSITIVE_INPUT)
    : DEFAULT_POSITIVE_INPUT
  let expectedInput = process.env.GEMMA_GEM_TRACE_EXPECTED_INPUT
    ? resolve(process.env.GEMMA_GEM_TRACE_EXPECTED_INPUT)
    : DEFAULT_EXPECTED_INPUT
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
    } else if (arg === '--expected-input') {
      if (!value) throw new Error('--expected-input requires a path')
      expectedInput = resolve(value)
      i += 1
    } else if (arg.startsWith('--expected-input=')) {
      expectedInput = resolve(arg.slice('--expected-input='.length))
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
      throw new Error(`Unknown argument ${arg}. Use --positive-input <path>, --expected-input <path>, --negative-input <path>, and --output <path>.`)
    }
  }

  return { positiveInput, expectedInput, negativeInput, output }
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

function candidateRecord(candidate: CounterfactualAction, index: number, sourceFile: string, label: 'positive' | 'negative'): TrainingRecord {
  return {
    recordType: 'web-control-action',
    sourceFile,
    task: candidate.task,
    outcome: {
      success: label === 'positive',
      strict: label === 'positive',
      jsonValid: false,
      selectorHitRate: label === 'positive' ? 1 : 0,
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
    label,
  }
}

async function main(): Promise<void> {
  const { positiveInput, expectedInput, negativeInput, output } = parseArgs()
  const positiveRecords = await readJsonl(positiveInput)
  if (!existsSync(expectedInput)) throw new Error(`Expected action source not found: ${expectedInput}`)
  if (!existsSync(negativeInput)) throw new Error(`Counterfactual source not found: ${negativeInput}`)

  const expectedCandidates = JSON.parse(await readFile(expectedInput, 'utf8')) as CounterfactualAction[]
  const expectedRecords = expectedCandidates.map((candidate, index) =>
    candidateRecord(candidate, index, sourcePath(expectedInput), 'positive'),
  )
  const candidates = JSON.parse(await readFile(negativeInput, 'utf8')) as CounterfactualAction[]
  const negatives = candidates.map((candidate, index) =>
    candidateRecord(candidate, index, sourcePath(negativeInput), 'negative'),
  )
  const records = [...positiveRecords, ...expectedRecords, ...negatives]

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''))

  console.log(`Wrote training trace records: ${sourcePath(output)}`)
  console.log(`Positive records: ${positiveRecords.length}`)
  console.log(`Expected action records: ${expectedRecords.length}`)
  console.log(`Negative records: ${negatives.length}`)
  console.log(`Total records: ${records.length}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
