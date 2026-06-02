# Gemma Gem Autoresearch Program: Web Control Plane

This is an autonomous-research program for improving Gemma Gem's browser control plane. The goal is not to change Gemma Gem into a generic training repo. The goal is to make the local extension and MCP sidecar measurably better at running browser tasks, then keep only changes that improve benchmarked behavior.

Gemma Gem is the system under test. The sibling repo `../autoresearch-win-rtx` is a reference for the research loop discipline: fixed benchmarks, short experiments, logs, keep wins, discard losses. Use it for ideas and local 4090-oriented experiment patterns, but do not make Gemma Gem depend on that repo.

Always use `pnpm`. Never use npm or yarn.

## Current Direction

Gemma Gem already has the right shape for a browser-agent control plane:

- Chrome MV3 extension with Gemma 4 running locally through WebGPU.
- Content tools for page reading, clicking, typing, selecting, scrolling, screenshots, and page JavaScript.
- Local MCP sidecar with Stagehand-style tools: `gemma_observe`, `gemma_act`, `gemma_extract`, `gemma_agent`, tabs, screenshot, stop, page brief, deterministic read/click/type/select/scroll helpers, and field transfer.
- Relay UI that separates foreground Chat from background MCP/Gemma Relay work.

The weak point to improve is reliability under benchmarked web tasks: selector grounding, single-action discipline, structured extraction validity, form filling, navigation recovery, timeout handling, and caller-friendly reporting.

## Primary Objective

Train a better Gemma Gem control plane through autonomous prompt, tool, policy, and harness experiments.

"Train" means improve the control system around the local model first:

- system prompts used by MCP tools and offscreen agent loops
- observe/act/extract contracts
- selector discovery and page-brief formatting
- deterministic helper tools exposed by the sidecar
- retries, timeout budgets, and task stop behavior
- benchmark task manifests and evaluation scoring

Only add actual model fine-tuning after the benchmark harness proves a stable data format and exposes enough failure traces to justify it.

## Branch

Run this work on a dedicated branch:

```powershell
git switch -c codex/autoresearch-testing
```

If the branch already exists, switch to it. Preserve any existing user changes. Do not reset the whole repository to discard one failed experiment. Revert only the files changed by the current experiment, and only after recording the failure.

## PR Policy

This program is fork-first. Push and open draft PRs only against the user's fork, currently `killerapp/gemma-gem-extension`, unless the user explicitly asks to send work upstream.

Rules:

- Use `fork` as the push remote for `codex/autoresearch-testing`.
- Draft PR target should be `killerapp/gemma-gem-extension:main`.
- Do not open PRs against `kessler/gemma-gem` or any other upstream repository without explicit user approval in the current thread.
- If an upstream PR is accidentally opened, close it immediately, leave a short explanatory comment, and continue only with the fork PR.
- Use the fork PR as a review artifact; do not treat it as proof that upstream is ready.

## Success Metrics

Primary metric:

- `task_success_rate`: fraction of frozen benchmark tasks completed correctly.

Secondary metrics:

- `strict_success_rate`: fraction passing exact assertions with no tolerated recovery.
- `json_valid_rate`: fraction of `gemma_observe` / `gemma_extract` outputs that parse as valid JSON when JSON is requested.
- `selector_hit_rate`: fraction of planned selectors that exist and point at the intended element.
- `actions_per_success`: fewer is better when success is equal.
- `timeout_rate`: lower is better.
- `p50_task_seconds` and `p95_task_seconds`: lower is better once success is stable.
- `tool_error_rate`: lower is better.

Target:

- First target: create a deterministic local web benchmark harness and establish a baseline.
- Near-term target: improve `task_success_rate` by at least 15 percentage points over that baseline without increasing `p95_task_seconds` by more than 50%.
- Longer target: pass a local suite plus at least one external web-agent benchmark subset, such as MiniWoB++/BrowserGym-style tasks, using the Gemma Gem MCP surface.

## Benchmark Harness

Build the frozen local benchmark before changing control-plane behavior.

Suggested structure:

```text
benchmarks/
  web-control-plane/
    tasks/
      forms.json
      extraction.json
      navigation.json
      semantic-buttons.json
    pages/
      forms.html
      extraction.html
      navigation.html
      semantic-buttons.html
    run.ts
    report.md
results.web.tsv
```

The harness should:

- start a local static web server on `127.0.0.1`
- launch or connect to Chrome with Gemma Gem loaded when possible
- run tasks through the MCP sidecar HTTP transport
- evaluate observable page state, URL, DOM text, downloaded/result values, and JSON validity
- emit machine-readable JSONL logs plus a short summary
- write `results.web.tsv`

If full extension automation is not ready yet, begin with sidecar-level contract tests using a fake extension WebSocket, then add real-browser tests once stable. Existing `host/test/semantic-button.e2e.test.ts` is the starting pattern.

## Frozen Eval Rule

After the local benchmark task set is created and baseline results are recorded, treat the task definitions, expected assertions, and scoring code as frozen.

Allowed:

- add new tasks in a new named suite
- fix true bugs in the evaluator
- improve diagnostics and logging

Not allowed:

- weakening assertions to make a candidate pass
- changing expected answers after seeing failures
- removing hard tasks from the frozen baseline suite

## In-Scope Edits

Edit these when running experiments:

- `host/src/index.ts`: MCP tool descriptions, prompts, sidecar orchestration, helper tools, validation, task result shape.
- `shared/bridge-messages.ts`: bridge protocol additions needed by benchmarks or tools.
- `background/bridge-client.ts`: timeout behavior, bridge execution routing, activity events, deterministic tool execution.
- `content/tool-executors.ts`: browser action reliability and DOM-result detail.
- `shared/tool-definitions.ts`: low-level tool schemas and descriptions used by the local Gemma loop.
- `offscreen/model-host.ts` and offscreen entry code: only for generation/control issues, stop behavior, chunk filtering, or model invocation settings.
- `host/test/*.test.ts` and `benchmarks/web-control-plane/**`: benchmark and contract tests.
- Docs and reports that record the current best control plane.

Avoid broad UI changes in this program. If UI work becomes necessary, use `.claude/skills/frontend-design/SKILL.md` and keep the extension UI compact, distinctive, and clear about foreground Chat versus background Gemma Relay work.

## Out-of-Scope Until Benchmarks Exist

Do not start with:

- adding unrelated model providers
- replacing the extension architecture
- making the sidecar network-accessible beyond loopback
- cloud inference
- broad visual redesign
- training model weights before the benchmark harness exists

## Experiment Loop

One experiment means one focused idea. Examples:

- Make `gemma_observe` return JSON that always validates against `ObservedAction[]`.
- Add a deterministic `gemma_click_text` or `gemma_find_interactive` helper if selector grounding is the failure mode.
- Improve `gemma_page_brief` so caller agents see labels, roles, ids, names, values, and nearby text without excessive page noise.
- Tighten `gemma_act` so it performs exactly one action and rejects multi-step prompts.
- Add recovery when a selector misses: re-read page, inspect candidate controls, retry once with a derived selector.
- Add benchmark tasks for checkout-like forms, settings pages, tab-to-tab field transfer, and structured table extraction.

Loop:

1. Inspect branch and working tree.
2. Pick one experiment and write down the hypothesis in the log.
3. Edit only the files needed for that idea.
4. Run the smallest relevant check.
5. Run the benchmark command.
6. Record metrics in `results.web.tsv`.
7. Keep if the change improves the primary metric or materially improves a secondary metric with no primary regression.
8. Discard if success drops, JSON validity regresses, security weakens, or latency/timeouts exceed budget without a large success-rate gain.
9. Write a short benchmark/report note for every kept change.

## Current Research Notes

Post-PR review run from commit `75bf82d` showed:

- `pnpm benchmark:web` passed.
- `pnpm benchmark:web -- --real` passed.
- `pnpm benchmark:web -- --real --include-agent` failed with model-backed timeouts:
  - `gemma_extract` timed out at about 300 seconds.
  - `gemma_agent` timed out at about 300 seconds.
  - deterministic bridge/browser tasks continued to pass.
  - JSON validity and selector grounding stayed at `1.0000`.

Interpretation:

- The bridge, Chrome runtime, task fixtures, and deterministic MCP helpers are healthy.
- The failure mode is local model/runtime readiness or generation hang, not selector grounding or JSON formatting.
- A previous agent-based prewarm moved cold-start cost out of extraction but changed later model behavior and failed the semantic receipt assertion. Do not use a full `gemma_agent` generation as the warmup primitive.

Next high-value experiment:

1. Add a bridge-level `bridge:warm_model` or `model:ensure_ready` path that creates the offscreen document and waits for the model to report `ready` without running an agent generation or touching the page.
2. Add benchmark support for reporting `model_load_seconds` separately from task durations.
3. Keep the frozen task assertions unchanged.
4. Keep the change only if real-agent success returns to `1.0000` and timeout rate returns to `0.0000`, or if the diagnostics prove a narrower runtime fix is needed.

Experiment result:

- A first load-only warmup attempt was tried on June 1, 2026.
- It added a `bridge:warm_model` request and benchmark-side warmup before real-agent tasks.
- The warmup itself timed out through MCP at 300 seconds before any benchmark task ran.
- The code was discarded because it reduced observability of the task suite and did not improve success.
- The useful finding is that the failure can happen before prompt execution, so the next try should instrument offscreen model-load status, readiness, and WebGPU/ONNX progress rather than changing agent prompts.

Refined next try:

1. Add diagnostics around `model:load`: timestamps for offscreen creation, file progress, `from_pretrained` start/finish, processor load, model load, and `ready/error`.
2. Make benchmark failures preserve the last model status/progress in `benchmark.web.jsonl` and `report.md`.
3. Add an isolated debug command that opens the extension profile and only waits for model readiness, outside the task suite.
4. Only after readiness is reliable, reintroduce model-load timing as a measured preflight.

Current runtime selection rule:

- Real smoke tests keep using a temporary Chrome profile.
- Real agent tests default to the persistent profile `.browsers/gemma-gem-benchmark-profile` so the local model cache is reused across runs.
- Override the profile with `GEMMA_GEM_CHROME_PROFILE=<path>` when debugging against a specific preloaded profile.
- Force a cold profile only when measuring first-load behavior with `GEMMA_GEM_FRESH_CHROME_PROFILE=1` or `pnpm benchmark:web -- --real --include-agent --fresh-profile`.
- Model-driven tasks default to the documented 180-second hard cap. Override with `GEMMA_GEM_AGENT_TASK_TIMEOUT_MS=<milliseconds>` when deliberately measuring cold-start behavior.
- Failed real-agent tasks should report the browser executable, profile path, last model `status`, `phase`, `progress`, and elapsed load time.

June 2, 2026 runtime finding:

- A cold run against the new persistent benchmark profile failed the first model task at the 180-second cap while loading `onnx/embed_tokens_q4f16.onnx_data` at 88 percent.
- A rerun against the same profile avoided the repeated download/stall: first model task fell to seconds and timeout rate returned to `0.0000`.
- Remaining failures are now ORT/WebGPU runtime errors, not selector grounding or repeated model download. Observed errors include failed WebGPU compute pipeline creation and `OrtRun()` buffer download failures.
- Branded stable Chrome `148.0.7778.181` did not register the unpacked extension in this harness; CDP returned `Extensions.loadUnpacked failed: Method not available`.
- Next runtime experiment should use a pinned Chrome-for-Testing or Chromium build with `--load-extension`/`Extensions.loadUnpacked` support and a separate persistent profile, then compare ORT/WebGPU stability before changing Gemma prompts.

Current runtime experiment:

- The Chrome-for-Testing manifest lists Stable `149.0.7827.54`, while the local marker was still on `149.0.7827.22`.
- Extend `pnpm browser:install` so it can install/select `--channel <Stable|Beta|Dev|Canary>` or exact `--version <x.y.z.w>`, also configurable through `CHROME_FOR_TESTING_CHANNEL` and `CHROME_FOR_TESTING_VERSION`.
- Install current Stable CFT and run the real-agent suite with a separate profile, for example `.browsers/gemma-gem-benchmark-cft-149.0.7827.54-profile`.
- Keep only if the runtime change materially improves task success or removes the ORT/WebGPU errors without weakening benchmark assertions.

Experiment result:

- `pnpm browser:install -- --channel Stable` installed Chrome-for-Testing `149.0.7827.54` and updated `.browsers/chrome-for-testing/chrome-path.txt`.
- Real smoke passed on CFT `149.0.7827.54`: `task_success_rate 1.0000`, `timeout_rate 0.0000`.
- A separate copied profile was attempted, but the copy failed due low disk space. The partial generated profile was removed after verifying the path stayed under `.browsers`.
- The real-agent comparison used the warmed persistent benchmark profile to avoid another model download.
- Result was kept: `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `p95_task_seconds 19.474`, `timeout_rate 0.0000`.
- Interpretation: updating CFT from `149.0.7827.22` to `149.0.7827.54` removed the observed ORT/WebGPU runtime failures for the frozen local suite.

Current recommended command:

```powershell
pnpm browser:install -- --channel Stable
pnpm build
pnpm benchmark:web -- --real --include-agent
```

Current model readiness experiment:

- Add a bridge-level `bridge:ensure_model_ready` request and MCP tool `gemma_model_ready`.
- The request creates/uses the offscreen document, sends `model:load`, waits for `model:status ready`, and returns model id, status, load time, phase, and progress without running a generation.
- Real-agent benchmark mode now runs this readiness preflight before task timing and records it separately in `benchmark.web.jsonl`, `benchmarks/web-control-plane/report.md`, and `results.web.tsv`.
- `results.web.tsv` now includes `model_load_s`; historical rows are migrated with `0.000` where no preflight measurement existed.

Experiment result:

- `pnpm benchmark:web` passed with `model_ready_status skipped`.
- `pnpm benchmark:web -- --real` passed with `model_ready_status skipped`.
- `pnpm benchmark:web -- --real --include-agent` passed with `model_ready_status ready`, `model_load_seconds 6.662`, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `p95_task_seconds 17.949`, and `timeout_rate 0.0000`.
- A warmed rerun passed with `model_load_seconds 1.106`, `task_success_rate 1.0000`, `json_valid_rate 1.0000`, `p95_task_seconds 20.008`, and `timeout_rate 0.0000`.
- Interpretation: model load is now measured separately from browser task duration without using a generation warmup or weakening frozen task assertions.

Current debug-command experiment:

- Add `pnpm browser:model-ready` as a readiness-only developer command.
- It launches the built extension in the configured Chrome-for-Testing runtime, starts the local MCP sidecar, connects the extension bridge, calls `gemma_model_ready`, prints readiness timing/status, and exits without running benchmark tasks or a generation.
- Use `--profile <path>` or `GEMMA_GEM_CHROME_PROFILE=<path>` to target a preloaded profile. Use `--keep-open` to leave the browser, DevTools endpoint, and bridge running for extension debugging.
- Keep if the command validates model readiness through the same extension/MCP control plane and does not regress the benchmark gates.

Example:

```powershell
pnpm build
pnpm browser:model-ready -- --profile .browsers/gemma-gem-benchmark-profile
pnpm browser:model-ready -- --keep-open
```

Experiment result:

- `pnpm browser:model-ready -- --profile .browsers\gemma-gem-benchmark-profile` passed through the real extension/MCP path with `modelId gemma-4-e2b`, `status ready`, `phase ready`, `progress 100`, and `load seconds 5.407`.
- `pnpm test` passed.
- `pnpm benchmark:web` passed with `model_ready_status skipped`.
- `pnpm benchmark:web -- --real --include-agent` passed with `model_ready_status ready`, `model_load_seconds 0.291`, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `p95_task_seconds 25.892`, and `timeout_rate 0.0000`.
- Interpretation: extension/runtime readiness can now be validated and debugged outside the task suite without downloading the model every run or running a generation warmup.

Current visible MCP debug experiment:

- Extend `pnpm browser:model-ready` with `--fixture <page>` and `--run-tool <gemma_page_brief|gemma_agent>`.
- The command now can serve a benchmark fixture, open it in the visible debug browser, run model readiness, run one MCP tool against the focused page, and optionally keep the browser plus MCP bridge open.
- This is for visually inspecting foreground page state and background Gemma Relay/MCP behavior without running the whole benchmark suite.

Example:

```powershell
pnpm browser:model-ready -- --profile .browsers\gemma-gem-benchmark-profile --fixture semantic-buttons --run-tool gemma_agent --keep-open
pnpm browser:model-ready -- --devtools-port 15067 --mcp-port 15068 --fixture semantic-buttons --run-tool gemma_agent --skip-ready
```

Experiment result:

- A live keep-open debug browser was opened against `.browsers\gemma-gem-benchmark-profile` with DevTools `http://127.0.0.1:15067` and MCP `http://127.0.0.1:15068/mcp`.
- Attach mode opened `semantic-buttons.html` in that visible browser and ran `gemma_page_brief` through the existing MCP bridge in `0.032` seconds.
- Attach mode then opened the same fixture and ran `gemma_agent` through the existing MCP bridge in `93.103` seconds. Gemma clicked `#download-receipt` and returned `Invoice INV-2026-041`.
- `pnpm compile`, `pnpm test`, `pnpm benchmark:web`, and `pnpm benchmark:web -- --real` passed after the change.
- A full `pnpm benchmark:web -- --real --include-agent` rerun was not committed for this cycle because the live visual debug browser intentionally held the persistent benchmark profile open, causing a Chrome DevTools launch timeout. The previous real-agent benchmark remains the current committed full-suite evidence.
- Interpretation: the debug command can now keep the extension visible while running one MCP-driven deterministic or model-backed browser task, which makes foreground page state and background Gemma Relay behavior inspectable during development.

Relevant platform constraints:

- Extension service workers are event-driven and can shut down when dormant, so long-running model work should not depend on unstated service-worker liveness.
- Offscreen documents are the intended Chrome extension surface for hidden DOM/WebGPU work, but only `chrome.runtime` messaging is available there.
- ONNX Runtime WebGPU documentation calls out explicit GPU tensor/buffer lifecycle management; repeated timeout or `OrtRun` failures should be treated as potential runtime state issues, not just prompt failures.

## Commands

Use these repo commands first:

```powershell
pnpm compile
pnpm test:e2e
pnpm test
```

Add a benchmark script once the harness exists:

```json
{
  "scripts": {
    "benchmark:web": "tsx benchmarks/web-control-plane/run.ts"
  }
}
```

Then run:

```powershell
pnpm benchmark:web
```

Redirect long benchmark output to a log:

```powershell
pnpm benchmark:web *> benchmark.web.log
```

## Timing Budget

Do not use the upstream autoresearch 5-minute LM-training budget. Web-control experiments have different failure modes.

Use these budgets:

- contract test run: under 2 minutes
- local benchmark smoke suite: under 5 minutes
- full local benchmark suite: under 20 minutes
- real-browser extension benchmark: under 30 minutes
- optional external benchmark subset: under 90 minutes

Per task:

- default task timeout: 120 seconds
- hard timeout: 180 seconds
- MCP bridge request timeout should remain explicit and logged

If a run exceeds its budget, stop it, mark the result as `timeout`, and move on.

## Results File

Use tab-separated `results.web.tsv`:

```text
commit	suite	tasks	success_rate	strict_success_rate	json_valid_rate	selector_hit_rate	actions_per_success	p50_s	p95_s	timeout_rate	model_load_s	status	description
```

Status values:

- `baseline`
- `keep`
- `discard`
- `crash`
- `timeout`

Use `0.0` for unavailable numeric fields after a crash. Descriptions must be short and tab-free.

## Decision Rule

Constraints:

- no unauthenticated non-loopback bridge access
- no default public `run_javascript` MCP tool unless deliberately gated for development
- no benchmark assertion weakening
- no broad UI churn
- no npm/yarn

Keep a change when:

- `task_success_rate` improves by at least one task on the frozen suite, or
- success is equal and one of `json_valid_rate`, `selector_hit_rate`, `actions_per_success`, or timeout behavior improves meaningfully.

Discard a change when:

- task success drops
- JSON validity drops for observe/extract tasks
- sidecar auth/origin safety weakens
- the change only improves one known task by overfitting evaluator text
- latency/timeouts regress beyond the timing budget with no success-rate gain

## Using `../autoresearch-win-rtx`

Use the sibling repo as a playbook, not as a dependency.

Useful ideas to borrow:

- the `program.md` loop structure
- frozen benchmark discipline
- `results.tsv` progress tracking
- benchmark report format
- explicit keep/discard rules

Do not copy its RAG service objective into Gemma Gem. Gemma Gem's objective is browser control-plane reliability.

If later model fine-tuning becomes justified, use autoresearch-style infrastructure to train a small control-plane reranker or policy model from Gemma Gem traces. Candidate data:

- page brief
- task instruction
- observed candidate actions
- selected action
- tool result
- success/failure label

Possible first trainable component:

- an action/selector reranker that chooses among observed candidates before calling `gemma_act`

This should only happen after there are enough benchmark traces to evaluate it.

## End-of-Run Deliverables

When interrupted or asked for a report, produce:

1. `benchmarks/web-control-plane/report.md`: baseline vs best control plane, including task success, strict success, JSON validity, selector hit rate, task latency, timeouts, and notable failures.
2. `results.web.tsv`: full experiment ledger.
3. A short list of kept changes and reverted/discarded hypotheses.
4. Current recommended command to run the suite.
5. Next three highest-value experiments.

The end state should be a Gemma Gem control plane that can repeatedly run measurable browser tasks, not just a set of plausible prompts.
