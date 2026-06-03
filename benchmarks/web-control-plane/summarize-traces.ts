import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.summary.md')
const CANDIDATE_TOOL_NAMES = new Set(['click_element', 'type_text', 'read_page_content'])

type TraceRecord = {
  recordType: 'web-control-action'
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

type TaskSummary = {
  suite: string
  tool: string
  records: number
  positive: number
  negative: number
  selectors: Set<string>
  targetSelectors: Set<string>
  actions: Set<string>
}

type CandidateBucket = {
  positive: number
  negative: number
}

function parseArgs(): { input: string; output: string } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_TRACE_SUMMARY_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_SUMMARY_OUTPUT) : DEFAULT_OUTPUT

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

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function tableRow(cells: Array<string | number>): string {
  return `| ${cells.map(cell => String(cell)).join(' | ')} |`
}

function sourcePath(path: string): string {
  return path.replace(REPO_ROOT, '.').replaceAll('\\', '/')
}

function candidateKey(record: TraceRecord): string | null {
  if (!record.action.selector || !record.action.toolName || !CANDIDATE_TOOL_NAMES.has(record.action.toolName)) return null
  return `${record.task.id}:${record.action.toolName}`
}

async function main(): Promise<void> {
  const { input, output } = parseArgs()
  if (!existsSync(input)) throw new Error(`Trace export not found: ${input}`)

  const records = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as TraceRecord)

  const byTask = new Map<string, TaskSummary>()
  const byTool = new Map<string, number>()
  const bySelector = new Map<string, number>()
  const byTargetSelector = new Map<string, number>()
  const byActionStatus = new Map<string, number>()
  const candidateBuckets = new Map<string, CandidateBucket>()

  let positives = 0
  let negatives = 0
  let selectorRecords = 0
  let targetSelectorRecords = 0
  let clickRecords = 0
  for (const record of records) {
    if (record.label === 'positive') positives += 1
    if (record.label === 'negative') negatives += 1

    const actionName = record.action.toolName ?? record.action.status
    increment(byTool, actionName)
    increment(byActionStatus, record.action.status)

    if (record.action.selector) {
      selectorRecords += 1
      increment(bySelector, record.action.selector)
    }
    if (record.task.targetSelector) {
      targetSelectorRecords += 1
      increment(byTargetSelector, record.task.targetSelector)
    }
    if (record.action.toolName === 'click_element' || String(record.action.text ?? '').includes('click_element')) {
      clickRecords += 1
    }
    const key = candidateKey(record)
    if (key) {
      const bucket = candidateBuckets.get(key) ?? { positive: 0, negative: 0 }
      if (record.label === 'positive') bucket.positive += 1
      if (record.label === 'negative') bucket.negative += 1
      candidateBuckets.set(key, bucket)
    }

    const task = byTask.get(record.task.id) ?? {
      suite: record.task.suite,
      tool: record.task.tool,
      records: 0,
      positive: 0,
      negative: 0,
      selectors: new Set<string>(),
      targetSelectors: new Set<string>(),
      actions: new Set<string>(),
    }
    task.records += 1
    if (record.label === 'positive') task.positive += 1
    if (record.label === 'negative') task.negative += 1
    if (record.action.selector) task.selectors.add(record.action.selector)
    if (record.task.targetSelector) task.targetSelectors.add(record.task.targetSelector)
    task.actions.add(actionName)
    byTask.set(record.task.id, task)
  }

  const lines: string[] = []
  lines.push('# Action Trace Summary')
  lines.push('')
  lines.push(`This report is generated by \`pnpm benchmark:traces:summary\` from \`${sourcePath(input)}\`.`)
  lines.push('')
  lines.push('## Coverage')
  lines.push('')
  lines.push(`- records: ${records.length}`)
  lines.push(`- positive_records: ${positives}`)
  lines.push(`- negative_records: ${negatives}`)
  lines.push(`- selector_records: ${selectorRecords}`)
  lines.push(`- target_selector_records: ${targetSelectorRecords}`)
  lines.push(`- click_records: ${clickRecords}`)
  lines.push(`- task_count: ${byTask.size}`)
  lines.push(`- candidate_buckets: ${candidateBuckets.size}`)
  lines.push(`- paired_candidate_buckets: ${[...candidateBuckets.values()].filter(bucket => bucket.positive > 0 && bucket.negative > 0).length}`)
  lines.push(`- unpaired_negative_candidate_buckets: ${[...candidateBuckets.values()].filter(bucket => bucket.negative > 0 && bucket.positive === 0).length}`)
  lines.push('')
  lines.push('## Task Coverage')
  lines.push('')
  lines.push(tableRow(['task', 'suite', 'tool', 'records', 'positive', 'negative', 'selectors', 'target_selectors', 'actions']))
  lines.push(tableRow(['---', '---', '---', '---:', '---:', '---:', '---:', '---', '---']))
  for (const [taskId, task] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(tableRow([
      taskId,
      task.suite,
      task.tool,
      task.records,
      task.positive,
      task.negative,
      task.selectors.size,
      [...task.targetSelectors].sort().join(', '),
      [...task.actions].sort().join(', '),
    ]))
  }
  lines.push('')
  lines.push('## Tool Coverage')
  lines.push('')
  lines.push(tableRow(['tool_or_status', 'records']))
  lines.push(tableRow(['---', '---:']))
  for (const [tool, count] of sortedEntries(byTool)) {
    lines.push(tableRow([tool, count]))
  }
  lines.push('')
  lines.push('## Selector Coverage')
  lines.push('')
  lines.push(tableRow(['selector', 'records']))
  lines.push(tableRow(['---', '---:']))
  for (const [selector, count] of sortedEntries(bySelector)) {
    lines.push(tableRow([selector, count]))
  }
  lines.push('')
  lines.push('## Target Selector Coverage')
  lines.push('')
  lines.push(tableRow(['target_selector', 'records']))
  lines.push(tableRow(['---', '---:']))
  for (const [targetSelector, count] of sortedEntries(byTargetSelector)) {
    lines.push(tableRow([targetSelector, count]))
  }
  lines.push('')
  lines.push('## Candidate Pair Coverage')
  lines.push('')
  lines.push(tableRow(['task_tool', 'positive', 'negative', 'paired']))
  lines.push(tableRow(['---', '---:', '---:', '---']))
  for (const [key, bucket] of [...candidateBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(tableRow([
      key,
      bucket.positive,
      bucket.negative,
      bucket.positive > 0 && bucket.negative > 0 ? 'yes' : 'no',
    ]))
  }
  lines.push('')
  lines.push('## Data Gaps')
  lines.push('')
  if (negatives === 0) {
    lines.push('- No negative action records yet. Add failure traces before training a selector/action reranker that must distinguish good and bad actions.')
  }
  if (clickRecords === 0) {
    lines.push('- No click actions are represented. Browser-control training needs click/select/type action coverage.')
  }
  if (selectorRecords === records.length) {
    lines.push('- Every record has a selector. Keep non-selector model-start/tool-planning records if planning-state supervision is needed.')
  } else if (selectorRecords === 0) {
    lines.push('- No selector-bearing records are represented. Selector-grounding training is not possible from this export yet.')
  }
  if (targetSelectorRecords === 0) {
    lines.push('- No scoped target selectors are represented. Scoped selector/reranker training cannot verify requested target context.')
  }
  if (negatives > 0 && clickRecords > 0 && selectorRecords > 0) {
    lines.push('- Basic positive/negative, click, and selector coverage is present.')
  }
  const unpairedNegativeBuckets = [...candidateBuckets.entries()]
    .filter(([, bucket]) => bucket.negative > 0 && bucket.positive === 0)
    .map(([key]) => key)
  if (unpairedNegativeBuckets.length > 0) {
    lines.push(`- Negative ranked candidates lack same-task same-tool positives for: ${unpairedNegativeBuckets.join(', ')}.`)
  } else if ([...candidateBuckets.values()].some(bucket => bucket.positive > 0 && bucket.negative > 0)) {
    lines.push('- Ranked negative candidates are paired with same-task same-tool positives.')
  }

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${lines.join('\n')}\n`)
  console.log(`Wrote trace summary: ${sourcePath(output)}`)
  console.log(`Records: ${records.length}`)
  console.log(`Tasks: ${byTask.size}`)
  console.log(`Selectors: ${selectorRecords}`)
  console.log(`Target selectors: ${targetSelectorRecords}`)
  console.log(`Clicks: ${clickRecords}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
