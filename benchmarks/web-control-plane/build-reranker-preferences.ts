import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-preferences.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.preferences.jsonl')
const CANDIDATE_A = 'candidate_a'
const CANDIDATE_B = 'candidate_b'

type PreferenceAction = {
  sourceFile: string
  index: number
  status: string
  toolName: string
  selector: string
  text: string | null
  title: string | null
}

type PreferenceRecord = {
  recordType: 'web-control-action-preference'
  sourceFile: string
  pairIndex: number
  bucket: {
    taskId: string
    toolName: string
  }
  task: {
    id: string
    suite: string
    title: string
    tool: string
  }
  preferred: PreferenceAction
  rejected: PreferenceAction
}

type RerankerCandidate = {
  id: typeof CANDIDATE_A | typeof CANDIDATE_B
  action: PreferenceAction
}

type RerankerPreferenceRecord = {
  recordType: 'web-control-action-reranker-preference'
  sourceFile: string
  pairIndex: number
  bucket: PreferenceRecord['bucket']
  task: PreferenceRecord['task']
  prompt: string
  candidates: [RerankerCandidate, RerankerCandidate]
  chosen: RerankerCandidate
  rejected: RerankerCandidate
  chosenCompletion: string
  rejectedCompletion: string
}

function parseArgs(): { input: string; output: string } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT) : DEFAULT_OUTPUT

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

function actionLines(action: PreferenceAction): string[] {
  return [
    `tool: ${action.toolName}`,
    `selector: ${action.selector}`,
    `action_text: ${action.text ?? ''}`,
    `title: ${action.title ?? ''}`,
  ]
}

function buildPrompt(pair: PreferenceRecord, first: RerankerCandidate, second: RerankerCandidate): string {
  return [
    'You are Gemma Gem\'s browser action reranker.',
    'Choose the better next browser action for the task. Prefer actions that satisfy the task with the correct selector and avoid distractor controls or overly narrow page reads.',
    '',
    `task_id: ${pair.task.id}`,
    `suite: ${pair.task.suite}`,
    `task_title: ${pair.task.title}`,
    `caller_tool: ${pair.task.tool}`,
    `candidate_tool: ${pair.bucket.toolName}`,
    '',
    `${first.id}:`,
    ...actionLines(first.action).map(line => `  ${line}`),
    '',
    `${second.id}:`,
    ...actionLines(second.action).map(line => `  ${line}`),
    '',
    `Return exactly one JSON object: {"choice":"${CANDIDATE_A}"} or {"choice":"${CANDIDATE_B}"}.`,
  ].join('\n')
}

function completionFor(candidateId: typeof CANDIDATE_A | typeof CANDIDATE_B): string {
  return JSON.stringify({ choice: candidateId })
}

function rerankerRecord(pair: PreferenceRecord): RerankerPreferenceRecord {
  const preferredFirst = pair.pairIndex % 2 === 0
  const preferredId = preferredFirst ? CANDIDATE_A : CANDIDATE_B
  const rejectedId = preferredFirst ? CANDIDATE_B : CANDIDATE_A
  const chosen: RerankerCandidate = { id: preferredId, action: pair.preferred }
  const rejected: RerankerCandidate = { id: rejectedId, action: pair.rejected }
  const candidates: [RerankerCandidate, RerankerCandidate] = preferredFirst
    ? [chosen, rejected]
    : [rejected, chosen]

  return {
    recordType: 'web-control-action-reranker-preference',
    sourceFile: pair.sourceFile,
    pairIndex: pair.pairIndex,
    bucket: pair.bucket,
    task: pair.task,
    prompt: buildPrompt(pair, candidates[0], candidates[1]),
    candidates,
    chosen,
    rejected,
    chosenCompletion: completionFor(chosen.id),
    rejectedCompletion: completionFor(rejected.id),
  }
}

async function main(): Promise<void> {
  const { input, output } = parseArgs()
  if (!existsSync(input)) throw new Error(`Preference source not found: ${input}`)

  const preferences = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as PreferenceRecord)
  const rerankerPreferences = preferences.map(rerankerRecord)

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, rerankerPreferences.map(record => JSON.stringify(record)).join('\n') + (rerankerPreferences.length ? '\n' : ''))

  const chosenA = rerankerPreferences.filter(record => record.chosen.id === CANDIDATE_A).length
  const chosenB = rerankerPreferences.filter(record => record.chosen.id === CANDIDATE_B).length
  console.log(`Wrote reranker preferences: ${sourcePath(output)}`)
  console.log(`Reranker pairs: ${rerankerPreferences.length}`)
  console.log(`Chosen ${CANDIDATE_A}: ${chosenA}`)
  console.log(`Chosen ${CANDIDATE_B}: ${chosenB}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
