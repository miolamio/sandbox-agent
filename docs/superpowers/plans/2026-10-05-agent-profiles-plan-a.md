# Agent Profiles, план A (этапы 1-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Честно задокументировать и пометить deprecated `/v1/config/mcp|skills`, затем добавить серверные профили агента (модель, `extends`, хранение, HTTP, CLI, `--profiles`), применение `process.env` при запуске агента и подстановку `session.*` в создание и восстановление сессий, с поддержкой в TS SDK.

**Architecture:** Новый модуль `server/packages/sandbox-agent/src/profiles/` (модель, слияние, capability, секреты, перевод `session.*` в запрос агента, хранилище). `AppState` держит `Arc<ProfileStore>`, отдаёт его HTTP-обработчикам `/v1/config/profiles` и `AcpProxyRuntime`. Прокси при первом POST с `?profile=` поднимает процесс с env профиля, закрепляет профиль за `server_id` и на `session/new|load|resume` подмешивает `session.*` в `mcpServers` и `_meta`. TS SDK ключует live-соединения по паре (agent, profile) и хранит в persist только имя профиля.

**Tech Stack:** Rust (axum 0.7, utoipa 4.2, serde, thiserror, clap), TypeScript (vitest, openapi-typescript), Docker-тесты (`docker/test-agent/Dockerfile`), mock-агент (`sandbox-agent mock-agent-process` и node-mock из `sdks/typescript/tests/helpers/mock-agent.ts`).

**Spec:** `docs/superpowers/specs/2026-10-05-agent-profiles-design.md`. Тикеты: SBA-89 (docs), SBA-87 (профили процесса, capability), SBA-86 (уровень сессии Claude), SBA-73, SBA-77.

---

## Общие правила для исполнителей

- Перед работой прочитать `CLAUDE.md`, `server/CLAUDE.md`, `sdks/CLAUDE.md`.
- Все Rust-команды запускать с `SANDBOX_AGENT_SKIP_INSPECTOR=1`.
- Docker-тесты (`--test v1_api`, TS integration) сами собирают образ `docker/test-agent/Dockerfile` из текущего дерева. Первый запуск долгий (несколько минут). Docker должен работать.
- Перед TS-тестами всегда:
  ```bash
  pnpm --filter @sandbox-agent/cli-shared build && pnpm --filter acp-http-client build
  SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent
  SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test -t "<фильтр>"
  ```
- Pre-commit (lefthook) форматирует staged-файлы (`rustfmt`, `biome`). Если хук переформатировал файлы, `git add` их и повторить коммит.
- В `docs/**/*.mdx` нельзя писать "ACP", имена протокольных методов и длинное тире.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Параллельные задачи запускать в отдельных git worktree (`isolation: "worktree"`), сливать по одной в порядке номеров. Не больше 3 параллельных сессий.

## Граф зависимостей

```
T1 ─────────────────────────────────────────────────────────────┐
T2 ── T4 ──┬── T5 ──┐                                             │
           ├── T6 ──┼── T7 ── T8 ──┬── T9 ───────────────────┐    │
           └── T11 ─┼──────────────┼───────────┐             │    │
T3 ─────────────────┴──────────────┴── T10 ── T12 ──┐        │    │
                                   T8,T10 ── T13 ───┴── T14 ─┴─┬── T15
                                                               └── T16
```

| Волна | Задачи | Режим |
|---|---|---|
| 1 | T1, T2, T3 | параллельно (разные файлы: docs+router.rs+client.ts / error crate / cli.rs mock+tests) |
| 2 | T4 | последовательно (нужен T2) |
| 3 | T5, T6, T11 | параллельно (каждая добавляет свой файл в `profiles/` и строки в `profiles/mod.rs`; конфликт слияния только в `mod.rs`, оставить строки всех трёх задач. `router.rs` и `router/types.rs` правит только T5) |
| 4 | T7 | последовательно (нужны T5, T6) |
| 5 | T8 | последовательно (нужен T7) |
| 6 | T9, T10 | параллельно (T9 только `cli.rs`; T10 `acp_proxy_runtime.rs`, `router.rs`, `router/types.rs`, тесты; нужен T3) |
| 7 | T12, T13 | параллельно (T12 прокси и Rust-тесты; T13 `openapi-gen/build.rs`, OpenAPI, TS SDK, inspector) |
| 8 | T14 | последовательно (нужны T12, T13) |
| 9 | T15, T16 | параллельно (examples+inspector persist / docs) |

## Карта файлов

Создать:
- `server/packages/sandbox-agent/src/profiles/mod.rs`: объявления подмодулей и реэкспорты.
- `server/packages/sandbox-agent/src/profiles/model.rs`: `AgentProfile` и вложенные типы, проверки имени и формы, конструкторы ошибок.
- `server/packages/sandbox-agent/src/profiles/merge.rs`: слияние `extends` по таблице spec, разбор `extends`, разворот цепочки.
- `server/packages/sandbox-agent/src/profiles/capability.rs`: `AgentCustomization` по агентам, список неподдерживаемых полей.
- `server/packages/sandbox-agent/src/profiles/secrets.rs`: маскирование `***`, восстановление прежних значений.
- `server/packages/sandbox-agent/src/profiles/session.rs`: перевод `session.*` в параметры `session/new|load|resume`.
- `server/packages/sandbox-agent/src/profiles/store.rs`: state-каталог, `ProfileStore` (диск + файл `--profiles`), атомарная запись.
- `server/packages/sandbox-agent/tests/openapi_deprecated.rs`: проверка флага deprecated в OpenAPI.
- `server/packages/sandbox-agent/tests/agent_customization.rs`: in-process проверка поля `customization` в `/v1/agents/:agent`.
- `server/packages/sandbox-agent/tests/profiles_http.rs`: in-process тесты HTTP `/v1/config/profiles`.
- `server/packages/sandbox-agent/tests/v1_api/mock_agent.rs`: Docker-тест хука `mock/env`.
- `server/packages/sandbox-agent/tests/v1_api/profiles.rs`: Docker-тесты применения профиля (env, 409, stale, `session.*`).
- `docs/agent-profiles.mdx`: страница docs о профилях.

Изменить:
- `server/packages/error/src/lib.rs`: `ErrorType` и `SandboxError` для `profile_mismatch`, `profile_read_only`, `profile_invalid`.
- `server/packages/sandbox-agent/src/lib.rs`: `pub mod profiles;`.
- `server/packages/sandbox-agent/src/router.rs`: deprecated на config/mcp|skills, `AppState.profiles`, обработчики профилей, `ApiDoc`, `?profile=` в `post_v1_acp`, поля в `get_v1_acp_servers`, `customization` в `AgentInfo`.
- `server/packages/sandbox-agent/src/router/types.rs`: `AgentInfo.customization`, `AcpPostQuery.profile`, `AcpServerInfo.profile|profileStale`, ответы профилей.
- `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`: профиль при создании процесса, закрепление, 409, stale, подстановка `session.*`.
- `server/packages/sandbox-agent/src/cli.rs`: хук `mock/env`, флаг `--profiles`, `profiles list|get|put|delete`, `api acp post --profile`.
- `server/packages/openapi-gen/build.rs`: rerun при изменении любого файла `src/`.
- `server/packages/sandbox-agent/tests/v1_api.rs`: регистрация модулей `mock_agent`, `profiles`.
- `docs/openapi.json`, `sdks/typescript/src/generated/openapi.ts`: перегенерация.
- `sdks/typescript/src/client.ts`, `sdks/typescript/src/types.ts`, `sdks/typescript/src/index.ts`: методы профилей, опция `profile`, `SessionRecord.profile`, `@deprecated` у config mcp/skills.
- `sdks/typescript/tests/helpers/mock-agent.ts`: хуки `_mock/env`, `_mock/received`.
- `sdks/typescript/tests/integration.test.ts`: describe "Integration: agent profiles".
- `frontend/packages/inspector/src/App.tsx`, `frontend/packages/inspector/src/components/debug/AgentsTab.tsx`: поле `customization` в заглушках `AgentInfo`.
- `frontend/packages/inspector/src/persist-indexeddb.ts`, `examples/persist-sqlite/src/persist.ts`, `examples/persist-postgres/src/persist.ts`: колонка/поле `profile`.
- `docs/mcp-config.mdx`, `docs/skills-config.mdx`, `docs/custom-tools.mdx`, `docs/cli.mdx`, `docs/sdk-overview.mdx`, `docs/docs.json`, `frontend/packages/website/docs.config.mjs`.
- `research/acp/friction.md`: запись о решениях.

## Отклонения от spec

1. **State-каталога у сервера нет.** Есть только `daemon_state_dir()` (`<data_dir>/sandbox-agent/daemon`, файлы pid/log/version) и каталог установки `<data_dir>/sandbox-agent/bin`. Вводится `server_state_dir()`: `$SANDBOX_AGENT_STATE_DIR`, иначе `<data_dir>/sandbox-agent/state`. Профили лежат в `<state>/profiles/<agent>/<name>.json`. Флага CLI для каталога нет, только env. В Docker-тестах `data_dir` = `$XDG_DATA_HOME` из временного каталога теста, поэтому тесты изолированы.
2. **Capability `customization` перенесена из этапа 3 в этап 2** (T5 до T7): проверка неподдерживаемых полей при PUT нужна ядру.
3. **Поддержка полей в плане A урезана.** `process.args` и `process.config` не поддерживает ни один агент (этап 5). `session.skills` не поддерживает ни один агент, пока на этапе 4 не проверено, принимает ли их `claude-agent-acp`. `systemPrompt`, `plugins`, `pluginConfigs` поддерживают только `claude` и `mock`. `process.env` и `session.mcpServers` поддерживают все агенты. Поля модели при этом принимаются парсером, PUT отвечает 400 со списком полей.
4. **`mock` переводит `session.*` так же, как Claude**, чтобы интеграционные тесты видели `_meta` в эхо-ответе встроенного mock и в node-mock TS-тестов.
5. **Форма `_meta` для Claude предварительная:** `systemPrompt` replace → строка `_meta.systemPrompt`, append → `{"append": text}`; `plugins` → `_meta.claudeCode.options.plugins = [{"type":"local","path"}]`; `pluginConfigs` → `_meta.claudeCode.options.settings.pluginConfigs`. Проверка на реальном Claude остаётся на этапе 4.
6. **utoipa 4.2.3 не знает ключа `deprecated` в `#[utoipa::path]`.** Флаг берётся из Rust-атрибута `#[deprecated]` на обработчике (utoipa-gen 4.3.1 читает его). Места использования обработчиков помечаются `#[allow(deprecated)]`.
7. **`session/resume` существует:** SDK шлёт его через `acp.unstableResumeSession`, прокси пересылает всё как есть. Подстановка работает на `session/new`, `session/load` и `session/resume`; `session/load` SDK сейчас не шлёт, он проверяется только Rust-тестом.
8. **Формат маскирования.** GET/PUT одного профиля возвращают `{agent, name, source, stored, resolved, hasValue}`, где `hasValue` это плоская карта `{"process.env.KEY": true, "session.pluginConfigs.plugin": true, "session.mcpServers.<server>.env.KEY": true, "session.mcpServers.<server>.headers.NAME": true}` по развёрнутому профилю. Пустая строка env не маскируется и даёт `false`.
8a. **Маскирование шире spec.** Кроме `process.env` и `session.pluginConfigs` маскируются `value` в списках `env` (stdio) и `headers` (http/sse) у `session.mcpServers` (там обычно токены). `"***"` в них при PUT сохраняет прежнее значение по паре (имя сервера, имя записи).
9. **Синтаксис `extends`:** `"base"` или `"<agent>/base"`. Префикс другого агента даёт 400 (так возникает ошибка "ссылка на профиль другого агента").
10. **Дополнительные ошибки, которых нет в spec:** DELETE профиля, от которого наследуется другой, даёт 409 `conflict` со списком наследников. Неизвестный профиль в `?profile=` при создании сервера даёт 404 и процесс не поднимается. Если закреплённый за сервером профиль удалён, `session/new|load|resume` на этом сервере дают 404, а в списке серверов `profileStale: true`.
11. **Новые типы ошибок:** `urn:sandbox-agent:error:profile_mismatch` (409), `...:profile_read_only` (409), `...:profile_invalid` (400, список полей в `details.fields`).
12. **SDK:** `resumeSession(id)` берёт профиль из записи persist. `resumeOrCreateSession` с другим `profile` для существующей сессии бросает `Error`.
13. **Persist вне SDK.** Эталонные драйверы `examples/persist-sqlite`, `examples/persist-postgres` и `frontend/packages/inspector/src/persist-indexeddb.ts` хранят поля по колонкам, им добавляется `profile` (T15).
14. **CLI:** профили управляются верхнеуровневой командой `sandbox-agent profiles ...` (как в spec), хотя другие обёртки HTTP живут под `api`. Добавлен `api acp post --profile`, чтобы CLI и HTTP совпадали.
15. **OpenAPI перегенерируется дважды:** в T1 (deprecated) и в T13 (все контракты профилей). `openapi-gen/build.rs` сейчас следит только за `router.rs` и `lib.rs`; T13 расширяет rerun на весь `src/`.
16. **TS-тесты запускают сервер в Docker** (`sdks/typescript/tests/helpers/docker.ts`), бинарник собирается внутри образа. `SANDBOX_AGENT_BIN` оставлен в командах, как просил пользователь.
17. **Вне плана A:** Inspector (вкладки, маскирование Request Log), `docs/agents/*.mdx`, проверки на реальном Claude.
18. **Store в памяти вне CLI-пути.** `AppState::new`, `with_branding` и `with_acp_request_timeout` создают `ProfileStore::in_memory()` (`dir: None`, диск не трогается), чтобы in-process тесты и встраивания не читали и не писали реальный state-каталог разработчика. Персистентный store грузит только CLI-путь сервера через `AppState::with_profile_store`. Решение координатора 05.10.2026.

## Риски

- Docker-тесты долгие, и каждая волна пересобирает образ. Параллельные worktree делят `id=sandbox-agent-test-target` под локом, поэтому параллельные сборки идут по очереди.
- Эхо встроенного mock (`mock/echo`, `result.echoed`) возвращает подмешанные `session.*` в поток событий. Это только тестовый агент, реальный Claude так не делает.
- Секреты в `session.mcpServers` маскируются только в формате запроса сессии (списки `{name, value}` в `env`/`headers`). Секрет в другом месте записи (например, в `args` или `url`) уходит наружу как есть.
- Формат `_meta` для Claude не проверен на реальном агенте (этап 4).
- Изменение `AgentInfo` (обязательное `customization`) ломает заглушки в inspector; T13 их чинит.
- Конфликты слияния в `profiles/mod.rs`, `tests/v1_api.rs` и `ApiDoc` между задачами одной волны тривиальны: каждая задача добавляет свои строки.

---

## Task 1: Docs и OpenAPI deprecated для `/v1/config/mcp` и `/v1/config/skills` (SBA-89)

**Files:**
- Create: `server/packages/sandbox-agent/tests/openapi_deprecated.rs`
- Modify: `server/packages/sandbox-agent/src/router.rs` (функции `get_v1_config_mcp` около 3022-3112, `get_v1_config_skills` около 3114-3192, `build_router_with_state` около 205, `ApiDoc` около 444)
- Modify: `sdks/typescript/src/client.ts:2646-2668`
- Modify: `docs/mcp-config.mdx`, `docs/skills-config.mdx`, `docs/custom-tools.mdx`
- Regenerate: `docs/openapi.json`, `sdks/typescript/src/generated/openapi.ts`

- [ ] **Step 1: Write the failing test**

Создать `server/packages/sandbox-agent/tests/openapi_deprecated.rs`:

```rust
use sandbox_agent::router::ApiDoc;
use serde_json::json;
use utoipa::OpenApi;

#[test]
fn legacy_config_endpoints_are_deprecated() {
    let doc = serde_json::to_value(ApiDoc::openapi()).expect("serialize openapi");
    for path in ["/v1/config/mcp", "/v1/config/skills"] {
        for method in ["get", "put", "delete"] {
            assert_eq!(
                doc["paths"][path][method]["deprecated"],
                json!(true),
                "{method} {path} must be deprecated"
            );
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test openapi_deprecated`
Expected: FAIL, `get /v1/config/mcp must be deprecated` (`left: Null`, `right: Bool(true)`).

- [ ] **Step 3: Mark the handlers deprecated**

В `router.rs` над каждым из шести `#[utoipa::path(...)]` добавить doc-комментарий, а между `)]` и `async fn` добавить `#[deprecated]`. Пример для `get_v1_config_mcp` (остальные пять так же, меняется только первая строка комментария):

```rust
/// Get a stored MCP server entry (deprecated).
///
/// Only stores JSON under `<directory>/.sandbox-agent/config/mcp.json`.
/// Nothing passes this config to agents. Will be removed in the next minor
/// release; use agent profiles or per-session `mcpServers` instead.
#[utoipa::path(
    get,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    responses(
        (status = 200, description = "MCP entry", body = McpServerConfig),
        (status = 404, description = "Entry not found", body = ProblemDetails)
    )
)]
#[deprecated(note = "stored config is never passed to agents; use agent profiles (SBA-89)")]
async fn get_v1_config_mcp(
```

Сами атрибуты `#[utoipa::path(...)]` и тела функций не меняются, добавляются только строки `///` сверху и `#[deprecated(...)]` перед `async fn`.

Первые строки комментариев: `put_v1_config_mcp`: `/// Store an MCP server entry (deprecated).`; `delete_v1_config_mcp`: `/// Delete a stored MCP server entry (deprecated).`; `get_v1_config_skills`: `/// Get a stored skills entry (deprecated).`; `put_v1_config_skills`: `/// Store a skills entry (deprecated).`; `delete_v1_config_skills`: `/// Delete a stored skills entry (deprecated).`. Для skills во второй строке путь `<directory>/.sandbox-agent/config/skills.json`.

Над `pub fn build_router_with_state` и над `#[derive(OpenApi)]` у `ApiDoc` добавить:

```rust
// The legacy /v1/config/mcp and /v1/config/skills handlers are deprecated (SBA-89).
#[allow(deprecated)]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test openapi_deprecated`
Expected: `test result: ok. 1 passed`.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent 2>&1 | grep -c "use of deprecated"`
Expected: `0`.

- [ ] **Step 5: Deprecate the SDK methods**

В `sdks/typescript/src/client.ts` перед каждым из шести методов `getMcpConfig`, `setMcpConfig`, `deleteMcpConfig`, `getSkillsConfig`, `setSkillsConfig`, `deleteSkillsConfig` добавить:

```ts
  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Pass MCP servers in `sessionInit.mcpServers` (or use agent profiles). Removed in the next minor release.
   */
```

Для трёх skills-методов вторая строка: `Put skill files where the agent reads skills (or use agent profiles). Removed in the next minor release.`

- [ ] **Step 6: Rewrite `docs/mcp-config.mdx`**

Заменить всё после frontmatter (frontmatter оставить, `description` поменять на `"Give agent sessions MCP servers."`):

````mdx
MCP (Model Context Protocol) servers extend agents with tools and external context.

## Give a session MCP servers

Pass MCP servers when you create the session. They are sent to the agent with the new session.

```ts
const session = await sdk.createSession({
  agent: "claude",
  sessionInit: {
    cwd: "/workspace",
    mcpServers: [
      { type: "http", name: "github", url: "https://example.com/mcp", headers: [] },
      { name: "filesystem", command: "node", args: ["/opt/mcp/fs-server.cjs"], env: [] },
    ],
  },
});

await session.prompt([
  { type: "text", text: "Use available MCP servers to help with this task." },
]);
```

## Deprecated config endpoints

<Warning>
`setMcpConfig`, `getMcpConfig` and `deleteMcpConfig` (and the HTTP endpoints behind them) are deprecated and will be removed in the next minor release. The server only stores the config as JSON in `<directory>/.sandbox-agent/config/mcp.json`. Nothing passes it to agents, so a session created afterwards does not get these MCP servers.
</Warning>

Stored entries use these fields.

### Local server

| Field | Description |
|---|---|
| `type` | `local` |
| `command` | executable path |
| `args` | array of CLI args |
| `env` | environment variable map |
| `cwd` | working directory |
| `enabled` | enable/disable server |
| `timeoutMs` | timeout override |

### Remote server

| Field | Description |
|---|---|
| `type` | `remote` |
| `url` | MCP server URL |
| `transport` | `http` or `sse` |
| `headers` | static headers map |
| `bearerTokenEnvVar` | env var name to inject in auth header |
| `envHeaders` | header name to env var map |
| `oauth` | optional OAuth config object |
| `enabled` | enable/disable server |
| `timeoutMs` | timeout override |

## Custom MCP servers

To bundle and upload your own MCP server into the sandbox, see [Custom Tools](/custom-tools).
````

- [ ] **Step 7: Rewrite `docs/skills-config.mdx`**

Заменить всё после frontmatter (`description` → `"Give agents skills."`):

````mdx
Skills are local instruction bundles stored in `SKILL.md` files.

## Give an agent skills

Agents read skills from their own skill directories. Upload the `SKILL.md` file and its scripts there with the [file system API](/file-system), for example `/workspace/.claude/skills/<skill-name>/SKILL.md` for Claude in a session whose working directory is `/workspace`.

```ts
import fs from "node:fs";

const skill = await fs.promises.readFile("./SKILL.md");
await sdk.writeFsFile({ path: "/workspace/.claude/skills/my-skill/SKILL.md" }, skill);

const session = await sdk.createSession({ agent: "claude", cwd: "/workspace" });
```

## Deprecated config endpoints

<Warning>
`setSkillsConfig`, `getSkillsConfig` and `deleteSkillsConfig` (and the HTTP endpoints behind them) are deprecated and will be removed in the next minor release. The server only stores the config as JSON in `<directory>/.sandbox-agent/config/skills.json`. Nothing reads it, so no skill source listed there reaches an agent.
</Warning>

Stored entries describe skill sources:

| Type | `source` value | Example |
|------|---------------|---------|
| `github` | `owner/repo` | `"rivet-dev/skills"` |
| `local` | filesystem path | `"/workspace/my-skill"` |
| `git` | git clone URL | `"https://git.example.com/skills.git"` |

Optional fields: `skills` (subset of skill directory names), `ref` (branch, tag or commit for `github` and `git`), `subpath` (subdirectory to scan).

## Custom skills

To write, upload, and use your own skills inside the sandbox, see [Custom Tools](/custom-tools).
````

- [ ] **Step 8: Fix `docs/custom-tools.mdx`**

В шаге `<Step title="Register MCP config and create a session">` заменить заголовок на `<Step title="Create a session with the MCP server">`, а блок кода с `setMcpConfig` и `createSession` на:

```ts
const session = await sdk.createSession({
  agent: "claude",
  sessionInit: {
    cwd: "/workspace",
    mcpServers: [
      { name: "customTools", command: "node", args: ["/opt/mcp/custom-tools/mcp-server.cjs"], env: [] },
    ],
  },
});

await session.prompt([
  { type: "text", text: "Use the random_number tool with min=1 and max=10." },
]);
```

В шаге `<Step title="Upload files">` раздела Skills заменить пути `/opt/skills/random-number/` на `/workspace/.claude/skills/random-number/` (оба `writeFsFile`), в `SKILL.md` строку запуска на `node /workspace/.claude/skills/random-number/random-number.cjs <min> <max>`. В Notes заменить последний пункт на:

```mdx
- Agents read skills from their own skill directories (for Claude, `.claude/skills/` under the session's working directory). The skills config endpoints do not install skills, see [Skills](/skills-config).
```

- [ ] **Step 9: Regenerate OpenAPI and TS types**

Run: `pnpm --filter sandbox-agent generate`
Expected: exit 0. Run: `grep -c '"deprecated": true' docs/openapi.json` → `6`.
Run: `pnpm --filter sandbox-agent typecheck` → exit 0.

- [ ] **Step 10: Commit**

```bash
git add server/packages/sandbox-agent/tests/openapi_deprecated.rs server/packages/sandbox-agent/src/router.rs \
  sdks/typescript/src/client.ts sdks/typescript/src/generated/openapi.ts docs/openapi.json \
  docs/mcp-config.mdx docs/skills-config.mdx docs/custom-tools.mdx
git commit -m "docs: config/mcp and config/skills are not passed to agents, mark deprecated (SBA-89)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Ошибки профилей в error crate

**Files:**
- Modify: `server/packages/error/src/lib.rs`

- [ ] **Step 1: Write the failing test**

В конец `server/packages/error/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profile_mismatch_is_a_409_problem() {
        let problem = SandboxError::ProfileMismatch {
            server_id: "s1".to_string(),
            bound: Some("base".to_string()),
            requested: "review".to_string(),
        }
        .to_problem_details();
        assert_eq!(problem.status, 409);
        assert_eq!(problem.type_, "urn:sandbox-agent:error:profile_mismatch");
        assert_eq!(
            problem.detail.as_deref(),
            Some("profile mismatch on server 's1': it runs with profile 'base', requested profile 'review'")
        );
        assert_eq!(
            problem.extensions["details"],
            json!({"serverId": "s1", "boundProfile": "base", "requestedProfile": "review"})
        );
    }

    #[test]
    fn profile_mismatch_without_bound_profile() {
        let error = SandboxError::ProfileMismatch {
            server_id: "s1".to_string(),
            bound: None,
            requested: "review".to_string(),
        };
        assert_eq!(
            error.to_string(),
            "profile mismatch on server 's1': it runs with no profile, requested profile 'review'"
        );
        assert_eq!(error.to_problem_details().extensions["details"]["boundProfile"], Value::Null);
    }

    #[test]
    fn profile_read_only_is_a_409_problem() {
        let problem = SandboxError::ProfileReadOnly {
            agent: "claude".to_string(),
            name: "ops".to_string(),
        }
        .to_problem_details();
        assert_eq!(problem.status, 409);
        assert_eq!(problem.type_, "urn:sandbox-agent:error:profile_read_only");
        assert_eq!(problem.extensions["agent"], json!("claude"));
        assert_eq!(problem.extensions["details"], json!({"name": "ops"}));
    }

    #[test]
    fn profile_invalid_lists_fields() {
        let problem = SandboxError::ProfileInvalid {
            message: "agent 'codex' does not support: session.skills".to_string(),
            fields: vec!["session.skills".to_string()],
        }
        .to_problem_details();
        assert_eq!(problem.status, 400);
        assert_eq!(problem.type_, "urn:sandbox-agent:error:profile_invalid");
        assert_eq!(problem.extensions["details"]["fields"], json!(["session.skills"]));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p sandbox-agent-error`
Expected: FAIL to compile, `no variant named ProfileMismatch found for enum SandboxError`.

- [ ] **Step 3: Implement**

В `enum ErrorType` после `Timeout,` добавить:

```rust
    ProfileMismatch,
    ProfileReadOnly,
    ProfileInvalid,
```

В `as_urn` после `Timeout`:

```rust
            Self::ProfileMismatch => "urn:sandbox-agent:error:profile_mismatch",
            Self::ProfileReadOnly => "urn:sandbox-agent:error:profile_read_only",
            Self::ProfileInvalid => "urn:sandbox-agent:error:profile_invalid",
```

В `title`:

```rust
            Self::ProfileMismatch => "Profile Mismatch",
            Self::ProfileReadOnly => "Profile Read Only",
            Self::ProfileInvalid => "Invalid Profile",
```

В `status_code`:

```rust
            Self::ProfileMismatch => 409,
            Self::ProfileReadOnly => 409,
            Self::ProfileInvalid => 400,
```

В `enum SandboxError` после `Timeout { message: Option<String> },`:

```rust
    #[error(
        "profile mismatch on server '{server_id}': it runs with {}, requested profile '{requested}'",
        bound_profile_label(.bound)
    )]
    ProfileMismatch {
        server_id: String,
        bound: Option<String>,
        requested: String,
    },
    #[error("profile '{agent}/{name}' comes from the --profiles file and is read-only")]
    ProfileReadOnly { agent: String, name: String },
    #[error("invalid profile: {message}")]
    ProfileInvalid { message: String, fields: Vec<String> },
```

Перед `impl SandboxError`:

```rust
fn bound_profile_label(bound: &Option<String>) -> String {
    match bound {
        Some(name) => format!("profile '{name}'"),
        None => "no profile".to_string(),
    }
}
```

В `error_type`:

```rust
            Self::ProfileMismatch { .. } => ErrorType::ProfileMismatch,
            Self::ProfileReadOnly { .. } => ErrorType::ProfileReadOnly,
            Self::ProfileInvalid { .. } => ErrorType::ProfileInvalid,
```

В `to_agent_error` перед закрывающей `};` match:

```rust
            Self::ProfileMismatch {
                server_id,
                bound,
                requested,
            } => {
                let mut map = Map::new();
                map.insert("serverId".to_string(), Value::String(server_id.clone()));
                map.insert(
                    "boundProfile".to_string(),
                    bound.clone().map(Value::String).unwrap_or(Value::Null),
                );
                map.insert(
                    "requestedProfile".to_string(),
                    Value::String(requested.clone()),
                );
                (None, None, Some(Value::Object(map)))
            }
            Self::ProfileReadOnly { agent, name } => {
                let mut map = Map::new();
                map.insert("name".to_string(), Value::String(name.clone()));
                (Some(agent.clone()), None, Some(Value::Object(map)))
            }
            Self::ProfileInvalid { message, fields } => {
                let mut map = Map::new();
                map.insert("message".to_string(), Value::String(message.clone()));
                map.insert(
                    "fields".to_string(),
                    Value::Array(fields.iter().cloned().map(Value::String).collect()),
                );
                (None, None, Some(Value::Object(map)))
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p sandbox-agent-error` → `test result: ok. 4 passed`.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo check --workspace` → exit 0 (нет исчерпывающих match по `SandboxError` вне crate).

- [ ] **Step 5: Commit**

```bash
git add server/packages/error/src/lib.rs
git commit -m "feat(error): profile_mismatch, profile_read_only and profile_invalid problems (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Хук `mock/env` во встроенном mock-агенте

Встроенный mock (`cli.rs::run_mock_agent_process`) уже отвечает на любой запрос `{"result": {"echoed": <полученное сообщение>}}`, поэтому пришедший `session/new` с `_meta` и `mcpServers` виден в ответе без доработки. Env процесса он не показывает, это добавляется здесь.

**Files:**
- Create: `server/packages/sandbox-agent/tests/v1_api/mock_agent.rs`
- Modify: `server/packages/sandbox-agent/tests/v1_api.rs` (список `mod` в конце)
- Modify: `server/packages/sandbox-agent/src/cli.rs` (`run_mock_agent_process`, около 1270)

- [ ] **Step 1: Write the failing test**

Создать `server/packages/sandbox-agent/tests/v1_api/mock_agent.rs`:

```rust
//! Test hooks of the built-in mock agent (`sandbox-agent mock-agent-process`).
use super::turn_events::bootstrap_mock;
use super::*;

#[tokio::test]
async fn mock_env_hook_reports_agent_process_env() {
    let mut options = docker_support::TestAppOptions::default();
    options
        .env
        .insert("MOCK_ENV_PROBE".to_string(), "from-server".to_string());
    let test_app = TestApp::with_options(AuthConfig::disabled(), options, |_| {});
    bootstrap_mock(&test_app.app, "mock-env").await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/mock-env",
        Some(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "mock/env",
            "params": { "names": ["MOCK_ENV_PROBE", "MOCK_ENV_MISSING"] }
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        parse_json(&body)["result"]["env"],
        json!({ "MOCK_ENV_PROBE": "from-server", "MOCK_ENV_MISSING": null })
    );
}
```

В `tests/v1_api.rs` после `mod fs_download_batch;`:

```rust
#[path = "v1_api/mock_agent.rs"]
mod mock_agent;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api mock_agent::`
Expected: FAIL, `assertion left == right failed` (`left: Null`, ответ mock без `env`).

- [ ] **Step 3: Implement**

В `run_mock_agent_process` в `cli.rs` прямо перед `if has_method && has_id {` (ветка "Request -> respond with echo result") вставить:

```rust
        if method == Some("mock/env") && has_id {
            // Test hook: report the listed variables of this agent process's
            // environment (null when unset).
            let mut env = serde_json::Map::new();
            let names = msg
                .pointer("/params/names")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for name in names.iter().filter_map(Value::as_str) {
                env.insert(
                    name.to_string(),
                    std::env::var(name).map(Value::String).unwrap_or(Value::Null),
                );
            }
            write_stdout_line(&serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": { "env": env }
            }))?)?;
            continue;
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api mock_agent::`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/cli.rs server/packages/sandbox-agent/tests/v1_api.rs server/packages/sandbox-agent/tests/v1_api/mock_agent.rs
git commit -m "test(mock): mock/env hook reports the agent process environment (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Модель профиля и слияние `extends`

**Files:**
- Create: `server/packages/sandbox-agent/src/profiles/mod.rs`
- Create: `server/packages/sandbox-agent/src/profiles/model.rs`
- Create: `server/packages/sandbox-agent/src/profiles/merge.rs`
- Modify: `server/packages/sandbox-agent/src/lib.rs`

- [ ] **Step 1: Create the module with types and failing tests**

`server/packages/sandbox-agent/src/lib.rs`: после `pub mod daemon;` добавить `pub mod profiles;`.

`server/packages/sandbox-agent/src/profiles/mod.rs`:

```rust
//! Server-side agent profiles: named, per-agent settings applied when an agent
//! process starts (`process`) and to every session of that process (`session`).

mod merge;
mod model;

pub use merge::{merge_profiles, parse_extends, resolve_chain};
pub use model::{
    validate_profile_name, validate_profile_shape, AgentProfile, ProfilePlugin, ProfileProcess,
    ProfileSession, SystemPrompt, SystemPromptMode,
};
```

`server/packages/sandbox-agent/src/profiles/model.rs`:

```rust
use std::collections::{BTreeMap, BTreeSet};

use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_error::SandboxError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

/// One agent profile. `agent` and `name` are optional in request bodies (the
/// path names the profile) and required in the `--profiles` file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Parent profile of the same agent: `"base"` or `"<agent>/base"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    #[serde(default, skip_serializing_if = "ProfileProcess::is_empty")]
    pub process: ProfileProcess,
    #[serde(default, skip_serializing_if = "ProfileSession::is_empty")]
    pub session: ProfileSession,
}

/// Applied when the agent process starts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileProcess {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

impl ProfileProcess {
    pub fn is_empty(&self) -> bool {
        self.env.is_empty() && self.args.is_none() && self.config.is_none()
    }
}

/// Applied to every session of the agent process.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<SystemPrompt>,
    /// MCP servers in the session request format; every entry needs a `name`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<ProfilePlugin>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plugin_configs: BTreeMap<String, Value>,
}

impl ProfileSession {
    pub fn is_empty(&self) -> bool {
        self.system_prompt.is_none()
            && self.mcp_servers.is_empty()
            && self.skills.is_none()
            && self.plugins.is_empty()
            && self.plugin_configs.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemPrompt {
    pub mode: SystemPromptMode,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SystemPromptMode {
    Replace,
    Append,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfilePlugin {
    pub path: String,
}

impl AgentProfile {
    /// Serialized `process` part. Compared to tell whether a running agent
    /// process still matches its profile (`profileStale`). Kept in memory only.
    pub fn process_fingerprint(&self) -> String {
        serde_json::to_string(&self.process).unwrap_or_default()
    }
}

pub(crate) fn profile_invalid(message: impl Into<String>, fields: &[&str]) -> SandboxError {
    SandboxError::ProfileInvalid {
        message: message.into(),
        fields: fields.iter().map(|field| field.to_string()).collect(),
    }
}

pub(crate) fn profile_not_found(agent: AgentId, name: &str) -> SandboxError {
    SandboxError::NotFound {
        resource: "profile".to_string(),
        id: format!("{}/{name}", agent.as_str()),
    }
}

/// 1-64 characters from `[A-Za-z0-9._-]`, starting with a letter or digit
/// (the name is also the file name on disk).
pub fn validate_profile_name(name: &str) -> Result<(), SandboxError> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(())
    } else {
        Err(profile_invalid(
            format!(
                "invalid profile name '{name}': use 1-64 characters from [A-Za-z0-9._-], starting with a letter or digit"
            ),
            &["name"],
        ))
    }
}

/// Checks that do not depend on other profiles or on the agent.
pub fn validate_profile_shape(profile: &AgentProfile) -> Result<(), SandboxError> {
    if let Some(extends) = profile.extends.as_deref() {
        if extends.trim().is_empty() {
            return Err(profile_invalid("extends must not be empty", &["extends"]));
        }
    }
    let mut names = BTreeSet::new();
    for (index, server) in profile.session.mcp_servers.iter().enumerate() {
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !server.is_object() || name.is_empty() {
            return Err(profile_invalid(
                format!("session.mcpServers[{index}] must be an object with a non-empty 'name'"),
                &["session.mcpServers"],
            ));
        }
        if !names.insert(name.to_string()) {
            return Err(profile_invalid(
                format!("session.mcpServers has two servers named '{name}'"),
                &["session.mcpServers"],
            ));
        }
    }
    let mut paths = BTreeSet::new();
    for plugin in &profile.session.plugins {
        if plugin.path.trim().is_empty() {
            return Err(profile_invalid(
                "session.plugins entries need a non-empty 'path'",
                &["session.plugins"],
            ));
        }
        if !paths.insert(plugin.path.clone()) {
            return Err(profile_invalid(
                format!("session.plugins lists '{}' twice", plugin.path),
                &["session.plugins"],
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(value: Value) -> AgentProfile {
        serde_json::from_value(value).expect("profile json")
    }

    fn invalid_fields(error: SandboxError) -> Vec<String> {
        match error {
            SandboxError::ProfileInvalid { fields, .. } => fields,
            other => panic!("expected ProfileInvalid, got {other:?}"),
        }
    }

    #[test]
    fn profile_round_trips_camel_case_json() {
        let value = json!({
            "extends": "base",
            "process": { "env": { "A": "1" } },
            "session": {
                "systemPrompt": { "mode": "replace", "text": "hi" },
                "mcpServers": [{ "name": "fs", "command": "node" }],
                "plugins": [{ "path": "/opt/mods/one" }],
                "pluginConfigs": { "one": { "level": 2 } }
            }
        });
        let parsed = profile(value.clone());
        assert_eq!(parsed.session.system_prompt.as_ref().unwrap().mode, SystemPromptMode::Replace);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    }

    #[test]
    fn profile_rejects_unknown_fields() {
        assert!(serde_json::from_value::<AgentProfile>(json!({ "sesion": {} })).is_err());
        assert!(serde_json::from_value::<AgentProfile>(json!({ "session": { "prompt": "x" } })).is_err());
    }

    #[test]
    fn validate_name_rules() {
        for ok in ["review", "base-1", "a.b_c", "0x"] {
            assert!(validate_profile_name(ok).is_ok(), "{ok}");
        }
        let too_long = "x".repeat(65);
        for bad in ["", "-x", ".hidden", "a/b", "with space", too_long.as_str()] {
            assert_eq!(invalid_fields(validate_profile_name(bad).unwrap_err()), vec!["name"], "{bad}");
        }
    }

    #[test]
    fn validate_shape_requires_unique_named_mcp_servers_and_plugins() {
        let unnamed = profile(json!({ "session": { "mcpServers": [{ "command": "x" }] } }));
        assert_eq!(invalid_fields(validate_profile_shape(&unnamed).unwrap_err()), vec!["session.mcpServers"]);
        let twice = profile(json!({ "session": { "mcpServers": [{ "name": "a" }, { "name": "a" }] } }));
        assert_eq!(invalid_fields(validate_profile_shape(&twice).unwrap_err()), vec!["session.mcpServers"]);
        let plugins = profile(json!({ "session": { "plugins": [{ "path": "/p" }, { "path": "/p" }] } }));
        assert_eq!(invalid_fields(validate_profile_shape(&plugins).unwrap_err()), vec!["session.plugins"]);
        let empty_extends = profile(json!({ "extends": " " }));
        assert_eq!(invalid_fields(validate_profile_shape(&empty_extends).unwrap_err()), vec!["extends"]);
        assert!(validate_profile_shape(&profile(json!({}))).is_ok());
    }

    #[test]
    fn process_fingerprint_changes_with_process_only() {
        let a = profile(json!({ "process": { "env": { "A": "1" } } }));
        let b = profile(json!({ "process": { "env": { "A": "1" } }, "session": { "plugins": [{ "path": "/p" }] } }));
        let c = profile(json!({ "process": { "env": { "A": "2" } } }));
        assert_eq!(a.process_fingerprint(), b.process_fingerprint());
        assert_ne!(a.process_fingerprint(), c.process_fingerprint());
    }
}
```

`server/packages/sandbox-agent/src/profiles/merge.rs` (только тесты, чтобы увидеть красный):

```rust
use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_error::SandboxError;
use serde_json::Value;

use super::model::{
    profile_invalid, profile_not_found, validate_profile_name, AgentProfile, ProfilePlugin,
    ProfileProcess, ProfileSession,
};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use serde_json::json;

    fn p(value: Value) -> AgentProfile {
        serde_json::from_value(value).expect("profile json")
    }

    fn invalid(error: SandboxError) -> (String, Vec<String>) {
        match error {
            SandboxError::ProfileInvalid { message, fields } => (message, fields),
            other => panic!("expected ProfileInvalid, got {other:?}"),
        }
    }

    #[test]
    fn merge_follows_table_rules() {
        let base = p(json!({
            "process": { "env": { "A": "base", "B": "base" }, "args": ["--base"], "config": { "k": "base" } },
            "session": {
                "systemPrompt": { "mode": "append", "text": "base" },
                "mcpServers": [{ "name": "fs", "command": "base-fs" }, { "name": "git", "command": "git" }],
                "skills": [{ "name": "s1" }],
                "plugins": [{ "path": "/p/one" }, { "path": "/p/two" }],
                "pluginConfigs": { "one": { "x": 1 }, "two": { "y": 2 } }
            }
        }));
        let derived = p(json!({
            "extends": "base",
            "process": { "env": { "B": "derived", "C": "derived" }, "args": ["--derived"] },
            "session": {
                "mcpServers": [{ "name": "fs", "command": "derived-fs" }, { "name": "web", "command": "web" }],
                "plugins": [{ "path": "/p/two" }, { "path": "/p/three" }],
                "pluginConfigs": { "two": { "y": 3 } }
            }
        }));
        let merged = merge_profiles(&base, &derived);
        assert_eq!(
            serde_json::to_value(&merged.process).unwrap(),
            json!({ "env": { "A": "base", "B": "derived", "C": "derived" }, "args": ["--derived"], "config": { "k": "base" } })
        );
        assert_eq!(merged.session.system_prompt, base.session.system_prompt);
        assert_eq!(
            merged.session.mcp_servers,
            vec![
                json!({ "name": "fs", "command": "derived-fs" }),
                json!({ "name": "git", "command": "git" }),
                json!({ "name": "web", "command": "web" })
            ]
        );
        assert_eq!(merged.session.skills, Some(vec![json!({ "name": "s1" })]));
        let paths: Vec<&str> = merged.session.plugins.iter().map(|plugin| plugin.path.as_str()).collect();
        assert_eq!(paths, vec!["/p/one", "/p/two", "/p/three"]);
        assert_eq!(
            serde_json::to_value(&merged.session.plugin_configs).unwrap(),
            json!({ "one": { "x": 1 }, "two": { "y": 3 } })
        );
        assert_eq!(merged.extends.as_deref(), Some("base"));
    }

    #[test]
    fn derived_replaces_whole_fields() {
        let base = p(json!({
            "process": { "config": { "a": 1, "b": 2 } },
            "session": { "systemPrompt": { "mode": "append", "text": "base" }, "skills": [{ "name": "s1" }] }
        }));
        let derived = p(json!({
            "process": { "config": { "c": 3 } },
            "session": { "systemPrompt": { "mode": "replace", "text": "derived" }, "skills": [] }
        }));
        let merged = merge_profiles(&base, &derived);
        assert_eq!(merged.process.config, Some(json!({ "c": 3 })));
        assert_eq!(merged.session.system_prompt, derived.session.system_prompt);
        assert_eq!(merged.session.skills, Some(Vec::new()));
    }

    #[test]
    fn resolve_chain_applies_base_first() {
        let profiles: BTreeMap<String, AgentProfile> = [
            ("root".to_string(), p(json!({ "process": { "env": { "A": "root", "B": "root", "C": "root" } } }))),
            ("mid".to_string(), p(json!({ "extends": "root", "process": { "env": { "B": "mid", "C": "mid" } } }))),
            ("leaf".to_string(), p(json!({ "extends": "mock/mid", "process": { "env": { "C": "leaf" } } }))),
        ]
        .into_iter()
        .collect();
        let resolved = resolve_chain(AgentId::Mock, "leaf", |name| profiles.get(name)).unwrap();
        assert_eq!(
            serde_json::to_value(&resolved.process.env).unwrap(),
            json!({ "A": "root", "B": "mid", "C": "leaf" })
        );
        assert_eq!(resolved.agent.as_deref(), Some("mock"));
        assert_eq!(resolved.name.as_deref(), Some("leaf"));
        assert_eq!(resolved.extends.as_deref(), Some("mock/mid"));
    }

    #[test]
    fn resolve_chain_reports_cycle() {
        let profiles: BTreeMap<String, AgentProfile> = [
            ("a".to_string(), p(json!({ "extends": "b" }))),
            ("b".to_string(), p(json!({ "extends": "a" }))),
        ]
        .into_iter()
        .collect();
        let (message, fields) = invalid(resolve_chain(AgentId::Mock, "a", |name| profiles.get(name)).unwrap_err());
        assert_eq!(fields, vec!["extends"]);
        assert!(message.contains("cycle: a -> b -> a"), "{message}");
    }

    #[test]
    fn resolve_chain_reports_missing_parent() {
        let profiles: BTreeMap<String, AgentProfile> =
            [("leaf".to_string(), p(json!({ "extends": "ghost" })))].into_iter().collect();
        let (message, fields) = invalid(resolve_chain(AgentId::Mock, "leaf", |name| profiles.get(name)).unwrap_err());
        assert_eq!(fields, vec!["extends"]);
        assert_eq!(message, "profile 'mock/leaf' extends 'ghost', which does not exist");
    }

    #[test]
    fn resolve_chain_rejects_other_agent() {
        let profiles: BTreeMap<String, AgentProfile> =
            [("leaf".to_string(), p(json!({ "extends": "codex/base" })))].into_iter().collect();
        let (message, fields) = invalid(resolve_chain(AgentId::Mock, "leaf", |name| profiles.get(name)).unwrap_err());
        assert_eq!(fields, vec!["extends"]);
        assert!(message.contains("agent 'codex'"), "{message}");
    }

    #[test]
    fn resolve_chain_missing_root_is_not_found() {
        let profiles: BTreeMap<String, AgentProfile> = BTreeMap::new();
        match resolve_chain(AgentId::Mock, "nope", |name| profiles.get(name)).unwrap_err() {
            SandboxError::NotFound { resource, id } => {
                assert_eq!(resource, "profile");
                assert_eq!(id, "mock/nope");
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::`
Expected: FAIL to compile, `cannot find function merge_profiles in this scope` и `unresolved imports merge::{merge_profiles, parse_extends, resolve_chain}`.

- [ ] **Step 3: Implement merge**

В `merge.rs` над `#[cfg(test)]`:

```rust
/// Merges `derived` over `base` by the spec table: `process.env` and
/// `session.pluginConfigs` by key, `session.mcpServers` by `name`,
/// `session.plugins` by `path` (derived wins in all of them); every other field
/// is replaced whole when the derived profile sets it.
pub fn merge_profiles(base: &AgentProfile, derived: &AgentProfile) -> AgentProfile {
    let mut env = base.process.env.clone();
    env.extend(derived.process.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    let mut plugin_configs = base.session.plugin_configs.clone();
    plugin_configs.extend(
        derived
            .session
            .plugin_configs
            .iter()
            .map(|(k, v)| (k.clone(), v.clone())),
    );

    AgentProfile {
        agent: derived.agent.clone().or_else(|| base.agent.clone()),
        name: derived.name.clone().or_else(|| base.name.clone()),
        extends: derived.extends.clone(),
        process: ProfileProcess {
            env,
            args: derived.process.args.clone().or_else(|| base.process.args.clone()),
            config: derived
                .process
                .config
                .clone()
                .or_else(|| base.process.config.clone()),
        },
        session: ProfileSession {
            system_prompt: derived
                .session
                .system_prompt
                .clone()
                .or_else(|| base.session.system_prompt.clone()),
            mcp_servers: merge_by_name(&base.session.mcp_servers, &derived.session.mcp_servers),
            skills: derived
                .session
                .skills
                .clone()
                .or_else(|| base.session.skills.clone()),
            plugins: merge_plugins(&base.session.plugins, &derived.session.plugins),
            plugin_configs,
        },
    }
}

fn mcp_server_name(server: &Value) -> Option<&str> {
    server.get("name").and_then(Value::as_str)
}

/// Base order is kept; a derived entry replaces the base entry of the same
/// `name` in place, new names are appended.
fn merge_by_name(base: &[Value], derived: &[Value]) -> Vec<Value> {
    let mut merged = base.to_vec();
    for server in derived {
        let position = mcp_server_name(server)
            .and_then(|name| merged.iter().position(|existing| mcp_server_name(existing) == Some(name)));
        match position {
            Some(index) => merged[index] = server.clone(),
            None => merged.push(server.clone()),
        }
    }
    merged
}

fn merge_plugins(base: &[ProfilePlugin], derived: &[ProfilePlugin]) -> Vec<ProfilePlugin> {
    let mut merged = base.to_vec();
    for plugin in derived {
        match merged.iter().position(|existing| existing.path == plugin.path) {
            Some(index) => merged[index] = plugin.clone(),
            None => merged.push(plugin.clone()),
        }
    }
    merged
}

/// Parent profile name from `extends` (`"base"` or `"<agent>/base"`).
pub fn parse_extends(agent: AgentId, raw: &str) -> Result<String, SandboxError> {
    let raw = raw.trim();
    let name = match raw.split_once('/') {
        Some((parent_agent, name)) => {
            if parent_agent != agent.as_str() {
                return Err(profile_invalid(
                    format!(
                        "extends '{raw}' refers to a profile of agent '{parent_agent}'; a '{agent}' profile can only extend '{agent}' profiles",
                        agent = agent.as_str()
                    ),
                    &["extends"],
                ));
            }
            name
        }
        None => raw,
    };
    validate_profile_name(name).map_err(|_| {
        profile_invalid(
            format!("extends '{raw}' is not a valid profile name"),
            &["extends"],
        )
    })?;
    Ok(name.to_string())
}

/// Resolves `name` through its `extends` chain, base first. `lookup` returns
/// the stored profile of the same agent by name.
pub fn resolve_chain<'a>(
    agent: AgentId,
    name: &str,
    lookup: impl Fn(&str) -> Option<&'a AgentProfile>,
) -> Result<AgentProfile, SandboxError> {
    let mut chain: Vec<&'a AgentProfile> = Vec::new();
    let mut visited: Vec<String> = Vec::new();
    let mut current = name.to_string();
    loop {
        if visited.contains(&current) {
            visited.push(current);
            return Err(profile_invalid(
                format!(
                    "profile '{}/{name}' has an extends cycle: {}",
                    agent.as_str(),
                    visited.join(" -> ")
                ),
                &["extends"],
            ));
        }
        let profile = match lookup(&current) {
            Some(profile) => profile,
            None if visited.is_empty() => return Err(profile_not_found(agent, name)),
            None => {
                return Err(profile_invalid(
                    format!(
                        "profile '{}/{}' extends '{current}', which does not exist",
                        agent.as_str(),
                        visited.last().map(String::as_str).unwrap_or(name)
                    ),
                    &["extends"],
                ))
            }
        };
        visited.push(current.clone());
        chain.push(profile);
        match profile.extends.as_deref() {
            Some(parent) => current = parse_extends(agent, parent)?,
            None => break,
        }
    }

    let mut resolved = AgentProfile::default();
    for profile in chain.iter().rev() {
        resolved = merge_profiles(&resolved, profile);
    }
    resolved.agent = Some(agent.as_str().to_string());
    resolved.name = Some(name.to_string());
    resolved.extends = chain.first().and_then(|profile| profile.extends.clone());
    Ok(resolved)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::`
Expected: `test result: ok. 12 passed`. Предупреждения `unused` для pub-элементов допустимы до T7.

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/lib.rs server/packages/sandbox-agent/src/profiles/
git commit -m "feat(server): agent profile model and extends merging (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Capability `customization` и проверка профиля по ней

**Files:**
- Create: `server/packages/sandbox-agent/src/profiles/capability.rs`
- Create: `server/packages/sandbox-agent/tests/agent_customization.rs`
- Modify: `server/packages/sandbox-agent/src/profiles/mod.rs`
- Modify: `server/packages/sandbox-agent/src/router/types.rs:50-65` (`AgentInfo`)
- Modify: `server/packages/sandbox-agent/src/router.rs` (два литерала `AgentInfo {` около 1580 и 1713, `ApiDoc` schemas)

- [ ] **Step 1: Write the failing tests**

`server/packages/sandbox-agent/tests/agent_customization.rs`:

```rust
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent_agent_management::agents::AgentManager;
use serde_json::{json, Value};
use tower::util::ServiceExt;

async fn get_agent(agent: &str) -> Value {
    let install_dir = tempfile::tempdir().expect("tempdir");
    let manager = AgentManager::new(install_dir.path()).expect("agent manager");
    let app = build_router(AppState::new(AuthConfig::disabled(), manager));
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/v1/agents/{agent}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.expect("body").to_bytes();
    serde_json::from_slice(&bytes).expect("json")
}

#[tokio::test]
async fn claude_reports_session_customization() {
    assert_eq!(
        get_agent("claude").await["customization"],
        json!({
            "process": { "env": true, "args": false },
            "session": {
                "systemPrompt": ["replace", "append"],
                "mcpServers": true,
                "skills": false,
                "plugins": true,
                "pluginConfigs": true
            }
        })
    );
}

#[tokio::test]
async fn codex_reports_process_env_and_mcp_servers_only() {
    assert_eq!(
        get_agent("codex").await["customization"],
        json!({
            "process": { "env": true, "args": false },
            "session": {
                "systemPrompt": [],
                "mcpServers": true,
                "skills": false,
                "plugins": false,
                "pluginConfigs": false
            }
        })
    );
}
```

`server/packages/sandbox-agent/src/profiles/capability.rs` (типы и тесты, функций ещё нет):

```rust
use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_error::SandboxError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::model::{profile_invalid, AgentProfile, SystemPromptMode};

/// Which profile fields an agent supports (`customization` in `/v1/agents`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentCustomization {
    pub process: ProcessCustomization,
    pub session: SessionCustomization,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCustomization {
    pub env: bool,
    pub args: bool,
    /// Format of `process.config` (for example `codex-toml`); absent when unsupported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionCustomization {
    pub system_prompt: Vec<SystemPromptMode>,
    pub mcp_servers: bool,
    pub skills: bool,
    pub plugins: bool,
    pub plugin_configs: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(value: serde_json::Value) -> AgentProfile {
        serde_json::from_value(value).expect("profile json")
    }

    #[test]
    fn claude_and_mock_support_the_session_part() {
        for agent in [AgentId::Claude, AgentId::Mock] {
            let caps = agent_customization_for(agent);
            assert_eq!(caps.session.system_prompt, vec![SystemPromptMode::Replace, SystemPromptMode::Append]);
            assert!(caps.session.plugins && caps.session.plugin_configs && caps.session.mcp_servers);
            assert!(!caps.session.skills);
        }
    }

    #[test]
    fn unsupported_fields_lists_every_field() {
        let profile = p(json!({
            "process": { "env": { "A": "1" }, "args": ["--x"], "config": {} },
            "session": {
                "systemPrompt": { "mode": "replace", "text": "x" },
                "mcpServers": [{ "name": "fs" }],
                "skills": [],
                "plugins": [{ "path": "/p" }],
                "pluginConfigs": { "p": {} }
            }
        }));
        assert_eq!(
            unsupported_fields(AgentId::Codex, &profile),
            vec![
                "process.args",
                "process.config",
                "session.systemPrompt",
                "session.skills",
                "session.plugins",
                "session.pluginConfigs"
            ]
        );
        assert_eq!(
            unsupported_fields(AgentId::Claude, &profile),
            vec!["process.args", "process.config", "session.skills"]
        );
    }

    #[test]
    fn validate_customization_returns_profile_invalid() {
        let profile = p(json!({ "session": { "systemPrompt": { "mode": "append", "text": "x" } } }));
        assert!(validate_customization(AgentId::Claude, &profile).is_ok());
        match validate_customization(AgentId::Pi, &profile).unwrap_err() {
            SandboxError::ProfileInvalid { message, fields } => {
                assert_eq!(fields, vec!["session.systemPrompt"]);
                assert_eq!(message, "agent 'pi' does not support: session.systemPrompt");
            }
            other => panic!("expected ProfileInvalid, got {other:?}"),
        }
    }
}
```

`profiles/mod.rs`: добавить `mod capability;` и

```rust
pub use capability::{
    agent_customization_for, unsupported_fields, validate_customization, AgentCustomization,
    ProcessCustomization, SessionCustomization,
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::capability`
Expected: FAIL to compile, `cannot find function agent_customization_for`.

- [ ] **Step 3: Implement**

В `capability.rs` над `#[cfg(test)]`:

```rust
/// Profile support per agent in this release. `process.args`, `process.config`
/// and `session.skills` are not wired for any agent yet; the session prompt,
/// plugins and plugin configs reach Claude (and the mock agent, which mirrors
/// Claude so tests can observe the result).
pub fn agent_customization_for(agent: AgentId) -> AgentCustomization {
    let claude_like = matches!(agent, AgentId::Claude | AgentId::Mock);
    AgentCustomization {
        process: ProcessCustomization {
            env: true,
            args: false,
            config: None,
        },
        session: SessionCustomization {
            system_prompt: if claude_like {
                vec![SystemPromptMode::Replace, SystemPromptMode::Append]
            } else {
                Vec::new()
            },
            mcp_servers: true,
            skills: false,
            plugins: claude_like,
            plugin_configs: claude_like,
        },
    }
}

/// Fields set in `profile` that `agent` does not support, as dotted paths.
pub fn unsupported_fields(agent: AgentId, profile: &AgentProfile) -> Vec<String> {
    let caps = agent_customization_for(agent);
    let mut fields = Vec::new();
    let mut check = |set: bool, supported: bool, field: &str| {
        if set && !supported {
            fields.push(field.to_string());
        }
    };
    check(!profile.process.env.is_empty(), caps.process.env, "process.env");
    check(profile.process.args.is_some(), caps.process.args, "process.args");
    check(profile.process.config.is_some(), caps.process.config.is_some(), "process.config");
    check(
        profile.session.system_prompt.is_some(),
        profile
            .session
            .system_prompt
            .as_ref()
            .is_some_and(|prompt| caps.session.system_prompt.contains(&prompt.mode)),
        "session.systemPrompt",
    );
    check(!profile.session.mcp_servers.is_empty(), caps.session.mcp_servers, "session.mcpServers");
    check(profile.session.skills.is_some(), caps.session.skills, "session.skills");
    check(!profile.session.plugins.is_empty(), caps.session.plugins, "session.plugins");
    check(
        !profile.session.plugin_configs.is_empty(),
        caps.session.plugin_configs,
        "session.pluginConfigs",
    );
    fields
}

pub fn validate_customization(agent: AgentId, profile: &AgentProfile) -> Result<(), SandboxError> {
    let fields = unsupported_fields(agent, profile);
    if fields.is_empty() {
        return Ok(());
    }
    let refs: Vec<&str> = fields.iter().map(String::as_str).collect();
    Err(profile_invalid(
        format!("agent '{}' does not support: {}", agent.as_str(), fields.join(", ")),
        &refs,
    ))
}
```

В `router/types.rs` в `AgentInfo` после `pub capabilities: AgentCapabilities,`:

```rust
    /// Profile fields this agent supports.
    pub customization: crate::profiles::AgentCustomization,
```

В `router.rs` в обоих литералах `AgentInfo { ... }` после `capabilities,` добавить:

```rust
            customization: crate::profiles::agent_customization_for(agent_id),
```

В `ApiDoc` `components(schemas(...))` после `AgentCapabilities,` добавить:

```rust
            crate::profiles::AgentCustomization,
            crate::profiles::ProcessCustomization,
            crate::profiles::SessionCustomization,
            crate::profiles::SystemPromptMode,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::capability` → `3 passed`.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test agent_customization` → `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/profiles/ server/packages/sandbox-agent/src/router.rs \
  server/packages/sandbox-agent/src/router/types.rs server/packages/sandbox-agent/tests/agent_customization.rs
git commit -m "feat(server): customization capability in /v1/agents (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Маскирование секретов

**Files:**
- Create: `server/packages/sandbox-agent/src/profiles/secrets.rs`
- Modify: `server/packages/sandbox-agent/src/profiles/mod.rs`

- [ ] **Step 1: Write the failing tests**

`server/packages/sandbox-agent/src/profiles/secrets.rs`:

```rust
use std::collections::BTreeMap;

use sandbox_agent_error::SandboxError;
use serde_json::Value;

use super::model::{profile_invalid, AgentProfile};

pub const SECRET_MASK: &str = "***";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(value: Value) -> AgentProfile {
        serde_json::from_value(value).expect("profile json")
    }

    #[test]
    fn mask_hides_env_and_plugin_config_values() {
        let profile = p(json!({
            "process": { "env": { "TOKEN": "s3cret", "EMPTY": "" } },
            "session": { "pluginConfigs": { "mod": { "key": "v" } }, "systemPrompt": { "mode": "append", "text": "visible" } }
        }));
        let (masked, has_value) = mask_profile(&profile);
        assert_eq!(
            serde_json::to_value(&masked).unwrap(),
            json!({
                "process": { "env": { "EMPTY": "", "TOKEN": "***" } },
                "session": { "pluginConfigs": { "mod": "***" }, "systemPrompt": { "mode": "append", "text": "visible" } }
            })
        );
        assert_eq!(
            serde_json::to_value(&has_value).unwrap(),
            json!({ "process.env.EMPTY": false, "process.env.TOKEN": true, "session.pluginConfigs.mod": true })
        );
    }

    #[test]
    fn mask_hides_mcp_server_env_and_header_values() {
        let profile = p(json!({
            "session": { "mcpServers": [
                { "name": "fs", "command": "node", "args": ["fs.js"], "env": [
                    { "name": "FS_TOKEN", "value": "s3cret-env" },
                    { "name": "FS_EMPTY", "value": "" }
                ] },
                { "type": "http", "name": "gh", "url": "https://example.com/mcp", "headers": [
                    { "name": "Authorization", "value": "Bearer s3cret-header" }
                ] }
            ] }
        }));
        let (masked, has_value) = mask_profile(&profile);
        let text = serde_json::to_string(&masked).unwrap();
        assert!(!text.contains("s3cret"), "{text}");
        assert_eq!(
            serde_json::to_value(&masked.session.mcp_servers).unwrap(),
            json!([
                { "name": "fs", "command": "node", "args": ["fs.js"], "env": [
                    { "name": "FS_TOKEN", "value": "***" },
                    { "name": "FS_EMPTY", "value": "" }
                ] },
                { "type": "http", "name": "gh", "url": "https://example.com/mcp", "headers": [
                    { "name": "Authorization", "value": "***" }
                ] }
            ])
        );
        assert_eq!(
            serde_json::to_value(&has_value).unwrap(),
            json!({
                "session.mcpServers.fs.env.FS_EMPTY": false,
                "session.mcpServers.fs.env.FS_TOKEN": true,
                "session.mcpServers.gh.headers.Authorization": true
            })
        );
    }

    #[test]
    fn restore_keeps_previous_values_for_masks() {
        let previous = p(json!({ "process": { "env": { "TOKEN": "s3cret" } }, "session": { "pluginConfigs": { "mod": { "key": "v" } } } }));
        let mut incoming = p(json!({ "process": { "env": { "TOKEN": "***", "NEW": "n" } }, "session": { "pluginConfigs": { "mod": "***" } } }));
        restore_masked_secrets(&mut incoming, Some(&previous)).unwrap();
        assert_eq!(incoming.process.env["TOKEN"], "s3cret");
        assert_eq!(incoming.process.env["NEW"], "n");
        assert_eq!(incoming.session.plugin_configs["mod"], json!({ "key": "v" }));
    }

    #[test]
    fn restore_keeps_previous_mcp_server_secrets() {
        let previous = p(json!({ "session": { "mcpServers": [
            { "name": "fs", "command": "node", "env": [{ "name": "FS_TOKEN", "value": "s3cret-env" }] },
            { "type": "http", "name": "gh", "url": "https://example.com/mcp", "headers": [{ "name": "Authorization", "value": "Bearer old" }] }
        ] } }));
        let mut incoming = p(json!({ "session": { "mcpServers": [
            { "name": "fs", "command": "node", "env": [
                { "name": "FS_TOKEN", "value": "***" },
                { "name": "FS_NEW", "value": "n" }
            ] },
            { "type": "http", "name": "gh", "url": "https://example.com/mcp", "headers": [{ "name": "Authorization", "value": "***" }] }
        ] } }));
        restore_masked_secrets(&mut incoming, Some(&previous)).unwrap();
        assert_eq!(incoming.session.mcp_servers[0]["env"][0]["value"], "s3cret-env");
        assert_eq!(incoming.session.mcp_servers[0]["env"][1]["value"], "n");
        assert_eq!(incoming.session.mcp_servers[1]["headers"][0]["value"], "Bearer old");
    }

    #[test]
    fn restore_rejects_mask_without_previous_value() {
        let mut incoming = p(json!({
            "process": { "env": { "TOKEN": "***" } },
            "session": {
                "pluginConfigs": { "mod": "***" },
                "mcpServers": [
                    { "name": "fs", "command": "node", "env": [{ "name": "FS_TOKEN", "value": "***" }] },
                    { "type": "http", "name": "gh", "url": "https://example.com/mcp", "headers": [{ "name": "Authorization", "value": "***" }] }
                ]
            }
        }));
        match restore_masked_secrets(&mut incoming, None).unwrap_err() {
            SandboxError::ProfileInvalid { fields, .. } => {
                assert_eq!(
                    fields,
                    vec![
                        "process.env.TOKEN",
                        "session.pluginConfigs.mod",
                        "session.mcpServers.fs.env.FS_TOKEN",
                        "session.mcpServers.gh.headers.Authorization"
                    ]
                );
            }
            other => panic!("expected ProfileInvalid, got {other:?}"),
        }
    }
}
```

`profiles/mod.rs`: добавить `mod secrets;` и `pub use secrets::{mask_profile, restore_masked_secrets, SECRET_MASK};`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::secrets`
Expected: FAIL to compile, `cannot find function mask_profile`.

- [ ] **Step 3: Implement**

В `secrets.rs` над `#[cfg(test)]`:

```rust
/// Fields of an MCP server entry whose values are secrets: `env` (stdio) and
/// `headers` (http/sse), both lists of `{ "name", "value" }` in the session
/// request format.
const MCP_SECRET_FIELDS: [&str; 2] = ["env", "headers"];

/// `(server name, field, entry name, value)` for every string `value` of the
/// `env`/`headers` entries of `servers`.
fn mcp_secret_values(servers: &mut [Value]) -> Vec<(String, &'static str, String, &mut String)> {
    let mut found = Vec::new();
    for server in servers.iter_mut() {
        let Some(server) = server.as_object_mut() else {
            continue;
        };
        let server_name = server
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        for (field, entries) in server.iter_mut() {
            let Some(field) = MCP_SECRET_FIELDS.iter().copied().find(|name| *name == field.as_str()) else {
                continue;
            };
            let Some(entries) = entries.as_array_mut() else {
                continue;
            };
            for entry in entries.iter_mut() {
                let Some(entry) = entry.as_object_mut() else {
                    continue;
                };
                let entry_name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if let Some(Value::String(value)) = entry.get_mut("value") {
                    found.push((server_name.clone(), field, entry_name, value));
                }
            }
        }
    }
    found
}

/// Stored value of `server`/`field`/`entry` in `servers`, if any.
fn previous_mcp_secret(servers: &[Value], server: &str, field: &str, entry: &str) -> Option<String> {
    servers
        .iter()
        .find(|candidate| candidate.get("name").and_then(Value::as_str) == Some(server))?
        .get(field)?
        .as_array()?
        .iter()
        .find(|candidate| candidate.get("name").and_then(Value::as_str) == Some(entry))?
        .get("value")?
        .as_str()
        .map(str::to_string)
}

/// Copy of `profile` with every non-empty `process.env` value, every non-null
/// `session.pluginConfigs` value and every non-empty `value` of the
/// `env`/`headers` entries of `session.mcpServers` replaced by
/// [`SECRET_MASK`], and which of those keys hold a value
/// (`"process.env.KEY"`, `"session.mcpServers.<server>.env.KEY"`,
/// `"session.mcpServers.<server>.headers.NAME"` -> bool).
pub fn mask_profile(profile: &AgentProfile) -> (AgentProfile, BTreeMap<String, bool>) {
    let mut masked = profile.clone();
    let mut has_value = BTreeMap::new();
    for (key, value) in masked.process.env.iter_mut() {
        has_value.insert(format!("process.env.{key}"), !value.is_empty());
        if !value.is_empty() {
            *value = SECRET_MASK.to_string();
        }
    }
    for (key, value) in masked.session.plugin_configs.iter_mut() {
        has_value.insert(format!("session.pluginConfigs.{key}"), !value.is_null());
        if !value.is_null() {
            *value = Value::String(SECRET_MASK.to_string());
        }
    }
    for (server, field, entry, value) in mcp_secret_values(&mut masked.session.mcp_servers) {
        has_value.insert(format!("session.mcpServers.{server}.{field}.{entry}"), !value.is_empty());
        if !value.is_empty() {
            *value = SECRET_MASK.to_string();
        }
    }
    (masked, has_value)
}

/// Replaces [`SECRET_MASK`] values in `incoming` with the values of the same
/// keys in `previous` (the profile being replaced).
pub fn restore_masked_secrets(
    incoming: &mut AgentProfile,
    previous: Option<&AgentProfile>,
) -> Result<(), SandboxError> {
    let mut missing = Vec::new();
    for (key, value) in incoming.process.env.iter_mut() {
        if value.as_str() == SECRET_MASK {
            match previous.and_then(|profile| profile.process.env.get(key)) {
                Some(old) => *value = old.clone(),
                None => missing.push(format!("process.env.{key}")),
            }
        }
    }
    for (key, value) in incoming.session.plugin_configs.iter_mut() {
        if value.as_str() == Some(SECRET_MASK) {
            match previous.and_then(|profile| profile.session.plugin_configs.get(key)) {
                Some(old) => *value = old.clone(),
                None => missing.push(format!("session.pluginConfigs.{key}")),
            }
        }
    }
    // MCP server secrets are matched by server `name` (unique, see
    // `validate_profile_shape`) and entry `name` (first match).
    let previous_servers: &[Value] = previous
        .map(|profile| profile.session.mcp_servers.as_slice())
        .unwrap_or(&[]);
    for (server, field, entry, value) in mcp_secret_values(&mut incoming.session.mcp_servers) {
        if value.as_str() == SECRET_MASK {
            match previous_mcp_secret(previous_servers, &server, field, &entry) {
                Some(old) => *value = old,
                None => missing.push(format!("session.mcpServers.{server}.{field}.{entry}")),
            }
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let fields: Vec<&str> = missing.iter().map(String::as_str).collect();
    Err(profile_invalid(
        format!(
            "'{SECRET_MASK}' keeps a stored value, but nothing is stored for: {}",
            missing.join(", ")
        ),
        &fields,
    ))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::secrets` → `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/profiles/
git commit -m "feat(server): mask profile secrets and keep values sent as *** (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Хранилище профилей в state-каталоге

**Files:**
- Create: `server/packages/sandbox-agent/src/profiles/store.rs`
- Modify: `server/packages/sandbox-agent/src/profiles/mod.rs`

- [ ] **Step 1: Write the failing tests**

`server/packages/sandbox-agent/src/profiles/store.rs`:

```rust
//! Profile storage: API profiles persisted one file per profile under the
//! server state directory, read-only profiles from `--profiles`, and
//! resolution of `extends` chains across both.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_error::SandboxError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::capability::validate_customization;
use super::merge::{parse_extends, resolve_chain};
use super::model::{
    profile_invalid, profile_not_found, validate_profile_name, validate_profile_shape,
    AgentProfile,
};
use super::secrets::restore_masked_secrets;

/// Overrides the server state directory (default `<data dir>/sandbox-agent/state`).
pub const STATE_DIR_ENV: &str = "SANDBOX_AGENT_STATE_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    Api,
    File,
}

#[derive(Debug, Clone)]
pub struct StoredProfile {
    pub agent: AgentId,
    pub name: String,
    pub source: ProfileSource,
    pub profile: AgentProfile,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(value: serde_json::Value) -> AgentProfile {
        serde_json::from_value(value).expect("profile json")
    }

    fn store_in(dir: &tempfile::TempDir) -> ProfileStore {
        ProfileStore::load(dir.path().join("profiles"))
    }

    fn invalid_fields(error: SandboxError) -> Vec<String> {
        match error {
            SandboxError::ProfileInvalid { fields, .. } => fields,
            other => panic!("expected ProfileInvalid, got {other:?}"),
        }
    }

    #[test]
    fn put_writes_one_file_atomically_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store
            .put(AgentId::Mock, "base", p(json!({ "process": { "env": { "TOKEN": "s3cret" } } })))
            .unwrap();
        let agent_dir = dir.path().join("profiles").join("mock");
        let text = fs::read_to_string(agent_dir.join("base.json")).unwrap();
        assert!(text.contains("s3cret"));
        let leftovers: Vec<String> = fs::read_dir(&agent_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        let reloaded = store_in(&dir);
        let stored = reloaded.get(AgentId::Mock, "base").expect("reloaded profile");
        assert_eq!(stored.source, ProfileSource::Api);
        assert_eq!(stored.profile.process.env["TOKEN"], "s3cret");
        assert_eq!(stored.profile.agent.as_deref(), Some("mock"));
        assert_eq!(stored.profile.name.as_deref(), Some("base"));
    }

    #[test]
    fn put_keeps_secret_sent_as_mask() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "base", p(json!({ "process": { "env": { "TOKEN": "s3cret" } } }))).unwrap();
        store
            .put(AgentId::Mock, "base", p(json!({ "process": { "env": { "TOKEN": "***", "OTHER": "x" } } })))
            .unwrap();
        let stored = store.get(AgentId::Mock, "base").unwrap();
        assert_eq!(stored.profile.process.env["TOKEN"], "s3cret");
        assert_eq!(stored.profile.process.env["OTHER"], "x");
    }

    #[test]
    fn put_rejects_body_for_another_profile() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let error = store.put(AgentId::Mock, "base", p(json!({ "agent": "claude" }))).unwrap_err();
        assert_eq!(invalid_fields(error), vec!["agent"]);
        let error = store.put(AgentId::Mock, "base", p(json!({ "name": "other" }))).unwrap_err();
        assert_eq!(invalid_fields(error), vec!["name"]);
    }

    #[test]
    fn put_rejects_extends_cycle_and_keeps_old_profile() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "base", p(json!({}))).unwrap();
        store.put(AgentId::Mock, "review", p(json!({ "extends": "base" }))).unwrap();
        let error = store.put(AgentId::Mock, "base", p(json!({ "extends": "review" }))).unwrap_err();
        assert_eq!(invalid_fields(error), vec!["extends"]);
        assert_eq!(store.get(AgentId::Mock, "base").unwrap().profile.extends, None);
        let on_disk = fs::read_to_string(dir.path().join("profiles/mock/base.json")).unwrap();
        assert!(!on_disk.contains("review"), "{on_disk}");
    }

    #[test]
    fn put_rejects_missing_parent_and_unsupported_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let error = store.put(AgentId::Mock, "review", p(json!({ "extends": "ghost" }))).unwrap_err();
        assert_eq!(invalid_fields(error), vec!["extends"]);
        let error = store
            .put(AgentId::Codex, "p", p(json!({ "session": { "systemPrompt": { "mode": "replace", "text": "x" } } })))
            .unwrap_err();
        assert_eq!(invalid_fields(error), vec!["session.systemPrompt"]);
        assert!(store.get(AgentId::Codex, "p").is_none());
    }

    #[test]
    fn file_profiles_win_and_are_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "ops", p(json!({ "process": { "env": { "A": "api" } } }))).unwrap();
        store
            .install_file_profiles(vec![p(json!({ "agent": "mock", "name": "ops", "process": { "env": { "A": "file" } } }))])
            .unwrap();
        let stored = store.get(AgentId::Mock, "ops").unwrap();
        assert_eq!(stored.source, ProfileSource::File);
        assert_eq!(stored.profile.process.env["A"], "file");
        assert!(matches!(
            store.put(AgentId::Mock, "ops", p(json!({}))).unwrap_err(),
            SandboxError::ProfileReadOnly { .. }
        ));
        assert!(matches!(
            store.delete(AgentId::Mock, "ops").unwrap_err(),
            SandboxError::ProfileReadOnly { .. }
        ));
    }

    #[test]
    fn install_file_profiles_validates_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        assert_eq!(
            invalid_fields(store.install_file_profiles(vec![p(json!({ "name": "x" }))]).unwrap_err()),
            vec!["agent"]
        );
        assert_eq!(
            invalid_fields(store.install_file_profiles(vec![p(json!({ "agent": "mock" }))]).unwrap_err()),
            vec!["name"]
        );
        assert_eq!(
            invalid_fields(
                store
                    .install_file_profiles(vec![p(json!({ "agent": "mock", "name": "a", "extends": "ghost" }))])
                    .unwrap_err()
            ),
            vec!["extends"]
        );
    }

    #[test]
    fn delete_refuses_extended_profile_and_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "base", p(json!({}))).unwrap();
        store.put(AgentId::Mock, "review", p(json!({ "extends": "mock/base" }))).unwrap();
        match store.delete(AgentId::Mock, "base").unwrap_err() {
            SandboxError::Conflict { message } => assert!(message.contains("mock/review"), "{message}"),
            other => panic!("expected Conflict, got {other:?}"),
        }
        store.delete(AgentId::Mock, "review").unwrap();
        assert!(!dir.path().join("profiles/mock/review.json").exists());
        store.delete(AgentId::Mock, "base").unwrap();
        assert!(matches!(
            store.delete(AgentId::Mock, "base").unwrap_err(),
            SandboxError::NotFound { .. }
        ));
    }

    #[test]
    fn load_skips_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("profiles").join("mock");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::write(agent_dir.join("broken.json"), "{not json").unwrap();
        fs::write(agent_dir.join("good.json"), r#"{"session":{"plugins":[{"path":"/p"}]}}"#).unwrap();
        fs::write(dir.path().join("profiles").join("not-an-agent.json"), "{}").unwrap();
        let store = store_in(&dir);
        assert!(store.get(AgentId::Mock, "broken").is_none());
        assert_eq!(store.get(AgentId::Mock, "good").unwrap().profile.session.plugins.len(), 1);
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn resolve_merges_chain() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "base", p(json!({ "process": { "env": { "A": "1", "B": "1" } } }))).unwrap();
        store.put(AgentId::Mock, "review", p(json!({ "extends": "base", "process": { "env": { "B": "2" } } }))).unwrap();
        let resolved = store.resolve(AgentId::Mock, "review").unwrap();
        assert_eq!(serde_json::to_value(&resolved.process.env).unwrap(), json!({ "A": "1", "B": "2" }));
    }

    #[test]
    fn state_dir_env_overrides_default() {
        assert!(server_state_dir_from(Some("/srv/sa-state".into())).ends_with("sa-state"));
        assert!(server_state_dir_from(None).ends_with(Path::new("sandbox-agent").join("state")));
    }
}
```

`profiles/mod.rs`: добавить `mod store;` и

```rust
pub use store::{
    load_profiles_file, server_state_dir, ProfileSource, ProfileStore, StoredProfile, STATE_DIR_ENV,
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::store`
Expected: FAIL to compile, `cannot find type ProfileStore in this scope`.

- [ ] **Step 3: Implement**

В `store.rs` над `#[cfg(test)]`:

```rust
/// Server state directory: `$SANDBOX_AGENT_STATE_DIR`, else
/// `<data dir>/sandbox-agent/state` (next to `.../daemon` and `.../bin`).
pub fn server_state_dir() -> PathBuf {
    server_state_dir_from(std::env::var_os(STATE_DIR_ENV))
}

fn server_state_dir_from(env: Option<std::ffi::OsString>) -> PathBuf {
    if let Some(dir) = env.filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("state"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("state"))
}

/// Reads a `--profiles` file: a JSON array of profiles with `agent` and `name`.
pub fn load_profiles_file(path: &Path) -> Result<Vec<AgentProfile>, SandboxError> {
    let text = fs::read_to_string(path).map_err(|err| SandboxError::InvalidRequest {
        message: format!("failed to read profiles file {}: {err}", path.display()),
    })?;
    serde_json::from_str(&text).map_err(|err| SandboxError::InvalidRequest {
        message: format!("invalid profiles file {}: {err}", path.display()),
    })
}

type Key = (String, String);

fn key(agent: AgentId, name: &str) -> Key {
    (agent.as_str().to_string(), name.to_string())
}

#[derive(Debug)]
pub struct ProfileStore {
    /// `None`: in-memory store (in-process tests, embedders); nothing touches disk.
    dir: Option<PathBuf>,
    entries: RwLock<BTreeMap<Key, StoredProfile>>,
}

impl ProfileStore {
    /// Empty store that never reads or writes disk. Used by `AppState`
    /// constructors other than the CLI server path.
    pub fn in_memory() -> Self {
        Self { dir: None, entries: RwLock::new(BTreeMap::new()) }
    }

    /// Loads API profiles from `<dir>/<agent>/<name>.json`. Unreadable or
    /// invalid files are skipped with a warning; nothing is written.
    pub fn load(dir: PathBuf) -> Self {
        let mut entries = BTreeMap::new();
        if let Ok(agent_dirs) = fs::read_dir(&dir) {
            for agent_dir in agent_dirs.flatten() {
                let file_name = agent_dir.file_name();
                let Some(agent) = file_name.to_str().and_then(AgentId::parse) else {
                    continue;
                };
                let Ok(files) = fs::read_dir(agent_dir.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                        continue;
                    }
                    let Some(name) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else {
                        continue;
                    };
                    match read_profile_file(&path, agent, &name) {
                        Ok(profile) => {
                            entries.insert(
                                key(agent, &name),
                                StoredProfile { agent, name, source: ProfileSource::Api, profile },
                            );
                        }
                        Err(err) => tracing::warn!(
                            path = %path.display(),
                            error = %err,
                            "profiles: skipping unreadable profile file"
                        ),
                    }
                }
            }
        }
        Self { dir: Some(dir), entries: RwLock::new(entries) }
    }

    /// Adds the read-only profiles from `--profiles`. They replace API
    /// profiles with the same agent and name.
    pub fn install_file_profiles(&self, profiles: Vec<AgentProfile>) -> Result<(), SandboxError> {
        let mut entries = self.entries.write().expect("profile store lock");
        let mut seen = std::collections::BTreeSet::new();
        for mut profile in profiles {
            let agent_raw = profile
                .agent
                .clone()
                .ok_or_else(|| profile_invalid("a profile in the profiles file has no 'agent'", &["agent"]))?;
            let agent = AgentId::parse(&agent_raw)
                .ok_or_else(|| SandboxError::UnsupportedAgent { agent: agent_raw.clone() })?;
            let name = profile.name.clone().ok_or_else(|| {
                profile_invalid(format!("a '{agent_raw}' profile in the profiles file has no 'name'"), &["name"])
            })?;
            validate_profile_name(&name)?;
            if !seen.insert(key(agent, &name)) {
                return Err(profile_invalid(
                    format!("profile '{agent_raw}/{name}' appears twice in the profiles file"),
                    &["name"],
                ));
            }
            validate_profile_shape(&profile)?;
            profile.agent = Some(agent.as_str().to_string());
            entries.insert(
                key(agent, &name),
                StoredProfile { agent, name, source: ProfileSource::File, profile },
            );
        }
        for stored in entries.values().filter(|stored| stored.source == ProfileSource::File) {
            let resolved = resolve_in(&entries, stored.agent, &stored.name)?;
            validate_customization(stored.agent, &resolved)?;
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<StoredProfile> {
        self.entries.read().expect("profile store lock").values().cloned().collect()
    }

    pub fn get(&self, agent: AgentId, name: &str) -> Option<StoredProfile> {
        self.entries.read().expect("profile store lock").get(&key(agent, name)).cloned()
    }

    /// The profile merged through its `extends` chain.
    pub fn resolve(&self, agent: AgentId, name: &str) -> Result<AgentProfile, SandboxError> {
        let entries = self.entries.read().expect("profile store lock");
        resolve_in(&entries, agent, name)
    }

    /// Creates or replaces an API profile. Nothing changes when any check fails.
    pub fn put(&self, agent: AgentId, name: &str, mut profile: AgentProfile) -> Result<StoredProfile, SandboxError> {
        validate_profile_name(name)?;
        if let Some(body_agent) = profile.agent.as_deref() {
            if body_agent != agent.as_str() {
                return Err(profile_invalid(
                    format!("body agent '{body_agent}' does not match '{}' in the path", agent.as_str()),
                    &["agent"],
                ));
            }
        }
        if let Some(body_name) = profile.name.as_deref() {
            if body_name != name {
                return Err(profile_invalid(
                    format!("body name '{body_name}' does not match '{name}' in the path"),
                    &["name"],
                ));
            }
        }

        let mut entries = self.entries.write().expect("profile store lock");
        let existing = entries.get(&key(agent, name));
        if existing.is_some_and(|stored| stored.source == ProfileSource::File) {
            return Err(SandboxError::ProfileReadOnly {
                agent: agent.as_str().to_string(),
                name: name.to_string(),
            });
        }
        restore_masked_secrets(&mut profile, existing.map(|stored| &stored.profile))?;
        profile.agent = Some(agent.as_str().to_string());
        profile.name = Some(name.to_string());
        validate_profile_shape(&profile)?;

        let stored = StoredProfile {
            agent,
            name: name.to_string(),
            source: ProfileSource::Api,
            profile,
        };
        let mut candidate = entries.clone();
        candidate.insert(key(agent, name), stored.clone());
        let resolved = resolve_in(&candidate, agent, name)?;
        validate_customization(agent, &resolved)?;

        let body = serde_json::to_vec_pretty(&stored.profile).map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        if let Some(path) = self.profile_path(agent, name) {
            write_atomic(&path, &body).map_err(|err| SandboxError::StreamError {
                message: format!("failed to write profile {}/{name}: {err}", agent.as_str()),
            })?;
        }
        *entries = candidate;
        Ok(stored)
    }

    pub fn delete(&self, agent: AgentId, name: &str) -> Result<(), SandboxError> {
        let mut entries = self.entries.write().expect("profile store lock");
        let existing = entries
            .get(&key(agent, name))
            .ok_or_else(|| profile_not_found(agent, name))?;
        if existing.source == ProfileSource::File {
            return Err(SandboxError::ProfileReadOnly {
                agent: agent.as_str().to_string(),
                name: name.to_string(),
            });
        }
        let dependents: Vec<String> = entries
            .values()
            .filter(|stored| {
                stored.agent == agent
                    && stored
                        .profile
                        .extends
                        .as_deref()
                        .and_then(|raw| parse_extends(agent, raw).ok())
                        .as_deref()
                        == Some(name)
            })
            .map(|stored| format!("{}/{}", stored.agent.as_str(), stored.name))
            .collect();
        if !dependents.is_empty() {
            return Err(SandboxError::Conflict {
                message: format!(
                    "profile '{}/{name}' is extended by: {}",
                    agent.as_str(),
                    dependents.join(", ")
                ),
            });
        }
        match self.profile_path(agent, name).map(fs::remove_file).unwrap_or(Ok(())) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(SandboxError::StreamError {
                    message: format!("failed to delete profile {}/{name}: {err}", agent.as_str()),
                })
            }
        }
        entries.remove(&key(agent, name));
        Ok(())
    }

    fn profile_path(&self, agent: AgentId, name: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|dir| dir.join(agent.as_str()).join(format!("{name}.json")))
    }
}

fn resolve_in(
    entries: &BTreeMap<Key, StoredProfile>,
    agent: AgentId,
    name: &str,
) -> Result<AgentProfile, SandboxError> {
    resolve_chain(agent, name, |candidate| {
        entries.get(&key(agent, candidate)).map(|stored| &stored.profile)
    })
}

fn read_profile_file(path: &Path, agent: AgentId, name: &str) -> Result<AgentProfile, String> {
    validate_profile_name(name).map_err(|err| err.to_string())?;
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut profile: AgentProfile = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    profile.agent = Some(agent.as_str().to_string());
    profile.name = Some(name.to_string());
    Ok(profile)
}

/// Writes to a temporary file next to `path`, then renames it over `path`.
/// The file is readable only by its owner: it holds secrets.
fn write_atomic(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "profile path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("profile.json");
    let tmp = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::` → все тесты `profiles::` проходят (`11` из store плюс прежние).

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/profiles/
git commit -m "feat(server): profile store in the server state directory with atomic writes (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: HTTP `/v1/config/profiles` и флаг `--profiles`

**Files:**
- Create: `server/packages/sandbox-agent/tests/profiles_http.rs`
- Modify: `server/packages/sandbox-agent/src/profiles/mod.rs`
- Modify: `server/packages/sandbox-agent/src/router.rs` (`AppState` 94-177, роуты около 318, новые обработчики после `delete_v1_config_skills`, `ApiDoc`)
- Modify: `server/packages/sandbox-agent/src/router/types.rs`
- Modify: `server/packages/sandbox-agent/src/cli.rs` (`ServerArgs`, `run_server` 469-493, тесты)

- [ ] **Step 1: Write the failing tests**

`server/packages/sandbox-agent/tests/profiles_http.rs`:

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use sandbox_agent::profiles::{AgentProfile, ProfileStore};
use sandbox_agent::router::{build_router, AppState, AuthConfig, BrandingMode, DEFAULT_ACP_REQUEST_TIMEOUT};
use sandbox_agent_agent_management::agents::AgentManager;
use serde_json::{json, Value};
use tower::util::ServiceExt;

struct Harness {
    app: Router,
    state_dir: tempfile::TempDir,
    _install_dir: tempfile::TempDir,
}

fn harness(file_profiles: Vec<Value>) -> Harness {
    let install_dir = tempfile::tempdir().expect("install dir");
    let state_dir = tempfile::tempdir().expect("state dir");
    let store = Arc::new(ProfileStore::load(state_dir.path().join("profiles")));
    let file_profiles: Vec<AgentProfile> = file_profiles
        .into_iter()
        .map(|value| serde_json::from_value(value).expect("file profile"))
        .collect();
    store.install_file_profiles(file_profiles).expect("file profiles");
    let manager = AgentManager::new(install_dir.path()).expect("agent manager");
    let state = AppState::with_profile_store(
        AuthConfig::disabled(),
        manager,
        BrandingMode::SandboxAgent,
        DEFAULT_ACP_REQUEST_TIMEOUT,
        store,
    );
    Harness { app: build_router(state), state_dir, _install_dir: install_dir }
}

async fn call(app: &Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app.clone().oneshot(builder.body(body).expect("request")).await.expect("response");
    let status = response.status();
    let bytes = response.into_body().collect().await.expect("body").to_bytes();
    let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).expect("json body") };
    (status, value)
}

#[tokio::test]
async fn profiles_crud_masks_secrets_and_keeps_masked_values() {
    let h = harness(Vec::new());
    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/base",
        Some(json!({
            "process": { "env": { "TOKEN": "s3cret" } },
            "session": {
                "systemPrompt": { "mode": "append", "text": "Be brief." },
                "mcpServers": [{
                    "type": "http", "name": "gh", "url": "https://example.com/mcp",
                    "headers": [{ "name": "Authorization", "value": "Bearer s3cret-header" }]
                }]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.to_string().contains("s3cret"), "{body}");
    assert_eq!(body["source"], "api");
    assert_eq!(body["stored"]["process"]["env"]["TOKEN"], "***");
    assert_eq!(body["hasValue"]["process.env.TOKEN"], true);
    assert_eq!(body["stored"]["session"]["mcpServers"][0]["headers"][0]["value"], "***");
    assert_eq!(body["hasValue"]["session.mcpServers.gh.headers.Authorization"], true);

    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/review",
        Some(json!({ "extends": "base", "session": { "systemPrompt": { "mode": "replace", "text": "Review only." } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles/mock/review", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["stored"]["extends"], "base");
    assert!(body["stored"]["process"].is_null());
    assert_eq!(body["resolved"]["process"]["env"]["TOKEN"], "***");
    assert_eq!(body["resolved"]["session"]["systemPrompt"], json!({ "mode": "replace", "text": "Review only." }));
    assert_eq!(body["hasValue"]["process.env.TOKEN"], true);

    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["profiles"],
        json!([
            { "agent": "mock", "name": "base", "source": "api" },
            { "agent": "mock", "name": "review", "source": "api", "extends": "base" }
        ])
    );

    let (status, _) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/base",
        Some(json!({ "process": { "env": { "TOKEN": "***", "EXTRA": "x" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let on_disk = std::fs::read_to_string(h.state_dir.path().join("profiles/mock/base.json")).expect("profile file");
    assert!(on_disk.contains("s3cret"), "{on_disk}");
    assert!(on_disk.contains("EXTRA"), "{on_disk}");

    let (status, body) = call(&h.app, Method::DELETE, "/v1/config/profiles/mock/base", None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, _) = call(&h.app, Method::DELETE, "/v1/config/profiles/mock/review", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles/mock/review", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["type"], "urn:sandbox-agent:error:not_found");
}

#[tokio::test]
async fn profiles_put_rejects_invalid_profiles() {
    let h = harness(Vec::new());
    let cases = [
        ("/v1/config/profiles/mock/a", json!({ "extends": "ghost" }), json!(["extends"])),
        ("/v1/config/profiles/mock/a", json!({ "extends": "codex/base" }), json!(["extends"])),
        (
            "/v1/config/profiles/codex/a",
            json!({ "session": { "systemPrompt": { "mode": "replace", "text": "x" }, "skills": [] } }),
            json!(["session.systemPrompt", "session.skills"]),
        ),
        ("/v1/config/profiles/mock/-bad", json!({}), json!(["name"])),
        ("/v1/config/profiles/mock/a", json!({ "process": { "env": { "T": "***" } } }), json!(["process.env.T"])),
    ];
    for (uri, body, fields) in cases {
        let (status, problem) = call(&h.app, Method::PUT, uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} {body} -> {problem}");
        assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_invalid", "{problem}");
        assert_eq!(problem["details"]["fields"], fields, "{uri} {body}");
    }

    let (status, problem) = call(&h.app, Method::PUT, "/v1/config/profiles/mock/a", Some(json!({ "sesion": {} }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_invalid");

    let (status, problem) = call(&h.app, Method::PUT, "/v1/config/profiles/nope/a", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:unsupported_agent");

    let (status, problem) = call(&h.app, Method::PUT, "/v1/config/profiles/mock/b", Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{problem}");
    let (status, problem) = call(&h.app, Method::PUT, "/v1/config/profiles/mock/c", Some(json!({ "extends": "b" }))).await;
    assert_eq!(status, StatusCode::OK, "{problem}");
    let (status, problem) = call(&h.app, Method::PUT, "/v1/config/profiles/mock/b", Some(json!({ "extends": "c" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(problem["detail"].as_str().unwrap().contains("cycle"), "{problem}");
}

#[tokio::test]
async fn file_profiles_are_listed_and_read_only() {
    let h = harness(vec![json!({ "agent": "mock", "name": "ops", "process": { "env": { "A": "1" } } })]);
    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["profiles"], json!([{ "agent": "mock", "name": "ops", "source": "file" }]));

    let (status, problem) = call(&h.app, Method::PUT, "/v1/config/profiles/mock/ops", Some(json!({}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_read_only");

    let (status, problem) = call(&h.app, Method::DELETE, "/v1/config/profiles/mock/ops", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_read_only");

    let (status, body) = call(&h.app, Method::PUT, "/v1/config/profiles/mock/child", Some(json!({ "extends": "ops" }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["resolved"]["process"]["env"]["A"], "***");
}
```

В `cli.rs` в `mod tests` добавить:

```rust
    #[test]
    fn server_parses_profiles_flag() {
        let cli = SandboxAgentCli::try_parse_from([
            "sandbox-agent",
            "server",
            "--profiles",
            "/etc/sandbox-agent/profiles.json",
        ])
        .expect("parse server args");
        match cli.command {
            Command::Server(args) => assert_eq!(
                args.profiles,
                Some(PathBuf::from("/etc/sandbox-agent/profiles.json"))
            ),
            other => panic!("unexpected command: {other:?}"),
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test profiles_http`
Expected: FAIL to compile, `no function or associated item named with_profile_store found for struct AppState`.

- [ ] **Step 3: Wire the store into `AppState`**

`profiles/mod.rs`: добавить `pub(crate) use model::{profile_invalid, profile_not_found};`.

В `router.rs` импорт рядом с `use crate::ui;`:

```rust
use crate::profiles::{
    mask_profile, profile_invalid, profile_not_found, server_state_dir, AgentProfile,
    ProfileStore, StoredProfile,
};
```

В `struct AppState` после `desktop_runtime: Arc<DesktopRuntime>,` добавить `profiles: Arc<ProfileStore>,`.

Заменить `with_acp_request_timeout` на:

```rust
    /// Like [`AppState::with_branding`], with an explicit ACP request timeout
    /// (already resolved from `--acp-request-timeout-ms` / env / default).
    /// Profiles live in memory only: in-process tests and embedders must not
    /// read or write the developer's real state directory. The CLI server path
    /// loads the persistent store explicitly via [`AppState::with_profile_store`].
    pub fn with_acp_request_timeout(
        auth: AuthConfig,
        agent_manager: AgentManager,
        branding: BrandingMode,
        acp_request_timeout: Duration,
    ) -> Self {
        let profiles = Arc::new(ProfileStore::in_memory());
        Self::with_profile_store(auth, agent_manager, branding, acp_request_timeout, profiles)
    }

    /// Like [`AppState::with_acp_request_timeout`], with an explicit profile
    /// store (the CLI loads `--profiles` into it before the server starts).
    pub fn with_profile_store(
        auth: AuthConfig,
        agent_manager: AgentManager,
        branding: BrandingMode,
        acp_request_timeout: Duration,
        profiles: Arc<ProfileStore>,
    ) -> Self {
        let agent_manager = Arc::new(agent_manager);
        let acp_proxy = Arc::new(AcpProxyRuntime::new(
            agent_manager.clone(),
            acp_request_timeout,
        ));
        let opencode_server_manager = Arc::new(OpenCodeServerManager::new(
            agent_manager.clone(),
            OpenCodeServerManagerConfig {
                log_dir: default_opencode_server_log_dir(),
                auto_restart: true,
            },
        ));
        let process_runtime = Arc::new(ProcessRuntime::new());
        let desktop_runtime = Arc::new(DesktopRuntime::new(process_runtime.clone()));
        Self {
            auth,
            agent_manager,
            acp_proxy,
            opencode_server_manager,
            process_runtime,
            desktop_runtime,
            profiles,
            branding,
            version_cache: Mutex::new(HashMap::new()),
        }
    }
```

(T10 меняет здесь `AcpProxyRuntime::new(agent_manager.clone(), acp_request_timeout)` на вызов с третьим аргументом `profiles.clone()`.)

После `desktop_runtime()` добавить:

```rust
    pub(crate) fn profiles(&self) -> Arc<ProfileStore> {
        self.profiles.clone()
    }
```

- [ ] **Step 4: Add response types**

В конец `router/types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub agent: String,
    pub name: String,
    pub source: crate::profiles::ProfileSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileListResponse {
    pub profiles: Vec<ProfileSummary>,
}

/// One profile as stored and as resolved through `extends`. Values of
/// `process.env`, `session.pluginConfigs` and the `env`/`headers` entries of
/// `session.mcpServers` are masked as `***`; `hasValue` says which of them are
/// set (keys like `process.env.TOKEN`, `session.mcpServers.gh.headers.Authorization`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDetailResponse {
    pub agent: String,
    pub name: String,
    pub source: crate::profiles::ProfileSource,
    pub stored: crate::profiles::AgentProfile,
    pub resolved: crate::profiles::AgentProfile,
    pub has_value: BTreeMap<String, bool>,
}
```

- [ ] **Step 5: Add handlers and routes**

В `build_router_with_state` после роута `/config/skills`:

```rust
        .route("/config/profiles", get(get_v1_config_profiles))
        .route(
            "/config/profiles/:agent/:name",
            get(get_v1_config_profile)
                .put(put_v1_config_profile)
                .delete(delete_v1_config_profile),
        )
```

В `router.rs` после `delete_v1_config_skills`:

```rust
/// List agent profiles.
///
/// Returns every profile with its source (`api` or `file`) and parent.
#[utoipa::path(
    get,
    path = "/v1/config/profiles",
    tag = "v1",
    responses(
        (status = 200, description = "Stored agent profiles", body = ProfileListResponse)
    )
)]
async fn get_v1_config_profiles(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProfileListResponse>, ApiError> {
    let profiles = state
        .profiles()
        .list()
        .into_iter()
        .map(|stored| ProfileSummary {
            agent: stored.agent.as_str().to_string(),
            name: stored.name,
            source: stored.source,
            extends: stored.profile.extends,
        })
        .collect();
    Ok(Json(ProfileListResponse { profiles }))
}

/// Get one agent profile.
///
/// Returns the stored profile and the profile resolved through `extends`, with
/// `process.env`, `session.pluginConfigs` and MCP server `env`/`headers` values
/// masked as `***`.
#[utoipa::path(
    get,
    path = "/v1/config/profiles/{agent}/{name}",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id"),
        ("name" = String, Path, description = "Profile name")
    ),
    responses(
        (status = 200, description = "Stored and resolved profile, secrets masked", body = ProfileDetailResponse),
        (status = 400, description = "Unknown agent", body = ProblemDetails),
        (status = 404, description = "Profile not found", body = ProblemDetails)
    )
)]
async fn get_v1_config_profile(
    State(state): State<Arc<AppState>>,
    Path((agent, name)): Path<(String, String)>,
) -> Result<Json<ProfileDetailResponse>, ApiError> {
    let agent = parse_agent_path(&agent)?;
    let stored = state
        .profiles()
        .get(agent, &name)
        .ok_or_else(|| profile_not_found(agent, &name))?;
    Ok(Json(profile_detail(&state, stored)?))
}

/// Create or replace an agent profile.
///
/// A `***` value in `process.env`, `session.pluginConfigs` or an MCP server's
/// `env`/`headers` entry keeps the stored value. Running agent servers keep the `process` part they started with.
#[utoipa::path(
    put,
    path = "/v1/config/profiles/{agent}/{name}",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id"),
        ("name" = String, Path, description = "Profile name")
    ),
    request_body = AgentProfile,
    responses(
        (status = 200, description = "Profile stored; stored and resolved profile, secrets masked", body = ProfileDetailResponse),
        (status = 400, description = "Invalid profile: name, JSON, extends cycle or unknown parent, or fields the agent does not support (listed in details.fields)", body = ProblemDetails),
        (status = 409, description = "Profile comes from the --profiles file and is read-only", body = ProblemDetails)
    )
)]
async fn put_v1_config_profile(
    State(state): State<Arc<AppState>>,
    Path((agent, name)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<ProfileDetailResponse>, ApiError> {
    let agent = parse_agent_path(&agent)?;
    let profile: AgentProfile = serde_json::from_slice(&body)
        .map_err(|err| profile_invalid(format!("invalid profile JSON: {err}"), &[]))?;
    let stored = state.profiles().put(agent, &name, profile)?;
    Ok(Json(profile_detail(&state, stored)?))
}

/// Delete an agent profile.
///
/// Running agent servers keep the settings they started with.
#[utoipa::path(
    delete,
    path = "/v1/config/profiles/{agent}/{name}",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id"),
        ("name" = String, Path, description = "Profile name")
    ),
    responses(
        (status = 204, description = "Profile deleted"),
        (status = 404, description = "Profile not found", body = ProblemDetails),
        (status = 409, description = "Profile is read-only or another profile extends it", body = ProblemDetails)
    )
)]
async fn delete_v1_config_profile(
    State(state): State<Arc<AppState>>,
    Path((agent, name)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let agent = parse_agent_path(&agent)?;
    state.profiles().delete(agent, &name)?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_agent_path(agent: &str) -> Result<AgentId, SandboxError> {
    AgentId::parse(agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.to_string(),
    })
}

fn profile_detail(state: &AppState, stored: StoredProfile) -> Result<ProfileDetailResponse, SandboxError> {
    let resolved = state.profiles().resolve(stored.agent, &stored.name)?;
    let (stored_masked, _) = mask_profile(&stored.profile);
    let (resolved_masked, has_value) = mask_profile(&resolved);
    Ok(ProfileDetailResponse {
        agent: stored.agent.as_str().to_string(),
        name: stored.name,
        source: stored.source,
        stored: stored_masked,
        resolved: resolved_masked,
        has_value,
    })
}
```

В `ApiDoc` `paths(...)` после `delete_v1_config_skills,` добавить `get_v1_config_profiles, get_v1_config_profile, put_v1_config_profile, delete_v1_config_profile,`. В `schemas(...)` после `SkillSource,` добавить:

```rust
            AgentProfile,
            crate::profiles::ProfileProcess,
            crate::profiles::ProfileSession,
            crate::profiles::SystemPrompt,
            crate::profiles::ProfilePlugin,
            crate::profiles::ProfileSource,
            ProfileSummary,
            ProfileListResponse,
            ProfileDetailResponse,
```

- [ ] **Step 6: Add the `--profiles` server flag**

В `ServerArgs` после `acp_request_timeout_ms`:

```rust
    /// JSON array of agent profiles loaded at startup. They are read-only and
    /// win over profiles created through the API with the same agent and name.
    #[arg(long = "profiles", value_name = "FILE")]
    profiles: Option<PathBuf>,
```

В импорты `cli.rs`: `use crate::profiles::{load_profiles_file, server_state_dir, ProfileStore};`.

В `run_server` заменить построение `state` на:

```rust
    let profiles = Arc::new(ProfileStore::load(server_state_dir().join("profiles")));
    if let Some(path) = server.profiles.as_deref() {
        let file_profiles =
            load_profiles_file(path).map_err(|err| CliError::Server(err.to_string()))?;
        profiles
            .install_file_profiles(file_profiles)
            .map_err(|err| CliError::Server(format!("profiles file {}: {err}", path.display())))?;
    }
    let state = Arc::new(AppState::with_profile_store(
        auth,
        agent_manager,
        branding,
        acp_request_timeout,
        profiles,
    ));
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test profiles_http` → `3 passed`.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib cli::tests::server_parses_profiles_flag` → `1 passed`.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test opencode_openapi --test agent_customization --test openapi_deprecated` → ok.

- [ ] **Step 8: Commit**

```bash
git add server/packages/sandbox-agent/src/ server/packages/sandbox-agent/tests/profiles_http.rs
git commit -m "feat(server): /v1/config/profiles API and --profiles startup file (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: CLI `sandbox-agent profiles` и `api acp post --profile`

**Files:**
- Modify: `server/packages/sandbox-agent/src/cli.rs` (`Command`, `run_command`, `AcpPostArgs`, `run_acp`, `build_acp_server_path` 1632-1659, `ClientContext`, вызов около 946, тесты)

- [ ] **Step 1: Write the failing tests**

В `mod tests` в `cli.rs`:

```rust
    #[test]
    fn profiles_put_parses_agent_name_and_payload() {
        let cli = SandboxAgentCli::try_parse_from([
            "sandbox-agent",
            "profiles",
            "put",
            "claude",
            "review",
            "--json-file",
            "/tmp/review.json",
            "--endpoint",
            "http://127.0.0.1:3000",
        ])
        .expect("parse profiles put");
        match cli.command {
            Command::Profiles(args) => match args.command {
                ProfilesCommand::Put(put) => {
                    assert_eq!(put.agent, "claude");
                    assert_eq!(put.name, "review");
                    assert_eq!(put.json_file, Some(PathBuf::from("/tmp/review.json")));
                    assert_eq!(put.client.endpoint.as_deref(), Some("http://127.0.0.1:3000"));
                }
                other => panic!("unexpected profiles command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn profiles_list_get_delete_parse() {
        for args in [
            vec!["sandbox-agent", "profiles", "list"],
            vec!["sandbox-agent", "profiles", "get", "claude", "review"],
            vec!["sandbox-agent", "profiles", "delete", "claude", "review"],
        ] {
            let cli = SandboxAgentCli::try_parse_from(args.iter().copied()).expect("parse");
            assert!(matches!(cli.command, Command::Profiles(_)), "{args:?}");
        }
    }

    #[test]
    fn profile_path_validates_parts() {
        assert_eq!(profile_path("claude", "review").unwrap(), "/v1/config/profiles/claude/review");
        assert!(profile_path("claude", "a/b").is_err());
        assert!(profile_path(" ", "review").is_err());
    }

    #[test]
    fn acp_server_path_includes_profile() {
        assert_eq!(
            build_acp_server_path("s1", Some("claude"), Some("review")).unwrap(),
            "/v1/acp/s1?agent=claude&profile=review"
        );
        assert_eq!(build_acp_server_path("s1", None, Some("review")).unwrap(), "/v1/acp/s1?profile=review");
        assert_eq!(build_acp_server_path("s1", Some("mock"), None).unwrap(), "/v1/acp/s1?agent=mock");
        assert_eq!(build_acp_server_path("s1", None, None).unwrap(), "/v1/acp/s1");
        assert!(build_acp_server_path("s1", None, Some(" ")).is_err());
    }

    #[test]
    fn acp_post_parses_profile() {
        let cli = SandboxAgentCli::try_parse_from([
            "sandbox-agent", "api", "acp", "post", "--server-id", "s1", "--agent", "claude", "--profile", "review", "--json", "{}",
        ])
        .expect("parse acp post");
        match cli.command {
            Command::Api(api) => match api.command {
                ApiCommand::Acp(acp) => match acp.command {
                    AcpCommand::Post(post) => assert_eq!(post.profile.as_deref(), Some("review")),
                    other => panic!("unexpected acp command: {other:?}"),
                },
                other => panic!("unexpected api command: {other:?}"),
            },
            other => panic!("unexpected command: {other:?}"),
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib cli::tests`
Expected: FAIL to compile, `no variant named Profiles found for enum Command`.

- [ ] **Step 3: Implement**

В `enum Command` после `Credentials(CredentialsArgs),`:

```rust
    /// Manage agent profiles on a running server.
    Profiles(ProfilesArgs),
```

После `pub struct CredentialsArgs`:

```rust
#[derive(Args, Debug)]
pub struct ProfilesArgs {
    #[command(subcommand)]
    command: ProfilesCommand,
}

#[derive(Subcommand, Debug)]
pub enum ProfilesCommand {
    /// List profiles (agent, name, source, extends).
    List(ClientArgs),
    /// Show one profile, stored and resolved, with secrets masked.
    Get(ProfileRefArgs),
    /// Create or replace a profile from JSON (`***` keeps a stored secret).
    Put(ProfilePutArgs),
    /// Delete a profile.
    Delete(ProfileRefArgs),
}

#[derive(Args, Debug)]
pub struct ProfileRefArgs {
    agent: String,
    name: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct ProfilePutArgs {
    agent: String,
    name: String,
    #[arg(long)]
    json: Option<String>,
    #[arg(long = "json-file")]
    json_file: Option<PathBuf>,
    #[command(flatten)]
    client: ClientArgs,
}
```

В `AcpPostArgs` после `agent`:

```rust
    /// Agent profile for the server this request creates.
    #[arg(long = "profile")]
    profile: Option<String>,
```

В `run_command` после `Credentials`: `Command::Profiles(subcommand) => run_profiles(&subcommand.command, cli),`.

После `run_acp`:

```rust
fn run_profiles(command: &ProfilesCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        ProfilesCommand::List(args) => {
            let ctx = ClientContext::new(cli, args)?;
            print_json_or_empty(ctx.get(&format!("{API_PREFIX}/config/profiles"))?)
        }
        ProfilesCommand::Get(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            print_json_or_empty(ctx.get(&profile_path(&args.agent, &args.name)?)?)
        }
        ProfilesCommand::Put(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let payload = load_json_payload(args.json.as_deref(), args.json_file.as_deref())?;
            print_json_or_empty(ctx.put(&profile_path(&args.agent, &args.name)?, &payload)?)
        }
        ProfilesCommand::Delete(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            print_empty_response(ctx.delete(&profile_path(&args.agent, &args.name)?)?)
        }
    }
}

fn profile_path(agent: &str, name: &str) -> Result<String, CliError> {
    for (label, value) in [("agent", agent), ("name", name)] {
        let value = value.trim();
        if value.is_empty() {
            return Err(CliError::Server(format!("profile {label} must not be empty")));
        }
        if value.contains('/') {
            return Err(CliError::Server(format!("profile {label} must not contain '/'")));
        }
    }
    Ok(format!("{API_PREFIX}/config/profiles/{}/{}", agent.trim(), name.trim()))
}
```

В `impl ClientContext` после `post`:

```rust
    fn put<T: Serialize>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::PUT, path).json(body).send()?)
    }
```

Заменить `build_acp_server_path` целиком:

```rust
fn build_acp_server_path(
    server_id: &str,
    bootstrap_agent: Option<&str>,
    profile: Option<&str>,
) -> Result<String, CliError> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Err(CliError::Server("server id must not be empty".to_string()));
    }
    if server_id.contains('/') {
        return Err(CliError::Server(
            "server id must not contain '/'".to_string(),
        ));
    }

    let mut query = Vec::new();
    if let Some(agent) = bootstrap_agent {
        let agent = agent.trim();
        if agent.is_empty() {
            return Err(CliError::Server(
                "agent must not be empty when provided".to_string(),
            ));
        }
        query.push(format!("agent={agent}"));
    }
    if let Some(profile) = profile {
        let profile = profile.trim();
        if profile.is_empty() {
            return Err(CliError::Server(
                "profile must not be empty when provided".to_string(),
            ));
        }
        query.push(format!("profile={profile}"));
    }

    let mut path = format!("{API_PREFIX}/acp/{server_id}");
    if !query.is_empty() {
        path.push('?');
        path.push_str(&query.join("&"));
    }
    Ok(path)
}
```

Обновить вызовы: около 946 `build_acp_server_path(&server_id, Some("mock"), None)?` и `build_acp_server_path(&server_id, None, None)?`; в `run_acp` Post: `build_acp_server_path(&args.server_id, args.agent.as_deref(), args.profile.as_deref())?`; Stream и Close: `build_acp_server_path(&args.server_id, None, None)?`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib cli::tests` → все проходят.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent && ./target/debug/sandbox-agent profiles --help` → в выводе `list`, `get`, `put`, `delete`.

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/cli.rs
git commit -m "feat(cli): profiles list|get|put|delete and api acp post --profile (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Профиль на уровне процесса: `?profile=`, env, закрепление, 409, `profileStale`

**Files:**
- Create: `server/packages/sandbox-agent/tests/v1_api/profiles.rs`
- Modify: `server/packages/sandbox-agent/tests/v1_api.rs`
- Modify: `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`
- Modify: `server/packages/sandbox-agent/src/router.rs` (`with_profile_store`, `post_v1_acp` 3216-3299, `get_v1_acp_servers` 3186-3212)
- Modify: `server/packages/sandbox-agent/src/router/types.rs` (`AcpPostQuery`, `AcpServerInfo`)

- [ ] **Step 1: Write the failing Docker tests**

`server/packages/sandbox-agent/tests/v1_api/profiles.rs`:

```rust
//! Agent profiles applied by the agent server proxy, observed through the
//! built-in mock agent (`mock/env` hook and its echoed requests).
use super::*;

async fn install_mock(app: &docker_support::DockerApp) {
    let (status, _, body) =
        send_request(app, Method::POST, "/v1/agents/mock/install", Some(json!({})), &[]).await;
    assert!(status.is_success(), "install mock: {status} {}", String::from_utf8_lossy(&body));
}

async fn put_profile(app: &docker_support::DockerApp, agent: &str, name: &str, body: Value) {
    let (status, _, response) = send_request(
        app,
        Method::PUT,
        &format!("/v1/config/profiles/{agent}/{name}"),
        Some(body),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "put profile: {}", String::from_utf8_lossy(&response));
}

async fn acp(app: &docker_support::DockerApp, path: &str, payload: Value) -> (StatusCode, Value) {
    let (status, _, body) = send_request(app, Method::POST, path, Some(payload), &[]).await;
    (status, parse_json(&body))
}

fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

async fn server_entry(app: &docker_support::DockerApp, server_id: &str) -> Value {
    let (status, _, body) = send_request(app, Method::GET, "/v1/acp", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    parse_json(&body)["servers"]
        .as_array()
        .expect("servers")
        .iter()
        .find(|server| server["serverId"] == server_id)
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test]
async fn profile_env_reaches_agent_process_and_profile_is_pinned() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "envp", json!({ "process": { "env": { "PROFILE_PROBE": "from-profile" } } })).await;

    let (status, body) = acp(&test_app.app, "/v1/acp/srv-env?agent=mock&profile=envp", initialize_payload()).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = acp(&test_app.app, "/v1/acp/srv-env", rpc(2, "mock/env", json!({ "names": ["PROFILE_PROBE"] }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["env"]["PROFILE_PROBE"], "from-profile");

    let (status, body) = acp(&test_app.app, "/v1/acp/srv-env?profile=other", rpc(3, "mock/env", json!({ "names": [] }))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["type"], "urn:sandbox-agent:error:profile_mismatch");
    assert_eq!(body["details"]["boundProfile"], "envp");

    let (status, _) = acp(&test_app.app, "/v1/acp/srv-env?profile=envp", rpc(4, "mock/env", json!({ "names": [] }))).await;
    assert_eq!(status, StatusCode::OK);

    let entry = server_entry(&test_app.app, "srv-env").await;
    assert_eq!(entry["profile"], "envp");
    assert_eq!(entry["profileStale"], false);
}

#[tokio::test]
async fn server_without_profile_rejects_a_profile() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "envp", json!({})).await;
    let (status, _) = acp(&test_app.app, "/v1/acp/srv-plain?agent=mock", initialize_payload()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = acp(&test_app.app, "/v1/acp/srv-plain?profile=envp", rpc(2, "mock/env", json!({ "names": [] }))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["details"]["boundProfile"], Value::Null);
    let entry = server_entry(&test_app.app, "srv-plain").await;
    assert!(entry.get("profile").is_none(), "{entry}");
    assert!(entry.get("profileStale").is_none(), "{entry}");
}

#[tokio::test]
async fn unknown_profile_starts_no_server() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    let (status, body) = acp(&test_app.app, "/v1/acp/srv-ghost?agent=mock&profile=ghost", initialize_payload()).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(server_entry(&test_app.app, "srv-ghost").await, Value::Null);
}

#[tokio::test]
async fn process_change_marks_server_stale() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "stale", json!({ "process": { "env": { "A": "1" } } })).await;
    let (status, _) = acp(&test_app.app, "/v1/acp/srv-stale?agent=mock&profile=stale", initialize_payload()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(server_entry(&test_app.app, "srv-stale").await["profileStale"], false);

    put_profile(
        &test_app.app,
        "mock",
        "stale",
        json!({ "process": { "env": { "A": "***" } }, "session": { "systemPrompt": { "mode": "append", "text": "x" } } }),
    )
    .await;
    assert_eq!(server_entry(&test_app.app, "srv-stale").await["profileStale"], false);

    put_profile(&test_app.app, "mock", "stale", json!({ "process": { "env": { "A": "2" } } })).await;
    assert_eq!(server_entry(&test_app.app, "srv-stale").await["profileStale"], true);

    let (status, body) = acp(&test_app.app, "/v1/acp/srv-stale", rpc(2, "mock/env", json!({ "names": ["A"] }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"]["env"]["A"], "1", "running process keeps its env");
}
```

В `tests/v1_api.rs` после модуля `processes`:

```rust
#[path = "v1_api/profiles.rs"]
mod profiles;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api profiles::`
Expected: FAIL, в `profile_env_reaches_agent_process_and_profile_is_pinned` `left: Null right: "from-profile"` (прокси игнорирует `?profile=`); `unknown_profile_starts_no_server` получает `200`.

- [ ] **Step 3: Implement the proxy part**

В `acp_proxy_runtime.rs`:

Импорт: `use crate::profiles::ProfileStore;`.

В `AcpProxyRuntimeInner` после `request_timeout: Duration,`: `profiles: Arc<ProfileStore>,`.

```rust
#[derive(Debug)]
struct ProxyInstance {
    server_id: String,
    agent: AgentId,
    runtime: Arc<AdapterRuntime>,
    created_at_ms: i64,
    profile: Option<BoundProfile>,
}

/// Profile an agent server was started with, and the `process` part it was
/// started with (to report `profileStale` once the profile changes).
#[derive(Debug, Clone)]
struct BoundProfile {
    name: String,
    process_fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct AcpServerInstanceInfo {
    pub server_id: String,
    pub agent: AgentId,
    pub created_at_ms: i64,
    pub profile: Option<String>,
    pub profile_stale: bool,
}
```

`new`:

```rust
    pub fn new(
        agent_manager: Arc<AgentManager>,
        request_timeout: Duration,
        profiles: Arc<ProfileStore>,
    ) -> Self {
        let require_preinstall = std::env::var("SANDBOX_AGENT_REQUIRE_PREINSTALL")
            .ok()
            .is_some_and(|value| {
                let trimmed = value.trim();
                trimmed == "1"
                    || trimmed.eq_ignore_ascii_case("true")
                    || trimmed.eq_ignore_ascii_case("yes")
            });

        Self {
            inner: Arc::new(AcpProxyRuntimeInner {
                agent_manager,
                require_preinstall,
                request_timeout,
                profiles,
                instances: RwLock::new(HashMap::new()),
                instance_locks: Mutex::new(HashMap::new()),
                install_locks: Mutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
            }),
        }
    }
```

`list_instances`, `.map(...)` заменить на:

```rust
            .map(|instance| AcpServerInstanceInfo {
                server_id: instance.server_id.clone(),
                agent: instance.agent,
                created_at_ms: instance.created_at_ms,
                profile: instance.profile.as_ref().map(|bound| bound.name.clone()),
                profile_stale: instance
                    .profile
                    .as_ref()
                    .is_some_and(|bound| self.profile_is_stale(instance.agent, bound)),
            })
```

и после `list_instances` добавить:

```rust
    /// True when the profile's `process` part changed, or the profile is gone,
    /// since the agent process started with it.
    fn profile_is_stale(&self, agent: AgentId, bound: &BoundProfile) -> bool {
        match self.inner.profiles.resolve(agent, &bound.name) {
            Ok(current) => current.process_fingerprint() != bound.process_fingerprint,
            Err(_) => true,
        }
    }
```

`post` и `post_with_origin` получают `profile: Option<&str>` после `bootstrap_agent`:

```rust
    pub async fn post(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
        profile: Option<&str>,
        payload: Value,
        mode: PostMode,
    ) -> Result<ProxyPostOutcome, SandboxError> {
        self.post_with_origin(server_id, bootstrap_agent, profile, payload, mode, true)
            .await
    }
```

В `post_with_origin` в лог `"acp_proxy: POST received"` добавить поле `profile = ?profile,`, вызов заменить на `self.get_or_create_instance(server_id, bootstrap_agent, profile, turn_events)`. В `AcpDispatch::post`: `.post_with_origin(&server_id, agent, None, payload, PostMode::Sync, false)`.

`get_or_create_instance` целиком:

```rust
    async fn get_or_create_instance(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
        profile: Option<&str>,
        turn_events: bool,
    ) -> Result<Arc<ProxyInstance>, SandboxError> {
        if let Some(existing) = self.live_instance(server_id).await {
            check_existing(&existing, server_id, bootstrap_agent, profile)?;
            return Ok(existing);
        }

        let lock = {
            let mut locks = self.inner.instance_locks.lock().await;
            locks
                .entry(server_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        if let Some(existing) = self.live_instance(server_id).await {
            check_existing(&existing, server_id, bootstrap_agent, profile)?;
            return Ok(existing);
        }

        let agent = bootstrap_agent.ok_or_else(|| SandboxError::InvalidRequest {
            message: format!(
                "missing required 'agent' query parameter for first POST to /v1/acp/{server_id}"
            ),
        })?;

        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(shutting_down_error());
        }
        let created = self
            .create_instance(server_id, agent, profile, turn_events)
            .await?;
        {
            let mut instances = self.inner.instances.write().await;
            if self.inner.shutting_down.load(Ordering::SeqCst) {
                drop(instances);
                created.runtime.shutdown().await;
                return Err(shutting_down_error());
            }
            instances.insert(server_id.to_string(), created.clone());
        }
        self.spawn_exit_reaper(&created);

        Ok(created)
    }
```

Свободная функция рядом с `shutting_down_error`:

```rust
/// A request for a running server must not ask for another agent or profile.
/// A request without a profile uses the profile the server was started with.
fn check_existing(
    existing: &ProxyInstance,
    server_id: &str,
    agent: Option<AgentId>,
    profile: Option<&str>,
) -> Result<(), SandboxError> {
    if let Some(agent) = agent {
        if agent != existing.agent {
            return Err(SandboxError::Conflict {
                message: format!(
                    "server '{server_id}' already exists for agent '{}'; requested '{agent}'",
                    existing.agent.as_str()
                ),
            });
        }
    }
    if let Some(requested) = profile {
        let bound = existing.profile.as_ref().map(|bound| bound.name.as_str());
        if bound != Some(requested) {
            return Err(SandboxError::ProfileMismatch {
                server_id: server_id.to_string(),
                bound: bound.map(str::to_string),
                requested: requested.to_string(),
            });
        }
    }
    Ok(())
}
```

`create_instance(&self, server_id: &str, agent: AgentId, profile: Option<&str>, turn_events: bool)`. Сразу после лога `"create_instance: starting"`:

```rust
        // Resolve the profile first: an unknown or broken profile starts no
        // agent process and installs nothing.
        let profile = match profile {
            Some(name) => Some((name.to_string(), self.inner.profiles.resolve(agent, name)?)),
            None => None,
        };
```

После блока `if agent == AgentId::Mock { ... }`:

```rust
        if let Some((name, resolved)) = &profile {
            for (key, value) in &resolved.process.env {
                launch.env.insert(key.clone(), value.clone());
            }
            tracing::info!(
                server_id = server_id,
                agent = agent.as_str(),
                profile = name.as_str(),
                env_keys = ?resolved.process.env.keys().collect::<Vec<_>>(),
                "create_instance: applied profile process env"
            );
        }
```

В конце литерала `ProxyInstance { ... }` добавить:

```rust
            profile: profile.map(|(name, resolved)| BoundProfile {
                name,
                process_fingerprint: resolved.process_fingerprint(),
            }),
```

- [ ] **Step 4: Implement the router part**

`router/types.rs`:

```rust
pub struct AcpPostQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

pub struct AcpServerInfo {
    pub server_id: String,
    pub agent: String,
    pub created_at_ms: i64,
    /// Profile the agent process was started with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Set with `profile`: true when the profile's `process` part changed (or
    /// the profile was deleted) since the process started. Restart to apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_stale: Option<bool>,
}
```

`router.rs`, в `with_profile_store`: `AcpProxyRuntime::new(agent_manager.clone(), acp_request_timeout, profiles.clone())`.

`get_v1_acp_servers`, `.map(...)`:

```rust
        .map(|instance| AcpServerInfo {
            server_id: instance.server_id,
            agent: instance.agent.as_str().to_string(),
            created_at_ms: instance.created_at_ms,
            profile_stale: instance.profile.as_ref().map(|_| instance.profile_stale),
            profile: instance.profile,
        })
```

`post_v1_acp`: в `params(...)` после `agent` добавить
`("profile" = Option<String>, Query, description = "Agent profile for the server this request creates; on a running server it must match the server's profile"),`; описание 404 → `"Unknown ACP server or profile"`; 409 → `"ACP server bound to a different agent or profile"`. В теле перед `let mode`:

```rust
    let profile = query
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
```

и вызов `.post(&server_id, bootstrap_agent, profile, payload, mode)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api profiles::` → `4 passed`.
Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api acp_transport::` → ok (без регрессий).

- [ ] **Step 6: Commit**

```bash
git add server/packages/sandbox-agent/src/ server/packages/sandbox-agent/tests/v1_api.rs server/packages/sandbox-agent/tests/v1_api/profiles.rs
git commit -m "feat(server): start agent processes with a profile, pin it to the server, report profileStale (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Перевод `session.*` в параметры запроса агента (чистая функция)

**Files:**
- Create: `server/packages/sandbox-agent/src/profiles/session.rs`
- Modify: `server/packages/sandbox-agent/src/profiles/mod.rs`

- [ ] **Step 1: Write the failing tests**

`server/packages/sandbox-agent/src/profiles/session.rs`:

```rust
//! Applies the `session` part of a profile to session requests sent to an agent.

use std::collections::BTreeSet;

use sandbox_agent_agent_management::agents::AgentId;
use serde_json::{json, Map, Value};

use super::model::{ProfileSession, SystemPromptMode};

/// Requests that create or restore a session.
pub const PROFILE_SESSION_METHODS: [&str; 3] = ["session/new", "session/load", "session/resume"];

#[cfg(test)]
mod tests {
    use super::*;

    fn session(value: Value) -> ProfileSession {
        serde_json::from_value(value).expect("session json")
    }

    fn request(method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params })
    }

    fn profile_session() -> ProfileSession {
        session(json!({
            "systemPrompt": { "mode": "replace", "text": "You are a reviewer." },
            "mcpServers": [
                { "name": "fs", "command": "node", "args": ["fs.js"], "env": [] },
                { "name": "shared", "command": "profile-cmd", "args": [], "env": [] }
            ],
            "plugins": [{ "path": "/opt/mods/first" }],
            "pluginConfigs": { "first": { "level": "strict" } }
        }))
    }

    #[test]
    fn claude_session_new_gets_meta_and_merged_mcp_servers() {
        let payload = request("session/new", json!({
            "cwd": "/w",
            "mcpServers": [{ "name": "shared", "command": "client-cmd", "args": [], "env": [] }]
        }));
        let applied = apply_session_profile(AgentId::Claude, &profile_session(), payload);
        assert_eq!(
            applied["params"],
            json!({
                "cwd": "/w",
                "mcpServers": [
                    { "name": "fs", "command": "node", "args": ["fs.js"], "env": [] },
                    { "name": "shared", "command": "client-cmd", "args": [], "env": [] }
                ],
                "_meta": {
                    "systemPrompt": "You are a reviewer.",
                    "claudeCode": { "options": {
                        "plugins": [{ "type": "local", "path": "/opt/mods/first" }],
                        "settings": { "pluginConfigs": { "first": { "level": "strict" } } }
                    } }
                }
            })
        );
        assert_eq!(applied["id"], 7);
    }

    #[test]
    fn client_meta_is_kept_and_profile_wins_conflicts() {
        let payload = request("session/new", json!({
            "cwd": "/w",
            "mcpServers": [],
            "_meta": {
                "client.example/trace": "t1",
                "systemPrompt": "client prompt",
                "claudeCode": { "options": { "model": "opus", "plugins": [] } }
            }
        }));
        let applied = apply_session_profile(AgentId::Claude, &profile_session(), payload);
        let meta = &applied["params"]["_meta"];
        assert_eq!(meta["client.example/trace"], "t1");
        assert_eq!(meta["systemPrompt"], "You are a reviewer.");
        assert_eq!(meta["claudeCode"]["options"]["model"], "opus");
        assert_eq!(meta["claudeCode"]["options"]["plugins"], json!([{ "type": "local", "path": "/opt/mods/first" }]));
    }

    #[test]
    fn load_and_resume_are_translated_too() {
        for method in ["session/load", "session/resume"] {
            let payload = request(method, json!({ "sessionId": "s1", "cwd": "/w", "mcpServers": [] }));
            let applied = apply_session_profile(AgentId::Mock, &profile_session(), payload);
            assert_eq!(applied["params"]["sessionId"], "s1", "{method}");
            assert_eq!(applied["params"]["_meta"]["systemPrompt"], "You are a reviewer.", "{method}");
            assert_eq!(applied["params"]["mcpServers"][0]["name"], "fs", "{method}");
        }
    }

    #[test]
    fn append_prompt_uses_append_object() {
        let profile = session(json!({ "systemPrompt": { "mode": "append", "text": "Be brief." } }));
        let applied = apply_session_profile(AgentId::Claude, &profile, request("session/new", json!({ "cwd": "/w" })));
        assert_eq!(applied["params"]["_meta"], json!({ "systemPrompt": { "append": "Be brief." } }));
        assert!(applied["params"].get("mcpServers").is_none());
    }

    #[test]
    fn other_agents_get_only_mcp_servers() {
        let applied = apply_session_profile(AgentId::Codex, &profile_session(), request("session/new", json!({ "cwd": "/w" })));
        assert!(applied["params"].get("_meta").is_none());
        assert_eq!(applied["params"]["mcpServers"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn other_methods_and_empty_profiles_change_nothing() {
        let prompt = request("session/prompt", json!({ "sessionId": "s1", "prompt": [] }));
        assert_eq!(apply_session_profile(AgentId::Claude, &profile_session(), prompt.clone()), prompt);
        let new = request("session/new", json!({ "cwd": "/w", "mcpServers": [] }));
        assert_eq!(apply_session_profile(AgentId::Claude, &ProfileSession::default(), new.clone()), new);
    }

    #[test]
    fn missing_params_are_created() {
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "session/new" });
        let applied = apply_session_profile(AgentId::Claude, &profile_session(), payload);
        assert_eq!(applied["params"]["_meta"]["systemPrompt"], "You are a reviewer.");
    }

    #[test]
    fn method_filter() {
        assert!(is_profile_session_method("session/resume"));
        assert!(!is_profile_session_method("session/prompt"));
    }
}
```

`profiles/mod.rs`: `mod session;` и `pub use session::{apply_session_profile, is_profile_session_method, PROFILE_SESSION_METHODS};`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::session`
Expected: FAIL to compile, `cannot find function apply_session_profile`.

- [ ] **Step 3: Implement**

В `session.rs` над `#[cfg(test)]`:

```rust
pub fn is_profile_session_method(method: &str) -> bool {
    PROFILE_SESSION_METHODS.contains(&method)
}

/// Adds the profile's session settings to a `session/new`, `session/load` or
/// `session/resume` request; other requests are returned unchanged.
/// - `mcpServers`: profile servers plus the client's, merged by `name`; the
///   client's entry wins.
/// - `_meta` (Claude and the mock agent): `systemPrompt`, and
///   `claudeCode.options.{plugins, settings.pluginConfigs}`. Client `_meta`
///   keys are kept; on a conflict the profile wins and the key path (never
///   the value) is logged.
pub fn apply_session_profile(agent: AgentId, session: &ProfileSession, mut payload: Value) -> Value {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !is_profile_session_method(&method) {
        return payload;
    }
    let profile_meta = agent_meta(agent, session);
    if session.mcp_servers.is_empty() && profile_meta.is_none() {
        return payload;
    }
    if let Some(object) = payload.as_object_mut() {
        let params = object
            .entry("params".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(params) = params.as_object_mut() {
            apply_to_params(agent, &method, session, profile_meta, params);
        }
    }
    payload
}

fn apply_to_params(
    agent: AgentId,
    method: &str,
    session: &ProfileSession,
    profile_meta: Option<Value>,
    params: &mut Map<String, Value>,
) {
    if !session.mcp_servers.is_empty() {
        let client = params
            .get("mcpServers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        params.insert(
            "mcpServers".to_string(),
            Value::Array(merge_mcp_servers(&session.mcp_servers, &client)),
        );
    }
    if let Some(profile_meta) = profile_meta {
        let mut meta = params
            .remove("_meta")
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut conflicts = Vec::new();
        deep_merge(&mut meta, &profile_meta, "_meta", &mut conflicts);
        if !conflicts.is_empty() {
            tracing::warn!(
                agent = agent.as_str(),
                method = method,
                conflicts = ?conflicts,
                "profile overrides _meta keys sent by the client"
            );
        }
        params.insert("_meta".to_string(), meta);
    }
}

fn mcp_server_name(server: &Value) -> Option<&str> {
    server.get("name").and_then(Value::as_str)
}

/// Profile servers whose name the client does not use, then the client's.
fn merge_mcp_servers(profile: &[Value], client: &[Value]) -> Vec<Value> {
    let client_names: BTreeSet<&str> = client.iter().filter_map(mcp_server_name).collect();
    let mut merged: Vec<Value> = profile
        .iter()
        .filter(|server| mcp_server_name(server).map_or(true, |name| !client_names.contains(name)))
        .cloned()
        .collect();
    merged.extend(client.iter().cloned());
    merged
}

fn agent_meta(agent: AgentId, session: &ProfileSession) -> Option<Value> {
    match agent {
        AgentId::Claude | AgentId::Mock => claude_meta(session),
        _ => None,
    }
}

/// `_meta` understood by `claude-agent-acp` on new and restored sessions.
fn claude_meta(session: &ProfileSession) -> Option<Value> {
    let mut meta = Map::new();
    if let Some(prompt) = &session.system_prompt {
        let value = match prompt.mode {
            SystemPromptMode::Replace => Value::String(prompt.text.clone()),
            SystemPromptMode::Append => json!({ "append": prompt.text }),
        };
        meta.insert("systemPrompt".to_string(), value);
    }
    let mut options = Map::new();
    if !session.plugins.is_empty() {
        options.insert(
            "plugins".to_string(),
            Value::Array(
                session
                    .plugins
                    .iter()
                    .map(|plugin| json!({ "type": "local", "path": plugin.path }))
                    .collect(),
            ),
        );
    }
    if !session.plugin_configs.is_empty() {
        options.insert(
            "settings".to_string(),
            json!({ "pluginConfigs": session.plugin_configs }),
        );
    }
    if !options.is_empty() {
        meta.insert("claudeCode".to_string(), json!({ "options": Value::Object(options) }));
    }
    (!meta.is_empty()).then_some(Value::Object(meta))
}

/// Merges `overlay` into `target` object by object; on a non-object conflict
/// the overlay wins and the dotted path is recorded.
fn deep_merge(target: &mut Value, overlay: &Value, path: &str, conflicts: &mut Vec<String>) {
    match (target.as_object_mut(), overlay.as_object()) {
        (Some(target), Some(overlay)) => {
            for (key, value) in overlay {
                let child = format!("{path}.{key}");
                match target.get_mut(key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        deep_merge(existing, value, &child, conflicts)
                    }
                    Some(existing) => {
                        if existing != value {
                            conflicts.push(child);
                        }
                        *existing = value.clone();
                    }
                    None => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        _ => *target = overlay.clone(),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib profiles::session` → `8 passed`.

- [ ] **Step 5: Commit**

```bash
git add server/packages/sandbox-agent/src/profiles/
git commit -m "feat(server): translate profile session settings into session requests (SBA-86)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Подстановка `session.*` в прокси на `session/new|load|resume`

**Files:**
- Modify: `server/packages/sandbox-agent/src/acp_proxy_runtime.rs` (`post_with_origin`)
- Modify: `server/packages/sandbox-agent/tests/v1_api/profiles.rs`
- Modify: `research/acp/friction.md`

- [ ] **Step 1: Write the failing Docker tests**

В конец `tests/v1_api/profiles.rs`:

```rust
fn session_profile() -> Value {
    json!({
        "session": {
            "systemPrompt": { "mode": "replace", "text": "You are a reviewer." },
            "mcpServers": [
                { "name": "fs", "command": "node", "args": ["fs.js"], "env": [] },
                { "name": "shared", "command": "profile-cmd", "args": [], "env": [] }
            ],
            "plugins": [{ "path": "/opt/mods/first" }]
        }
    })
}

#[tokio::test]
async fn session_settings_reach_new_load_and_resume() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "sess", session_profile()).await;
    let (status, _) = acp(&test_app.app, "/v1/acp/srv-sess?agent=mock&profile=sess", initialize_payload()).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-sess",
        rpc(2, "session/new", json!({
            "cwd": "/tmp",
            "mcpServers": [{ "name": "shared", "command": "client-cmd", "args": [], "env": [] }],
            "_meta": { "client.example/trace": "t1", "claudeCode": { "options": { "model": "x" } } }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let params = &body["result"]["echoed"]["params"];
    assert_eq!(params["_meta"]["systemPrompt"], "You are a reviewer.");
    assert_eq!(params["_meta"]["client.example/trace"], "t1");
    assert_eq!(params["_meta"]["claudeCode"]["options"]["model"], "x");
    assert_eq!(params["_meta"]["claudeCode"]["options"]["plugins"], json!([{ "type": "local", "path": "/opt/mods/first" }]));
    let names: Vec<&str> = params["mcpServers"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["fs", "shared"]);
    assert_eq!(params["mcpServers"][1]["command"], "client-cmd");

    for (id, method) in [(3, "session/load"), (4, "session/resume")] {
        let (status, body) = acp(
            &test_app.app,
            "/v1/acp/srv-sess",
            rpc(id, method, json!({ "sessionId": "s1", "cwd": "/tmp", "mcpServers": [] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{method}: {body}");
        let params = &body["result"]["echoed"]["params"];
        assert_eq!(params["_meta"]["systemPrompt"], "You are a reviewer.", "{method}");
        assert_eq!(params["mcpServers"][0]["name"], "fs", "{method}");
        assert_eq!(params["sessionId"], "s1", "{method}");
    }

    let (status, body) = acp(&test_app.app, "/v1/acp/srv-sess", rpc(5, "session/prompt", json!({ "sessionId": "s1", "prompt": [] }))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["result"]["echoed"]["params"].get("_meta").is_none(), "{body}");
}

#[tokio::test]
async fn new_sessions_get_the_updated_session_part() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "sess", session_profile()).await;
    let (status, _) = acp(&test_app.app, "/v1/acp/srv-upd?agent=mock&profile=sess", initialize_payload()).await;
    assert_eq!(status, StatusCode::OK);

    put_profile(&test_app.app, "mock", "sess", json!({ "session": { "systemPrompt": { "mode": "append", "text": "Updated." } } })).await;
    let (_, body) = acp(&test_app.app, "/v1/acp/srv-upd", rpc(2, "session/new", json!({ "cwd": "/tmp", "mcpServers": [] }))).await;
    assert_eq!(body["result"]["echoed"]["params"]["_meta"]["systemPrompt"], json!({ "append": "Updated." }));
    assert_eq!(server_entry(&test_app.app, "srv-upd").await["profileStale"], false);
}

#[tokio::test]
async fn servers_without_profile_pass_session_requests_through() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    let (status, _) = acp(&test_app.app, "/v1/acp/srv-raw?agent=mock", initialize_payload()).await;
    assert_eq!(status, StatusCode::OK);
    let params = json!({ "cwd": "/tmp", "mcpServers": [] });
    let (_, body) = acp(&test_app.app, "/v1/acp/srv-raw", rpc(2, "session/new", params.clone())).await;
    assert_eq!(body["result"]["echoed"]["params"], params);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api profiles::session_settings`
Expected: FAIL, `left: Null right: "You are a reviewer."`.

- [ ] **Step 3: Implement**

В `acp_proxy_runtime.rs` импорт расширить: `use crate::profiles::{apply_session_profile, is_profile_session_method, ProfileStore};`.

В `post_with_origin` заменить строку `let payload = normalize_payload_for_agent(instance.agent, payload);` на:

```rust
        // Session settings of the server's profile, read fresh so a changed
        // profile reaches the next new or restored session.
        let payload = match &instance.profile {
            Some(bound) if is_profile_session_method(&method) => {
                let resolved = self.inner.profiles.resolve(instance.agent, &bound.name)?;
                apply_session_profile(instance.agent, &resolved.session, payload)
            }
            _ => payload,
        };
        let payload = normalize_payload_for_agent(instance.agent, payload);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api profiles::` → `7 passed`.

- [ ] **Step 5: Record the decision in `research/acp/friction.md`**

Добавить в конец:

```markdown
- Date: 2026-10-05
- Area: Server-side agent profiles, session part (SBA-86, SBA-87)
- Issue: The SDK could not pass `_meta` on `session/new` (typed `Omit<NewSessionRequest, "_meta">`) and lost it on resume; `/v1/config/mcp|skills` were never passed to agents.
- Decision: The proxy adds a server profile's `session` part to `session/new`, `session/load` and `session/resume` of a server started with `?profile=`. `mcpServers` go into the standard field, merged by `name` (client wins). For `claude` (and `mock`, which mirrors it for tests): `systemPrompt` replace as a string and append as `{append}` in `_meta.systemPrompt`; plugins as `_meta.claudeCode.options.plugins = [{type:"local", path}]`; plugin configs as `_meta.claudeCode.options.settings.pluginConfigs`. Client `_meta` is kept, the profile wins conflicts (key paths logged, values never). The `_meta` shape is not yet verified against a real Claude (stage 4); `session.skills` stays unsupported until then.
- Owner: Unassigned.
- Status: open (verify with real Claude, SBA-88)
- Links: `server/packages/sandbox-agent/src/profiles/session.rs`, `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`, `docs/superpowers/specs/2026-10-05-agent-profiles-design.md`
```

- [ ] **Step 6: Commit**

```bash
git add server/packages/sandbox-agent/src/acp_proxy_runtime.rs server/packages/sandbox-agent/tests/v1_api/profiles.rs research/acp/friction.md
git commit -m "feat(server): apply profile session settings on new, load and resume (SBA-86)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: OpenAPI, TS-типы, CRUD профилей в TS SDK, заглушки inspector

**Files:**
- Modify: `server/packages/openapi-gen/build.rs:9-10`
- Regenerate: `docs/openapi.json`, `sdks/typescript/src/generated/openapi.ts`
- Modify: `sdks/typescript/src/types.ts` (после строки 76), `sdks/typescript/src/index.ts`, `sdks/typescript/src/client.ts` (после `deleteSkillsConfig`)
- Modify: `sdks/typescript/tests/integration.test.ts` (новый describe в конце)
- Modify: `frontend/packages/inspector/src/App.tsx` (две заглушки), `frontend/packages/inspector/src/components/debug/AgentsTab.tsx` (одна)

- [ ] **Step 1: Make OpenAPI generation track the whole crate**

В `server/packages/openapi-gen/build.rs` после двух строк `rerun-if-changed` добавить:

```rust
    // Schemas live in router/types.rs and profiles/*.rs as well.
    emit_stdout("cargo:rerun-if-changed=../sandbox-agent/src");
```

- [ ] **Step 2: Regenerate**

Run: `pnpm --filter sandbox-agent generate`
Expected: exit 0. `grep -c '"/v1/config/profiles' docs/openapi.json` → `2`. `grep -c "profileStale" sdks/typescript/src/generated/openapi.ts` → `1` или больше.

- [ ] **Step 3: Write the failing TS test**

В конец `sdks/typescript/tests/integration.test.ts`:

```ts
describe("Integration: agent profiles", () => {
  let handle: DockerSandboxAgentHandle;
  let baseUrl: string;
  let token: string;
  let layout: ReturnType<typeof createDockerTestLayout>;

  beforeEach(async () => {
    layout = createDockerTestLayout();
    prepareMockAgentDataHome(layout.xdgDataHome);
    handle = await startDockerSandboxAgent(layout, { timeoutMs: 30000 });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterEach(async () => {
    await handle?.dispose?.();
    if (layout) {
      disposeDockerTestLayout(layout);
    }
  });

  it("manages agent profiles with masked secrets", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });

    const saved = await sdk.putProfile("mock", "base", {
      process: { env: { API_TOKEN: "s3cr3t" } },
      session: { systemPrompt: { mode: "append", text: "Be brief." } },
    });
    expect(saved.stored.process?.env?.API_TOKEN).toBe("***");
    expect(saved.hasValue["process.env.API_TOKEN"]).toBe(true);

    await sdk.putProfile("mock", "review", { extends: "base", session: { systemPrompt: { mode: "replace", text: "Review only." } } });
    const review = await sdk.getProfile("mock", "review");
    expect(review.source).toBe("api");
    expect(review.resolved.process?.env?.API_TOKEN).toBe("***");
    expect(review.resolved.session?.systemPrompt).toEqual({ mode: "replace", text: "Review only." });

    const listed = await sdk.listProfiles();
    expect(listed.profiles).toEqual([
      { agent: "mock", name: "base", source: "api" },
      { agent: "mock", name: "review", source: "api", extends: "base" },
    ]);

    const conflict = await sdk.deleteProfile("mock", "base").catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(SandboxAgentError);
    expect((conflict as SandboxAgentError).status).toBe(409);

    const invalid = await sdk.putProfile("codex", "x", { session: { plugins: [{ path: "/p" }] } }).catch((error: unknown) => error);
    expect((invalid as SandboxAgentError).status).toBe(400);
    expect((invalid as SandboxAgentError).problem?.type).toBe("urn:sandbox-agent:error:profile_invalid");

    await sdk.deleteProfile("mock", "review");
    await sdk.deleteProfile("mock", "base");
    expect((await sdk.listProfiles()).profiles).toEqual([]);

    const agents = await sdk.listAgents();
    expect(agents.agents.find((agent) => agent.id === "claude")?.customization.session.plugins).toBe(true);

    await sdk.dispose();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
pnpm --filter @sandbox-agent/cli-shared build && pnpm --filter acp-http-client build
SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent
SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test -t "agent profiles"
```

Expected: FAIL, `TypeError: sdk.putProfile is not a function`.

- [ ] **Step 5: Implement SDK types and methods**

`sdks/typescript/src/types.ts` после `export type SkillsConfig = ...`:

```ts
export type AgentProfile = components["schemas"]["AgentProfile"];
export type AgentCustomization = components["schemas"]["AgentCustomization"];
export type ProfileSource = components["schemas"]["ProfileSource"];
export type ProfileSummary = components["schemas"]["ProfileSummary"];
export type ProfileListResponse = JsonResponse<operations["get_v1_config_profiles"], 200>;
export type ProfileDetailResponse = JsonResponse<operations["get_v1_config_profile"], 200>;
```

`sdks/typescript/src/index.ts`: в блок `export type { AcpEnvelope, ... } from "./types.ts";` добавить `AgentCustomization, AgentProfile, ProfileDetailResponse, ProfileListResponse, ProfileSource, ProfileSummary,` (с сортировкой как в блоке).

`sdks/typescript/src/client.ts`: добавить эти типы в импорт из `./types.ts` в том же стиле, что и соседние имена (`type AgentProfile,`, `type ProfileDetailResponse,`, `type ProfileListResponse,`); после `deleteSkillsConfig`:

```ts
  /** Lists agent profiles stored on the server (from the API and from `--profiles`). */
  async listProfiles(): Promise<ProfileListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/config/profiles`);
  }

  /** Stored and resolved (`extends` applied) profile; env and plugin config values come back as `***`. */
  async getProfile(agent: string, name: string): Promise<ProfileDetailResponse> {
    return this.requestJson("GET", profilePath(agent, name));
  }

  /** Creates or replaces a profile. A `***` value keeps the value stored for that key. */
  async putProfile(agent: string, name: string, profile: AgentProfile): Promise<ProfileDetailResponse> {
    return this.requestJson("PUT", profilePath(agent, name), { body: profile });
  }

  async deleteProfile(agent: string, name: string): Promise<void> {
    await this.requestRaw("DELETE", profilePath(agent, name));
  }
```

Рядом с `normalizeSessionInit`:

```ts
function profilePath(agent: string, name: string): string {
  return `${API_PREFIX}/config/profiles/${encodeURIComponent(agent)}/${encodeURIComponent(name)}`;
}
```

- [ ] **Step 6: Fix inspector placeholders**

`frontend/packages/inspector/src/App.tsx`: обе строки `capabilities: {} as AgentInfo["capabilities"],` дополнить следующей строкой `customization: {} as AgentInfo["customization"],`.
`frontend/packages/inspector/src/components/debug/AgentsTab.tsx`: после `capabilities: emptyFeatureCoverage as AgentInfo["capabilities"],` добавить `customization: {} as AgentInfo["customization"],`.

- [ ] **Step 7: Run tests and typechecks**

```bash
SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test -t "agent profiles"
pnpm --filter sandbox-agent typecheck
# inspector берёт типы SDK из dist (types: ./dist/index.d.ts), поэтому сначала пересобрать SDK
SKIP_OPENAPI_GEN=1 pnpm --filter sandbox-agent build
pnpm --filter @sandbox-agent/inspector typecheck
```

Expected: `1 passed`; оба typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/packages/openapi-gen/build.rs docs/openapi.json sdks/typescript/src/ sdks/typescript/tests/integration.test.ts \
  frontend/packages/inspector/src/App.tsx frontend/packages/inspector/src/components/debug/AgentsTab.tsx
git commit -m "feat(sdk): listProfiles, getProfile, putProfile, deleteProfile; regenerate OpenAPI (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Опция `profile` в TS SDK при создании и восстановлении сессии

**Files:**
- Modify: `sdks/typescript/tests/helpers/mock-agent.ts` (node-скрипт)
- Modify: `sdks/typescript/tests/integration.test.ts` (describe "Integration: agent profiles")
- Modify: `sdks/typescript/src/types.ts:139-152` (`SessionRecord`)
- Modify: `sdks/typescript/src/client.ts` (`SessionCreateRequest` 223, `SessionResumeOrCreateRequest` 235, `Session` getters ~494, `LiveAcpConnection` 639-800, `createSession` 1587, `restoreSession` 1686, `resumeOrCreateSession` 1830, `getLiveConnection` 2817, `isAcpServerListedForOtherAgent` 2885, `openLiveConnection` 2895)

- [ ] **Step 1: Add mock hooks**

В `sdks/typescript/tests/helpers/mock-agent.ts` внутри `nodeScript` после `let lateNotFoundUsed = false;`:

```js
// Session requests this process received, for "_mock/received".
const receivedSessionRequests = [];
```

Прямо перед `  if (method === "session/new") {`:

```js
  if (method === "session/new" || method === "session/load" || method === "session/resume") {
    receivedSessionRequests.push({ method, params: msg.params ?? null });
  }

  // Test hook: the session requests received so far (params as sent by the server).
  if (method === "_mock/received") {
    emit({ jsonrpc: "2.0", id: msg.id, result: { requests: receivedSessionRequests } });
    return;
  }

  // Test hook: the listed variables of this process's environment (null when unset).
  if (method === "_mock/env") {
    const names = Array.isArray(msg?.params?.names) ? msg.params.names : [];
    const env = {};
    for (const name of names) {
      env[name] = process.env[name] ?? null;
    }
    emit({ jsonrpc: "2.0", id: msg.id, result: { env } });
    return;
  }
```

(В скрипте нельзя использовать `${`: это `String.raw`-шаблон.)

- [ ] **Step 2: Write the failing tests**

В describe "Integration: agent profiles" добавить:

```ts
  type ReceivedRequest = { method: string; params: { _meta?: Record<string, unknown>; mcpServers?: Array<{ name: string }> } | null };

  async function putReviewProfile(sdk: SandboxAgent): Promise<void> {
    await sdk.putProfile("mock", "review", {
      process: { env: { REVIEW_TOKEN: "s3cr3t-env" } },
      session: {
        systemPrompt: { mode: "replace", text: "Review only." },
        mcpServers: [{ name: "profile-fs", command: "node", args: ["fs.js"], env: [] }],
      },
    });
  }

  it("createSession with a profile starts the server with it and persists only the name", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 500 });
    const sdk = await SandboxAgent.connect({ baseUrl, token, persist });
    await putReviewProfile(sdk);

    const session = await sdk.createSession({ agent: "mock", profile: "review" });
    expect(session.profile).toBe("review");

    const record = await persist.getSession(session.id);
    expect(record?.profile).toBe("review");
    const events = await persist.listEvents({ sessionId: session.id, limit: 500 });
    expect(JSON.stringify(record)).not.toContain("s3cr3t-env");
    expect(JSON.stringify(events.items)).not.toContain("s3cr3t-env");

    const servers = await sdk.listAcpServers();
    expect(servers.servers.find((server) => server.serverId === record?.serverId)).toMatchObject({ profile: "review", profileStale: false });

    const received = (await session.rawSend("_mock/received", {})) as { requests: ReceivedRequest[] };
    const created = received.requests.find((request) => request.method === "session/new");
    expect(created?.params?._meta?.systemPrompt).toBe("Review only.");
    expect(created?.params?.mcpServers?.map((server) => server.name)).toEqual(["profile-fs"]);

    const env = (await session.rawSend("_mock/env", { names: ["REVIEW_TOKEN"] })) as { env: Record<string, string | null> };
    expect(env.env.REVIEW_TOKEN).toBe("s3cr3t-env");

    const plain = await sdk.createSession({ agent: "mock" });
    expect((await sdk.getSession(plain.id))?.serverId).not.toBe(record?.serverId);

    await sdk.dispose();
  });

  it("resumeSession starts a new server with the stored profile", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 500 });
    const first = await SandboxAgent.connect({ baseUrl, token, persist });
    await putReviewProfile(first);
    const created = await first.createSession({ agent: "mock", profile: "review" });
    await created.prompt([{ type: "text", text: "first run" }]);
    const firstServerId = (await persist.getSession(created.id))?.serverId;
    await first.dispose();

    const second = await SandboxAgent.connect({ baseUrl, token, persist });
    const restored = await second.resumeSession(created.id);
    const record = await persist.getSession(created.id);
    expect(record?.profile).toBe("review");
    expect(record?.serverId).not.toBe(firstServerId);
    const servers = await second.listAcpServers();
    expect(servers.servers.find((server) => server.serverId === record?.serverId)?.profile).toBe("review");

    const received = (await restored.rawSend("_mock/received", {})) as { requests: ReceivedRequest[] };
    const resumed = received.requests.find((request) => request.method === "session/resume");
    expect(resumed?.params?._meta?.systemPrompt).toBe("Review only.");
    expect(resumed?.params?.mcpServers?.map((server) => server.name)).toContain("profile-fs");

    await second.dispose();
  });

  it("resumeOrCreateSession refuses another profile for an existing session", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 500 });
    const sdk = await SandboxAgent.connect({ baseUrl, token, persist });
    await putReviewProfile(sdk);
    await sdk.putProfile("mock", "other", {});
    const session = await sdk.resumeOrCreateSession({ id: "profile-session", agent: "mock", profile: "review" });
    expect(session.profile).toBe("review");
    await expect(sdk.resumeOrCreateSession({ id: "profile-session", agent: "mock", profile: "other" })).rejects.toThrow(
      "session 'profile-session' uses profile 'review'; requested 'other'",
    );
    const again = await sdk.resumeOrCreateSession({ id: "profile-session", agent: "mock" });
    expect(again.profile).toBe("review");
    await sdk.dispose();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @sandbox-agent/cli-shared build && pnpm --filter acp-http-client build
SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent
SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test -t "agent profiles"
```

Expected: FAIL, `expected undefined to be 'review'` (`session.profile`).

- [ ] **Step 4: Implement**

`types.ts`, в `SessionRecord` после `serverId?: string;`:

```ts
  /** Agent profile the session's agent server runs with. Only the name is stored. */
  profile?: string;
```

`client.ts`, в `SessionCreateRequest` и `SessionResumeOrCreateRequest` после `sessionInit`:

```ts
  /**
   * Server-side agent profile (see `putProfile`). The session's agent server is
   * started with it; only the name is stored with the session.
   */
  profile?: string;
```

В классе `Session` после getter `serverId`:

```ts
  /** Agent profile the session's agent server runs with, if any. */
  get profile(): string | undefined {
    return this.record.profile;
  }
```

`LiveAcpConnection`: после `readonly serverId: string;`:

```ts
  /** Agent profile this connection's server was (or is expected to be) started with. */
  readonly profile?: string;
```

Конструктор: параметр `profile: string | undefined` после `serverId: string,`, в теле `this.profile = profile;`. В `create(options)` добавить в тип опций `profile?: string;` после `serverId: string;`, `bootstrapQuery` заменить на:

```ts
        bootstrapQuery: attach ? undefined : options.profile ? { agent: options.agent, profile: options.profile } : { agent: options.agent },
```

и вызов конструктора `new LiveAcpConnection(options.agent, options.serverId, options.profile, supportsResume, ...)`.

`createSession`: после `const sessionInit = ...`:

```ts
    const profile = normalizeProfileName(request.profile);
```

`live = await this.getLiveConnection(request.agent.trim(), profile);`, в литерал `record` после `serverId: live.serverId,` добавить `profile,`.

`restoreSession`: `const live = await this.getLiveConnection(existing.agent, existing.profile, existing.serverId);`.

`resumeOrCreateSession`: сразу внутри `if (existing) {`:

```ts
      const requestedProfile = normalizeProfileName(request.profile);
      if (requestedProfile !== undefined && requestedProfile !== existing.profile) {
        throw new Error(`session '${existing.id}' uses profile '${existing.profile ?? "(none)"}'; requested '${requestedProfile}'`);
      }
```

`getLiveConnection` целиком (в doc-комментарии над функцией "Live connection for an agent" заменить на "Live connection for an agent and profile", "any connection for the agent" на "any connection for the agent and profile"):

```ts
  private async getLiveConnection(agent: string, profile?: string, preferredServerId?: string): Promise<LiveAcpConnection> {
    this.assertNotDisposed();
    await this.awaitHealthy();

    const preferred = preferredServerId?.trim();
    if (preferred) {
      const existing = this.liveConnections.get(preferred) ?? (await this.pendingLiveConnections.get(preferred)?.catch(() => undefined));
      if (existing && existing.agent === agent && existing.profile === profile) {
        return existing;
      }
      if (!existing) {
        let attached: LiveAcpConnection | undefined;
        try {
          attached = await this.openLiveConnection(agent, profile, preferred, true);
        } catch (error) {
          // Only a server confirmed gone by the list is replaced by a new one
          // below. Any other failure (network, auth, server error, or a list
          // that cannot be read) is thrown, so the session is not forked onto a
          // second server.
          if (!isMissingServerRejection(error) || (await this.isAcpServerListedOrThrow(preferred, error))) {
            throw error;
          }
        }
        if (attached) {
          const otherServer = await this.isAcpServerListedForOtherAgent(preferred, agent, profile);
          // dispose() may have run during the list call and closed `attached`.
          this.assertNotDisposed();
          if (!otherServer) {
            return attached;
          }
          // The id now belongs to a server of another agent or profile: leave it
          // running and use a server for this agent and profile instead.
          await this.discardLiveConnection(attached);
        }
      }
    }
    // The checks above await the server; nothing is reused or started after dispose().
    this.assertNotDisposed();

    for (const connection of this.liveConnections.values()) {
      if (connection.agent === agent && connection.profile === profile) {
        return connection;
      }
    }
    const pendingForAgent = this.pendingLiveConnectionsByAgent.get(liveConnectionKey(agent, profile));
    if (pendingForAgent) {
      return pendingForAgent;
    }

    return this.openLiveConnection(agent, profile, `sdk-${agent}-${randomId()}`, false);
  }
```

`isAcpServerListedForOtherAgent`:

```ts
  /**
   * Whether the server list shows the server running a different agent or
   * profile. A list that cannot be read counts as no: the attached server stays
   * in use, since a session is never moved to a new server on a guess.
   */
  private async isAcpServerListedForOtherAgent(serverId: string, agent: string, profile: string | undefined): Promise<boolean> {
    let servers: AcpServerListResponse;
    try {
      servers = await this.listAcpServers();
    } catch {
      return false;
    }
    return servers.servers.some((server) => server.serverId === serverId && (server.agent !== agent || (server.profile ?? undefined) !== profile));
  }
```

`openLiveConnection(agent: string, profile: string | undefined, serverId: string, attach: boolean)`: в `LiveAcpConnection.create({...})` добавить `profile,` после `serverId,`; три использования `pendingLiveConnectionsByAgent` с ключом `agent` заменить на `liveConnectionKey(agent, profile)`.

Рядом с `normalizeSessionInit`:

```ts
function normalizeProfileName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Pending-connection key: one agent server per agent and profile. */
function liveConnectionKey(agent: string, profile: string | undefined): string {
  return profile ? `${agent}\u0000${profile}` : agent;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test -t "agent profiles"
SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test -t "flat session API"
pnpm --filter sandbox-agent typecheck
```

Expected: `4 passed` в "agent profiles"; "flat session API" без новых падений; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add sdks/typescript/src/ sdks/typescript/tests/
git commit -m "feat(sdk): profile option for createSession and resume, persist only the name (SBA-86, SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Поле `profile` в эталонных persist-драйверах

У этих драйверов нет тестов, поэтому красная проверка здесь структурная (grep по схеме и отображению поля), зелёная: тот же grep плюс typecheck. Нужен слитый T14 (`SessionRecord.profile`).

**Files:**
- Modify: `examples/persist-sqlite/src/persist.ts`
- Modify: `examples/persist-postgres/src/persist.ts`
- Modify: `frontend/packages/inspector/src/persist-indexeddb.ts`

- [ ] **Step 1: Run the failing check**

```bash
grep -q "profile TEXT" examples/persist-sqlite/src/persist.ts \
  && grep -q "profile: row.profile ?? undefined" examples/persist-sqlite/src/persist.ts \
  && grep -q "ADD COLUMN IF NOT EXISTS profile TEXT" examples/persist-postgres/src/persist.ts \
  && grep -q "profile: row.profile ?? undefined" examples/persist-postgres/src/persist.ts \
  && grep -q "profile: session.profile" frontend/packages/inspector/src/persist-indexeddb.ts \
  && echo OK
```

Expected: пустой вывод (FAIL).

- [ ] **Step 2: IndexedDB driver (inspector)**

В `frontend/packages/inspector/src/persist-indexeddb.ts`: в `type SessionRow` после `serverId?: string;` добавить `profile?: string;`; в `encodeSessionRow` после `serverId: session.serverId,` добавить `profile: session.profile,`; в `decodeSessionRow` после `serverId: row.serverId,` добавить `profile: row.profile,`.

- [ ] **Step 2a: SQLite driver**

В `examples/persist-sqlite/src/persist.ts`:
- оба `SELECT id, agent, agent_session_id, server_id, ...` → `SELECT id, agent, agent_session_id, server_id, profile, last_connection_id, ...`;
- в `INSERT INTO sessions (` (многострочный, около строки 58) в строке колонок `server_id,` → `server_id, profile,`, строку `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` заменить на 12 плейсхолдеров `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; в `ON CONFLICT ... DO UPDATE SET` после `server_id = excluded.server_id,` добавить `profile = excluded.profile,`, в `.run(...)` после `session.serverId ?? null,` добавить `session.profile ?? null,`;
- в `CREATE TABLE IF NOT EXISTS sessions` после `server_id TEXT,` добавить `profile TEXT,`;
- после проверки колонки `server_id`:

```ts
    if (!sessionColumns.some((column) => column.name === "profile")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN profile TEXT`);
    }
```

- в `type SessionRow` после `server_id: string | null;` добавить `profile: string | null;`, в `decodeSessionRow` после `serverId: row.server_id ?? undefined,` добавить `profile: row.profile ?? undefined,`.

- [ ] **Step 3: Postgres driver**

В `examples/persist-postgres/src/persist.ts` те же правки: оба `SELECT` получают `profile` после `server_id`; в многострочном `INSERT` (около строки 81) строка колонок получает `profile` после `server_id`, строка `) VALUES ($1, ..., $11)` становится `) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`; `profile = EXCLUDED.profile,` после `server_id = EXCLUDED.server_id,`, `session.profile ?? null,` после `session.serverId ?? null,`; в `CREATE TABLE` `profile TEXT,` после `server_id TEXT,`; после `ADD COLUMN IF NOT EXISTS server_id TEXT`:

```ts
    await this.pool.query(`
      ALTER TABLE ${this.table("sessions")}
      ADD COLUMN IF NOT EXISTS profile TEXT
    `);
```

`type SessionRow`: `profile: string | null;`; `decodeSessionRow`: `profile: row.profile ?? undefined,`.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter sandbox-agent build
pnpm --filter @sandbox-agent/example-persist-sqlite typecheck
pnpm --filter @sandbox-agent/example-persist-postgres typecheck
pnpm --filter @sandbox-agent/inspector typecheck
```

Expected: все exit 0, и команда из Step 1 печатает `OK`.

- [ ] **Step 5: Commit**

```bash
git add examples/persist-sqlite/src/persist.ts examples/persist-postgres/src/persist.ts frontend/packages/inspector/src/persist-indexeddb.ts
git commit -m "feat(examples): store the session profile name in persist drivers (SBA-87)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: Docs: страница профилей, CLI, SDK, ссылки с deprecated-страниц

**Files:**
- Create: `docs/agent-profiles.mdx`
- Modify: `docs/docs.json` (группа "Agent"), `frontend/packages/website/docs.config.mjs:103-105`
- Modify: `docs/cli.mdx`, `docs/sdk-overview.mdx`, `docs/mcp-config.mdx`, `docs/skills-config.mdx`

- [ ] **Step 1: Write the failing docs check**

Run:
```bash
test -f docs/agent-profiles.mdx && grep -q "agent-profiles" docs/docs.json && grep -q "profiles list" docs/cli.mdx && grep -q "putProfile" docs/sdk-overview.mdx && echo OK
```
Expected: пустой вывод (FAIL).

- [ ] **Step 2: Create `docs/agent-profiles.mdx`**

````mdx
---
title: "Agent Profiles"
description: "Named server-side settings for agent processes and their sessions."
sidebarTitle: "Agent Profiles"
icon: "sliders"
---

An agent profile is a named set of settings stored on the server for one agent, for example `claude/review`. It sets the environment of the agent process and settings applied to every session that runs on it: a system prompt, MCP servers, and Claude Code plugins. Variants for different environments (local, E2B, Daytona) are profiles that extend a shared base.

## Profile format

```json
{
  "extends": "base",
  "process": {
    "env": { "ANTHROPIC_BASE_URL": "https://llm-proxy.internal" }
  },
  "session": {
    "systemPrompt": { "mode": "append", "text": "Answer in English." },
    "mcpServers": [
      { "name": "github", "command": "github-mcp", "args": ["--stdio"], "env": [] }
    ],
    "plugins": [{ "path": "/opt/mods/first-mod" }],
    "pluginConfigs": { "first-mod": { "level": "strict" } }
  }
}
```

| Field | Applied | Agents |
|---|---|---|
| `process.env` | when the agent process starts | all |
| `session.systemPrompt` (`mode`: `replace` or `append`) | every new or restored session | Claude |
| `session.mcpServers` | every new or restored session | all |
| `session.plugins` | every new or restored session | Claude |
| `session.pluginConfigs` | every new or restored session | Claude |
| `process.args`, `process.config`, `session.skills` | not supported yet | none |

`GET /v1/agents` reports what each agent supports in its `customization` field. Saving a profile with a field the agent does not support fails with `400`, and `details.fields` lists those fields.

Profile names use 1 to 64 characters from `A-Z a-z 0-9 . _ -` and start with a letter or digit.

## Inheritance

`extends` names a profile of the same agent (`"base"` or `"claude/base"`). The chain is applied from the base to the derived profile:

| Field | Merge |
|---|---|
| `process.env`, `session.pluginConfigs` | by key, the derived profile wins |
| `session.mcpServers` | by `name` |
| `session.plugins` | by `path` |
| `process.args`, `process.config`, `session.systemPrompt`, `session.skills` | the derived profile replaces the whole value |

Saving fails with `400` for a cycle, a parent that does not exist, or a parent of another agent. A profile that another profile extends cannot be deleted (`409`).

## Manage profiles

<Tabs>
  <Tab title="TypeScript">
```ts
await sdk.putProfile("claude", "base", {
  process: { env: { ANTHROPIC_BASE_URL: "https://llm-proxy.internal" } },
});
await sdk.putProfile("claude", "review", {
  extends: "base",
  session: { systemPrompt: { mode: "replace", text: "You review code. Never edit files." } },
});

const { profiles } = await sdk.listProfiles();
const review = await sdk.getProfile("claude", "review"); // { stored, resolved, hasValue }
await sdk.deleteProfile("claude", "review");
```
  </Tab>
  <Tab title="HTTP">
```bash
curl -X PUT http://127.0.0.1:2468/v1/config/profiles/claude/review \
  -H 'content-type: application/json' \
  -d '{"extends":"base","session":{"systemPrompt":{"mode":"replace","text":"You review code."}}}'
curl http://127.0.0.1:2468/v1/config/profiles
curl http://127.0.0.1:2468/v1/config/profiles/claude/review
curl -X DELETE http://127.0.0.1:2468/v1/config/profiles/claude/review
```
  </Tab>
  <Tab title="CLI">
```bash
sandbox-agent profiles put claude review --json-file ./review.json
sandbox-agent profiles list
sandbox-agent profiles get claude review
sandbox-agent profiles delete claude review
```
  </Tab>
</Tabs>

## Use a profile

```ts
const session = await sdk.createSession({ agent: "claude", profile: "review" });
```

- The agent server started for the session runs with the profile, and the profile stays pinned to that server. Sessions with different profiles run on different agent servers. A request for a running server with another profile fails with `409` (`profile_mismatch`).
- Session settings from the profile are applied every time a session is created or restored, so they are kept when `resumeSession` restores a session. MCP servers you pass in `sessionInit.mcpServers` are merged with the profile's by `name`, and yours win.
- The SDK stores only the profile name with the session (`session.profile`). `resumeSession` uses it; `resumeOrCreateSession` with a different `profile` for an existing session throws.
- Without a profile nothing changes.

## Changing a profile

New and restored sessions get the changed `session` settings right away. Changes to `process` apply only to agent processes started afterwards: `GET /v1/acp` (`sdk.listAcpServers()`) shows `profileStale: true` for a running server whose profile changed. The server does not restart agent processes on its own; delete the server (`sdk.destroyAcpServer(serverId)`) to apply the change.

## Secrets

Values of `process.env`, `session.pluginConfigs`, and the `env` and `headers` entries of `session.mcpServers` are stored as given but are never returned: reads show `"***"`, and `hasValue` (for example `"process.env.ANTHROPIC_API_KEY": true` or `"session.mcpServers.github.headers.Authorization": true`) says which keys hold a value. Send `"***"` in an update to keep the stored value of that key. Profile files on disk are readable only by the server's user. Keep secrets of MCP servers in `env` or `headers`: other fields (such as `args` or `url`) are returned as they are.

## Profiles from a file

```bash
sandbox-agent server --profiles ./profiles.json
```

The file is a JSON array of profiles, each with `agent` and `name`:

```json
[
  { "agent": "claude", "name": "base", "process": { "env": { "ANTHROPIC_BASE_URL": "https://llm-proxy.internal" } } },
  { "agent": "claude", "name": "e2b", "extends": "base", "session": { "systemPrompt": { "mode": "append", "text": "You run in E2B." } } }
]
```

The file is read once at startup and an invalid file stops the server. Its profiles are listed with `source: "file"`, cannot be changed or deleted through the API (`409`, `profile_read_only`), and win over API profiles with the same agent and name.

## Storage

Profiles created through the API are stored one file per profile in `<state dir>/profiles/<agent>/<name>.json`. The state directory is `$SANDBOX_AGENT_STATE_DIR`, by default `sandbox-agent/state` in the user data directory (for example `~/.local/share/sandbox-agent/state` on Linux).
````

- [ ] **Step 3: Navigation**

`docs/docs.json`: в группе `"Agent"` после `"attachments",` добавить `"agent-profiles",`.
`frontend/packages/website/docs.config.mjs`: перед `{ slug: "docs/skills-config", ...}` добавить:

```js
        { slug: "docs/agent-profiles", label: "Agent Profiles", attrs: { "data-icon": "blocks" } },
```

- [ ] **Step 4: CLI reference**

`docs/cli.mdx`: в таблицу опций `## server` после строки `--acp-request-timeout-ms`:

```mdx
| `--profiles <FILE>` | - | JSON array of agent profiles loaded at startup. They are read-only and win over profiles created through the API. See [Agent Profiles](/agent-profiles) |
```

В Notes `## server` добавить пункт:

```mdx
- Agent profiles created through the API are stored in the state directory, `$SANDBOX_AGENT_STATE_DIR` (default `sandbox-agent/state` in the user data directory). An invalid `--profiles` file stops the server at startup.
```

Перед `## api` добавить раздел:

````mdx
## profiles

Manage [agent profiles](/agent-profiles) on a running server.

```bash
sandbox-agent profiles list [--endpoint <URL>]
sandbox-agent profiles get <AGENT> <NAME> [--endpoint <URL>]
sandbox-agent profiles put <AGENT> <NAME> (--json <JSON> | --json-file <FILE>) [--endpoint <URL>]
sandbox-agent profiles delete <AGENT> <NAME> [--endpoint <URL>]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-e, --endpoint <URL>` | `http://127.0.0.1:2468` | Target server |
| `--json <JSON>` | - | Profile body (`put`) |
| `--json-file <FILE>` | - | Profile body from a file (`put`) |

`get` and `put` print the stored and the resolved profile with secret values shown as `***`. In `put`, a `***` value keeps the stored value of that key.

```bash
sandbox-agent profiles put claude review --json '{"extends":"base","session":{"systemPrompt":{"mode":"replace","text":"You review code."}}}'
```
````

- [ ] **Step 5: SDK overview**

`docs/sdk-overview.mdx`, в конец раздела `## Session configuration` (перед строкой `See [Agent Sessions]...`):

````mdx
Start sessions with a server-side [agent profile](/agent-profiles) (system prompt, MCP servers, plugins, process environment):

```ts
await sdk.putProfile("claude", "review", {
  session: { systemPrompt: { mode: "replace", text: "You review code. Never edit files." } },
});

const reviewer = await sdk.createSession({ agent: "claude", profile: "review" });
console.log(reviewer.profile); // "review"
```

Sessions with different profiles run on different agent servers. Only the profile name is stored with the session, and `resumeSession` starts a new agent server with the same profile when the old one is gone.
````

В блок кода `## Control-plane and HTTP helpers` после `await sdk.installAgent("codex", { reinstall: true });`:

```ts
const profiles = await sdk.listProfiles();
const review = await sdk.getProfile("claude", "review"); // secrets masked as "***"
```

- [ ] **Step 6: Link from the deprecated pages**

`docs/mcp-config.mdx`, после блока кода в `## Give a session MCP servers`:

```mdx
To give every session of an agent the same MCP servers, put them in an [agent profile](/agent-profiles) (`session.mcpServers`).
```

`docs/skills-config.mdx`, в конец `<Warning>` добавить предложение: `Agent profiles will cover skills once agents support them, see [Agent Profiles](/agent-profiles).`

- [ ] **Step 7: Run the docs checks**

```bash
test -f docs/agent-profiles.mdx && grep -q "agent-profiles" docs/docs.json && grep -q "profiles list" docs/cli.mdx && grep -q "putProfile" docs/sdk-overview.mdx && echo OK
grep -n "ACP\|session/new\|session/load\|session/resume\|—" docs/agent-profiles.mdx docs/mcp-config.mdx docs/skills-config.mdx docs/custom-tools.mdx || true
git diff -U0 docs/cli.mdx docs/sdk-overview.mdx | grep "^+" | grep -n "ACP\|session/new\|session/load\|session/resume\|—" || true
pnpm --filter @sandbox-agent/website build
```

Expected: `OK`; вторая и третья команды ничего не выводят (в новых текстах нет "ACP", имён протокольных методов и длинных тире; старые строки `PI_ACP_PI_COMMAND` в `cli.mdx` не трогаем); сборка сайта exit 0.

- [ ] **Step 8: Commit**

```bash
git add docs/agent-profiles.mdx docs/docs.json frontend/packages/website/docs.config.mjs docs/cli.mdx docs/sdk-overview.mdx docs/mcp-config.mdx docs/skills-config.mdx
git commit -m "docs: agent profiles page, CLI and SDK reference (SBA-87, SBA-86)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Финальная проверка (после T16)

```bash
SANDBOX_AGENT_SKIP_INSPECTOR=1 just check
SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --lib
SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test profiles_http --test agent_customization --test openapi_deprecated --test opencode_openapi
SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo test -p sandbox-agent --test v1_api
cargo test -p sandbox-agent-error
pnpm --filter @sandbox-agent/cli-shared build && pnpm --filter acp-http-client build
SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent
SANDBOX_AGENT_BIN=$PWD/target/debug/sandbox-agent pnpm --filter sandbox-agent test
git status --short docs/openapi.json sdks/typescript/src/generated/openapi.ts   # пусто после pnpm --filter sandbox-agent generate
```

Expected: всё зелёное; `pnpm --filter sandbox-agent generate` не меняет закоммиченные файлы.

## Покрытие spec (этапы 1-3)

| Требование spec | Задача |
|---|---|
| Docs SBA-89: честное описание, deprecated в docs и OpenAPI | T1, ссылка на профили T16 |
| Модель `(agent, name)`, `process`, `session` | T4 |
| Слияние `extends` по таблице, 400 на цикл, отсутствующий родитель, чужой агент | T4, T7, T8 |
| 400 на неподдерживаемые capability поля со списком | T5, T7, T8 |
| Хранение по файлу на профиль, атомарная запись | T7 |
| `--profiles` только для чтения, файл выигрывает, 409 `profile_read_only` | T7, T8 |
| `GET` список, `GET` один `{stored, resolved}`, `PUT`, `DELETE` | T8 |
| Маскирование `***`, `hasValue`, сохранение при `***` (включая `env`/`headers` у `session.mcpServers`) | T6, T8 |
| CLI `profiles list|get|put|delete` | T9 |
| `?profile=` при запуске, env процесса, закрепление, 409 `profile_mismatch`, без `profile` работает с закреплённым | T10 |
| `profileStale` | T10, T12 |
| `session.*` на `session/new`, `load`, `resume`; mcpServers по name (клиент выигрывает); `_meta` клиента сохраняется, конфликт в лог без значений | T11, T12 |
| Capability `customization` в `/v1/agents` | T5 |
| SDK `listProfiles|getProfile|putProfile|deleteProfile` | T13 |
| SDK опция `profile` при создании и resume, в persist только имя | T14, T15 |
| Перегенерация OpenAPI | T1, T13 |
| `docs/cli.mdx`, `docs/sdk-overview.mdx`, страница профилей | T16 |
| Тесты Rust unit (слияние, маскирование, capability) | T4, T5, T6, T7, T11 |
| Тесты Rust интеграционные (env, `session.*` в new и load, 409, stale, 409 файла) | T8, T10, T12 |
| Тесты TS (profile при создании и resume, нет env в persist) | T14 |
