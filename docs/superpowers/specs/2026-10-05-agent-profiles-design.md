# Серверные профили агента

Дата: 2026-10-05. Статус: дизайн согласован с пользователем, реализация не начата.
Тикеты: SBA-73 (mods), SBA-77 (hijack), SBA-86 (уровень сессии Claude), SBA-87 (профили процесса и capability), SBA-88 (версия Claude CLI), SBA-89 (config/mcp и skills не применяются). Эпик: см. трекер.

## Зачем

Нужно задавать агенту системный промпт, env, mods (plugins Claude Code), MCP-серверы, skills и pluginConfigs. Значения должны различаться по средам (local, e2b, daytona…).

Сейчас это не работает:

- SDK не даёт передать `_meta` в `session/new`: в типах `Omit<NewSessionRequest, "_meta">` (`sdks/typescript/src/client.ts`). При resume `_meta` теряется.
- Env процесса агента наследуется от сервера целиком, публичного способа его задать нет.
- `/v1/config/mcp` и `/v1/config/skills` только сохраняют JSON по каталогу. Агенту этот конфиг никто не передаёт (SBA-89), а docs утверждают обратное.
- Codex, OpenCode и Pi настраиваются только на уровне процесса (`CODEX_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `PI_ACP_PI_COMMAND`).
- `claude-agent-acp` 0.84.0 принимает на `session/new` поля `_meta.systemPrompt` (replace/append) и `_meta.claudeCode.options.{env, plugins, settings}`. Hooks модов через этот путь срабатывают, это проверено 05.10.2026.

## Решения пользователя (05.10.2026)

1. Настройка живёт в **именованных профилях на сервере**, а не передаётся из SDK на сессию.
2. Профиль **привязан к процессу агента** (`server_id`), а не к отдельной сессии.
3. Варианты под среды делаются **наследованием `extends`**.
4. Профили приходят **через API и файлом при старте** (`--profiles`). Профили из файла только для чтения.
5. `/v1/config/mcp` и `/v1/config/skills` **входят в профиль**. Старые эндпоинты помечаются deprecated и удаляются в следующем minor.

## Модель

Профиль идентифицируется парой `(agent, name)`, например `claude/review`.

```jsonc
{
  "agent": "claude",
  "extends": "base",
  "process": {
    "env": { "ANTHROPIC_BASE_URL": "…", "CLAUDE_CODE_PLUGIN_DIRS": "…" },
    "args": [],
    "config": {}
  },
  "session": {
    "systemPrompt": { "mode": "replace", "text": "…" },
    "mcpServers": [],
    "skills": [],
    "plugins": [{ "path": "/opt/mods/first-mod" }],
    "pluginConfigs": {}
  }
}
```

- `process.*` применяется при запуске процесса агента. `session.*` применяется к каждой сессии этого процесса.
- `process.config` хранит агент-специфичный конфиг, его форма задаётся capability агента (например, `codex-toml`).
- `extends` ссылается на профиль того же агента. Цепочка разворачивается от базового к производному.

### Правила слияния `extends`

| Поле | Как сливается |
|---|---|
| `process.env`, `session.pluginConfigs` | по ключам, производный выигрывает |
| `session.mcpServers` | по `name` |
| `session.plugins` | по `path` |
| остальные поля (`args`, `config`, `systemPrompt`, `skills`) | производный заменяет целиком |

При сохранении профиля это ошибки 400:
- цикл в `extends`;
- ссылка на несуществующий профиль;
- ссылка на профиль другого агента;
- поле, которое агент не поддерживает по capability. В ответе список таких полей.

## Применение

1. **Запуск процесса.** `/v1/acp/:server_id?agent=<id>&profile=<name>` при первом обращении поднимает процесс с развёрнутыми `process.env` / `args` / `config`. После этого профиль закреплён за `server_id`. Обращение к тому же `server_id` с другим профилем даёт 409 `profile_mismatch`. Обращение без `profile` к уже поднятому процессу работает с закреплённым профилем.
2. **Сессии.** Прокси (`acp_proxy_runtime.rs`) переводит `session.*` в запрос конкретного агента. Это делается на `session/new`, а также на `session/load` и `session/resume`, поэтому настройки не теряются при восстановлении.
   - Claude: `systemPrompt` → `_meta.systemPrompt`; `plugins`, `pluginConfigs`, `skills` → `_meta.claudeCode.options.{plugins, settings}`.
   - `mcpServers` идёт в стандартное поле `mcpServers` запроса. MCP-серверы, переданные клиентом явно, сливаются с профилем по `name`, при совпадении выигрывает клиент.
   - `_meta`, переданный клиентом, сохраняется. Ключи профиля добавляются, а при конфликте выигрывает профиль. Конфликт пишется в лог без значений.
3. **Изменение профиля.** Новые сессии сразу получают новую `session`-часть. Изменения в `process` действуют только после перезапуска процесса: в списке серверов `/v1/acp` у такого процесса `profileStale: true`. Сервер сам процесс не перезапускает.
4. **Без профиля** поведение прежнее.

## API, SDK, CLI, Inspector

- `GET /v1/config/profiles`: список `{agent, name, source: "api" | "file", extends}`.
- `GET /v1/config/profiles/:agent/:name`: `{ stored, resolved }`, секреты замаскированы.
- `PUT /v1/config/profiles/:agent/:name` и `DELETE …`. Для `source: "file"` ответ 409 `profile_read_only`.
- SDK: `listProfiles`, `getProfile`, `putProfile`, `deleteProfile`. Опция `profile` у создания сессии и resume. В persist сессии хранится только имя профиля.
- CLI: `sandbox-agent profiles list|get|put|delete`. Флаг сервера `--profiles <file>` (JSON-массив профилей). Обновить `docs/cli.mdx`.
- OpenAPI перегенерировать (`pnpm --filter sandbox-agent generate`).
- Inspector:
  - профили редактируются на вкладке Agents;
  - в «Create Session» появляется выбор профиля;
  - вкладки Mods, Skills и MCP показывают соответствующие поля профиля (связано с SBA-74).

## Хранение

- Профили из API хранятся в state-каталоге сервера, по одному JSON-файлу на профиль (`profiles/<agent>/<name>.json`). Запись атомарная: временный файл, затем rename.
- Профили из `--profiles` читаются один раз при старте. При конфликте имени файл выигрывает у API.

## Секреты

- Значения `process.env`, `session.pluginConfigs` и `value` в `env` и `headers` у `session.mcpServers` записываются как есть. Наружу отдаётся `"***"` и `hasValue: true`. (Маскирование `mcpServers` добавлено 05.10.2026 при проверке плана: там обычно лежат токены.)
- PUT со значением `"***"` сохраняет прежнее значение.
- Значения не попадают в tracing-логи, Request Log и Events. Request Log Inspector маскирует тела запросов к `/v1/config/profiles`.

## Capability

У агента в `/v1/agents` появляется поле `customization`:

```json
{
  "process": { "env": true, "args": false, "config": "codex-toml" },
  "session": { "systemPrompt": ["replace", "append"], "mcpServers": true, "skills": true, "plugins": true }
}
```

По этому полю сервер проверяет профиль при сохранении, UI показывает только доступные поля, а `docs/agents/*.mdx` описывают поддержку.

## Устаревший API

- `/v1/config/mcp` и `/v1/config/skills` помечаются deprecated в OpenAPI и docs.
- В docs сразу пишем правду: эти эндпоинты агенту ничего не передают, а для MCP и skills нужны профили. Эту правку можно сделать до реализации профилей.
- Удаление в следующем minor.

## Тесты

- Rust unit:
  - слияние `extends` и ошибки цикла или чужого агента;
  - маскирование секретов и сохранение при `"***"`;
  - проверка профиля по capability.
- Rust интеграционные (mock-агент):
  - env из профиля дошёл до процесса;
  - `session.*` подставлен в `session/new` и снова в `session/load`;
  - 409 при другом профиле на том же `server_id`;
  - `profileStale` после изменения `process`;
  - 409 при изменении профиля из файла.
- TS SDK:
  - опция `profile` при создании и resume;
  - в persist нет значений env.
- Вручную на реальном Claude (после SBA-88):
  - замена системного промпта;
  - срабатывание mod с `tool.call` hook.

## Порядок работ

1. Docs по SBA-89: честное описание текущего поведения.
2. Ядро: модель, слияние, хранение, API, CLI, применение на уровне процесса.
3. Уровень сессии: подстановка в `session/new`, `load` и `resume`, capability `customization`.
4. Claude: системный промпт, mods и pluginConfigs вместе с SBA-88 (`CLAUDE_CODE_EXECUTABLE` → установленный `claude` 2.1.287+).
5. Codex, OpenCode, Pi: уровень процесса.
6. Inspector.

## Вне рамок

- Профиль на отдельную сессию с неявным пулом процессов. Отклонено, профиль привязан к процессу.
- Подстановка `${VAR}` из env сервера. Может появиться позже поверх `extends`.
- Автоматический перезапуск процесса при изменении `process`.

## Проверить при реализации

- Принимает ли `claude-agent-acp` skills через `settings` в `_meta`, или их нужно класть файлами в окружение агента.
- Как `session/load` и `session/resume` у каждого агента принимают `_meta` и `mcpServers`.
- Где state-каталог сервера (тот же, что у daemon state).
