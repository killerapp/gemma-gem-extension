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
pnpm benchmark:web:real:agent
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

Current runtime/debug hardening experiment:

- A live extension reload during debugging can leave a persistent `.browsers` Chrome profile in a bad service-worker state where the background worker is visible and the bridge reports connected, but `chrome.tabs.query({})` rejects with `No SW`.
- The large model cache lives under profile cache storage (`Default\Service Worker\CacheStorage` was about 3.2 GB in the benchmark profile), so repairing this state must not delete the whole `Service Worker` tree.
- `pnpm browser:model-ready` now has an opt-in `--reset-service-worker-metadata` flag that removes only `Default\Service Worker\Database` and `Default\Service Worker\ScriptCache` for repo-local `.browsers` profiles, preserving `CacheStorage`.
- Normal debug launches do not reset metadata by default. If `No SW` appears after extension reload/debugging, run one repair launch with `--reset-service-worker-metadata`, close it, then relaunch normally against the same cached profile.
- `gemma_model_ready` debug calls now give the MCP client a timeout buffer beyond the extension readiness timeout. This lets extension-side readiness timeouts surface as `Status: error` with `Error: Model readiness timed out after ...ms`, instead of an unhelpful raw MCP client timeout.
- The benchmark model-ready preflight uses the same timeout-buffer discipline, so include-agent runs should record a bounded preflight error instead of hanging the suite.
- The offscreen `model:load` handler now emits a terminal `model:status ready` when the requested model is already loaded, when a readiness caller joins an existing load, or when a prior in-flight load completes for the same target model. This prevents cached-model readiness checks from timing out only because no new status event was emitted.

Experiment result:

- After resetting small service-worker metadata and relaunching normally, `.browsers\gemma-gem-benchmark-profile` passed visible `gemma_page_brief` with the existing cached profile and no model CacheStorage deletion.
- `pnpm browser:model-ready -- --devtools-port 50637 --mcp-port 50638 --timeout-ms 10000` returned a bounded readiness diagnostic: `Status: error`, `Error: Model readiness timed out after 10000ms`.
- After the offscreen status-emission fix, `pnpm browser:model-ready -- --profile .browsers\gemma-gem-benchmark-profile --timeout-ms 60000` returned `status ready`, `phase ready`, `progress 100`, and `load seconds 3.546`.
- A visible cached-profile run, `pnpm browser:model-ready -- --profile .browsers\gemma-gem-benchmark-profile --fixture semantic-buttons --run-tool gemma_page_brief --keep-open`, returned `status ready`, `load seconds 2.317`, and `gemma_page_brief` in `0.016` seconds.
- `pnpm benchmark:web -- --real --include-agent` passed with `model_ready_status ready`, `model_load_seconds 0.045`, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `p95_task_seconds 20.729`, and `timeout_rate 0.0000`.
- `pnpm compile`, `pnpm build`, `pnpm test`, `pnpm benchmark:web`, and `pnpm benchmark:web -- --real` passed after the change.
- Interpretation: the debug loop can recover from extension service-worker registration corruption without discarding the downloaded model cache, cached readiness no longer depends on a fresh load event, and readiness failures stay bounded and diagnostic.

Current action-accounting experiment:

- Real extension mode previously reported `actions_per_success: 0.00` even when `gemma_agent` used page tools, because the real harness cannot see nested offscreen-agent tool calls through the host-side bridge request log.
- The service worker now keeps a bounded dev-only Gemma Relay activity log exposed as `__gemmaGemBenchmarkBridgeActivity()`.
- The real benchmark harness uses that activity log to count Relay `started` and `tool` events per task, while the fake harness keeps using its direct bridge request log.
- `benchmark.web.jsonl` task records now include an `actionTrace` array with compact per-task Relay/tool events (`status`, `toolName`, `requestId`, `tabId`, title/text preview, timestamp). This keeps the raw action path available for later selector/action policy analysis without replaying the browser session.
- `pnpm benchmark:traces` exports normalized action-policy records to `benchmarks/web-control-plane/action-traces.jsonl`. The export omits volatile request IDs, timestamps, tab IDs, durations, and task output previews, then keeps task context, outcome labels, tool names, selector hints, and compact action text.
- The Relay panel should display streamed thinking as one live `thinking` row per active request. Token-sized `[Thinking]` or `Thinking:` chunks are transport detail, not separate user-visible Relay events.
- Relay activity statuses are now normalized before rendering, so transport-shaped values like `CHUNK` still enter the coalesced stream path instead of creating one visible row per token-sized thinking chunk.
- The Relay renderer now treats chunk-shaped activity as non-renderable in the ordinary event path, so `CHUNK / Thinking: ...` rows are dropped instead of leaking through when a payload uses noncanonical casing.
- This matters for the future training loop: selector/action traces need a reliable action count before they can become useful policy/reranker data.

Experiment result:

- `pnpm compile`, `pnpm build`, `pnpm test`, `pnpm benchmark:web`, and `pnpm benchmark:web -- --real` passed after the instrumentation change.
- `pnpm benchmark:web -- --real --include-agent` passed on `fa86e6b` with `model_ready_status ready`, `model_load_seconds 0.018`, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `actions_per_success 2.43`, `p95_task_seconds 20.885`, and `timeout_rate 0.0000`.
- The resulting `benchmark.web.jsonl` includes real-extension `actionTrace` entries such as `read_page_content`, `type_text`, `click_element`, and model-task `started` events with request/tab metadata.
- Local fake-mode `pnpm benchmark:web` passed after selector-summary enrichment with `actions_per_success 2.43`; `pnpm benchmark:traces` exported `17` positive records from `6` tasks.
- A visible debug run on `c8abed8` used `pnpm browser:model-ready -- --profile .browsers\gemma-gem-benchmark-profile --fixture semantic-buttons --run-tool gemma_agent --keep-open`. Cached readiness returned `status ready`, `load seconds 2.890`, then `gemma_agent` completed in `94.739` seconds with selector `#download-receipt` and invoice `INV-2026-041`.
- The same visible run held DevTools on `http://127.0.0.1:2998` and MCP on `http://127.0.0.1:2999/mcp`. The worker activity hook recorded `324` raw chunks, including `286` `[Thinking]` chunks, but the Relay panel rendered them as coalesced stream/thinking rows plus normal tool/completed rows instead of token-sized `CHUNK` spam.
- The current full real-agent suite passed on `e10d1d7` with `model_ready_status ready`, `model_load_seconds 0.577`, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `actions_per_success 2.43`, `p95_task_seconds 20.726`, and `timeout_rate 0.0000`.
- The trace exporter was tightened after that run so `action-traces.jsonl` keeps stable action-policy records and drops volatile duration/output-preview fields.
- `pnpm benchmark:traces:check` now validates the normalized trace contract. It fails if volatile fields reappear or if the export loses positive, selector-bearing, or click-action records. Current check result: `17` records, `17` positive, `14` selector records, and `2` click records.
- `pnpm benchmark:traces:summary` now writes `benchmarks/web-control-plane/action-traces.summary.md` so the loop can see training coverage at a glance. Current summary: `17` records across `6` tasks, `14` selector records, `2` click records, and `0` negative records. The next data gap is explicit: add failure traces before training a selector/action reranker.
- `pnpm benchmark:traces:check` now also locks the current benchmark-derived raw trace floors: `17` records, `17` positives, `14` selector records, `2` click records, and `3` candidate buckets.
- `pnpm benchmark:traces:training` now combines the positive benchmark-derived trace export with curated counterfactual negatives from `counterfactual-actions.json`. `pnpm benchmark:traces:training:check` requires negative records and currently validates `23` records: `17` positive, `6` negative, `20` selector records, and `6` click records.
- `pnpm benchmark:traces:policy` now writes `benchmarks/web-control-plane/trace-policy-baseline.md`, a deterministic lexical selector/action baseline. After removing label leakage from counterfactual titles, the current baseline is intentionally weak: `pairwise_task_accuracy 0.2917` and `best_threshold_accuracy 0.7391`. Future selector/action policy work should beat this while preserving benchmark success.
- `expected-actions.json` now adds a supervised positive candidate for `gemma_observe`'s expected `#download-receipt` action, because raw observe traces only show page reads while the useful policy target is the returned candidate action. The training check now validates `24` records: `18` positive, `6` negative, `21` selector records, and `7` click records. The lexical baseline improved to `pairwise_task_accuracy 0.3462` and `best_threshold_accuracy 0.7500`.
- `pnpm benchmark:traces:policy` now compares deterministic policy variants and reports `candidate_pairwise_accuracy` over click/type candidate actions separately from whole-trace ranking. A transparent `semantic_keyword` policy is current best: `pairwise_task_accuracy 0.4231`, `candidate_pairwise_accuracy 0.8000`, and `best_threshold_accuracy 0.7917`.
- `expected-actions.json` now also adds supervised positive candidates for `transfer-profile-fields` name/email writes, matching the existing swapped-field counterfactual negatives. The `semantic_keyword` policy scores field-title/selector agreement, raising the current policy report to `26` records, `20` positive, `6` negative, `pairwise_task_accuracy 0.7667`, `candidate_pairwise_accuracy 1.0000`, and `best_threshold_accuracy 0.8077`.
- `pnpm benchmark:traces:policy:check` now gates the deterministic policy baseline in check-only mode, requiring `best_policy semantic_keyword`, `pairwise_task_accuracy >= 0.75`, `candidate_pairwise_accuracy >= 1.00`, and `best_threshold_accuracy >= 0.80`.
- The policy report now includes pair-count denominators, and `pnpm benchmark:traces:policy:check` requires at least `30` whole-trace task pairs and `14` click/type candidate pairs so perfect candidate accuracy cannot hide a collapsed training set.
- `pnpm benchmark:traces:training:check` now requires paired click/type candidates: every negative candidate must have a same-task, same-tool positive candidate. The current training set has `4` total click/type candidate buckets and `3` paired positive/negative buckets.
- `counterfactual-actions.json` now adds a transfer-form click distractor for `#dest-name`, pairing the existing `#save-profile` click bucket. The `semantic_keyword` policy now penalizes transfer field clicks and receipt/settings distractors, raising the current training set to `27` records, `7` negatives, `4` paired candidate buckets, `pairwise_task_accuracy 0.8684` over `38` pairs, `candidate_pairwise_accuracy 1.0000` over `19` candidate pairs, and `best_threshold_accuracy 0.8148`.
- `pnpm benchmark:traces:training:check` now also requires `--min-paired-candidate-buckets 4`, turning the current click/type task-tool coverage into an explicit floor.
- `pnpm benchmark:traces:training:check` now also locks the current training coverage floors: `27` records, `20` positive, `7` negative, `24` selector records, `8` click records, `4` candidate buckets, and `4` paired candidate buckets.
- `counterfactual-actions.json` now adds two more transfer submit-click distractors, `#dest-email` and `#save-result`, so the `transfer-profile-fields:click_element` bucket tests the real submit button against field and status-element clicks.
- The `semantic_keyword` policy now applies stronger transparent penalties for wrong billing document/panel selectors, transfer-field/status clicks when submit is required, and swapped transfer field writes. This keeps the current deterministic policy separable after the harder negative set.
- `pnpm benchmark:traces:training:check` now locks the expanded training coverage floors: `29` records, `20` positive, `9` negative, `26` selector records, `10` click records, `4` candidate buckets, and `4` paired candidate buckets.
- `pnpm benchmark:traces:policy:check` now locks the expanded policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `54` pairs, `candidate_pairwise_accuracy 1.0000` over `29` candidate pairs, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:policy` now reports pairwise score margins, and `pnpm benchmark:traces:policy:check` requires the current separation floors: `pairwise_min_margin 0.500` and `candidate_min_margin 3.750`. This prevents future policy changes from passing on fragile score ties while still preserving the same candidate accuracy gates.
- Candidate buckets now include selector-bearing `read_page_content` actions in addition to `click_element` and `type_text`, because page/context reads are real control-plane decisions in the MCP loop. Raw trace coverage now locks `8` candidate buckets.
- `counterfactual-actions.json` now adds read-context distractors for extraction, page brief, and receipt-agent tasks. The `semantic_keyword` policy penalizes narrow reads when full page context is required while leaving transfer field reads selector-specific.
- `pnpm benchmark:traces:training:check` now locks the broadened read/click/type coverage floors: `32` records, `20` positive, `12` negative, `29` selector records, `10` click records, `9` candidate buckets, and `7` paired candidate buckets.
- `pnpm benchmark:traces:policy:check` now locks the broadened policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `62` pairs, `candidate_pairwise_accuracy 1.0000` over `58` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `counterfactual-actions.json` now adds read-context distractors for the remaining unpaired read buckets: `semantic-observe-json:read_page_content` and `transfer-profile-fields:read_page_content`. All `9` ranked read/click/type candidate buckets now have positive and negative coverage.
- The `semantic_keyword` policy now penalizes transfer destination-field reads more strongly, keeping those read distractors below useful source/result reads without affecting destination-field typing actions.
- `pnpm benchmark:traces:training:check` now locks the fully paired ranked-candidate floors: `35` records, `20` positive, `15` negative, `32` selector records, `10` click records, `9` candidate buckets, and `9` paired candidate buckets.
- `pnpm benchmark:traces:policy:check` now locks the fully paired policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `81` pairs, `candidate_pairwise_accuracy 1.0000` over `77` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences` now writes `benchmarks/web-control-plane/action-preferences.jsonl`, a pairwise preference dataset for a future selector/action reranker. It expands each same-task same-tool positive/negative ranked candidate bucket into direct `preferred` versus `rejected` action pairs.
- `pnpm benchmark:traces:preferences:check` validates the preference schema, rejects volatile fields and label leakage, requires distinct preferred/rejected action surfaces, and locks the current floors: `28` preference pairs across `9` buckets and `5` tasks, with `13` read pairs, `7` click pairs, and `8` type pairs.
- The deterministic scoring logic now lives in `trace-policy-scoring.ts` so the trace-policy and preference-policy reports use one shared baseline definition.
- `pnpm benchmark:traces:preferences:policy` now writes `benchmarks/web-control-plane/action-preferences.policy.md`, evaluating policies directly on preferred/rejected pairs. `pnpm benchmark:traces:preferences:policy:check` locks `semantic_keyword` at `preference_accuracy 1.0000` over `28` pairs with `preference_min_margin 2.000`.
- `pnpm benchmark:traces:reranker` now writes `benchmarks/web-control-plane/action-reranker.preferences.jsonl`, a prompt-shaped action-reranker preference dataset. Each row presents two same-task same-tool candidate actions, alternates whether the useful action is `candidate_a` or `candidate_b`, and emits JSON `chosenCompletion` / `rejectedCompletion` strings for training a small control-plane reranker.
- `pnpm benchmark:traces:reranker:check` validates that reranker rows keep the stable preference schema, include exactly two candidates, preserve same-task same-tool pairing, parse completions as JSON choices, reject volatile fields and label leakage, and lock the current floors: `28` pairs, `9` buckets, `5` tasks, `14` chosen `candidate_a`, and `14` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline` now writes `benchmarks/web-control-plane/action-reranker.baseline.md`, comparing the deterministic `semantic_keyword` scorer with a tiny pairwise perceptron trained on the prompt-shaped reranker rows. The full-data learned baseline reaches `accuracy 1.0000` over `28` pairs with `min_margin 5.000`, while `semantic_keyword` remains `accuracy 1.0000` with `min_margin 2.000`.
- `pnpm benchmark:traces:reranker:baseline:check` locks the current offline reranker floors: `semantic_keyword accuracy 1.0000`, learned full-data accuracy `1.0000`, `28` pairs, and leave-one-task-out learned accuracy at least `0.69`. Current leave-one-task-out accuracy is `0.6964`, showing the present data is separable but still too narrow for strong cross-task generalization.
- `expected-actions.json` and `counterfactual-actions.json` now add a second supervised form-field task, `copy-shipping-fields`, with paired `type_text` name/email candidates. This keeps frozen runtime tasks unchanged while adding another form-like bucket for offline reranker generalization.
- The deterministic and learned policy features now apply field-title/selector alignment to all `type_text` actions, not only `transfer-profile-fields`. This preserves transparent scoring while making the form-write rule task-agnostic.
- `pnpm benchmark:traces:training:check` now locks the expanded supervised diversity floors: `39` records, `22` positive, `17` negative, `36` selector records, `10` click records, `10` candidate buckets, and `10` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` now locks `32` preference pairs across `10` buckets and `6` tasks, with `13` read pairs, `7` click pairs, and `12` type pairs.
- `pnpm benchmark:traces:reranker:check` now locks `32` prompt-shaped reranker pairs across `10` buckets and `6` tasks, balanced at `16` chosen `candidate_a` and `16` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks `semantic_keyword accuracy 1.0000`, learned full-data accuracy `1.0000`, `32` pairs, and leave-one-task-out learned accuracy at least `0.85`. Current leave-one-task-out accuracy improved to `0.8594`.
- `pnpm benchmark:traces:policy:check` now locks the expanded deterministic policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `85` pairs, `candidate_pairwise_accuracy 1.0000` over `81` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now locks `semantic_keyword` at `preference_accuracy 1.0000` over `32` pairs with `preference_min_margin 2.000`.
- `copy-shipping-fields` now also includes supervised `read_page_content` source/result positives and billing-field read distractors, adding form read-context diversity for the remaining LOTO failure mode.
- The learned reranker features now normalize `source`/`shipping` selectors as source-like and `dest`/`billing` selectors as destination-like, including tool-specific selector-role features for read decisions.
- `pnpm benchmark:traces:training:check` now locks `44` records, `25` positive, `19` negative, `41` selector records, `10` click records, `11` candidate buckets, and `11` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` now locks `38` preference pairs across `11` buckets and `6` tasks, with `19` read pairs, `7` click pairs, and `12` type pairs.
- `pnpm benchmark:traces:reranker:check` now locks `38` prompt-shaped reranker pairs across `11` buckets and `6` tasks, balanced at `19` chosen `candidate_a` and `19` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks `38` pairs and leave-one-task-out learned accuracy at least `0.94`. Current leave-one-task-out accuracy improved to `0.9474`; remaining misses are a held-out shipping read field-alignment case and a transfer submit/status click case.
- `pnpm benchmark:traces:policy:check` now locks the expanded deterministic policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `101` pairs, `candidate_pairwise_accuracy 1.0000` over `97` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now locks `semantic_keyword` at `preference_accuracy 1.0000` over `38` pairs with `preference_min_margin 1.000`.
- `copy-shipping-fields` now adds a supervised `click_element` submit positive, `#save-billing`, plus billing field/status click distractors. This gives the learned reranker a second form submit/status click pattern without changing frozen runtime tasks.
- The deterministic scorer now treats form submit selectors and status/field click distractors through generic selector-role checks, and the learned reranker uses stronger field/selector/click-role features.
- `pnpm benchmark:traces:training:check` now locks `48` records, `26` positive, `22` negative, `45` selector records, `14` click records, `12` candidate buckets, and `12` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` now locks `41` preference pairs across `12` buckets and `6` tasks, with `19` read pairs, `10` click pairs, and `12` type pairs.
- `pnpm benchmark:traces:reranker:check` now locks `41` prompt-shaped reranker pairs across `12` buckets and `6` tasks, with `21` chosen `candidate_a` and `20` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks `41` pairs and leave-one-task-out learned accuracy at least `0.95`. Current leave-one-task-out accuracy is `0.9512`; the original transfer submit/status miss is now correctly ranked, while remaining misses are source-email read cases.
- `pnpm benchmark:traces:policy:check` now locks the expanded deterministic policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `123` pairs, `candidate_pairwise_accuracy 1.0000` over `119` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now locks `semantic_keyword` at `preference_accuracy 1.0000` over `41` pairs with `preference_min_margin 2.000`.
- The learned reranker now includes tool-specific source/destination field-role features, such as `read_page_content_selector_role_field=source:email`, so source email reads are no longer confused with misplaced email writes.
- `pnpm benchmark:traces:reranker:baseline:check` now also locks nonnegative leave-one-task-out margin with `--min-learned-loto-margin 0`. Current leave-one-task-out accuracy improved to `0.9634` over `41` pairs with `learned_perceptron_loto min_margin 0.000`; remaining losses are ties, not negative rankings.
- `expected-actions.json` and `counterfactual-actions.json` now add supervised observe-click diversity (`semantic-proof-observe`) and a third form-read analogue (`sync-contact-fields`) without changing frozen runtime tasks.
- The learned reranker now recognizes `contact-*` selectors as source-like, `checkout-*` selectors as destination-like, and result/status read selectors before destination fields. This fixes the prior zero-margin observe and form-read LOTO cases.
- `pnpm benchmark:traces:training:check` now locks `56` records, `30` positive, `26` negative, `53` selector records, `17` click records, `14` candidate buckets, and `14` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` now locks `49` preference pairs across `14` buckets and `8` tasks, with `25` read pairs, `12` click pairs, and `12` type pairs.
- `pnpm benchmark:traces:reranker:check` now locks `49` prompt-shaped reranker pairs across `14` buckets and `8` tasks, with `25` chosen `candidate_a` and `24` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks leave-one-task-out learned accuracy at `1.0000` with `learned_perceptron_loto min_margin 3.000` over `49` pairs; `learned_perceptron` is again the best policy by min margin.
- `pnpm benchmark:traces:policy:check` now locks the expanded deterministic policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `131` pairs, `candidate_pairwise_accuracy 1.0000` over `127` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now locks `semantic_keyword` at `preference_accuracy 1.0000` over `49` pairs with `preference_min_margin 2.000`.
- `pnpm benchmark:traces:reranker:baseline` now also reports `learned_perceptron_loso`, a leave-one-suite-out learned baseline. This exposes cross-suite transfer weakness that task-level LOTO can hide.
- `semantic-context-read` adds supervised full-page read-context diversity for payment proof pages, and the learned reranker now has explicit full-page-read features for `gemma_extract`, `gemma_page_brief`, `gemma_agent`, and `gemma_observe` read decisions.
- `pnpm benchmark:traces:training:check` now locks `59` records, `31` positive, `28` negative, `56` selector records, `17` click records, `15` candidate buckets, and `15` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` now locks `51` preference pairs across `15` buckets and `9` tasks, with `27` read pairs, `12` click pairs, and `12` type pairs.
- `pnpm benchmark:traces:reranker:check` now locks `51` prompt-shaped reranker pairs across `15` buckets and `9` tasks, with `26` chosen `candidate_a` and `25` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks `learned_perceptron_loto accuracy 1.0000` with `min_margin 9.000` and the new `learned_perceptron_loso accuracy 0.9804` with `min_margin 0.000` over `51` pairs.
- `pnpm benchmark:traces:policy:check` now locks the expanded deterministic policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `133` pairs, `candidate_pairwise_accuracy 1.0000` over `129` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now locks `semantic_keyword` at `preference_accuracy 1.0000` over `51` pairs with `preference_min_margin 2.000`.
- `mirror-customer-fields` adds an independent `forms-read-supervised` suite with customer source fields, order destination fields, and order-result read context. This gives leave-one-suite-out training a second non-held-out form-read analogue.
- The selector-role aliases now treat `customer-*` as source-like and `order-*` as destination-like for both learned reranker features and deterministic trace scoring.
- `pnpm benchmark:traces:training:check` now locks `64` records, `34` positive, `30` negative, `61` selector records, `17` click records, `16` candidate buckets, and `16` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` now locks `57` preference pairs across `16` buckets and `10` tasks, with `33` read pairs, `12` click pairs, and `12` type pairs.
- `pnpm benchmark:traces:reranker:check` now locks `57` prompt-shaped reranker pairs across `16` buckets and `10` tasks, with `29` chosen `candidate_a` and `28` chosen `candidate_b`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks both cross-task and cross-suite learned generalization at `1.0000` accuracy with `min_margin 10.000`: `learned_perceptron_loto` and `learned_perceptron_loso` both pass over `57` pairs.
- `pnpm benchmark:traces:policy:check` now locks the expanded deterministic policy floor: `semantic_keyword`, `pairwise_task_accuracy 1.0000` over `142` pairs, `candidate_pairwise_accuracy 1.0000` over `135` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now locks `semantic_keyword` at `preference_accuracy 1.0000` over `57` pairs with `preference_min_margin 2.000`.
- `pnpm benchmark:traces:reranker:baseline` now also writes `benchmarks/web-control-plane/action-reranker.weights.json`, a machine-readable pairwise perceptron artifact for later runtime integration.
- `pnpm benchmark:traces:reranker:weights:check` validates the weights schema, stable feature ordering, required policy metric, and required features (`full_page_read=body`, `full_page_read=narrow`, `read_page_content_selector_role=source`, `read_page_content_selector_role=destination`). Current artifact has `305` nonzero weights and locks `learned_perceptron_loso accuracy 1.0000` with `min_margin 10.000`.
- The learned reranker feature extraction, scoring, training, and margin computation were factored behind the benchmark adapter in `benchmarks/web-control-plane/reranker-scoring.ts`, so the evaluator and artifact checker use the same executable scorer instead of duplicate logic.
- `pnpm benchmark:traces:reranker:weights:check` now recomputes learned margins from `action-reranker.preferences.jsonl` plus `action-reranker.weights.json`, requiring recomputed `learned_perceptron accuracy 1.0000` and `min_margin 14.000`. This makes the weights artifact executable, not only schema-valid.
- The Relay panel now also canonicalizes status labels at row creation and refuses chunk-like rows there. This keeps token-sized `CHUNK / Thinking: ...` transport payloads out of ordinary Relay event rows even if a future caller bypasses the normal chunk coalescer.
- The learned reranker scoring code now lives in `shared/action-reranker.ts`, and the host sidecar exposes `gemma_rank_actions` as a runtime MCP tool. It accepts a task context plus observed/proposed candidates, normalizes `gemma_observe` actions into tool actions, loads the checked perceptron weights, and returns ranked scores, margins, normalized actions, and top feature contributions.
- The MCP e2e test now calls `gemma_rank_actions` on the semantic-button receipt/invoice/settings candidates and requires `#download-receipt` to rank first before the normal `gemma_agent` task runs. This proves the checked weights are reachable through the runtime MCP surface, not only offline scripts.
- `pnpm pack --dry-run` now verifies the packaged bridge includes both `shared/action-reranker.ts` and `benchmarks/web-control-plane/action-reranker.weights.json`, so fork installs can load the same scorer and artifact.
- `gemma_observe` now applies the learned reranker to deterministic multi-candidate observe results before returning them. If the weights are unavailable, it falls back to the deterministic order instead of failing observation.
- The MCP e2e fixture now deliberately lists `#download-invoice` before `#download-receipt` and calls `gemma_observe` with the ambiguous instruction `download payment document`; the test requires the returned first candidate to be `#download-receipt`. This proves the learned ranker is improving the observe-to-act path, not only a standalone ranking tool.
- `gemma_act` now executes an explicit `ObservedAction` directly through the deterministic bridge tool for `click`, `type`, `select`, and `scroll` instead of sending that already-grounded action back through model generation. `wait` is handled as a bounded local delay, and unsupported/malformed observed actions fail before execution.
- The MCP e2e test now runs the reranked `gemma_observe` result through `gemma_act` and asserts the sidecar sends exactly one `click_element` request for `#download-receipt`, while the later `gemma_agent` call remains the only `bridge:run_agent` request.
- `pnpm test` passed after this direct observed-action execution path was added.
- `pnpm benchmark:web` passed in local-fake-extension mode with `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.43`, `p95_task_seconds 0.009`, and `timeout_rate 0.0000`.
- The frozen semantic-buttons suite now includes `semantic-observed-act`, a `gemma_act` task that passes an explicit receipt `ObservedAction`, expects `#download-receipt` and `Receipt PDF` in the result, verifies `#download-receipt` was clicked, requires `click_element`, and rejects `bridge:run_agent` in harness modes with raw bridge request logs.
- `click_element` results now echo the clicked selector alongside the visible clicked label, so caller agents and benchmark assertions can verify the exact grounded element after deterministic execution.
- `pnpm benchmark:web` now passes with `8` local-fake-extension tasks, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.25`, `p95_task_seconds 0.009`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` also passes the deterministic real-extension smoke subset with `5` tasks, including `semantic-observed-act`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.80`, `p95_task_seconds 0.064`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces` now exports `18` positive records across `7` tasks, and `pnpm benchmark:traces:training:check` now locks `66` training records: `36` positive, `30` negative, `62` selector records, `18` click records, `17` candidate buckets, and `16` paired candidate buckets. Preference/reranker pair counts remain `57` because the new direct-act click is intentionally an unpaired runtime coverage trace.
- `pnpm benchmark:traces:policy:check` now locks `semantic_keyword` at `pairwise_task_accuracy 1.0000` over `142` whole-trace pairs, `candidate_pairwise_accuracy 1.0000` over `135` read/click/type candidate pairs, `pairwise_min_margin 0.500`, `candidate_min_margin 0.500`, and `best_threshold_accuracy 1.0000`.
- `gemma_extract` now validates model JSON against the requested JSON-like schema (`type`, `required`, `properties`, and `items`) and retries once with concrete validation errors if the first response has the wrong structure. The same validator is shared with the benchmark evaluator and packaged as `shared/json-schema.ts`.
- The MCP e2e fake extension now returns an invalid extraction payload first, then a corrected payload; the test requires two extract attempts and verifies the corrected `plans[].price` fields. The frozen extraction benchmark now sets `schemaValid: true`, so `extract-pricing-json` must validate against its requested schema in addition to returning valid JSON and at least two plans.
- `pnpm benchmark:web` passes the schema-valid extraction gate with `8` local-fake-extension tasks, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.25`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `gemma_act` now rejects likely multi-step free-form instructions in the sidecar before delegating to the extension agent. The validation returns `ERROR_MULTIPLE_ACTIONS` with explicit `gemma_agent` guidance, while explicit single `ObservedAction` inputs still execute directly through deterministic bridge tools.
- The MCP e2e test now calls `gemma_act` with `click the receipt button and then open payment settings`, requires `ERROR_MULTIPLE_ACTIONS`, and still requires only three `bridge:run_agent` requests total: two extraction attempts plus the later delegated `gemma_agent` task.
- The frozen semantic-buttons suite now includes `semantic-act-multi-reject`, requiring the same validation text and `bridgeRunAgent: false`. `pnpm benchmark:web` passes with `9` local-fake-extension tasks, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.00`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `6` tasks, including `semantic-act-multi-reject`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.50`, `p95_task_seconds 0.066`, and `timeout_rate 0.0000`.
- `gemma_extract` now scopes its page snapshot reads to the requested selector instead of always reading `body`. The prompt includes `Snapshot selector`, and the sidecar reads both text and HTML through `read_page_content` using the same selector.
- The frozen extraction suite now includes `extract-scoped-plan-json`, which extracts only `.plan[data-plan="team"]`, requires `Team` and `$49`, rejects `Starter` and `$19`, validates the requested schema, and checks the raw fake-extension bridge log for the scoped selector.
- `pnpm benchmark:web` passes with `10` local-fake-extension tasks, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.10`, `p95_task_seconds 0.009`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces` now exports `21` positive records across `8` tasks, and the locked trace floors are raised to `21` records, `21` positives, `16` selector records, and `9` candidate buckets. `pnpm benchmark:traces:training:check` now locks `69` training records: `39` positive, `30` negative, `64` selector records, `18` click records, `18` candidate buckets, and `16` paired candidate buckets.
- `pnpm benchmark:web -- --real` still passes the deterministic real-extension smoke subset with `6` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.50`, `p95_task_seconds 0.146`, and `timeout_rate 0.0000`.
- The observed-action act path now contributes paired click preferences, not only unpaired runtime coverage. `counterfactual-actions.json` adds `#download-invoice` and `#payment-settings` negatives for `semantic-observed-act`, reusing the same receipt-vs-distractor surface that the runtime sidecar executes directly without generation.
- `pnpm benchmark:traces:training:check` now locks `71` training records: `39` positive, `32` negative, `66` selector records, `20` click records, `18` candidate buckets, and `17` paired candidate buckets. `pnpm benchmark:traces:preferences:check` now locks `59` pairs across `17` buckets and `11` tasks, with `14` click pairs.
- The deterministic trace policy was tightened for billing distractors on receipt/proof tasks. `pnpm benchmark:traces:policy:check` now locks `144` whole-trace pairs and `137` candidate pairs with `pairwise_min_margin 1.500`, `candidate_min_margin 1.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:reranker:baseline:check` and `pnpm benchmark:traces:reranker:weights:check` pass on the expanded `59` reranker pairs: `learned_perceptron` remains best, full-data margin remains `14.000`, and LOTO/LOSO both remain `accuracy 1.0000` with `min_margin 10.000`.
- `pnpm benchmark:web` still passes with `10` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `actions_per_success 2.10`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`; `pnpm benchmark:web -- --real` still passes the deterministic real-extension smoke subset with `6` tasks at `p95_task_seconds 0.120`.
- `gemma_click` now recovers selector-engine-specific text selectors before execution when a selector looks like `:has-text(...)` or `text=...`. It re-reads compact page controls, derives the matching observed click action, executes the recovered CSS selector, and still has the prior one-retry recovery path after an actual click error.
- The frozen semantic-buttons suite now includes `semantic-click-recover-selector`, proving `button:has-text("Receipt PDF")` recovers to `#download-receipt`, returns the recovered selector and visible label, clicks `#download-receipt`, and does not use `bridge:run_agent`.
- `pnpm benchmark:web` passes with `11` local-fake-extension tasks, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.09`, `p95_task_seconds 0.014`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `7` tasks, including `semantic-click-recover-selector`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.71`, `p95_task_seconds 0.151`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:check` now locks `23` raw trace records, `23` positives, `19` selector records, `3` click records, and `10` candidate buckets. `pnpm benchmark:traces:training:check` now locks `75` training records: `41` positive, `34` negative, `71` selector records, `23` click records, `20` candidate buckets, and `18` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` and `pnpm benchmark:traces:reranker:check` now lock `61` preference/reranker pairs across `18` buckets and `12` tasks, with `16` click pairs and balanced reranker choices at `31` chosen `candidate_a` / `30` chosen `candidate_b`.
- `pnpm benchmark:traces:policy:check` now locks `147` whole-trace pairs and `143` candidate pairs with `pairwise_min_margin 1.500`, `candidate_min_margin 1.500`, and `best_threshold_accuracy 1.0000`. The learned reranker baselines remain fully separable: LOTO and LOSO both stay at `accuracy 1.0000` with `min_margin 10.000`.
- `gemma_type_text` now uses the same text-like selector recovery path as `gemma_click`: selectors such as `text=Name` are resolved by re-reading compact page controls and executing the derived CSS selector before the first type attempt, while the post-error retry path remains available for bridge failures.
- The fake extension now rejects unknown `type_text` selectors and exposes realistic HTML for the destination form, so recovery is required for label-style field selectors instead of silently writing to arbitrary selector strings.
- The frozen forms suite now includes `type-text-recover-selector`, proving `text=Name` recovers to `#dest-name`, writes `Grace Hopper`, returns the recovered selector, and does not use `bridge:run_agent`.
- `pnpm benchmark:web` passes with `12` local-fake-extension tasks, `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.17`, `p95_task_seconds 0.012`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `8` tasks, including `type-text-recover-selector`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.88`, `p95_task_seconds 0.134`, and `timeout_rate 0.0000`.
- `counterfactual-actions.json` now adds a wrong-field `#dest-email` negative for `type-text-recover-selector`, and the deterministic scorer strengthens `field_title_selector_mismatch` to keep wrong field writes below low-value positive reads. `pnpm benchmark:traces:policy:check` now locks `150` whole-trace pairs and `146` candidate pairs with `pairwise_min_margin 1.500`, `candidate_min_margin 1.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:check` now locks `26` raw trace records, `26` positives, `22` selector records, `3` click records, and `13` candidate buckets. `pnpm benchmark:traces:training:check` now locks `79` training records: `44` positive, `35` negative, `75` selector records, `23` click records, `22` candidate buckets, and `19` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` and `pnpm benchmark:traces:reranker:check` now lock `62` preference/reranker pairs across `19` buckets and `13` tasks, with `13` type pairs and balanced reranker choices at `31` chosen `candidate_a` / `31` chosen `candidate_b`. The learned reranker baselines remain fully separable: full-data margin stays `14.000`, and LOTO/LOSO both stay at `accuracy 1.0000` with `min_margin 10.000`.
- `gemma_page_brief` now includes an `interactiveControls` array derived from the page HTML, with each control's selector, label, tag, id/name, value, and aria label when available. Label-wrapped form inputs now surface their visible label instead of only the raw `name` attribute.
- The frozen forms suite now includes `forms-page-brief-controls`, proving a destination form brief exposes `#dest-name`, `Name`, `input`, `name`, and `#save-profile` without using `bridge:run_agent`.
- Page briefs that request text now perform one extra HTML read to build control metadata. `pnpm benchmark:web` still passes with `13` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.23`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `9` tasks, including `forms-page-brief-controls`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.00`, `p95_task_seconds 0.128`, and `timeout_rate 0.0000`.
- `counterfactual-actions.json` now adds a narrow `#dest-email` read negative for `forms-page-brief-controls`, and the deterministic scorer strengthens the generic `narrow_context_read` penalty for tasks that require full context. `pnpm benchmark:traces:policy:check` now locks `153` whole-trace pairs and `149` candidate pairs with `pairwise_min_margin 1.500`, `candidate_min_margin 1.500`, and `best_threshold_accuracy 1.0000`.
- `pnpm benchmark:traces:check` now locks `29` raw trace records, `29` positives, `25` selector records, `3` click records, and `14` candidate buckets. `pnpm benchmark:traces:training:check` now locks `83` training records: `47` positive, `36` negative, `79` selector records, `23` click records, `23` candidate buckets, and `20` paired candidate buckets.
- `pnpm benchmark:traces:preferences:check` and `pnpm benchmark:traces:reranker:check` now lock `65` preference/reranker pairs across `20` buckets and `14` tasks, with `36` read pairs and balanced reranker choices at `33` chosen `candidate_a` / `32` chosen `candidate_b`. Preference policy margin rises to `3.000`; learned reranker full-data margin stays `14.000`, and LOTO/LOSO both stay at `accuracy 1.0000` with `min_margin 10.000`.
- The frozen navigation suite now includes `stop-contract`, proving `gemma_stop` sends `bridge:stop`, does not use `bridge:run_agent`, and returns a bounded acknowledgement containing `stopped: true` and the requested `runId`.
- The benchmark runner can now assert `bridgeStop` from the fake extension request log and counts local `bridge:stop` as one bounded action, while keeping stop events out of selector/action trace exports and reranker training data.
- `pnpm benchmark:web` passes with `14` local-fake-extension tasks, including `navigation/stop-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.14`, `p95_task_seconds 0.014`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `10` tasks, including `navigation/stop-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.80`, `p95_task_seconds 0.120`, and `timeout_rate 0.0000`.
- Trace and reranker floors remain unchanged after adding stop coverage: `29` raw records, `83` training records, `65` preference/reranker pairs, `153` whole-trace pairs, `149` candidate pairs, and all trace, policy, preference, reranker, baseline, and weight checks pass.
- The frozen forms suite now includes `select-role-label`, proving `gemma_select_option` can select `#dest-role` by visible label `Reviewer`, returns the selected label/value/selector, writes the select value `reviewer`, and does not use `bridge:run_agent`.
- The destination form fixture now includes a compact `Role` dropdown, and the fake extension records selected option state so the evaluator verifies the DOM value rather than only the sidecar acknowledgement.
- `pnpm benchmark:web` passes with `15` local-fake-extension tasks, including `forms/select-role-label`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.07`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `11` tasks, including `forms/select-role-label`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.73`, `p95_task_seconds 0.176`, and `timeout_rate 0.0000`.
- Trace floors are raised to `30` raw records, `30` positives, `26` selector records, `84` training records, `48` training positives, and `80` training selector records. Preference, policy, reranker, baseline, and weight gates remain unchanged and green.
- The frozen extraction suite now includes `read-scoped-plan`, proving the public `gemma_read_page` helper reads `.plan[data-plan="team"]` through `read_page_content`, returns only `Team` and `$49`, excludes the neighboring `Starter` and `$19` plan, and does not use `bridge:run_agent`.
- `pnpm benchmark:web` passes with `16` local-fake-extension tasks, including `extraction/read-scoped-plan`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 2.00`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `12` tasks, including `extraction/read-scoped-plan`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.67`, `p95_task_seconds 0.066`, and `timeout_rate 0.0000`.
- Trace floors are raised to `31` raw records, `31` positives, `27` selector records, `85` training records, `49` training positives, and `81` training selector records. Preference, policy, reranker, baseline, and weight gates remain unchanged and green.
- The frozen navigation suite now includes `scroll-contract`, proving `gemma_scroll` sends `scroll_page`, moves a real/fake navigation viewport past `scrollY >= 650`, returns a deterministic `scrollY` value, and does not use `bridge:run_agent`.
- The content `scroll_page` helper now uses instant scrolling instead of smooth scrolling so the bridge response reports the completed scroll position. The benchmark harness opens `navigation.html` as logical tab `105` and verifies scroll state in both fake and real Chrome modes.
- A first draft of the scroll-state evaluator failed because it checked an undefined remapped task variable. That run is recorded as `discard`; the kept version checks the original logical tab id before asking the harness for scroll state.
- `pnpm benchmark:web` passes with `17` local-fake-extension tasks, including `navigation/scroll-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.94`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `13` tasks, including `navigation/scroll-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.62`, `p95_task_seconds 0.035`, and `timeout_rate 0.0000`.
- Trace floors are raised to `32` raw records, `32` positives, `86` training records, and `50` training positives. Selector, preference, policy, reranker, baseline, and weight gates remain unchanged and green.
- The frozen navigation suite now includes `tabs-contract`, proving `gemma_tabs` returns valid JSON, lists the five addressable fixture tabs, sends `bridge:list_tabs`, and does not use `bridge:run_agent`.
- The benchmark evaluator now supports a generic `minItems` assertion for JSON arrays and explicit `bridgeListTabs` request-log checks in fake-extension mode.
- `pnpm benchmark:web` passes with `18` local-fake-extension tasks, including `navigation/tabs-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.83`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `14` tasks, including `navigation/tabs-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.50`, `p95_task_seconds 0.103`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding tabs coverage because `bridge:list_tabs` is a metadata request, not an action trace. All trace, policy, preference, reranker, baseline, and weight gates remain green.
- The frozen semantic-buttons suite now includes `rank-receipt-actions`, proving the public `gemma_rank_actions` helper loads `action-reranker.weights.json`, returns valid JSON metadata, and ranks `#download-receipt` above `#download-invoice` and `#payment-settings` without using `bridge:run_agent`.
- The benchmark evaluator now supports a `bestSelector` JSON-object assertion for reranker outputs. A first draft expected the old `learned_perceptron` label in the output and is recorded as `discard`; the kept contract checks the stable returned `pairwise_perceptron` artifact metadata and best selector.
- `pnpm benchmark:web` passes with `19` local-fake-extension tasks, including `semantic-buttons/rank-receipt-actions`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.74`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks, including `semantic-buttons/rank-receipt-actions`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.107`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding rank coverage because reranking is local metadata, not a browser action trace. All trace, policy, preference, reranker, baseline, and weight gates remain green.
- The frozen navigation suite now includes `model-ready-contract`, proving `gemma_model_ready` returns valid JSON readiness diagnostics with `status: ready`, `modelId: gemma-4-e2b`, `phase: fake-ready`, and `progress`, sends `bridge:ensure_model_ready`, and does not use `bridge:run_agent`.
- The benchmark evaluator now supports explicit `bridgeEnsureModelReady` request-log assertions, while default real smoke uses a separate exclusion set for model-readiness and model-driven tasks so deterministic real runs do not load the local model unless `--include-agent` is requested.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks, including `navigation/model-ready-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks, excluding `navigation/model-ready-contract`, at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.081`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding model-readiness coverage because readiness is diagnostic bridge metadata, not a browser action trace. All trace, policy, preference, reranker, baseline, and weight gates remain green.
- The frozen navigation suite now hardens `active-tab-contract` and `screenshot-contract`: `gemma_active_tab` must return valid JSON with the active fixture tab id and send `bridge:get_active_tab`, while `gemma_screenshot` must return MCP `image/png` content through `take_screenshot`; both reject `bridge:run_agent`.
- The benchmark evaluator now supports explicit `bridgeGetActiveTab` request-log assertions in fake-extension mode, complementing the existing bridge tool and image checks.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.094`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening active-tab and screenshot coverage because the added assertions cover metadata/image bridge requests, not selector/action trace training data.
- The frozen forms suite now hardens `transfer-profile-fields`, proving `gemma_transfer_fields` returns valid JSON, reads `#source-name` and `#source-email`, types `#dest-name` and `#dest-email`, clicks `#save-profile`, reads `#save-result`, reports the saved result, and does not use `bridge:run_agent`.
- The benchmark evaluator now supports `bridgeExecuteTools` and `bridgeExecuteSelectors` arrays for multi-step deterministic helper contracts without requiring brittle request ordering.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.104`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening transfer coverage because the new assertions freeze the bridge request shape around existing action traces rather than adding new browser actions.
- The frozen semantic-buttons suite now hardens context contracts: `semantic-observe-json` must read `body` page context and avoid `bridge:run_agent` for the deterministic receipt observation path, while `semantic-page-brief` must return valid JSON, list tabs, read `body`, expose `#download-receipt` and `#payment-settings`, and avoid `bridge:run_agent`.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.149`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening semantic context coverage because the added assertions lock existing page-read/list-tabs behavior rather than adding new browser action steps.
- The frozen extraction suite now hardens context contracts: `extract-pricing-json` must read `body` context and delegate to `bridge:run_agent`, while `extract-scoped-plan-json` must read `.plan[data-plan="team"]` context and delegate to `bridge:run_agent`; both still require valid schema-shaped JSON output.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.152`, and `timeout_rate 0.0000`; default real smoke continues to exclude model-backed extraction tasks.
- Trace floors remain unchanged after hardening extraction context coverage because the assertions freeze existing page-read and model-delegation shape rather than adding new browser action steps.
- The frozen semantic-buttons suite now hardens `semantic-receipt-agent`, proving `gemma_agent` reads `body` page context before delegating through `bridge:run_agent` for the receipt proof task.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.078`, and `timeout_rate 0.0000`; default real smoke continues to exclude model-backed agent tasks.
- Trace floors remain unchanged after hardening agent context coverage because the assertion freezes existing page-read and delegation shape rather than adding new browser action steps.
- The frozen form and semantic selector-recovery contracts now require body context reads before deterministic recovered actions: `type-text-recover-selector` must read `body`, recover `#dest-name`, call `type_text`, and avoid `bridge:run_agent`; `semantic-click-recover-selector` must read `body`, recover `#download-receipt`, call `click_element`, and avoid `bridge:run_agent`.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.116`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening selector recovery coverage because the new assertions freeze existing recovery read/action shape rather than adding new browser action steps.
- The frozen forms suite now hardens `forms-page-brief-controls`: `gemma_page_brief` must return valid JSON object output, list tabs, read `body`, expose destination controls including `#dest-name` and `#save-profile`, and avoid `bridge:run_agent`.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.024`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening form brief JSON/tab coverage because the new assertions freeze existing metadata and bridge-request shape rather than adding browser action steps.
- The frozen deterministic helper tasks now harden JSON object contracts for `read-scoped-plan`, `type-text-recover-selector`, `select-role-label`, `stop-contract`, `scroll-contract`, `semantic-observed-act`, `semantic-click-recover-selector`, and `semantic-act-multi-reject`.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.076`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening deterministic JSON coverage because the new assertions change output validity expectations, not browser action counts.
- The benchmark evaluator now supports exact `jsonFields` dot-path assertions for stable structured values. The first draft asserted volatile real-browser fields such as remapped tab ids, ephemeral fixture ports, and whitespace-sensitive scoped text; that local-only pass and real-smoke failure are recorded as `discard`.
- The kept exact-field contracts check stable JSON fields for recovered selectors, selected option value, transfer submit/result selectors, active-tab title, model readiness diagnostics, stop acknowledgement, scroll result, rank-action best selector, deterministic click result, and multi-action rejection.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.009`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.158`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding exact JSON field checks because the evaluator now verifies richer structured output without changing browser action traces.
- The frozen page-brief contracts now use exact `jsonFields` checks for stable control metadata: `forms-page-brief-controls` asserts `body` text output plus `#dest-name` and `#save-profile` control fields, while `semantic-page-brief` asserts `body` text output plus receipt, invoice, and payment-settings controls.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.072`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after hardening page-brief control fields because the new assertions lock structured metadata in existing page-read traces.
- The frozen model-shaped JSON tasks now use exact `jsonFields` checks for local fake-extension outputs: `extract-pricing-json` asserts Starter and Team plan names/prices, `extract-scoped-plan-json` asserts the scoped Team plan fields, and `semantic-observe-json` asserts the first two observed click candidates.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.074`, and `timeout_rate 0.0000`; default real smoke continues to exclude model-backed extraction and observe tasks.
- Trace floors remain unchanged after hardening model-shaped JSON fields because the assertions verify output structure without changing browser action traces.
- `pnpm benchmark:web -- --real --include-agent` initially failed at `19/20` tasks because the model-ready exact field expected the local fake `phase: fake-ready`, while the real extension correctly returned `phase: already-loaded`; that failure is recorded as `discard`.
- The benchmark evaluator now supports mode-specific `containsByMode` and `jsonFieldsByMode` overlays, so `model-ready-contract` keeps exact common readiness fields and separately asserts `phase: fake-ready` in `local-fake-extension` and `phase: already-loaded` in `real-chrome-extension-agent`.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.431`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding mode-specific exact fields because the change only selects mode-appropriate readiness assertions and does not change browser action traces.
- The benchmark evaluator now supports `jsonFieldIncludes` and `jsonFieldExcludes`, including mode-specific overlays, so tasks can assert stable substrings inside specific JSON fields instead of searching the whole serialized output.
- The kept field-specific contracts cover scoped read `content`, page brief `content` and tab titles, active-tab URL suffix, transfer copied-field/result fields, and observed click text. A draft exact `active: true` check for `gemma_active_tab` was discarded because the real extension omits that field while still returning title and URL.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.108`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.507`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding field-specific substring assertions because the checks harden JSON result validation without changing browser action traces.
- The benchmark evaluator now supports `jsonFieldMinItems`, including mode-specific overlays, for nested parsed JSON arrays that cannot be covered by the root-level `minItems` check.
- The kept array-length contracts assert at least two pricing plans, four destination form controls, two copied transfer fields, two observed receipt candidates, and three semantic billing controls.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.107`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.480`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding nested array-length assertions because the checks validate structured output shape without changing browser action traces.
- The benchmark evaluator now supports `jsonFieldItemCount`, including mode-specific overlays, for exact item counts on fixed fixture-owned JSON arrays.
- The kept exact-count contracts assert exactly two pricing plans, four destination form controls, two copied transfer fields, and three semantic billing controls, while retaining the previous minimum-count checks as less-brittle diagnostics.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.030`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.530`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding exact nested item-count assertions because the checks validate fixed JSON result shape without changing browser action traces.
- The benchmark evaluator now supports exact per-task `actions` assertions, with `actionsByMode` overlays available for mode-specific counts. Mismatches fail task success/strict success without changing JSON validity metrics.
- The kept action-count contracts freeze deterministic helper action budgets for scoped reads, page briefs, selector recovery, transfer fields, screenshot, scroll, observe, and observed single-action execution.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.142`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.501`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding exact action-count assertions because the checks constrain existing action traces rather than adding new browser actions.
- The frozen metadata contracts now assert exact zero browser actions for `gemma_tabs`, `gemma_active_tab`, `gemma_model_ready`, `gemma_rank_actions`, and multi-step `gemma_act` rejection. A draft `gemma_stop` action-count assertion was discarded because the fake harness normalizes it as one stop request while the real extension path reports zero browser actions.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.069`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.457`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding zero-action metadata assertions because the checks validate non-action tool behavior rather than adding browser action traces.
- The benchmark evaluator now supports exact root JSON array `itemCount` assertions, with `itemCountByMode` overlays available when needed. A draft exact `gemma_tabs` root count was discarded because real Chrome exposes two extra non-fixture tabs, while the kept `semantic-observe-json` root count freezes the fixture-owned two-action observation result.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.028`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.539`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding root JSON array exact counts because the checks validate parsed output shape without adding browser action traces.
- The frozen model-backed tasks now assert exact action budgets: `extract-pricing-json` and `extract-scoped-plan-json` require two page-context reads plus one `bridge:run_agent` request, while `semantic-receipt-agent` requires the same three actions locally and a mode-specific fourth action in real-agent mode for the delegated receipt click recorded by the real extension.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.031`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.573`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding model-backed action-count contracts because the assertions freeze existing read/delegate/click traces rather than adding new browser actions.
- The benchmark evaluator now supports exact `actionTraceTools` assertions, with `actionTraceToolsByMode` overlays and normalized `gemma_agent` labels for real-extension started events. The kept contracts freeze model-backed trace order: extraction tasks must read text, read HTML, then delegate; the receipt agent must do the same locally and additionally record `click_element` after delegation in real-agent mode.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.154`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.529`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding exact action-trace tool sequences because the assertions validate existing ordered traces without changing tool behavior.
- The deterministic helper contracts now also assert exact `actionTraceTools` order for scoped reads, page briefs, text-selector recovery, select-option, field transfer, screenshot, scroll, observed click execution, semantic click recovery, and semantic observe/page brief reads. Metadata and stop tasks remain covered by zero-action or bridge-request assertions rather than nonempty trace sequences.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.146`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.466`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding deterministic action-trace tool sequences because the assertions freeze existing helper order without adding action records.
- The benchmark evaluator now supports `actionTraceTextIncludes` checks, with `actionTraceTextIncludesByMode` overlays for mode-specific trace text. The kept model-backed contracts assert selector and format evidence on context reads, `gemma_extract`/scoped extraction prompt identity, the receipt-agent delegation prompt, and the real-agent `#download-receipt` click trace.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.148`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.432`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding action-trace text assertions because the checks validate existing trace text without changing action records.
- Deterministic helper contracts now also assert `actionTraceTextIncludes` for scoped read selectors, page-brief `body` text/html reads, recovered type/click selectors, select labels, transfer source/destination selectors, screenshot, scroll direction/amount, observed click selectors, semantic observe reads, and semantic page-brief reads.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.026`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.473`, `model_ready_status ready`, `model_load_seconds 0.002`, and `timeout_rate 0.0000`.
- Trace floors remain unchanged after adding deterministic trace-text assertions because the checks harden existing trace detail without changing action records.
- Normalized trace records now carry `targetSelector` for scoped-selector tasks, and reranker prompts include `target_selector` when present. Scoped pricing/read counterfactuals now pair `extract-scoped-plan-json` and `read-scoped-plan` read decisions against starter-plan distractors, with supervised scoped-read analogues in pricing and semantic suites.
- The learned reranker now trains as a margin perceptron, so already-correct pairs still update until they clear the same margin discipline enforced by the offline gates. The saved weights now include `scoped_target_selector=match` and `scoped_target_selector=mismatch`.
- Trace floors are raised to `94` training records, `53` positives, `41` negatives, `89` selector records, `27` candidate buckets, and `25` paired buckets. Preference/reranker floors are raised to `71` pairs across `25` buckets and `19` tasks, including `42` read pairs and balanced reranker choices at `36` chosen `candidate_a` / `35` chosen `candidate_b`.
- `pnpm benchmark:traces:preferences:policy:check` locks `semantic_keyword` at `preference_accuracy 1.0000` over `71` pairs with `preference_min_margin 3.000`; `pnpm benchmark:traces:policy:check` locks `160` whole-trace pairs, `155` candidate pairs, and threshold accuracy `1.0000`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks `71` reranker pairs with `learned_perceptron_loto min_margin 12.000` and `learned_perceptron_loso min_margin 10.000`; `pnpm benchmark:traces:reranker:weights:check` locks `452` weights and recomputed learned margin `14.000`.
- `pnpm benchmark:web` passes with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes the deterministic real-extension smoke subset with `15` tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.065`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.640`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace schema checkers now validate optional `task.targetSelector`, reject label leakage there, and lock scoped-target coverage: `4` raw trace records, `12` training records, and `6` preference/reranker pairs. Reranker preference checks also require scoped rows to include the exact `target_selector` line in the prompt.
- `pnpm benchmark:traces:check`, `pnpm benchmark:traces:training:check`, `pnpm benchmark:traces:preferences:check`, and `pnpm benchmark:traces:reranker:check` all pass with those scoped-target floors; the remaining preference, policy, reranker baseline, weights, and trace-policy gates still pass unchanged.
- `pnpm benchmark:web` passes after the checker hardening with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:summary` and `pnpm benchmark:traces:training:summary` now report scoped target coverage directly, including `target_selector_records`, per-task `target_selectors`, and a `Target Selector Coverage` table.
- The raw trace summary shows `4` target-selector records for `.plan[data-plan="team"]`; the training summary shows `12` target-selector records split across `.plan[data-plan="team"]` and `#download-receipt`.
- `pnpm benchmark:web` passes after the summary reporting change with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- Trace summaries now split scoped target records into `target_selector_matching_records`, `target_selector_mismatched_records`, and `target_selector_no_action_selector_records`, with the same match/mismatch/no-selector breakdown in the `Target Selector Coverage` table.
- The raw trace summary shows `3` scoped selector matches, `0` mismatches, and `1` no-action-selector delegation record; the training summary shows `6` matches, `5` mismatches, and `1` no-action-selector record.
- `pnpm benchmark:web` passes after the target selector match/mismatch reporting change with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:check` now locks raw scoped target diagnostics at `4` records, `3` selector matches, and `1` no-action-selector delegation record; `pnpm benchmark:traces:training:check` locks training diagnostics at `12` records, `6` matches, `5` mismatches, and `1` no-action-selector record.
- `pnpm benchmark:web` passes after adding target selector match/mismatch checker floors with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:check` now also locks distinct scoped target bucket coverage: raw traces require `1` target selector bucket, `1` match bucket, and `1` no-action-selector bucket; training traces require `2` target selector buckets, `2` match buckets, `2` mismatch buckets, and `1` no-action-selector bucket.
- `pnpm benchmark:web` passes after adding target selector bucket checker floors with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:preferences:check` and `pnpm benchmark:traces:reranker:check` now lock scoped target diversity at `6` target-selector pairs across `2` target-selector values and `5` scoped task/tool buckets.
- `pnpm benchmark:web` passes after adding preference/reranker target selector diversity floors with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:policy:check` now locks scoped target-selector candidate policy quality separately: `6` target-selector candidate pairs, `target_selector_candidate_pairwise_accuracy 1.0000`, and `target_selector_candidate_min_margin 11.000`.
- `pnpm benchmark:web` passes after adding scoped trace-policy target selector floors with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:reranker:baseline` now reports scoped target-selector policy quality separately: `6` target-selector reranker pairs, `semantic_keyword target_selector min_margin 11.000`, and learned full/LOTO/LOSO target-selector min margins all `101.000`.
- `pnpm benchmark:traces:reranker:baseline:check` now locks those scoped reranker floors with `--min-target-selector-pairs 6`, perfect scoped semantic/learned accuracy, semantic scoped margin at least `10`, and learned full/LOTO/LOSO scoped margins at least `100`.
- `pnpm benchmark:web` passes after adding scoped reranker-baseline target selector floors with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:reranker:weights:check` now validates the saved weights artifact's scoped target-selector policy metrics and recomputes saved-weight scoped target rankings from `action-reranker.preferences.jsonl`. The current saved `learned_perceptron` target-selector result is `accuracy 1.0000` over `6` pairs with `min_margin 101.000`.
- `pnpm benchmark:web` passes after adding scoped reranker weight gates with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:reranker:weights:check` now also locks saved-weight training coverage and best-policy metadata: `71` pairs, `25` buckets, `19` tasks, `8` suites, `bestPolicy learned_perceptron`, and `71` rows for the required `learned_perceptron_loso` policy metric.
- `pnpm benchmark:web` passes after adding saved-weight coverage gates with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:preferences:policy` now reports scoped target-selector preference-policy quality separately: `6` target-selector preference pairs, `target_selector_preference_accuracy 1.0000`, and `target_selector_preference_min_margin 11.000` for the best `semantic_keyword` policy.
- `pnpm benchmark:traces:preferences:policy:check` now locks those scoped preference-policy floors with `--min-target-selector-accuracy 1`, `--min-target-selector-pairs 6`, and `--min-target-selector-margin 10`.
- `pnpm benchmark:web` passes after adding scoped preference-policy target selector floors with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:preferences:policy:check` now also locks preference-policy coverage at `71` pairs, `25` task/tool buckets, and `19` tasks, so the policy quality gate cannot pass on a collapsed preference artifact.
- `pnpm benchmark:web` passes after adding preference-policy coverage gates with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.011`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:policy:check` now locks trace-policy input coverage at `94` records, `53` positives, `41` negatives, and `22` trace tasks before checking pairwise policy quality. The generated `trace-policy-baseline.md` now reports `trace_tasks` directly.
- `pnpm benchmark:web` passes after adding trace-policy coverage gates with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:policy:check` now also locks trace-policy candidate diversity at `27` task/tool candidate buckets and `25` paired candidate buckets. The generated `trace-policy-baseline.md` reports `candidate_buckets` and `paired_candidate_buckets`.
- `pnpm benchmark:web` passes after adding trace-policy bucket gates with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:traces:policy:check` now enforces the scoped target-selector candidate margin with `--min-target-selector-candidate-margin 10`; the current deterministic policy still reports `target_selector_candidate_min_margin 11.000` over `6` scoped pairs.
- `pnpm benchmark:web` passes after tightening the trace-policy scoped target margin floor with `20` local-fake-extension tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 0.010`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real` passes on the current branch with `15` deterministic real-extension smoke tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.119`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web -- --real --include-agent` passes on the current branch with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.463`, `model_ready_status ready`, `model_load_seconds 0.002`, and `timeout_rate 0.0000`.
- `package.json` now exposes direct real benchmark aliases: `pnpm benchmark:web:real` for deterministic real-extension smoke and `pnpm benchmark:web:real:agent` for the model-backed real-extension agent suite. Both aliases pass on the current branch: real smoke `15/15` with `p95_task_seconds 0.116`, and real agent `20/20` with `p95_task_seconds 6.534`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Generated benchmark reports now point users at `pnpm benchmark:web:real:agent` for model-backed real-extension coverage instead of the older forwarded-argument form.
- Generated benchmark reports now also identify the mode-specific command that produced them: `pnpm benchmark:web`, `pnpm benchmark:web:real`, or `pnpm benchmark:web:real:agent`.
- Generated benchmark reports now describe `real-chrome-extension-agent` separately from deterministic smoke, including the model-backed `gemma_model_ready`, `gemma_agent`, `gemma_observe`, and `gemma_extract` task coverage.
- Generated benchmark reports now include a compact Recent Ledger table from `results.web.tsv`, including the just-recorded run, so baseline/keep context is visible without opening the full TSV.
- Generated benchmark reports now also summarize the best kept row per runner suite, ranked by success, strict success, JSON validity, selector hit rate, timeout rate, p95 latency, and action count.
- Generated benchmark reports now include a Recent Decisions section that lists recent kept changes and recent discarded, crashed, or timed-out hypotheses from the experiment ledger.
- Generated benchmark reports now include Recommended Commands and Next Experiments sections, so the report carries the current suite command and the next three high-value follow-ups.
- Generated benchmark reports now include an Artifacts section pointing at the report, TSV ledger, latest JSONL task log, raw/training trace logs, and saved reranker weights.
- `pnpm benchmark:web:real` passes on the current branch after the report artifact work with `15` deterministic real-extension smoke tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.40`, `p95_task_seconds 0.072`, and `timeout_rate 0.0000`.
- `pnpm benchmark:web:real:agent` passes on the current branch after the real-smoke refresh with `20` real-extension agent tasks at `task_success_rate 1.0000`, `strict_success_rate 1.0000`, `json_valid_rate 1.0000`, `selector_hit_rate 1.0000`, `actions_per_success 1.65`, `p95_task_seconds 6.560`, `model_ready_status ready`, `model_load_seconds 0.002`, and `timeout_rate 0.0000`.
- Interpretation: real-extension benchmark runs now report model-driven browser activity at the same action-count scale as the fake harness, and the JSONL artifacts keep enough action metadata to begin building selector/action trace datasets.

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

June 3, 2026 source-read coverage result:

- Added frozen `forms/read-source-name`, a one-action `gemma_read_page` task that reads `#source-name` from the source profile tab and asserts the response includes `Ada Lovelace` without leaking the email field.
- Baseline local before the task stayed green at 20/20 with `p95_task_seconds 0.010`; after adding the task, local stayed green at 21/21 with `p95_task_seconds 0.009` and `actions_per_success 1.62`.
- The first real-smoke run exposed an evaluator bug, not a task failure: the tool returned `Ada Lovelace`, but selector verification still checked logical tab `101`. Keep the tab-aware selector check in `benchmarks/web-control-plane/run.ts`; do not weaken the selector assertion.
- After the tab-aware check, real smoke passed 16/16 with `p95_task_seconds 0.025`, and real agent passed 21/21 with `p95_task_seconds 6.684`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace regeneration now normalizes untitled tool-action trace rows to `bridge:execute_tool` and deduplicates equivalent click surfaces before preference pairing. This keeps real and fake trace surfaces comparable and preserves reranker gates at 71 pairs, learned LOTO margin 12, and learned LOSO margin 10.

June 3, 2026 source-email read coverage result:

- Added frozen `forms/read-source-email`, a one-action `gemma_read_page` task that reads `#source-email` from the source profile tab and asserts the scoped response includes `ada@example.test` without leaking `Ada Lovelace`.
- Baseline local before the task stayed green at 21/21 with `p95_task_seconds 0.010`; after adding the task, local passed 22/22 with `actions_per_success 1.59` and `p95_task_seconds 0.010`.
- Real smoke passed 17/17 with `selector_hit_rate 1.0000`, `actions_per_success 1.35`, and `timeout_rate 0.0000`; real agent passed 22/22 with `p95_task_seconds 6.523`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 35 raw positive records from 16 tasks and 97 training records from 24 tasks, while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 destination select read coverage result:

- Added frozen `forms/read-destination-role-options`, a one-action `gemma_read_page` task that reads `#dest-role` and asserts the scoped response includes `Choose role`, `Administrator`, and `Reviewer` without leaking adjacent source or save-button text.
- The fake harness now returns the same option-label text for scoped `#dest-role` reads that the real content script sees from the select element, keeping local and real fixture semantics aligned.
- Baseline local before the task stayed green at 22/22 with `p95_task_seconds 0.011`; after adding the task, local passed 23/23 with `actions_per_success 1.57` and `p95_task_seconds 0.009`.
- Real smoke passed 18/18 with `selector_hit_rate 1.0000`, `actions_per_success 1.33`, and `timeout_rate 0.0000`; real agent passed 23/23 with `p95_task_seconds 6.639`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 36 raw positive records from 17 tasks and 98 training records from 25 tasks, while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 scoped HTML read coverage result:

- Added frozen `extraction/read-scoped-plan-html`, a one-action `gemma_read_page` task that reads `.plan[data-plan="team"]` with `format: "html"` and asserts the scoped HTML includes `<h2>Team</h2>`, `class="price"`, and `$49/month` without leaking `Starter` or `$19`.
- The first local post-edit run was recorded as `discard` because the raw MCP text assertion expected unescaped `class="price"`; the parsed JSON content assertion stayed strict, and the raw-text `contains` check now uses `price` to account for JSON escaping.
- Baseline local before the task stayed green at 23/23 with `p95_task_seconds 0.010`; after the escaped-text assertion fix, local passed 24/24 with `actions_per_success 1.54` and `p95_task_seconds 0.010`.
- Real smoke passed 19/19 with `selector_hit_rate 1.0000`, `actions_per_success 1.32`, and `timeout_rate 0.0000`; real agent passed 24/24 with `p95_task_seconds 7.403`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 37 raw positive records from 18 tasks and 99 training records from 26 tasks, with target selector matching records up to 7 while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 negative scroll coverage result:

- Added frozen `navigation/scroll-up-contract`, a one-action `gemma_scroll` task that follows the existing down-scroll task and sends `amount: -300`, asserting the bridge tool call uses `direction=up amount=300` and the viewport returns to roughly 400px.
- Added a `scrollYAtMost` benchmark assertion alongside the existing `scrollYAtLeast` check, so scroll regressions can be bounded from both directions without relying only on exact JSON result fields.
- Baseline local before the task stayed green at 24/24 with `p95_task_seconds 0.010`; after adding the task, local passed 25/25 with `actions_per_success 1.52` and `p95_task_seconds 0.010`.
- Real smoke passed 20/20 with `selector_hit_rate 1.0000`, `actions_per_success 1.30`, and `timeout_rate 0.0000`; real agent passed 25/25 with `p95_task_seconds 6.821`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 38 raw positive records from 19 tasks and 100 training records from 27 tasks, while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation link brief coverage result:

- Added frozen `navigation/navigation-page-brief-links`, a two-action `gemma_page_brief` task that reads the navigation fixture body as text and HTML, then asserts `#settings-link` and `#billing-link` are exposed as anchor controls.
- The fake harness now mirrors the real navigation fixture text and link HTML for `tabId 105`, keeping local page-brief control extraction aligned with the real content-script path.
- Baseline local before the task stayed green at 25/25 with `p95_task_seconds 0.010`; after adding the task, local passed 26/26 with `actions_per_success 1.54` and `p95_task_seconds 0.010`.
- Real smoke passed 21/21 with `selector_hit_rate 1.0000`, `actions_per_success 1.33`, and `timeout_rate 0.0000`; real agent passed 26/26 with `p95_task_seconds 6.636`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 40 raw positive records from 20 tasks and 102 training records from 28 tasks, while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation link click coverage result:

- Added frozen `navigation/click-settings-link`, a one-action `gemma_click` task that clicks `#settings-link` at the end of the navigation suite and asserts the browser URL path changes to `/settings`.
- Added a `urlPath` benchmark assertion with a short real-browser poll, so link-click tests prove navigation state instead of only checking that `click_element` was dispatched.
- Baseline local before the task stayed green at 26/26 with `p95_task_seconds 0.010`; after adding the task, local passed 27/27 with `actions_per_success 1.52` and `p95_task_seconds 0.010`.
- Real smoke passed 22/22 with `selector_hit_rate 1.0000`, `actions_per_success 1.32`, and `timeout_rate 0.0000`; real agent passed 27/27 with `p95_task_seconds 6.539`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 41 raw positive records from 21 tasks and 103 training records from 29 tasks, with click records up to 5 raw and 25 training while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 select-by-value coverage result:

- Added frozen `forms/select-role-value`, a one-action `gemma_select_option` task that selects `#dest-role` by `value: "admin"` and asserts the returned visible label is `Administrator`.
- The fake harness now maps the `admin` option value to the same label/value pair as the real content script, keeping local and real select-option semantics aligned.
- Baseline local before the task stayed green at 27/27 with `p95_task_seconds 0.010`; after adding the task, local passed 28/28 with `actions_per_success 1.50` and `p95_task_seconds 0.010`.
- Real smoke passed 23/23 with `selector_hit_rate 1.0000`, `actions_per_success 1.30`, and `timeout_rate 0.0000`; real agent passed 28/28 with `p95_task_seconds 6.614`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 42 raw positive records from 22 tasks and 104 training records from 30 tasks, while preference and reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 destination name readback coverage result:

- Added frozen `forms/read-destination-name-after-type`, a one-action `gemma_read_page` task that reads `#dest-name` after `gemma_type_text` writes `Grace Hopper`, proving exact selector reads can observe current form-control state.
- The first real-smoke run was recorded as `discard`: the task passed locally but failed in Chrome because text reads of an `<input>` returned visible `innerText` instead of the input value. `read_page_content` now returns `.value` for exact text reads of input and textarea elements while leaving select elements on their option-label text path.
- Real-agent retries also recorded discards while `semantic-receipt-agent` omitted `INV-2026-041` or briefly chose the invoice control after identifier-focused prompt wording. The final kept run preserves visible page identifiers host-side with `withVisiblePageIdentifiers`, so peer-agent results retain snapshot IDs without weakening the benchmark expectation.
- Baseline local before the task stayed green at 28/28 with `p95_task_seconds 0.010`; after adding the task, local passed 29/29 with `actions_per_success 1.48` and `p95_task_seconds 0.011`.
- Real smoke passed 24/24 after the input-value read fix with `actions_per_success 1.29`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 29/29 after identifier preservation with `p95_task_seconds 6.483`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 43 raw positive records from 23 tasks and 105 training records from 31 tasks, while candidate buckets rose to 34 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 checkbox readback coverage result:

- Added frozen `forms/click-destination-updates-checkbox` and `forms/read-destination-updates-after-click`, proving a clicked checkbox can be read back by exact selector as current boolean state.
- Extended the destination fixture and page-brief expectations with `#dest-updates`, keeping the control list compact and explicit while preserving the existing source/destination profile workflow.
- `read_page_content` now reports checkbox and radio inputs as `checked` or `unchecked` for exact text reads, avoiding the misleading static `value` attribute path used by ordinary text inputs.
- Baseline local before the task stayed green at 29/29 with `actions_per_success 1.48` and `p95_task_seconds 0.010`; after adding the tasks, local passed 31/31 with `actions_per_success 1.45` and `p95_task_seconds 0.010`.
- Real smoke passed 26/26 with `actions_per_success 1.27`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 31/31 with `actions_per_success 1.45`, `p95_task_seconds 6.852`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 45 raw positive records from 25 tasks and 107 training records from 33 tasks, while candidate buckets rose to 36 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 radio readback coverage result:

- Added frozen `forms/click-destination-priority-high-radio`, `forms/read-destination-priority-high-after-click`, and `forms/read-destination-priority-low-after-high-click`, proving exact selector reads expose both selected and unselected radio state after a click.
- Extended the destination fixture and fake harness with `#dest-priority-low` and `#dest-priority-high`, including radio-group exclusivity in the fake click path so local and real Chrome state transitions stay aligned.
- Page-brief expectations now freeze the radio selectors, labels, shared `priority` name, and option values alongside the existing text, select, checkbox, and save controls.
- Baseline local before the tasks stayed green at 31/31 with `actions_per_success 1.45` and `p95_task_seconds 0.010`; after adding the tasks, local passed 34/34 with `actions_per_success 1.41` and `p95_task_seconds 0.010`.
- Real smoke passed 29/29 with `actions_per_success 1.24`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 34/34 with `actions_per_success 1.41`, `p95_task_seconds 6.566`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 48 raw positive records from 28 tasks and 110 training records from 36 tasks, while candidate buckets rose to 39 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 type append coverage result:

- Added frozen `forms/append-destination-name-without-clear` and `forms/read-destination-name-after-append`, proving `gemma_type_text` honors `clear: false` by appending to an existing input value and that exact selector reads observe the appended value.
- `type_text` now appends when `clear` is false in both the content script and fake harness, while preserving default clearing behavior for existing form-copy and text-recovery tasks.
- The first real-smoke run was recorded as `discard`: the append behavior and readback passed, but real extension activity traces omitted `clear=false`, so the strict trace assertion failed. Background bridge activity now includes `clear=false` in compact `type_text` diagnostics without exposing typed content.
- Baseline local before the tasks stayed green at 34/34 with `actions_per_success 1.41` and `p95_task_seconds 0.011`; after adding the tasks, local passed 36/36 with `actions_per_success 1.39` and `p95_task_seconds 0.010`.
- Real smoke passed 31/31 after the trace fix with `actions_per_success 1.23`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 36/36 with `actions_per_success 1.39`, `p95_task_seconds 6.656`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 50 raw positive records from 30 tasks and 112 training records from 38 tasks, while candidate buckets rose to 41 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 textarea type/read coverage result:

- Added frozen `forms/type-destination-notes-textarea` and `forms/read-destination-notes-textarea`, proving `gemma_type_text` can type into a textarea and exact selector reads return its current value.
- Extended the destination fixture, page-brief expectations, and fake harness with `#dest-notes`, keeping textarea coverage in the same compact destination form as the existing input, select, checkbox, radio, and save controls.
- The first local run was recorded as `discard`: adding a textarea exposed that deterministic selector recovery scored metadata such as `name=notes`, causing `text=Name` recovery to pick `#dest-notes`. Recovery now strips parenthesized metadata before scoring visible labels, preserving page-brief metadata while avoiding text-selector collisions.
- Baseline local before the tasks stayed green at 36/36 with `actions_per_success 1.39` and `p95_task_seconds 0.010`; after the metadata-label fix, local passed 38/38 with `actions_per_success 1.37` and `p95_task_seconds 0.009`.
- Real smoke passed 33/33 with `actions_per_success 1.21`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 38/38 with `actions_per_success 1.37`, `p95_task_seconds 6.483`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 52 raw positive records from 32 tasks and 114 training records from 40 tasks, while candidate buckets rose to 43 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 save button recovery coverage result:

- Added frozen `forms/click-save-profile-recover-selector`, proving `gemma_click` can recover `text=Save profile` to `#save-profile` through the deterministic page-brief recovery path.
- The task freezes the expected three-action recovery trace: page text read, page HTML read, then `click_element` on the recovered save button selector.
- Baseline local before the task stayed green at 38/38 with `actions_per_success 1.37` and `p95_task_seconds 0.010`; after adding the task, local passed 39/39 with `actions_per_success 1.41` and `p95_task_seconds 0.009`.
- Real smoke passed 34/34 with `actions_per_success 1.26`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 39/39 with `actions_per_success 1.41`, `p95_task_seconds 6.504`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 55 raw positive records from 33 tasks and 117 training records from 41 tasks, while candidate buckets rose to 45 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 textarea recovery coverage result:

- Added frozen `forms/type-notes-recover-selector`, proving `gemma_type_text` can recover `text=Notes` to the textarea selector `#dest-notes` and type through the recovered control.
- The task freezes the same text-selector recovery shape used by input and button recovery: page text read, page HTML read, then `type_text` on the recovered textarea selector while keeping typed text redacted in action traces via `textLength=8`.
- Baseline local before the task stayed green at 39/39 with `actions_per_success 1.41` and `p95_task_seconds 0.009`; after adding the task, local passed 40/40 with `actions_per_success 1.45` and `p95_task_seconds 0.006`.
- Real smoke passed 35/35 with `actions_per_success 1.31`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 40/40 with `actions_per_success 1.45`, `p95_task_seconds 4.186`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 58 raw positive records from 34 tasks and 120 training records from 42 tasks, while candidate buckets rose to 47 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 checkbox recovery coverage result:

- Added frozen `forms/click-updates-recover-selector`, proving `gemma_click` can recover `text=Subscribe updates` to the checkbox selector `#dest-updates` instead of only recovering button text selectors.
- Added `forms/read-destination-updates-after-recovered-click` to prove the recovered checkbox click toggles live form state back to `unchecked`, while preserving the compact no-label exact selector read shape.
- Baseline local before the tasks stayed green at 40/40 with `actions_per_success 1.45` and `p95_task_seconds 0.007`; after adding the tasks, local passed 42/42 with `actions_per_success 1.48` and `p95_task_seconds 0.006`.
- Real smoke passed 37/37 with `actions_per_success 1.35`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 42/42 with `actions_per_success 1.48`, `p95_task_seconds 4.220`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 62 raw positive records from 36 tasks and 124 training records from 44 tasks, while candidate buckets rose to 50 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 radio recovery coverage result:

- Added frozen `forms/click-priority-low-recover-selector`, proving `gemma_click` can recover `text=Priority Low` to the radio selector `#dest-priority-low`.
- Added `forms/read-destination-priority-low-after-recovered-click` and `forms/read-destination-priority-high-after-low-recovered-click`, proving the recovered radio click selects low priority and clears the previously selected high-priority radio in the same group.
- Baseline local before the tasks stayed green at 42/42 with `actions_per_success 1.48` and `p95_task_seconds 0.007`; after adding the tasks, local passed 45/45 with `actions_per_success 1.49` and `p95_task_seconds 0.007`.
- Real smoke passed 40/40 with `actions_per_success 1.38`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent attempt failed before tasks because a stale bridge sidecar left the extension bridge disconnected, then `pnpm bridge:stop` cleared it and the rerun passed 45/45.
- Real agent passed with `actions_per_success 1.49`, `p95_task_seconds 4.120`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 67 raw positive records from 39 tasks and 129 training records from 47 tasks, while candidate buckets rose to 54 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings recovery coverage result:

- Added frozen `semantic-buttons/semantic-settings-recover-selector`, proving `gemma_click` can recover `button:has-text("Payment settings")` to `#payment-settings` on the billing sandbox.
- This complements receipt-button recovery with a second semantic button on the same page, freezing the same page text read, page HTML read, and recovered `click_element` trace shape for the payment settings distractor.
- Baseline local before the task stayed green at 45/45 with `actions_per_success 1.49` and `p95_task_seconds 0.008`; after adding the task, local passed 46/46 with `actions_per_success 1.52` and `p95_task_seconds 0.006`.
- Real smoke passed 41/41 with `actions_per_success 1.41`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 46/46 with `actions_per_success 1.52`, `p95_task_seconds 4.192`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 70 raw positive records from 40 tasks and 132 training records from 48 tasks, while candidate buckets rose to 56 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 starter scoped read coverage result:

- Added frozen `extraction/read-scoped-starter-plan`, proving exact selector reads can scope to `.plan[data-plan="starter"]` and exclude the neighboring Team card.
- Added the matching local fake harness scoped pricing response for the Starter plan, keeping fake and real fixture behavior aligned with the existing Team scoped-read coverage.
- Baseline local before the task stayed green at 46/46 with `actions_per_success 1.52` and `p95_task_seconds 0.007`; after adding the task, local passed 47/47 with `actions_per_success 1.51` and `p95_task_seconds 0.005`.
- Real smoke passed 42/42 with `actions_per_success 1.40`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 47/47 with `actions_per_success 1.51`, `p95_task_seconds 4.159`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 71 raw positive records from 41 tasks and 133 training records from 49 tasks, with target selector matching records up to 8 while preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 starter scoped HTML coverage result:

- Added frozen `extraction/read-scoped-starter-plan-html`, proving exact selector HTML reads can scope to `.plan[data-plan="starter"]` and exclude the neighboring Team card.
- The task mirrors the existing Team scoped HTML read and freezes the HTML response shape with `<h2>Starter</h2>`, `class="price"`, and `$19/month`.
- Baseline local before the task stayed green at 47/47 with `actions_per_success 1.51` and `p95_task_seconds 0.007`; after adding the task, local passed 48/48 with `actions_per_success 1.50` and `p95_task_seconds 0.006`.
- Real smoke passed 43/43 with `actions_per_success 1.40`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 48/48 with `actions_per_success 1.50`, `p95_task_seconds 4.183`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 72 raw positive records from 42 tasks and 134 training records from 50 tasks, with target selector matching records up to 9 while preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 starter scoped extract coverage result:

- Added frozen `extraction/extract-scoped-starter-plan-json`, proving model-backed scoped extraction can return the Starter plan object from `.plan[data-plan="starter"]` while excluding the neighboring Team card.
- Added the matching fake `gemma_extract` scoped Starter response branch so local contract runs cover the same selector-specific JSON shape as the real extension/model path.
- Baseline local before the task stayed green at 48/48 with `actions_per_success 1.50` and `p95_task_seconds 0.006`; after adding the task, local passed 49/49 with `actions_per_success 1.53` and `p95_task_seconds 0.006`.
- Real smoke stayed green at 43/43 with `actions_per_success 1.40`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 49/49 with `actions_per_success 1.53`, `p95_task_seconds 4.845`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 75 raw positive records from 43 tasks and 137 training records from 51 tasks, with target selector matching records up to 11 while preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 select selected-readback coverage result:

- Added frozen `forms/read-destination-role-after-select`, proving exact `gemma_read_page` on `#dest-role` exposes the live selected option after `gemma_select_option` sets the role by value.
- Updated select text reads in the content script and fake harness to include `selected: Administrator (admin)` plus the option list, preserving the existing role-options coverage while freezing selected-state readback.
- Baseline local before the task stayed green at 49/49 with `actions_per_success 1.53` and `p95_task_seconds 0.007`; after adding the task, local passed 50/50 with `actions_per_success 1.52` and `p95_task_seconds 0.006`.
- Real smoke passed 44/44 with `actions_per_success 1.39`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 50/50 with `actions_per_success 1.52`, `p95_task_seconds 4.903`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 76 raw positive records from 44 tasks and 138 training records from 52 tasks, while candidate buckets rose to 60 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 select recovery coverage result:

- Added frozen `forms/select-role-recover-selector`, proving `gemma_select_option` can recover `text=Role` to `#dest-role` and select the visible `Reviewer` option.
- Routed select-option calls through the same bounded text-selector recovery path used by click/type recovery, while preserving direct exact-selector selection behavior and retrying recovery only after bridge selector errors.
- Baseline local before the task stayed green at 50/50 with `actions_per_success 1.52` and `p95_task_seconds 0.006`; after adding the task, local passed 51/51 with `actions_per_success 1.55` and `p95_task_seconds 0.006`.
- Real smoke passed 45/45 with `actions_per_success 1.42`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 51/51 with `actions_per_success 1.55`, `p95_task_seconds 4.873`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 79 raw positive records from 45 tasks and 141 training records from 53 tasks, while candidate buckets rose to 61 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 select recovered-readback coverage result:

- Added frozen `forms/read-destination-role-after-recovered-select`, proving exact `gemma_read_page` on `#dest-role` observes the `Reviewer` selection made through recovered `text=Role` selector selection.
- This closes the select recovery loop by pairing the recovered select action with an exact state readback, mirroring the checkbox and radio recovered-action readback pattern.
- Baseline local before the task stayed green at 51/51 with `actions_per_success 1.55` and `p95_task_seconds 0.005`; after adding the task, local passed 52/52 with `actions_per_success 1.54` and `p95_task_seconds 0.005`.
- Real smoke passed 46/46 with `actions_per_success 1.41`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 52/52 with `actions_per_success 1.54`, `p95_task_seconds 4.881`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 80 raw positive records from 46 tasks and 142 training records from 54 tasks, while candidate buckets rose to 62 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation scroll-target read coverage result:

- Added frozen `navigation/read-scroll-target-after-scroll`, proving exact `gemma_read_page` can read `#scroll-target` after the navigation fixture has been scrolled down and partially back up.
- The task freezes selector-scoped readback for the scroll target while excluding neighboring navigation link text, complementing the existing scroll position assertions.
- Baseline local before the task stayed green at 52/52 with `actions_per_success 1.54` and `p95_task_seconds 0.005`; after adding the task, local passed 53/53 with `actions_per_success 1.53` and `p95_task_seconds 0.006`.
- Real smoke passed 47/47 with `actions_per_success 1.40`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent attempt was recorded as `discard` after existing `semantic-buttons/semantic-receipt-agent` over-clicked `#download-invoice`, while the new scroll-target read passed.
- Real agent retry passed 53/53 with `actions_per_success 1.53`, `p95_task_seconds 4.850`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 81 raw positive records from 47 tasks and 143 training records from 55 tasks, while candidate buckets rose to 63 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation billing-link read coverage result:

- Added frozen `navigation/read-billing-link-before-click`, proving exact `gemma_read_page` can scope to `#billing-link` before the navigation fixture clicks the neighboring Settings link.
- The task freezes the second navigation link as a one-action selector-scoped read and excludes both the adjacent Settings link and the lower scroll-target text.
- Baseline local before the task stayed green at 53/53 with `actions_per_success 1.53` and `p95_task_seconds 0.006`; after adding the task, local passed 54/54 with `actions_per_success 1.52` and `p95_task_seconds 0.006`.
- Real smoke passed 48/48 with `actions_per_success 1.40`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 54/54 with `actions_per_success 1.52`, `p95_task_seconds 4.799`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 82 raw positive records from 48 tasks and 144 training records from 56 tasks, while candidate buckets rose to 64 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation settings-link read coverage result:

- Added frozen `navigation/read-settings-link-before-click`, proving exact `gemma_read_page` can scope to `#settings-link` immediately before the navigation fixture clicks that same link.
- The task freezes the clicked navigation link as a one-action selector-scoped read and excludes both the adjacent Billing link and the lower scroll-target text.
- Baseline local before the task stayed green at 54/54 with `actions_per_success 1.52` and `p95_task_seconds 0.006`; after adding the task, local passed 55/55 with `actions_per_success 1.51` and `p95_task_seconds 0.006`.
- Real smoke passed 49/49 with `actions_per_success 1.39`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 55/55 with `actions_per_success 1.51`, `p95_task_seconds 4.822`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 83 raw positive records from 49 tasks and 145 training records from 57 tasks, while candidate buckets rose to 65 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 transfer email readback coverage result:

- Added frozen `forms/read-destination-email-after-transfer`, proving exact `gemma_read_page` on `#dest-email` observes the email value copied by the preceding `gemma_transfer_fields` workflow.
- The task closes one side of the transfer loop with a one-action selector-scoped state readback and excludes the source name, save result, and submit-button text.
- Baseline local before the task stayed green at 55/55 with `actions_per_success 1.51` and `p95_task_seconds 0.006`; after adding the task, local passed 56/56 with `actions_per_success 1.50` and `p95_task_seconds 0.006`.
- Real smoke passed 50/50 with `actions_per_success 1.38`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 56/56 with `actions_per_success 1.50`, `p95_task_seconds 4.844`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 84 raw positive records from 50 tasks and 146 training records from 58 tasks, while candidate buckets rose to 66 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 transfer name readback coverage result:

- Added frozen `forms/read-destination-name-after-transfer`, proving exact `gemma_read_page` on `#dest-name` observes the name value copied by the preceding `gemma_transfer_fields` workflow.
- This closes the two-field transfer readback pair by verifying both copied destination fields through exact selector reads after submit.
- Baseline local before the task stayed green at 56/56 with `actions_per_success 1.50` and `p95_task_seconds 0.007`; after adding the task, local passed 57/57 with `actions_per_success 1.49` and `p95_task_seconds 0.006`.
- Real smoke passed 51/51 with `actions_per_success 1.37`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 57/57 with `actions_per_success 1.49`, `p95_task_seconds 4.833`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 85 raw positive records from 51 tasks and 147 training records from 59 tasks, while candidate buckets rose to 67 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 transfer save-result readback coverage result:

- Added frozen `forms/read-save-result-after-transfer`, proving exact `gemma_read_page` on `#save-result` observes the submitted result text produced by the preceding `gemma_transfer_fields` workflow.
- This completes the transfer workflow readback trio: copied email, copied name, and submitted result are now each verified through exact selector reads.
- Baseline local before the task stayed green at 57/57 with `actions_per_success 1.49` and `p95_task_seconds 0.006`; after adding the task, local passed 58/58 with `actions_per_success 1.48` and `p95_task_seconds 0.006`.
- Real smoke passed 52/52 with `actions_per_success 1.37`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 58/58 with `actions_per_success 1.48`, `p95_task_seconds 4.817`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 86 raw positive records from 52 tasks and 148 training records from 60 tasks, while candidate buckets rose to 68 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 transfer body readback coverage result:

- Added frozen `forms/read-destination-body-after-transfer`, proving page-level `gemma_read_page` on `body` observes the submitted transfer result alongside the destination form context.
- This complements the exact field/result transfer readbacks with a full-page post-submit state read, preserving broad context coverage after the workflow mutates the destination page.
- Baseline local before the task stayed green at 58/58 with `actions_per_success 1.48` and `p95_task_seconds 0.007`; after adding the task, local passed 59/59 with `actions_per_success 1.47` and `p95_task_seconds 0.006`.
- Real smoke passed 53/53 with `actions_per_success 1.36`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 59/59 with `actions_per_success 1.47`, `p95_task_seconds 4.825`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 87 raw positive records from 53 tasks and 149 training records from 61 tasks, while candidate buckets rose to 69 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic receipt read coverage result:

- Added frozen `semantic-buttons/read-receipt-button-before-act`, proving exact `gemma_read_page` on `#download-receipt` reads the receipt button label without including invoice, settings, or page heading distractors.
- This complements the existing semantic observe/rank/act/recovery coverage with a one-action selector-scoped readback for the winning receipt control.
- Baseline local before the task stayed green at 59/59 with `actions_per_success 1.47` and `p95_task_seconds 0.006`; after adding the task, local passed 60/60 with `actions_per_success 1.47` and `p95_task_seconds 0.006`.
- Real smoke passed 54/54 with `actions_per_success 1.35`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 60/60 with `actions_per_success 1.47`, `p95_task_seconds 4.097`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 88 raw positive records from 54 tasks and 150 training records from 62 tasks, while candidate buckets rose to 70 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings read coverage result:

- Added frozen `semantic-buttons/read-payment-settings-button-before-recovery`, proving exact `gemma_read_page` on `#payment-settings` reads the settings button label without including receipt, invoice, or page heading distractors.
- The first two local attempts were discarded at 60/61 because the fake harness only special-cased `#download-receipt`; the kept change adds parity for `#download-invoice` and `#payment-settings`, matching the real content script's scoped button text behavior.
- Baseline local before the task stayed green at 60/60 with `actions_per_success 1.47` and `p95_task_seconds 0.005`; after adding the task and harness parity fix, local passed 61/61 with `actions_per_success 1.46` and `p95_task_seconds 0.006`.
- Real smoke passed 55/55 with `actions_per_success 1.35`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 61/61 with `actions_per_success 1.46`, `p95_task_seconds 4.179`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 89 raw positive records from 55 tasks and 151 training records from 63 tasks, while candidate buckets rose to 71 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic invoice read coverage result:

- Added frozen `semantic-buttons/read-invoice-button-before-act`, proving exact `gemma_read_page` on `#download-invoice` reads the invoice distractor button label without including receipt, settings, or page heading text.
- This completes one-action selector-scoped readback coverage for all three billing controls: receipt, invoice, and payment settings.
- Baseline local before the task stayed green at 61/61 with `actions_per_success 1.46` and `p95_task_seconds 0.006`; after adding the task, local passed 62/62 with `actions_per_success 1.45` and `p95_task_seconds 0.007`.
- Real smoke passed 56/56 with `actions_per_success 1.34`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 62/62 with `actions_per_success 1.45`, `p95_task_seconds 4.164`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 90 raw positive records from 56 tasks and 152 training records from 64 tasks, while candidate buckets rose to 72 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings act coverage result:

- Added frozen `semantic-buttons/semantic-settings-observed-act`, proving `gemma_act` executes the observed `#payment-settings` click candidate directly without invoking generation.
- This complements the receipt observed-action task with a non-receipt semantic candidate execution path, preserving single-action `gemma_act` behavior for distractor controls.
- Baseline local before the task stayed green at 62/62 with `actions_per_success 1.45` and `p95_task_seconds 0.005`; after adding the task, local passed 63/63 with `actions_per_success 1.44` and `p95_task_seconds 0.006`.
- Real smoke passed 57/57 with `actions_per_success 1.33`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 63/63 with `actions_per_success 1.44`, `p95_task_seconds 4.173`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 91 raw positive records from 57 tasks and 153 training records from 65 tasks, while candidate buckets rose to 73 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic invoice act coverage result:

- Added frozen `semantic-buttons/semantic-invoice-observed-act`, proving `gemma_act` executes the observed `#download-invoice` click candidate directly without invoking generation.
- This completes direct observed-action execution coverage for all three billing controls: receipt, payment settings, and invoice.
- Baseline local before the task stayed green at 63/63 with `actions_per_success 1.44` and `p95_task_seconds 0.005`; after adding the task, local passed 64/64 with `actions_per_success 1.44` and `p95_task_seconds 0.006`.
- Real smoke passed 58/58 with `actions_per_success 1.33`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 64/64 with `actions_per_success 1.44`, `p95_task_seconds 4.148`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 92 raw positive records from 58 tasks and 154 training records from 66 tasks, while candidate buckets rose to 74 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic invoice recovery coverage result:

- Added frozen `semantic-buttons/semantic-invoice-recover-selector`, proving `gemma_click` recovers `button:has-text("Invoice PDF")` to `#download-invoice` and clicks it through the bounded text-selector recovery path.
- This completes text-like click selector recovery coverage for all three billing controls: receipt, payment settings, and invoice.
- Baseline local before the task stayed green at 64/64 with `actions_per_success 1.44` and `p95_task_seconds 0.005`; after adding the task, local passed 65/65 with `actions_per_success 1.46` and `p95_task_seconds 0.007`.
- Real smoke passed 59/59 with `actions_per_success 1.36`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 65/65 with `actions_per_success 1.46`, `p95_task_seconds 4.150`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 95 raw positive records from 59 tasks and 157 training records from 67 tasks, while candidate buckets rose to 76 and preference/reranker pair counts remain stable at 71 pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic invoice rerank coverage result:

- Added frozen `semantic-buttons/rank-invoice-actions`, proving runtime `gemma_rank_actions` ranks `#download-invoice` above receipt and payment-settings billing distractors for an invoice download request.
- The first local run was discarded at 65/66 because the checked weights still preferred `#download-receipt`; the kept fix adds invoice-positive billing-control training pairs and a shared `billing_control_goal` match/mismatch reranker feature rather than weakening the benchmark assertion.
- Updated the deterministic trace policy baseline with symmetric invoice/settings billing-control rules and updated the reranker weights gate to require the new billing match/mismatch features while keeping policy accuracy and margin floors intact.
- Baseline local before the task stayed green at 65/65 with `actions_per_success 1.46` and `p95_task_seconds 0.005`; after the reranker fix, local passed 66/66 with `actions_per_success 1.44` and `p95_task_seconds 0.006`.
- Real smoke passed 60/60 with `actions_per_success 1.33`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 66/66 with `actions_per_success 1.44`, `p95_task_seconds 4.111`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Raw action traces remain at 95 positive records from 59 tasks because the new rank task is zero-action; training traces now cover 164 records from 68 tasks, 117 positive and 47 negative records, 77 candidate buckets, 28 paired buckets, and 77 preference/reranker pairs with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings rerank coverage result:

- Added frozen `semantic-buttons/rank-settings-actions`, proving runtime `gemma_rank_actions` ranks `#payment-settings` above receipt and invoice billing distractors for a payment-settings request.
- This completes runtime billing-control reranker coverage for all three semantic billing controls: receipt, invoice, and payment settings.
- Baseline local before the task stayed green at 66/66 with `actions_per_success 1.44` and `p95_task_seconds 0.005`; after adding the zero-action rank task, local passed 67/67 with `actions_per_success 1.42` and `p95_task_seconds 0.006`.
- Real smoke passed 61/61 with `actions_per_success 1.31`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 67/67 with `actions_per_success 1.42`, `p95_task_seconds 4.176`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remain at 95 raw positive records from 59 tasks and 164 training records from 68 tasks because the new reranker task emits no browser actions; preference/reranker pairs remain at 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic invoice observe coverage result:

- Added frozen `semantic-buttons/semantic-invoice-observe-json`, proving `gemma_observe` returns `#download-invoice` first for an invoice download instruction through the deterministic observe candidate path and checked billing-control reranker.
- This completes observe/read/act/recovery/rank coverage for all three semantic billing controls: receipt, invoice, and payment settings.
- Baseline local before the task stayed green at 67/67 with `actions_per_success 1.42` and `p95_task_seconds 0.005`; after adding the observe task, local passed 68/68 with `actions_per_success 1.43` and `p95_task_seconds 0.005`.
- Real smoke passed 61/61 with `actions_per_success 1.31`, final observed `p95_task_seconds 0.012`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 68/68 with `actions_per_success 1.43`, `p95_task_seconds 4.211`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 97 raw positive records from 60 tasks and 166 training records from 69 tasks, while candidate buckets rose to 78, paired buckets remain 28, and preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings observe coverage result:

- Added frozen `semantic-buttons/semantic-settings-observe-json`, proving `gemma_observe` returns `#payment-settings` first for a payment-settings instruction through the deterministic observe candidate path and checked billing-control reranker.
- This completes JSON observe coverage for all three semantic billing controls: receipt, invoice, and payment settings.
- Baseline local before the task stayed green at 68/68 with `actions_per_success 1.43` and `p95_task_seconds 0.006`; after adding the observe task, local passed 69/69 with `actions_per_success 1.43` and `p95_task_seconds 0.005`.
- Real smoke passed 61/61 with `actions_per_success 1.31`, `p95_task_seconds 0.011`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 69/69 with `actions_per_success 1.43`, `p95_task_seconds 4.213`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 99 raw positive records from 61 tasks and 168 training records from 70 tasks, while candidate buckets rose to 79, paired buckets remain 28, and preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic invoice agent coverage result:

- Added frozen `semantic-buttons/semantic-invoice-agent`, proving end-to-end `gemma_agent` can select `#download-invoice` for an invoice download task through the real extension and model-backed agent path.
- The first local attempt was discarded at 69/70 because the fake bridge classified any prompt containing invoice page text as an invoice task, breaking the existing receipt agent; the kept harness parity fix keys fake invoice selection to the task wording instead.
- Baseline local before the task stayed green at 69/69 with `actions_per_success 1.43` and `p95_task_seconds 0.005`; after the fake parity fix, local passed 70/70 with `actions_per_success 1.46` and `p95_task_seconds 0.006`.
- Real smoke passed 61/61 with `actions_per_success 1.31`, `p95_task_seconds 0.011`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 70/70 with `actions_per_success 1.47`, `p95_task_seconds 4.875`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 103 raw positive records from 62 tasks and 172 training records from 71 tasks, while candidate buckets rose to 81, paired buckets remain 28, and preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings agent fallback coverage result:

- Added frozen `semantic-buttons/semantic-settings-agent`, proving end-to-end `gemma_agent` can recover from a transient WebGPU/ONNX runtime failure and still click `#payment-settings` for a payment-settings task.
- The first real-agent attempts were discarded at 70/71 because the settings agent hit `OrtRun`/`GPUBuffer` failures before clicking; a one-shot model retry was also discarded because the repeated runtime error produced a second agent call without a click.
- The kept recovery falls back from recognized transient model runtime errors to deterministic observed-action ranking and execution, and fixes billing-goal precedence so explicit `settings` beats incidental invoice identifiers in tasks like `open payment settings for invoice INV-2026-041`.
- Baseline local before the task stayed green at 70/70 with `actions_per_success 1.46` and `p95_task_seconds 0.005`; after the fallback and precedence fix, local passed 71/71 with `actions_per_success 1.48` and `p95_task_seconds 0.005`.
- Real smoke passed 61/61 with `actions_per_success 1.31`, final observed `p95_task_seconds 0.015`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 71/71 with `actions_per_success 1.51`, final observed `p95_task_seconds 4.919`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 107 raw positive records from 63 tasks and 176 training records from 72 tasks, while candidate buckets rose to 83, paired buckets remain 28, and preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic settings invoice-id rank coverage result:

- Added frozen `semantic-buttons/rank-settings-with-invoice-id-actions`, proving checked `gemma_rank_actions` keeps `#payment-settings` above `#download-invoice` when an invoice identifier is context rather than the action goal.
- This directly freezes the billing-goal precedence fix from the settings-agent fallback cycle: explicit `settings` must beat incidental `invoice` tokens in task text.
- Baseline local before the task stayed green at 71/71 with `actions_per_success 1.48` and `p95_task_seconds 0.006`; after adding the zero-action rank task, local passed 72/72 with `actions_per_success 1.46` and `p95_task_seconds 0.006`.
- Real smoke passed 62/62 with `actions_per_success 1.29`, `p95_task_seconds 0.013`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 72/72 with `actions_per_success 1.49`, `p95_task_seconds 4.924`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remain at 107 raw positive records from 63 tasks and 176 training records from 72 tasks because the new rank task emits no browser actions; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation billing click coverage result:

- Added frozen `navigation/click-billing-link`, proving deterministic `gemma_click` on `#billing-link` changes a navigation fixture URL to `/billing`.
- The first two real-smoke attempts were discarded at 62/63 because the new task reused tab state after `click-settings-link`; the kept design uses a distinct `navigation-billing.html` fixture on logical tab 106 so settings and billing link-click assertions are independent.
- The fake harness now mirrors billing-link navigation alongside settings-link navigation and maps tab 106 to the duplicate billing-click fixture.
- Baseline local before the task stayed green at 72/72 with `actions_per_success 1.46` and `p95_task_seconds 0.006`; after isolating the new task, local passed 73/73 with `actions_per_success 1.45` and `p95_task_seconds 0.006`.
- Real smoke passed 63/63 with `actions_per_success 1.29`, `p95_task_seconds 0.015`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 73/73 with `actions_per_success 1.48`, `p95_task_seconds 4.813`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 108 raw positive records from 64 tasks and 177 training records from 73 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation billing tab visibility coverage result:

- Added frozen `navigation/tabs-billing-navigation-contract`, proving `gemma_tabs` exposes the isolated `navigation-billing.html` fixture used by the billing-link click task.
- The task is zero-action and requires at least six tab records, `Navigation sandbox`, `navigation-billing.html`, `bridge:list_tabs`, and no `bridge:run_agent`.
- Baseline local before the task stayed green at 73/73 with `actions_per_success 1.45` and `p95_task_seconds 0.006`; after adding the tab-list contract, local passed 74/74 with `actions_per_success 1.43` and `p95_task_seconds 0.006`.
- Real smoke passed 64/64 with `actions_per_success 1.27`, `p95_task_seconds 0.014`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 74/74 with `actions_per_success 1.46`, `p95_task_seconds 4.910`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remain at 108 raw positive records from 64 tasks and 177 training records from 73 tasks because the new tabs contract emits no browser action; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation isolated billing-link read coverage result:

- Added frozen `navigation/read-isolated-billing-link-before-click`, proving exact `gemma_read_page` can scope to `#billing-link` on isolated logical tab 106 before that tab is used for the billing-link click.
- The task complements the tab-list and click assertions by freezing content-script readability of `navigation-billing.html`, excluding the neighboring Settings link and lower scroll-target text.
- Baseline local before the task stayed green at 74/74 with `actions_per_success 1.43` and `p95_task_seconds 0.006`; after adding the read task, local passed 75/75 with `actions_per_success 1.43` and `p95_task_seconds 0.006`.
- Real smoke passed 65/65 with `actions_per_success 1.26`, `p95_task_seconds 0.015`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 75/75 with `actions_per_success 1.45`, `p95_task_seconds 4.938`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 109 raw positive records from 65 tasks and 178 training records from 74 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation active-tab activation coverage result:

- Added harness support for per-task `activateTabId` preconditions, then added frozen `navigation/active-navigation-tab-contract` proving `gemma_active_tab` follows an activated navigation fixture.
- Added `navigation/active-billing-tab-restored-contract` to restore the active tab to the billing fixture after the navigation assertion, keeping later model-backed semantic tasks in their historical active-tab context.
- The un-restored real-agent shape was discarded at 74/76 after two semantic agent tasks hit the known transient model runtime error path; the restored design passed the full real-agent suite.
- Baseline local before the task stayed green at 75/75 with `actions_per_success 1.43` and `p95_task_seconds 0.006`; after adding the active-tab activation and restore contracts, local passed 77/77 with `actions_per_success 1.39` and `p95_task_seconds 0.006`.
- Real smoke passed 67/67 with `actions_per_success 1.22`, `p95_task_seconds 0.019`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 77/77 with `actions_per_success 1.42`, `p95_task_seconds 4.887`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remain at 109 raw positive records from 65 tasks and 178 training records from 74 tasks because both active-tab contracts emit no browser action; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation screenshot coverage result:

- Added frozen `navigation/screenshot-navigation-tab-contract`, proving `gemma_screenshot` routes `take_screenshot` to the navigation fixture tab and returns MCP `image/png` content outside the default billing tab.
- Baseline local before the task stayed green at 77/77 with `actions_per_success 1.39` and `p95_task_seconds 0.006`; after adding the screenshot task, local passed 78/78 with `actions_per_success 1.38` and `p95_task_seconds 0.005`.
- Real smoke passed 68/68 with `actions_per_success 1.22`, `p95_task_seconds 0.055`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- The first real-agent attempt was discarded at 76/78 after the screenshot task passed but two semantic agent tasks hit the known transient model runtime error path; the retry passed 78/78 with `actions_per_success 1.41`, `p95_task_seconds 4.886`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 110 raw positive records from 66 tasks and 179 training records from 75 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation isolated page-brief coverage result:

- Added frozen `navigation/navigation-billing-page-brief-links`, proving `gemma_page_brief` exposes `#settings-link` and `#billing-link` controls on isolated `navigation-billing.html` logical tab 106.
- The task complements tabs/read/click/screenshot coverage by freezing text+HTML readback and interactive-control extraction for the duplicate billing navigation fixture.
- Baseline local before the task stayed green at 78/78 with `actions_per_success 1.38` and `p95_task_seconds 0.005`; after adding the page-brief task, local passed 79/79 with `actions_per_success 1.39` and `p95_task_seconds 0.005`.
- Real smoke passed 69/69 with `actions_per_success 1.23`, `p95_task_seconds 0.052`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 79/79 with `actions_per_success 1.42`, `p95_task_seconds 4.920`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 112 raw positive records from 67 tasks and 181 training records from 76 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 extraction page-brief no-controls coverage result:

- Added frozen `extraction/pricing-page-brief-no-controls`, proving `gemma_page_brief` reads pricing fixture content on logical tab 102 while returning zero interactive controls.
- The task complements scoped extraction/read coverage by freezing body-level text+HTML readback for a non-interactive page, catching false positive control extraction from plain pricing content.
- Baseline local before the task stayed green at 79/79 with `actions_per_success 1.39` and `p95_task_seconds 0.005`; after adding the page-brief task, local passed 80/80 with `actions_per_success 1.40` and `p95_task_seconds 0.005`.
- Real smoke passed 70/70 with `actions_per_success 1.24`, `p95_task_seconds 0.037`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 80/80 with `actions_per_success 1.43`, `p95_task_seconds 4.172`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 114 raw positive records from 68 tasks and 183 training records from 77 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 forms source page-brief no-controls coverage result:

- Added frozen `forms/source-page-brief-no-controls`, proving `gemma_page_brief` reads the profile source fixture on logical tab 103 while returning zero interactive controls.
- Added fake-harness parity for source tab body text+HTML reads so local page-brief behavior mirrors the real `forms-source.html` fixture used by transfer-field workflows.
- Baseline local before the task stayed green at 80/80 with `actions_per_success 1.40` and `p95_task_seconds 0.006`; after adding the page-brief task, local passed 81/81 with `actions_per_success 1.41` and `p95_task_seconds 0.005`.
- Real smoke passed 71/71 with `actions_per_success 1.25`, `p95_task_seconds 0.023`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 81/81 with `actions_per_success 1.43`, `p95_task_seconds 4.213`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 116 raw positive records from 69 tasks and 185 training records from 78 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 forms source HTML read coverage result:

- Added frozen `forms/read-source-body-html`, proving direct `gemma_read_page` HTML readback on logical tab 103 preserves the source profile `#source-name` and `#source-email` elements without leaking destination form controls.
- The task complements source page-brief and transfer-field coverage by freezing the raw source fixture markup used for profile-copy workflows.
- Baseline local before the task stayed green at 81/81 with `actions_per_success 1.41` and `p95_task_seconds 0.006`; after adding the HTML read task, local passed 82/82 with `actions_per_success 1.40` and `p95_task_seconds 0.005`.
- Real smoke passed 72/72 with `actions_per_success 1.25`, `p95_task_seconds 0.049`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 82/82 with `actions_per_success 1.43`, `p95_task_seconds 4.248`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 117 raw positive records from 70 tasks and 186 training records from 79 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 extraction pricing HTML read coverage result:

- Added frozen `extraction/read-pricing-body-html`, proving direct `gemma_read_page` HTML readback on logical tab 102 preserves both pricing plan sections without leaking form or billing-control markup.
- The first two local attempts were discarded at 82/83: first because the fake harness did not yet mirror pricing body HTML, then because the top-level text assertion expected unescaped HTML attribute quotes. The kept version adds fake-harness parity for pricing body HTML and keeps exact attribute checks inside `jsonFieldIncludes`.
- Baseline local before the task stayed green at 82/82 with `actions_per_success 1.40` and `p95_task_seconds 0.005`; after the parity/assertion fix, local passed 83/83 with `actions_per_success 1.40` and `p95_task_seconds 0.005`.
- Real smoke passed 73/73 with `actions_per_success 1.25`, `p95_task_seconds 0.088`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 83/83 with `actions_per_success 1.42`, `p95_task_seconds 4.209`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 118 raw positive records from 71 tasks and 187 training records from 80 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 forms destination initial HTML read coverage result:

- Added frozen `forms/read-destination-body-html-initial`, proving direct `gemma_read_page` HTML readback captures the initial destination form controls before stateful typing, selecting, clicking, and transfer tasks mutate the page.
- The task complements destination page-brief control extraction by freezing raw form markup for `#dest-name`, `#dest-email`, `#dest-role`, checkbox/radio controls, `#dest-notes`, `#save-profile`, and `#save-result`, while excluding source/pricing/billing-control markup.
- Baseline local before the task stayed green at 83/83 with `actions_per_success 1.40` and `p95_task_seconds 0.007`; after adding the HTML read task, local passed 84/84 with `actions_per_success 1.39` and `p95_task_seconds 0.005`.
- Real smoke passed 74/74 with `actions_per_success 1.24`, `p95_task_seconds 0.104`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 84/84 with `actions_per_success 1.42`, `p95_task_seconds 4.137`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 119 raw positive records from 72 tasks and 188 training records from 81 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 semantic billing HTML read coverage result:

- Added frozen `semantic-buttons/read-billing-body-html`, proving direct `gemma_read_page` HTML readback captures the billing fixture controls for receipt, invoice, and payment settings before semantic act/recovery tasks.
- The task complements semantic page-brief and exact selector reads by freezing raw billing-control markup on logical tab 101 while excluding pricing, form, and navigation markup.
- Baseline local before the task stayed green at 84/84 with `actions_per_success 1.39` and `p95_task_seconds 0.005`; after adding the HTML read task, local passed 85/85 with `actions_per_success 1.39` and `p95_task_seconds 0.006`.
- Real smoke passed 75/75 with `actions_per_success 1.24`, `p95_task_seconds 0.097`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 85/85 with `actions_per_success 1.41`, `p95_task_seconds 4.216`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 120 raw positive records from 73 tasks and 189 training records from 82 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation isolated HTML read coverage result:

- Added frozen `navigation/read-isolated-navigation-body-html`, proving direct `gemma_read_page` HTML readback captures the isolated navigation fixture before the billing-link click mutates its URL.
- The task complements tab-list, page-brief, exact link read, screenshot, and click coverage for logical tab 106 by freezing raw link and scroll-target markup while excluding semantic, form, and pricing markup.
- Baseline local before the task stayed green at 85/85 with `actions_per_success 1.39` and `p95_task_seconds 0.006`; after adding the HTML read task, local passed 86/86 with `actions_per_success 1.38` and `p95_task_seconds 0.005`.
- Real smoke passed 76/76 with `actions_per_success 1.24`, `p95_task_seconds 0.027`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 86/86 with `actions_per_success 1.41`, `p95_task_seconds 4.133`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 121 raw positive records from 74 tasks and 190 training records from 83 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation primary HTML read coverage result:

- Added frozen `navigation/read-navigation-body-html`, proving direct `gemma_read_page` HTML readback captures the primary navigation fixture before the settings-link click mutates its URL.
- The task complements page-brief, screenshot, scroll, exact link read, and isolated tab-106 HTML coverage by freezing raw `#settings-link`, `#billing-link`, and `#scroll-target` markup on logical tab 105 while excluding semantic, form, and pricing markup.
- Baseline local before the task stayed green at 86/86 with `actions_per_success 1.38` and `p95_task_seconds 0.006`; after adding the HTML read task, local passed 87/87 with `actions_per_success 1.38` and `p95_task_seconds 0.006`.
- Real smoke passed 77/77 with `actions_per_success 1.23`, `p95_task_seconds 0.102`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent attempt was discarded at 85/87 after existing semantic invoice/settings agent tasks missed their expected selectors, while the new navigation read passed.
- The real-agent retry passed 87/87 with `actions_per_success 1.40`, `p95_task_seconds 4.147`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 122 raw positive records from 75 tasks and 191 training records from 84 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation isolated screenshot coverage result:

- Added frozen `navigation/screenshot-isolated-navigation-tab-contract`, proving `gemma_screenshot` can route `take_screenshot` to the isolated navigation fixture on logical tab 106 and return MCP `image/png` content.
- The first real-smoke attempt was discarded at 77/78 because three screenshot tasks in quick succession exceeded Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota; the bridge now throttles screenshot captures before `chrome.tabs.captureVisibleTab`.
- Baseline local before the task stayed green at 87/87 with `actions_per_success 1.38` and `p95_task_seconds 0.005`; after adding the screenshot task, local passed 88/88 with `actions_per_success 1.38` and `p95_task_seconds 0.006`.
- The throttled real smoke passed 78/78 with `actions_per_success 1.23`, `p95_task_seconds 0.124`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first throttled real-agent attempt was discarded at 86/88 after existing semantic invoice/settings agent tasks missed their expected selectors, while all screenshot tasks passed.
- The real-agent retry passed 88/88 with `actions_per_success 1.40`, `p95_task_seconds 4.193`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 123 raw positive records from 76 tasks and 192 training records from 85 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation isolated active-tab coverage result:

- Added frozen `navigation/active-isolated-navigation-tab-contract`, proving `gemma_active_tab` reports the isolated `navigation-billing.html` fixture after activating logical tab 106.
- The task complements tabs, page-brief, exact read, body HTML, click, and screenshot coverage for tab 106, and the existing billing-tab restore keeps later semantic model tasks in their expected tab context.
- Baseline local before the task stayed green at 88/88 with `actions_per_success 1.38` and `p95_task_seconds 0.005`; after adding the zero-action active-tab task, local passed 89/89 with `actions_per_success 1.36` and `p95_task_seconds 0.005`.
- Real smoke passed 79/79 with `actions_per_success 1.22`, `p95_task_seconds 0.121`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 89/89 with `actions_per_success 1.38`, `p95_task_seconds 4.249`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Because this task records browser metadata instead of a content action, trace artifacts remain at 123 raw positive records from 76 tasks and 192 training records from 85 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 pricing screenshot coverage result:

- Added frozen `navigation/screenshot-pricing-tab-contract`, proving `gemma_screenshot` can route `take_screenshot` to the pricing fixture on logical tab 102 and return MCP `image/png` content.
- The task extends screenshot coverage beyond billing and navigation fixtures, and the throttled bridge path handled four consecutive screenshot captures without hitting Chrome's capture quota.
- Baseline local before the task stayed green at 89/89 with `actions_per_success 1.36` and `p95_task_seconds 0.005`; after adding the screenshot task, local passed 90/90 with `actions_per_success 1.36` and `p95_task_seconds 0.005`.
- Real smoke passed 80/80 with `actions_per_success 1.21`, `p95_task_seconds 0.122`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 90/90 with `actions_per_success 1.38`, `p95_task_seconds 4.158`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 124 raw positive records from 77 tasks and 193 training records from 86 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 source profile screenshot coverage result:

- Added frozen `navigation/screenshot-source-tab-contract`, proving `gemma_screenshot` can route `take_screenshot` to the source profile fixture on logical tab 103 and return MCP `image/png` content.
- The task extends screenshot coverage across billing, pricing, source-profile, and navigation fixtures, and the throttled bridge path handled five consecutive screenshot captures without hitting Chrome's capture quota.
- Baseline local before the task stayed green at 90/90 with `actions_per_success 1.36` and `p95_task_seconds 0.005`; after adding the screenshot task, local passed 91/91 with `actions_per_success 1.35` and `p95_task_seconds 0.006`.
- Real smoke passed 81/81 with `actions_per_success 1.21`, `p95_task_seconds 0.124`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 91/91 with `actions_per_success 1.37`, `p95_task_seconds 4.221`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 125 raw positive records from 78 tasks and 194 training records from 87 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 destination profile screenshot coverage result:

- Added frozen `navigation/screenshot-destination-tab-contract`, proving `gemma_screenshot` can route `take_screenshot` to the destination profile fixture on logical tab 104 and return MCP `image/png` content.
- The task completes screenshot coverage across the current logical fixture tabs 101 through 106, and the throttled bridge path handled six consecutive screenshot captures without hitting Chrome's capture quota.
- Baseline local before the task stayed green at 91/91 with `actions_per_success 1.35` and `p95_task_seconds 0.005`; after adding the screenshot task, local passed 92/92 with `actions_per_success 1.35` and `p95_task_seconds 0.005`.
- Real smoke passed 82/82 with `actions_per_success 1.21`, `p95_task_seconds 0.498`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent run discarded at 90/92 after model-backed semantic invoice/settings misses while the new screenshot contract passed.
- The real-agent retry passed 92/92 with `actions_per_success 1.37`, `p95_task_seconds 4.186`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 126 raw positive records from 79 tasks and 195 training records from 88 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 source active-tab coverage result:

- Added frozen `navigation/active-source-tab-contract`, proving `gemma_active_tab` reports the source profile fixture after activating logical tab 103 and preserves explicit billing restoration for later tasks.
- The task extends active-tab metadata coverage beyond billing and navigation fixtures into the form source fixture without adding content actions.
- Baseline local before the task stayed green at 92/92 with `actions_per_success 1.35` and `p95_task_seconds 0.005`; after adding the zero-action active-tab task, local passed 93/93 with `actions_per_success 1.33` and `p95_task_seconds 0.006`.
- Real smoke passed 83/83 with `actions_per_success 1.19`, `p95_task_seconds 0.501`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent run discarded at 91/93 after the same model-backed semantic invoice/settings misses while the new active-tab contract passed.
- The real-agent retry passed 93/93 with `actions_per_success 1.35`, `p95_task_seconds 4.191`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Because this task records browser metadata instead of a content action, trace artifacts remain at 126 raw positive records from 79 tasks and 195 training records from 88 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 destination active-tab coverage result:

- Added frozen `navigation/active-destination-tab-contract`, proving `gemma_active_tab` reports the destination profile fixture after activating logical tab 104 and preserves explicit billing restoration for later tasks.
- The task completes active-tab metadata coverage for both form fixtures while keeping the contract zero-action and bridge-only.
- Baseline local before the task stayed green at 93/93 with `actions_per_success 1.33` and `p95_task_seconds 0.006`; after adding the zero-action active-tab task, local passed 94/94 with `actions_per_success 1.32` and `p95_task_seconds 0.006`.
- Real smoke passed 84/84 with `actions_per_success 1.18`, `p95_task_seconds 0.501`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 94/94 with `actions_per_success 1.34`, `p95_task_seconds 4.184`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Because this task records browser metadata instead of a content action, trace artifacts remain at 126 raw positive records from 79 tasks and 195 training records from 88 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 pricing active-tab coverage result:

- Added frozen `navigation/active-pricing-tab-contract`, proving `gemma_active_tab` reports the pricing/extraction fixture after activating logical tab 102 and still restores billing before later tasks.
- The task completes active-tab metadata coverage across the current logical fixture tabs 101 through 106 while keeping the contract zero-action and bridge-only.
- Baseline local before the task stayed green at 94/94 with `actions_per_success 1.32` and `p95_task_seconds 0.006`; after adding the zero-action active-tab task, local passed 95/95 with `actions_per_success 1.31` and `p95_task_seconds 0.005`.
- Real smoke passed 85/85 with `actions_per_success 1.16`, `p95_task_seconds 0.504`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 95/95 with `actions_per_success 1.33`, `p95_task_seconds 4.158`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Because this task records browser metadata instead of a content action, trace artifacts remain at 126 raw positive records from 79 tasks and 195 training records from 88 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 source body-text read coverage result:

- Added frozen `forms/read-source-body-text`, proving exact `gemma_read_page` body text reads on logical tab 103 expose source profile labels and values without leaking destination controls or pricing markup.
- The task complements the existing source page brief, body HTML read, and exact field reads with a one-action text-only content contract.
- Baseline local before the task stayed green at 95/95 with `actions_per_success 1.31` and `p95_task_seconds 0.005`; after adding the content-read task, local passed 96/96 with `actions_per_success 1.30` and `p95_task_seconds 0.005`.
- Real smoke passed 86/86 with `actions_per_success 1.16`, `p95_task_seconds 0.502`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent run discarded at 94/96 after model-backed semantic invoice/settings misses while the new source body-text contract passed.
- The real-agent retry passed 96/96 with `actions_per_success 1.32`, `p95_task_seconds 4.189`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 127 raw positive records from 80 tasks and 196 training records from 89 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 destination body-text read coverage result:

- Added frozen `forms/read-destination-body-text-initial`, proving exact `gemma_read_page` body text reads on logical tab 104 expose the initial destination form labels and options without leaking source profile values or pricing identifiers.
- The task complements the destination page brief, initial body HTML read, exact field reads after mutations, transfer-result body read, and source body-text read with a one-action text-only destination contract.
- Baseline local before the task stayed green at 96/96 with `actions_per_success 1.30` and `p95_task_seconds 0.005`; after adding the content-read task, local passed 97/97 with `actions_per_success 1.30` and `p95_task_seconds 0.006`.
- Real smoke passed 87/87 with `actions_per_success 1.16`, `p95_task_seconds 0.548`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; real agent passed 97/97 with `actions_per_success 1.32`, `p95_task_seconds 4.191`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 128 raw positive records from 81 tasks and 197 training records from 90 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 pricing body-text read coverage result:

- Added frozen `extraction/read-pricing-body-text`, proving exact `gemma_read_page` body text reads on logical tab 102 expose full pricing plan names and monthly prices without leaking HTML-only `data-plan` markup or unrelated form/billing controls.
- The task complements the pricing page brief, full body HTML read, scoped plan text reads, scoped plan HTML reads, and model-backed extraction contracts with a one-action full-page text contract.
- Baseline local before the task stayed green at 97/97 with `actions_per_success 1.30` and `p95_task_seconds 0.006`; after adding the content-read task, local passed 98/98 with `actions_per_success 1.30` and `p95_task_seconds 0.006`.
- Real smoke passed 88/88 with `actions_per_success 1.16`, `p95_task_seconds 0.547`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent run discarded at 93/98 after five screenshot tasks failed MCP `image/png` content assertions while the new pricing body-text contract passed.
- The real-agent retry passed 98/98 with `actions_per_success 1.32`, `p95_task_seconds 4.281`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 129 raw positive records from 82 tasks and 198 training records from 91 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 navigation body-text read coverage result:

- Added frozen `navigation/read-navigation-body-text`, proving exact `gemma_read_page` body text reads on logical tab 105 expose navigation link text and the scroll target without leaking HTML ids or unrelated fixture identifiers.
- The task complements the navigation page brief, body HTML read, isolated navigation body HTML read, exact link reads, scroll target read, clicks, active-tab, and screenshot contracts with a one-action full-page text contract.
- Baseline local before the task stayed green at 98/98 with `actions_per_success 1.30` and `p95_task_seconds 0.007`; after adding the content-read task, local passed 99/99 with `actions_per_success 1.29` and `p95_task_seconds 0.006`.
- Real smoke passed 89/89 with `actions_per_success 1.16`, `p95_task_seconds 0.548`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first two default real-agent runs discarded at 94/99 after five switched-tab screenshot tasks returned `image readback failed` while the new navigation body-text contract passed.
- An uncommitted screenshot retry helper was discarded after it did not resolve the persistent-profile screenshot failures; a fresh-profile diagnostic passed 99/99, so the generated `.browsers/gemma-gem-benchmark-profile` was reset.
- The default real-agent run on the recreated persistent profile passed 99/99 with `actions_per_success 1.31`, `p95_task_seconds 4.906`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 130 raw positive records from 83 tasks and 199 training records from 92 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 isolated navigation body-text read coverage result:

- Added frozen `navigation/read-isolated-navigation-body-text`, proving exact `gemma_read_page` body text reads on logical tab 106 expose isolated navigation link text and the scroll target without leaking HTML ids or unrelated fixture identifiers.
- The task complements the isolated navigation page brief, body HTML read, exact isolated billing-link read, isolated active-tab and screenshot contracts, and the main navigation body-text read with a one-action full-page text contract.
- Baseline local before the task stayed green at 99/99 with `actions_per_success 1.29` and `p95_task_seconds 0.006`; after adding the content-read task, local passed 100/100 with `actions_per_success 1.29` and `p95_task_seconds 0.005`.
- Real smoke passed 90/90 with `actions_per_success 1.16`, `p95_task_seconds 0.532`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`; the first real-agent run discarded at 98/100 after existing semantic invoice/settings agent misses while the new isolated body-text contract and all deterministic tasks passed.
- The real-agent retry passed 100/100 with `actions_per_success 1.31`, `p95_task_seconds 4.429`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 131 raw positive records from 84 tasks and 200 training records from 93 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 billing body-text read and runtime fallback result:

- Added frozen `semantic-buttons/read-billing-body-text`, proving exact `gemma_read_page` body text reads on logical tab 101 expose the invoice id, last-payment text, and three billing control labels without leaking HTML ids or unrelated fixture identifiers.
- The task complements the billing page brief, body HTML read, exact button reads, observed acts, text-like selector recovery, reranker checks, and model-backed semantic agent tasks with a one-action full-page text contract.
- Baseline local before the task stayed green at 100/100 with `actions_per_success 1.29` and `p95_task_seconds 0.005`; after adding the task, local passed 101/101 and real smoke passed 91/91 while preserving `selector_hit_rate 1.0000` and `timeout_rate 0.0000`.
- The first real-agent attempts discarded at 99/101 after `operation does not support unaligned accesses` model runtime errors in semantic invoice/settings tasks; the new billing body-text task and all deterministic billing read/act/recovery contracts passed in those runs.
- Extended the existing transient model runtime fallback to classify the unaligned-access ORT/WebGPU error, capture agent tool chunks, avoid duplicate fallback clicks when the model already emitted a `click_element` tool, and keep the bridge loopback-only with no new public tool surface.
- Post-fallback local passed 101/101 with `p95_task_seconds 0.005`, real smoke passed 91/91 with `p95_task_seconds 0.531`, and real agent passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 0.566`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 132 raw positive records from 85 tasks and 201 training records from 94 tasks; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 local runtime-fallback benchmark coverage result:

- Added optional per-mode task filtering to the benchmark runner and a frozen local-only `semantic-buttons/semantic-receipt-agent-runtime-error-after-click` task.
- The fake extension now deterministically emits a `click_element({"selector":"#download-receipt"})` agent chunk followed by `Something went wrong: operation does not support unaligned accesses`, proving the sidecar reports the already-executed selector without issuing a duplicate fallback `click_element` bridge request.
- Baseline local before the task stayed green at 101/101 with `actions_per_success 1.29` and `p95_task_seconds 0.005`; after adding the local-only task, local passed 102/102 with `actions_per_success 1.30`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.548`, and `timeout_rate 0.0000`, proving the local-only mode gate did not change deterministic real-extension coverage.
- The first real-agent run discarded at 99/101 after an existing semantic invoice model timeout; the retry passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 0.565`, `model_ready_status ready`, and `timeout_rate 0.0000`, proving the local-only task did not enter real-agent coverage.
- Trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks because the latest trace export follows the real-agent JSONL, where the local-only synthetic task is excluded; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 pre-click runtime-fallback benchmark coverage result:

- Added frozen local-only `semantic-buttons/semantic-receipt-agent-runtime-error-before-click`, completing deterministic benchmark coverage for the other unaligned-access recovery branch.
- The fake extension now can return `Something went wrong: operation does not support unaligned accesses` before emitting any internal click chunk, proving the sidecar ranks the receipt control from the page snapshot and issues exactly one fallback `click_element` request for `#download-receipt`.
- Baseline local before the task stayed green at 102/102 with `actions_per_success 1.30` and `p95_task_seconds 0.006`; after adding the task, local passed 103/103 with `actions_per_success 1.33`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.532`, and `timeout_rate 0.0000`, proving the local-only synthetic runtime task still does not affect deterministic real-extension coverage.
- Real agent passed 101/101 on the first run with `actions_per_success 1.31`, `p95_task_seconds 0.564`, `model_ready_status ready`, and `timeout_rate 0.0000`, proving the local-only task did not enter model-backed real-extension coverage.
- Trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks because the latest trace export follows the real-agent JSONL, where both local-only synthetic runtime tasks are excluded; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 invoice pre-click runtime-fallback benchmark coverage result:

- Added frozen local-only `semantic-buttons/semantic-invoice-agent-runtime-error-before-click`, proving the transient runtime fallback can recover the invoice-specific selector instead of defaulting to the receipt control.
- The fake extension now can return the unaligned-access runtime error for the invoice synthetic task before any internal click, and fake billing clicks return visible labels for receipt, invoice, and payment settings controls.
- Baseline local before the task stayed green at 103/103 with `actions_per_success 1.33` and `p95_task_seconds 0.005`; the first candidate discarded at 103/104 because the fake invoice click returned only `#download-invoice`, exposing a fixture fidelity gap rather than a selector failure.
- After making fake billing click labels match the real fixture, local passed 104/104 with `actions_per_success 1.36`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.547`, and `timeout_rate 0.0000`; real agent passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 4.130`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks because the latest trace export follows the real-agent JSONL, where the local-only synthetic runtime tasks are excluded; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 settings pre-click runtime-fallback benchmark coverage result:

- Added frozen local-only `semantic-buttons/semantic-settings-agent-runtime-error-before-click`, completing deterministic receipt/invoice/settings pre-click unaligned-access fallback coverage.
- The fake extension now can return the unaligned-access runtime error for the settings synthetic task before any internal click, proving the sidecar ranks the settings control and issues exactly one fallback `click_element` request for `#payment-settings`.
- Baseline local before the task stayed green at 104/104 with `actions_per_success 1.36` and `p95_task_seconds 0.006`; after adding the task, local passed 105/105 with `actions_per_success 1.38`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.548`, and `timeout_rate 0.0000`; real agent passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 0.566`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks because the latest trace export follows the real-agent JSONL, where the local-only synthetic runtime tasks are excluded; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 invoice after-click runtime-fallback benchmark coverage result:

- Added frozen local-only `semantic-buttons/semantic-invoice-agent-runtime-error-after-click`, extending the already-executed transient runtime fallback coverage from receipt to invoice.
- The fake extension now can emit a `click_element({"selector":"#download-invoice"})` agent chunk before returning the unaligned-access runtime error, proving the sidecar reports the already-executed invoice selector without issuing a duplicate fallback `click_element`.
- Baseline local before the task stayed green at 105/105 with `actions_per_success 1.38` and `p95_task_seconds 0.006`; after adding the task, local passed 106/106 with `actions_per_success 1.40`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.548`, and `timeout_rate 0.0000`; real agent passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 4.145`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks because the latest trace export follows the real-agent JSONL, where the local-only synthetic runtime tasks are excluded; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 3, 2026 settings after-click runtime-fallback benchmark coverage result:

- Added frozen local-only `semantic-buttons/semantic-settings-agent-runtime-error-after-click`, completing deterministic receipt/invoice/settings already-executed unaligned-access fallback coverage.
- The fake extension now can emit a `click_element({"selector":"#payment-settings"})` agent chunk before returning the unaligned-access runtime error, proving the sidecar reports the already-executed settings selector without issuing a duplicate fallback `click_element`.
- Baseline local before the task stayed green at 106/106 with `actions_per_success 1.40` and `p95_task_seconds 0.005`; after adding the task, local passed 107/107 with `actions_per_success 1.41`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.548`, and `timeout_rate 0.0000`; real agent passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 0.581`, `model_ready_status ready`, and `timeout_rate 0.0000`.
- Trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks because the latest trace export follows the real-agent JSONL, where the local-only synthetic runtime tasks are excluded; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 latest kept report section result:

- Added a generated `Latest Kept Runs By Suite` report section so coverage progress remains visible even when the older `Best Kept Runs By Suite` table still favors smaller historical suites with lower action count or latency.
- The report generator now reuses one suite-summary table renderer for both best-kept and latest-kept rows, while preserving the existing best-kept comparison logic and recent ledger tables.
- Baseline local before the report change stayed green at 107/107 with `actions_per_success 1.41` and `p95_task_seconds 0.006`; after adding the report section, local again passed 107/107 with `actions_per_success 1.41`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke remained 91/91 with `actions_per_success 1.15`, `p95_task_seconds 0.548`, and `timeout_rate 0.0000`; real agent passed 101/101 with `actions_per_success 1.31`, `p95_task_seconds 4.209`, `model_ready_status ready`, `model_load_seconds 0.533`, and `timeout_rate 0.0000`.
- The regenerated report now shows latest kept rows for `local-fake-extension` at 107 tasks, `real-chrome-extension-smoke` at 91 tasks, and `real-chrome-extension-agent` at 101 tasks; trace artifacts remained at 132 raw positive records from 85 tasks and 201 training records from 94 tasks, with preference/reranker pairs still 77 and learned LOTO/LOSO margins 12/10.

June 8, 2026 isolated settings-link read coverage result:

- Added frozen `navigation/read-isolated-settings-link-before-click`, proving exact `gemma_read_page` on logical tab 106 can read the isolated navigation fixture's settings link before the later billing-link click mutates that tab.
- The task completes exact pre-click isolated navigation link read coverage for both `#billing-link` and `#settings-link`, complementing the isolated page brief, body HTML/text reads, active-tab, screenshot, and click contracts.
- Baseline local before the task stayed green at 107/107 with `actions_per_success 1.41` and `p95_task_seconds 0.005`; after adding the task, local passed 108/108 with `actions_per_success 1.41`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 92/92 with `actions_per_success 1.15`, `p95_task_seconds 0.546`, and `timeout_rate 0.0000`; real agent passed 102/102 with `actions_per_success 1.30`, `p95_task_seconds 4.424`, `model_ready_status ready`, `model_load_seconds 0.055`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 133 raw positive records from 86 tasks and 202 training records from 95 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 isolated scroll-target read coverage result:

- Added frozen `navigation/read-isolated-scroll-target-before-click`, proving exact `gemma_read_page` on logical tab 106 can read the isolated navigation fixture's scroll target before the later billing-link click mutates that tab.
- The task completes exact isolated navigation selector read coverage for both links and the scroll target, complementing the isolated body HTML/text, active-tab, screenshot, and click contracts.
- Baseline local before the task stayed green at 108/108 with `actions_per_success 1.41` and `p95_task_seconds 0.005`; after adding the task, local passed 109/109 with `actions_per_success 1.40`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 93/93 with `actions_per_success 1.15`, `p95_task_seconds 0.501`, and `timeout_rate 0.0000`; real agent passed 103/103 with `actions_per_success 1.30`, `p95_task_seconds 4.205`, `model_ready_status ready`, `model_load_seconds 0.161`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 134 raw positive records from 87 tasks and 203 training records from 96 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 save-profile button read coverage result:

- Added frozen `forms/read-save-profile-button-before-click`, proving exact `gemma_read_page` can read the destination form submit button on tab 104 before the existing save-profile recovery click mutates `#save-result`.
- The first candidate was discarded at 109/110 because fake-extension `#save-profile` reads returned an empty field value; fixing the fake reader to return the fixture button label made the harness match the real content executor without weakening the text assertion.
- Baseline local before the task stayed green at 109/109 with `actions_per_success 1.40` and `p95_task_seconds 0.005`; after the harness fidelity fix, local passed 110/110 with `actions_per_success 1.40`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 94/94 with `actions_per_success 1.15`, `p95_task_seconds 0.498`, and `timeout_rate 0.0000`; real agent passed 104/104 with `actions_per_success 1.30`, `p95_task_seconds 4.142`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 135 raw positive records from 88 tasks and 204 training records from 97 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 save-result after-click read coverage result:

- Added frozen `forms/read-save-result-after-click`, proving exact `gemma_read_page` can read the destination form result immediately after the recovered save-profile click and before `transfer-profile-fields` rewrites the same result node.
- The task locks in the pre-transfer mutation state `Saved Grace Hopper Jr. <>`, complementing the prior save-button read and the later transferred-profile result read.
- Baseline local before the task stayed green at 110/110 with `actions_per_success 1.40` and `p95_task_seconds 0.005`; after adding the task, local passed 111/111 with `actions_per_success 1.40`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 95/95 with `actions_per_success 1.15`, `p95_task_seconds 0.499`, and `timeout_rate 0.0000`; real agent passed 105/105 with `actions_per_success 1.30`, `p95_task_seconds 4.260`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 136 raw positive records from 89 tasks and 205 training records from 98 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 empty destination-email read coverage result:

- Added frozen `forms/read-destination-email-empty-initial`, proving exact `gemma_read_page` can read an initially empty destination input by selector before any transfer task populates `#dest-email`.
- The task uses an exact empty `content` JSON-field assertion rather than visible-text matching, covering empty input reads while still requiring the selector, one `read_page_content` action, bridge selector propagation, and absence of later source values.
- Baseline local before the task stayed green at 111/111 with `actions_per_success 1.40` and `p95_task_seconds 0.005`; after adding the task, local passed 112/112 with `actions_per_success 1.39`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 96/96 with `actions_per_success 1.15`, `p95_task_seconds 0.498`, and `timeout_rate 0.0000`; real agent passed 106/106 with `actions_per_success 1.29`, `p95_task_seconds 0.606`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 137 raw positive records from 90 tasks and 206 training records from 99 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 empty destination-name read coverage result:

- Added frozen `forms/read-destination-name-empty-initial`, proving exact `gemma_read_page` can read the initially empty destination name input before the first text-selector recovery task mutates `#dest-name`.
- The task completes exact initial empty-read coverage for the destination form's two primary text inputs, using an empty `content` assertion plus selector, one-action trace, bridge selector, and absence checks for later typed/source values.
- Baseline local before the task stayed green at 112/112 with `actions_per_success 1.39` and `p95_task_seconds 0.005`; after adding the task, local passed 113/113 with `actions_per_success 1.39`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 97/97 with `actions_per_success 1.14`, `p95_task_seconds 0.500`, and `timeout_rate 0.0000`; real agent passed 107/107 with `actions_per_success 1.29`, `p95_task_seconds 4.330`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 138 raw positive records from 91 tasks and 207 training records from 100 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 empty destination-notes read coverage result:

- Added frozen `forms/read-destination-notes-empty-initial`, proving exact `gemma_read_page` can read the initially empty destination notes textarea before the first notes typing task mutates `#dest-notes`.
- The task completes exact initial empty-read coverage for the destination form's primary free-text controls, using an empty `content` assertion plus selector, one-action trace, bridge selector, and absence checks for later typed values.
- Baseline local before the task stayed green at 113/113 with `actions_per_success 1.39` and `p95_task_seconds 0.005`; after adding the task, local passed 114/114 with `actions_per_success 1.39`, `p95_task_seconds 0.006`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 98/98 with `actions_per_success 1.14`, `p95_task_seconds 0.499`, and `timeout_rate 0.0000`; real agent passed 108/108 with `actions_per_success 1.29`, `p95_task_seconds 0.602`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 139 raw positive records from 92 tasks and 208 training records from 101 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 initial destination-role read coverage result:

- Added frozen `forms/read-destination-role-initial`, proving exact `gemma_read_page` can read the untouched destination role select before any select task mutates `#dest-role`.
- The task covers the initial select-control state with `selected: Choose role ()`, requires the exact selector and one `read_page_content` action, and guards against already-selected Administrator/Reviewer state leaking from later tasks.
- Baseline local before the task stayed green at 114/114 with `actions_per_success 1.39` and `p95_task_seconds 0.005`; after adding the task, local passed 115/115 with `actions_per_success 1.38`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 99/99 with `actions_per_success 1.14`, `p95_task_seconds 0.499`, and `timeout_rate 0.0000`; real agent passed 109/109 with `actions_per_success 1.28`, `p95_task_seconds 4.288`, `model_ready_status ready`, `model_load_seconds 0.002`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 140 raw positive records from 93 tasks and 209 training records from 102 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

June 8, 2026 initial destination-updates read coverage result:

- Added frozen `forms/read-destination-updates-initial`, proving exact `gemma_read_page` can read the untouched destination updates checkbox before the first checkbox click mutates `#dest-updates`.
- The task covers the initial checkbox state with exact `content: unchecked`, requires the exact selector and one `read_page_content` action, and guards against leaking surrounding label/body text.
- Baseline local before the task stayed green at 115/115 with `actions_per_success 1.38` and `p95_task_seconds 0.005`; after adding the task, local passed 116/116 with `actions_per_success 1.38`, `p95_task_seconds 0.005`, `selector_hit_rate 1.0000`, and `timeout_rate 0.0000`.
- Real smoke passed 100/100 with `actions_per_success 1.14`, `p95_task_seconds 0.126`, and `timeout_rate 0.0000`; real agent passed 110/110 with `actions_per_success 1.28`, `p95_task_seconds 4.185`, `model_ready_status ready`, `model_load_seconds 0.001`, and `timeout_rate 0.0000`.
- Trace artifacts now cover 141 raw positive records from 94 tasks and 210 training records from 103 tasks because the new deterministic real-extension read enters the real-agent JSONL; preference/reranker pairs remain 77 with learned LOTO margin 12 and learned LOSO margin 10.

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
