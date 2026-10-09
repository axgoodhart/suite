# Fork Agent Guide (2.7.6 line)

Orientation for agents working on this fork's planned changes:

1. **Update to the latest Anthropic models** (small)
2. **Codex subscription support + local model support** (large)
3. **Remote control** (large, scope not yet decided)

Everything here describes the `2.7.6` branch (commit `2a79ba1`, the upstream `v2.7.6` release). File references use these prefixes:

- `BE/` → `apps/backend/`
- `FE/` → `apps/frontend/src/`

Line numbers are as of `2a79ba1`, so re-check them after edits land.

---

## 0. Branch context

| Branch | What it is |
|---|---|
| `2.7.6` | Upstream `main` at the v2.7.6 release. Python backend + Electron frontend. **This is the line being customized.** |
| `aperant` | Upstream `develop` (2.8.0-beta.6). A full TypeScript rewrite: no Python, Vercel AI SDK, `apps/desktop/`. Not merged with 2.7.6. Useful only as **reference code** (it already has Codex OAuth and Ollama). |

Read it with `git show origin/aperant:<path>`. Don't merge or cherry-pick across the two lines, because the directory layouts are unrelated.

The root `CLAUDE.md` on this branch was written for upstream. Its rules on i18n, platform abstraction and "investigate before speculating" still apply. Its rule "PR target = `develop` on AndyMik90/Auto-Claude" does **not** apply to this fork.

---

## 1. Architecture in one screen

```
Electron main (FE/main)
  ├─ AgentManager ── spawn(python, run.py / runners/*.py, env) ──► Python backend (BE)
  │     ▲ stdout lines: "__EXEC_PHASE__:{json}", "__TASK_EVENT__:{json}"
  │     ▲ files: .auto-claude/specs/<id>/implementation_plan.json, task_logs.json …
  ├─ TerminalManager ── node-pty ──► interactive `claude` CLI in user terminals
  ├─ ClaudeProfileManager / API profiles ── build env (tokens, base URL, model overrides)
  └─ ipc-handlers/* ◄── IPC ──► preload (window.electronAPI) ◄── React renderer

Python backend (BE)
  every agent ─► claude_agent_sdk.ClaudeSDKClient ─► spawns Claude Code CLI subprocess ─► Anthropic API
```

**The key fact for all three workstreams:** the backend never calls a model API itself. Every agent goes through `claude-agent-sdk`, which runs the **Claude Code CLI** as a subprocess. That CLI provides:

- the tool runtime (Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch/Task)
- the sandbox and permission rules
- PreToolUse hooks
- MCP hosting
- subagents
- structured output

### Where clients are created

| Factory | Location | Used by |
|---|---|---|
| `create_client()` | `BE/core/client.py:528-989` | Full agents. Options are built at L939-986. It writes `<project>/.claude_settings.json` (sandbox + permission allowlist) at L717-773. |
| `create_simple_client()` | `BE/core/simple_client.py:41-146` | Single-turn utilities. |

Call sites that bypass both factories and pass **no `env=`**:

- `BE/runners/insights_runner.py:204`
- `BE/runners/ai_analyzer/claude_client.py:112`
- `BE/integrations/linear/updater.py:132`
- `BE/runners/github/services/followup_reviewer.py:697-730` (direct `query()`)

The frontend also runs inline Python snippets that use the SDK:

- `FE/main/title-generator.ts:~380`
- `FE/main/terminal-name-generator.ts:~268`

And it calls the `claude` CLI directly:

- `FE/main/changelog/formatter.ts:353`
- `FE/main/changelog/version-suggester.ts:160`

### Other plumbing

- **Stream consumers** branch on SDK class names (`AssistantMessage`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ResultMessage`, `SystemMessage`). Main ones:
  - `BE/agents/session.py:442-727`
  - `BE/core/error_utils.py:133-188`
  - `BE/runners/github/services/sdk_utils.py:228-669`
- **SDK monkey-patch:** `BE/core/client.py:42-101` wraps `claude_agent_sdk._internal.message_parser.parse_message`, so unknown message types such as `rate_limit_event` don't crash the run. Any SDK upgrade must keep this working.
- **SDK pin mismatch:** `BE/requirements.txt:5` says `claude-agent-sdk>=0.1.39`, but `BE/pyproject.toml:9` says `>=0.1.25`.

---

## 2. Workstream: update to the latest Anthropic models

### Current state

| Alias | Full ID |
|---|---|
| `opus`, `opus-1m` | `claude-opus-4-6` |
| `opus-4.5` | `claude-opus-4-5-20251101` |
| `sonnet` | `claude-sonnet-4-5-20250929` |
| `haiku` | `claude-haiku-4-5-20251001` |

`opus-1m` also adds the beta `context-1m-2025-08-07`.

### Target models (Anthropic list as of 2026-10)

| Model | ID | Context | $/MTok in / out | Notes |
|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 1M | 10 / 50 | Most capable; thinking always on |
| Claude Opus 5.5 | `claude-opus-5-5` | 1M | 4 / 20 | Current Opus; effort default `medium` |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 1M | 2 / 10 | Current Sonnet; effort default `high` |
| Claude Haiku 5.5 | `claude-haiku-5-5` | 1M | 0.10 / 0.50 | Current Haiku; prices above are for prompts ≤100K tokens |

These IDs take **no date suffix**. Verify them against the Models API (`GET /v1/models`) before committing, since the list changes.

API behaviour that matters here:

- On all four models, fixed thinking budgets (`budget_tokens`) are **rejected** by the API. Thinking is adaptive and controlled by **effort** (`low` / `medium` / `high` / `xhigh` / `max`).
- 1M context is standard on all four, so the `opus-1m` alias and its `context-1m-2025-08-07` beta are probably unnecessary for new models. Check before removing them.

The app doesn't call the API itself. It passes `max_thinking_tokens` and the env var `CLAUDE_CODE_EFFORT_LEVEL` to the Claude Code CLI, and the CLI builds the request. So the main prerequisite is:

> **Bump `claude-agent-sdk`** (which bundles the CLI) to a version that knows these models. Then confirm how that CLI version treats `max_thinking_tokens` on adaptive-only models before relying on the existing budget plumbing.

### Sources of truth (they must stay in sync)

**Backend: `BE/phase_config.py`**

- L19-25 `MODEL_ID_MAP`, L29-31 `MODEL_BETAS_MAP`, L35-39 `THINKING_BUDGET_MAP` (1024 / 4096 / 16384), L43 `EFFORT_LEVEL_MAP`.
- L47 `ADAPTIVE_THINKING_MODELS = {"claude-opus-4-6"}`. This is keyed on **full ID**. Only models in this set get `effort_level` (L410-443).
- L69-81 `DEFAULT_PHASE_MODELS` / `DEFAULT_PHASE_THINKING`.
- L112-148 `resolve_model_id()`:
  - The env vars `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` override the **shorthand** only.
  - Full IDs pass through unchanged.
  - `opus-4.5` is deliberately not overridable.
- L151-164 `get_model_betas()`: looks up the shorthand only, so a full ID returns `[]`.

**Frontend: `FE/shared/constants/models.ts`**

- L12-18 `AVAILABLE_MODELS` (UI labels), L22-28 `MODEL_ID_MAP`.
- Agent-profile presets at L56-113 (auto / complex / balanced / quick); defaults at L116-141; `DEFAULT_AGENT_PROFILES` at L155-196.
- L199 `FAST_MODE_MODELS`.
- L202 `ADAPTIVE_THINKING_MODELS = ['opus','opus-1m']`. This is keyed on **shorthand**, unlike the backend.

**Alias type unions** (add new aliases here):

- `FE/shared/types/settings.ts:161-201`
- `FE/shared/types/task.ts:157,167,236`
- `FE/main/agent/types.ts:58-72`
- `FE/shared/types/insights.ts:165`
- `FE/shared/types/profile.ts:19-30` (API profile model slots: default / haiku / sonnet / opus only)

**Utility model:** `BE/core/model_config.py:15` sets `DEFAULT_UTILITY_MODEL`, which can be overridden with the env vars `UTILITY_MODEL_ID` / `UTILITY_THINKING_BUDGET`.

### Hard-coded full IDs outside the maps

| Location | Hard-coded ID or value |
|---|---|
| `BE/core/simple_client.py:43` | Haiku 4.5 |
| `BE/core/workspace.py:1704-1707` | `MERGE_FAST_MODEL` (Haiku 4.5), `MERGE_CAPABLE_MODEL` (Sonnet 4.5), thinking budgets 1024 / 16000 |
| `BE/core/workspace.py:2005-2040` | Haiku → Sonnet retry tier |
| `BE/analysis/insight_extractor.py:38` | Haiku 4.5 (comment says "Haiku does not support extended thinking") |
| `BE/runners/github/runner.py:692` | Sonnet 4.5 |
| `BE/runners/github/services/review_tools.py:77,170,256` | Sonnet 4.5 |
| `BE/runners/gitlab/runner.py:283` | Sonnet 4.5 |
| `BE/runners/gitlab/models.py:211` | Sonnet 4.5 |
| `FE/main/ipc-handlers/github/autofix-handlers.ts:141,152` | Sonnet 4.5 |
| `FE/main/ipc-handlers/gitlab/autofix-handlers.ts:89,101` | Sonnet 4.5 |
| `FE/main/title-generator.ts:387` | `claude-haiku-4-5` |
| `FE/main/terminal-name-generator.ts:268` | `claude-haiku-4-5` |
| `FE/main/changelog/*` | `--model haiku` |
| `BE/integrations/graphiti/config.py:129,149` | Memory LLM defaults |

### Other places to update

- **Cost table:** `BE/runners/github/rate_limiter.py:162-175` (`AI_PRICING`). Exact-match lookup, so unknown IDs fall back to `"default"`. Its Opus and Haiku prices are already stale.
- **Display-name parsing:** `BE/runners/github/services/sdk_utils.py:29-75`. Substring matches on 4.x names; new versions fall through to a generic label.
- **UI text:**
  - `FE/shared/i18n/locales/{en,fr}/settings.json:104-111,171,202,403-405`
  - `FE/shared/i18n/locales/{en,fr}/tasks.json:258-260` ("Same Opus 4.6 model with faster output")
  - `FE/renderer/components/task-detail/TaskLogs.tsx:67-73` (`MODEL_SHORT_LABELS`)
- **Docs and env examples:**
  - `BE/.env.example:35-36,222-223`
  - `FE/main/ipc-handlers/env-handlers.ts:97,238,404-405`
  - `guides/CLI-USAGE.md:196`
  - `BE/prompts/github/pr_orchestrator.md:203-215` (mentions "Sonnet 4.5")

### How the selected model reaches the backend

| Feature | How the model is passed |
|---|---|
| Build (`run.py`) | Phase models/thinking are saved to `specs/<id>/task_metadata.json` (`FE/main/ipc-handlers/task/crud-handlers.ts:22-38, 288-293`). The backend reads them through `phase_config.get_phase_*`. `run.py` gets no `--model`. |
| Spec / roadmap / ideation | Shorthand passed as `--model`, plus `--thinking-level` (`FE/main/agent/agent-manager.ts:308-317`, `FE/main/agent/agent-queue.ts:233-236, 309-312`). |
| Insights, GitHub PR / issues, GitLab MR, utility | The **frontend converts to the full ID** before passing it (`insights-executor.ts:115`, `github/pr-handlers.ts:1433`, `triage-handlers.ts:206`, `gitlab/mr-review-handlers.ts:157`, `task/worktree-handlers.ts:116-131`). |

### Existing bugs to fix during the update

These cause a model to silently lose its beta header, its effort setting, or its API-profile override:

- **a.** `BE/runners/spec_runner.py:279` resolves to a full ID before the orchestrator runs. As a result, `spec/pipeline/agent_runner.py:134` `get_model_betas(full_id)` returns `[]`.
- **b.** Wherever the frontend converts to a full ID (row 3 of the table above), betas are lost and `ANTHROPIC_DEFAULT_*_MODEL` overrides are bypassed.
- **c.** `BE/runners/roadmap/executor.py:130` passes the raw `--model` shorthand to `create_client`. It doesn't call `resolve_model_id`, and it passes no betas and no effort. `opus-1m` / `opus-4.5` would reach the CLI as invalid names.
- **d.** These pass a thinking budget only (no effort), or no thinking kwargs at all:
  - `BE/runners/github/services/followup_reviewer.py:698-703`
  - `BE/runners/github/services/parallel_orchestrator_reviewer.py:1165-1168`
  - `BE/runners/github/services/parallel_followup_reviewer.py:1155-1163`
- **e.** Backend `DEFAULT_PHASE_THINKING` (planning / qa = `high`) doesn't match the frontend Balanced profile (all `medium`).

**Recommended shape:**

- Keep shorthands end-to-end and resolve only in Python.
- Replace the full-ID `ADAPTIVE_THINKING_MODELS` check with a capability check that covers all current models (adaptive-only).

### Tests that pin model IDs

- **Main backend test:** `tests/test_model_resolution.py`.
  - L196, 278-279, 326-327 assert that source files *don't* contain the literal Sonnet 4.5 ID.
  - L345-513 cover betas, adaptive thinking and effort.
- **Other backend tests:**
  - `tests/test_thinking_level_validation.py:81-83`
  - `tests/agents/test_agent_configs.py:63-65,217-221`
  - `tests/test_spec_pipeline.py:206-209`
  - `BE/core/workspace/tests/test_merge.py:1263-1476`
  - `BE/integrations/graphiti/tests/*`
- **Frontend tests:**
  - `FE/renderer/components/__tests__/AgentTools.test.tsx`
  - `FE/renderer/components/settings/ModelSearchableSelect.test.tsx`
  - `FE/main/agent/agent-process.test.ts:236-251,873,893`
  - `FE/main/services/**/profile-service.test.ts`
  - `FE/main/claude-code-settings/__tests__/*`
- **Not tested:** `AI_PRICING` and `_short_model_name` have no tests.

---

## 3. Workstream: Codex subscription + local models

### The core constraint

Because the backend runtime is the Claude Code CLI, a non-Anthropic provider has two possible routes.

**(A) Anthropic-compatible endpoint (low effort).**

- The existing **API Profiles** feature already points the CLI at any `ANTHROPIC_BASE_URL`, with a token and model remaps.
- Everything is kept: tools, sandbox, hooks, MCP, subagents, structured output.
- The endpoint must speak the Anthropic Messages API, including `tool_use` and streaming.
- For **local** models, this may work if the local server offers an Anthropic-compatible endpoint, or if a translating proxy such as LiteLLM sits in front. *Unverified; test it first.*
- For **Codex**, the ChatGPT subscription endpoint is OpenAI **Responses API** only. Route A therefore needs a local translating proxy (Anthropic Messages in, Responses out, using Codex OAuth tokens).

**(B) A provider-neutral agent loop in Python (high effort).**

- Write a loop that calls OpenAI / Codex / Ollama directly.
- It must re-implement:
  - the tools under the **same names** (Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch/Task), because prompts reference them, e.g. `BE/prompts/coder.md:502` "Use the Task tool"
  - path containment and the sandbox
  - the MCP client (including the in-process `auto-claude` server's tools)
  - structured output (`ResultMessage.structured_output`)
  - subagents (`AgentDefinition` in `parallel_orchestrator_reviewer.py:283-390`)
- It must emit objects shaped like the SDK messages (see section 1), or every consumer has to change.
- The security hook `BE/security/hooks.py:20` `bash_security_hook` is a plain async function and can be called directly.
- The `aperant` branch is a complete worked example of route B, in TypeScript:
  - tools: `ai/tools/builtin/*`
  - security: `ai/security/*`
  - session runner: `ai/session/runner.ts`

**Decide between A and B before writing code.** Route A with a proxy is much smaller, but it relies on a component outside this repo.

### Backend auth gates (Anthropic-only today)

**`BE/core/auth.py`:**

- **Accepted tokens** (`AUTH_TOKEN_ENV_VARS`, L40-43): `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`. `ANTHROPIC_API_KEY` is deliberately ignored.
- **Pass-through env vars** (`SDK_ENV_VARS`, L47-67) for the CLI subprocess.
- **Token precedence** in `get_auth_token()` (L673-767): env vars → `CLAUDE_CONFIG_DIR` credentials file → profile keychain entry → default keychain.
- **Prefix checks:** tokens must start with `sk-ant-oat01-` (L467, 501, 524, 598, 661).
- **`configure_sdk_authentication()`** (L981-1047): a non-empty `ANTHROPIC_BASE_URL` means "API profile mode" and requires `ANTHROPIC_AUTH_TOKEN`.

**Build gate:** `BE/cli/utils.py:166` aborts with "No OAuth token found".

**Per-runner token checks:**

- `commit_message.py:199`
- `insights_runner.py:153`
- `merge/ai_resolver/claude_client.py:42`
- `analysis/insight_extractor.py:52,357`
- `core/workspace.py:1985`
- `spec/compaction.py:37`
- `runners/ai_analyzer/claude_client.py:44`
- `integrations/linear/updater.py:123`
- `runners/github/batch_issues.py:148`

### Frontend touch points

**Env building** (env layers are applied in order; later layers win):

- `FE/main/agent/agent-process.ts:176-269` `setupProcessEnvironment`, and `:650-703` `spawnProcess` (`{...env, ...pythonEnv, ...oauthModeClearVars, ...apiProfileEnv}`).
- `FE/main/agent/env-utils.ts:104-126` `getOAuthModeClearVars` blanks all `ANTHROPIC_*` vars when no API profile is active.
- The same pattern is repeated in:
  - `agent-queue.ts:355-362, 694-701`
  - `insights/config.ts:113-116`
  - `ipc-handlers/github/utils/runner-env.ts:37-40`
  - `title-generator.ts:159-182`
  - `ipc-handlers/task/worktree-handlers.ts:2043,2625,3263`
  - `changelog/*`

**API profiles:**

- `FE/main/services/profile/profile-service.ts:247-290` `getAPIProfileEnv()`.
- Stored in `userData/auto-claude/profiles.json`. The `apiKey` appears to be stored in plaintext.
- Validation requires a key of at least 12 characters (L51-70), so a local server needs a dummy key.
- The connection test and model discovery use `@anthropic-ai/sdk` `models.list` (L405, 568), which may fail against local servers.
- Presets live in `FE/shared/constants/api-profiles.ts`. The `groq` preset points at an OpenAI-protocol URL that the CLI can't use.

**Claude OAuth profiles:**

- `FE/main/claude-profile-manager.ts` (`getActiveProfileEnv` at L541-583, `getProfileEnv` at L831).
- The `FE/main/claude-profile/*` modules (usage monitor, scorer, token refresh, keychain `credential-utils.ts`).

**Account model:**

- `FE/shared/types/unified-account.ts` (`'oauth' | 'api'`)
- `FE/shared/utils/provider-detection.ts` (`ApiProvider`)
- `FE/main/claude-profile/usage-monitor.ts:53-110` (per-provider usage endpoints)

**Profile selection and swapping:**

- `FE/main/rate-limit-detector.ts:476` `getBestAvailableProfileEnv()`
- Reactive swap at `agent-process.ts:305-356`
- Codex and local accounts must be **excluded from Claude profile swapping**.

**Pre-flight auth checks:**

- `agent-manager.ts:355`
- `ipc-handlers/task/execution-handlers.ts:167` (`hasValidAuth()`)

**UI:**

- `FE/renderer/components/settings/AccountSettings.tsx`, `ProfileEditDialog.tsx`
- `FE/renderer/components/onboarding/AuthChoiceStep.tsx`, `OnboardingWizard.tsx`
- New text goes into **both** `en` and `fr` locale files.

**Terminals:** `FE/main/terminal/claude-integration-handler.ts` hard-codes the `claude` CLI. A Codex terminal would be a separate launch path (e.g. the `codex` CLI).

### Error and rate-limit handling is keyed on Anthropic/CLI text

- `BE/core/error_utils.py:22-130`
- `BE/runners/github/services/sdk_utils.py:153-225`
- `BE/agents/coder.py:290-354` (parses "resets at …")
- `FE/main/rate-limit-detector.ts:14-60`
- `FE/main/terminal/output-parser.ts`

Each new provider needs its own classification.

### Existing non-Anthropic code (memory system only)

- `BE/integrations/graphiti/config.py:159-230` and `providers_pkg/*`: OpenAI, Azure, OpenRouter, Ollama and Google wrappers for **Graphiti entity extraction**. These are not chat or tool-calling clients, so their reuse value is limited to the config shape.
- `BE/ollama_model_detector.py`: a JSON CLI (`check-status`, `list-models`, `pull-model`) already wired to the frontend (`FE/main/ipc-handlers/memory-handlers.ts:200-287`). It can be reused as-is to list local models in a model picker.
- The frontend already stores `ollamaBaseUrl` and `globalOpenAIApiKey` (`FE/main/memory-env-builder.ts:19-82`).
- There are no references to LM Studio.

### Codex reference implementation (`origin/aperant`)

**OAuth login:** `apps/desktop/src/main/ai/auth/codex-oauth.ts`

- PKCE flow against `https://auth.openai.com/oauth/{authorize,token}`.
- Client id `app_EMoamEEZ73f0CkXaXp7hrann`; scopes `openid profile email offline_access`.
- The callback is a local server on `127.0.0.1:1455/auth/callback`.
- Extra auth parameters: `codex_cli_simplified_flow=true`, `originator=…`.
- Tokens are stored in `userData/codex-auth.json` (mode 0600) and refreshed when less than 5 minutes remain. Refresh-token rotation is handled.

**Request path:** `apps/desktop/src/main/ai/providers/oauth-fetch.ts`

- Rewrites OpenAI URLs to `https://chatgpt.com/backend-api/codex/responses`.
- Sets `Authorization: Bearer <access_token>`.
- The official Codex CLI is reported to also send `chatgpt-account-id` and other headers. *Unverified; test against the live endpoint.*

**Request quirks** (`ai/session/runner.ts:337-381`):

- The system prompt goes into `instructions`, and `store: false` is set.
- Inactivity timeouts handle streams that never start.
- Structured output is never combined with tools.

**Model list** (`apps/desktop/src/shared/constants/models.ts:47-53, 286-290, 407-479`):

- Codex-capable models, alias equivalences (e.g. opus → codex flagship), and `apiKeyOnly` flags.
- The model names there will be out of date; refresh them.

**Ollama** (`ai/providers/factory.ts:144-157`): OpenAI-compatible client at `<base>/v1`, with the dummy key `ollama`.

---

## 4. Workstream: remote control

**Scope is not defined yet.** Ask the owner which they mean before designing anything:

- (i) monitor and steer the desktop app's tasks from a phone or browser,
- (ii) run the backend headless on a server, or
- (iii) attach to agent terminals remotely.

### What exists

No HTTP or WebSocket server exists, and there are no deep links, single-instance lock, webhook receivers, or chat-bot or tunnel integrations. The only network-facing pieces:

- **Chromium debug port 9222** (`npm run dev:mcp`), for QA via `electron-mcp-server`. Local only, no authentication.
- **A dormant PTY daemon** on a Unix socket (`FE/main/terminal/pty-daemon.ts`; it isn't built by `electron.vite.config.ts`). Its multi-client `subscribe` design is prior art for remote terminal attach.

### Seams to build on

**Events out:**

- `AgentManager` (EventEmitter): `log`, `execution-progress`, `task-event`, `exit`, `sdk-rate-limit`, `auth-failure`, `roadmap-*`, `ideation-*`. Wired to the renderer in `FE/main/ipc-handlers/agent-events-handlers.ts`.
- `fileWatcher` `progress`.
- `taskLogService` `logs-changed` / `stream-chunk`.
- `taskStateManager` status changes (XState, `FE/main/task-state-manager.ts`).
- `usageMonitor` events.
- PTY `onData` (`FE/main/terminal/pty-manager.ts:204-227`).

**Commands in:**

- `agentManager.startSpecCreation` / `startTaskExecution` / `killTask` (`FE/main/agent/agent-manager.ts:224, 340, 489`).
- `terminalManager.create` / `write` / `resize` / `invokeClaudeAsync`.
- File signals in the spec dir, all safe to drive remotely:
  - `PAUSE`, `RESUME`, `HUMAN_INPUT.md`
  - see `BE/agents/base.py:30-43` and `FE/main/ipc-handlers/task/execution-handlers.ts:875-909`

**IPC surface:**

- About 426 channels in `FE/shared/constants/ipc.ts`.
- About 325 handlers registered inline in `FE/main/ipc-handlers/**`. There is no central dispatch table.
- The typed contract is `ElectronAPI` in `FE/shared/types/ipc.ts:179`.

**Browser-ready UI:** `FE/renderer/lib/browser-mock.ts` already lets the React app run outside Electron with a mocked `electronAPI`. A remote web client could replace the mock with a WebSocket-backed implementation of the same `ElectronAPI` interface.

**Headless option:** drive `BE/run.py` and `BE/runners/*.py` directly (flags in `guides/CLI-USAGE.md`). Progress comes from the stdout markers (`__EXEC_PHASE__:`, `__TASK_EVENT__:`; protocol in `FE/shared/constants/phase-protocol.ts` and `BE/core/phase_event.py`, `BE/core/task_event.py`) plus the JSON files under `.auto-claude/specs/<id>/`.

### Blockers

- Closing the main window kills every agent (`FE/main/index.ts:332-336`). On non-macOS, the app quits when all windows close (L601).
- `TASK_START` returns early when there is no main window (`execution-handlers.ts:114-118`).
- About 82 direct `webContents.send` calls in 22 files bypass `safeSendToRenderer` (`FE/main/ipc-handlers/utils.ts:89`). Remote clients need a single fan-out point.
- There is no authentication or pairing concept. Anything that listens on the network must add it. Agents run with Bash access, so an unauthenticated endpoint is remote code execution.

---

## 5. Build, run, test

**Requirements:** Python **3.12+** (CI runs 3.12 and 3.13; the bundled runtime is 3.12.8), Node ≥24, npm ≥10.

| Task | Command |
|---|---|
| Install everything | `npm run install:all` (creates `apps/backend/.venv`, then installs the frontend) |
| Run (dev) | `npm run dev` |
| Run (debug) | `npm run dev:debug` |
| Run with debug port 9222 | `npm run dev:mcp` |
| Backend tests | `npm run test:backend`, or `apps/backend/.venv/bin/pytest tests/ -v` |
| Frontend unit tests | `cd apps/frontend && npm test` (Vitest) |
| Frontend E2E tests | `cd apps/frontend && npm run test:e2e` (Playwright) |
| Lint / typecheck | `cd apps/frontend && npm run lint` (Biome), `npm run typecheck` |

Path resolution differs between dev and packaged builds:

- **Backend location** (`agent-process.ts:459-488`): `process.resourcesPath/backend` when packaged, `apps/backend` in dev.
- **Python** (`FE/main/python-env-manager.ts`): bundled `resources/python` when packaged, `apps/backend/.venv` in dev.

Check both cases for any path you add.

---

## 6. Open questions for the owner

1. **Codex:** route A (translating proxy + API Profiles) or route B (native Python agent loop)?
2. **"Local support":** local models (Ollama / LM Studio) for the agents? Or running the Codex CLI locally?
3. **Remote control:** which of (i), (ii) or (iii) in section 4? From which devices, and over what network (LAN, tunnel, relay)?
4. **Models:** which models should each agent profile (auto / complex / balanced / quick) map to? Should `opus-4.5` / `opus-1m` be dropped?
