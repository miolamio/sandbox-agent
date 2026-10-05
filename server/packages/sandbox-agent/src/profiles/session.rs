//! Applies the `session` part of a profile to session requests sent to an agent.

use std::collections::BTreeSet;

use sandbox_agent_agent_management::agents::AgentId;
use serde_json::{json, Map, Value};

use super::model::{ProfileSession, SystemPromptMode};

/// Requests that create or restore a session.
pub const PROFILE_SESSION_METHODS: [&str; 3] = ["session/new", "session/load", "session/resume"];

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
pub fn apply_session_profile(
    agent: AgentId,
    session: &ProfileSession,
    mut payload: Value,
) -> Value {
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
    server.get("name").and_then(Value::as_str).map(str::trim)
}

/// Profile servers whose name (trimmed) the client does not use, then the client's.
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
        meta.insert(
            "claudeCode".to_string(),
            json!({ "options": Value::Object(options) }),
        );
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
        let payload = request(
            "session/new",
            json!({
                "cwd": "/w",
                "mcpServers": [{ "name": "shared", "command": "client-cmd", "args": [], "env": [] }]
            }),
        );
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
        let payload = request(
            "session/new",
            json!({
                "cwd": "/w",
                "mcpServers": [],
                "_meta": {
                    "client.example/trace": "t1",
                    "systemPrompt": "client prompt",
                    "claudeCode": { "options": { "model": "opus", "plugins": [] } }
                }
            }),
        );
        let applied = apply_session_profile(AgentId::Claude, &profile_session(), payload);
        let meta = &applied["params"]["_meta"];
        assert_eq!(meta["client.example/trace"], "t1");
        assert_eq!(meta["systemPrompt"], "You are a reviewer.");
        assert_eq!(meta["claudeCode"]["options"]["model"], "opus");
        assert_eq!(
            meta["claudeCode"]["options"]["plugins"],
            json!([{ "type": "local", "path": "/opt/mods/first" }])
        );
    }

    #[test]
    fn load_and_resume_are_translated_too() {
        for method in ["session/load", "session/resume"] {
            let payload = request(
                method,
                json!({ "sessionId": "s1", "cwd": "/w", "mcpServers": [] }),
            );
            let applied = apply_session_profile(AgentId::Mock, &profile_session(), payload);
            assert_eq!(applied["params"]["sessionId"], "s1", "{method}");
            assert_eq!(
                applied["params"]["_meta"]["systemPrompt"], "You are a reviewer.",
                "{method}"
            );
            assert_eq!(applied["params"]["mcpServers"][0]["name"], "fs", "{method}");
        }
    }

    #[test]
    fn append_prompt_uses_append_object() {
        let profile = session(json!({ "systemPrompt": { "mode": "append", "text": "Be brief." } }));
        let applied = apply_session_profile(
            AgentId::Claude,
            &profile,
            request("session/new", json!({ "cwd": "/w" })),
        );
        assert_eq!(
            applied["params"]["_meta"],
            json!({ "systemPrompt": { "append": "Be brief." } })
        );
        assert!(applied["params"].get("mcpServers").is_none());
    }

    #[test]
    fn other_agents_get_only_mcp_servers() {
        let applied = apply_session_profile(
            AgentId::Codex,
            &profile_session(),
            request("session/new", json!({ "cwd": "/w" })),
        );
        assert!(applied["params"].get("_meta").is_none());
        assert_eq!(applied["params"]["mcpServers"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn other_methods_and_empty_profiles_change_nothing() {
        let prompt = request("session/prompt", json!({ "sessionId": "s1", "prompt": [] }));
        assert_eq!(
            apply_session_profile(AgentId::Claude, &profile_session(), prompt.clone()),
            prompt
        );
        let new = request("session/new", json!({ "cwd": "/w", "mcpServers": [] }));
        assert_eq!(
            apply_session_profile(AgentId::Claude, &ProfileSession::default(), new.clone()),
            new
        );
    }

    #[test]
    fn missing_params_are_created() {
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "session/new" });
        let applied = apply_session_profile(AgentId::Claude, &profile_session(), payload);
        assert_eq!(
            applied["params"]["_meta"]["systemPrompt"],
            "You are a reviewer."
        );
    }

    #[test]
    fn mcp_server_names_are_trimmed_before_merging() {
        let profile = session(
            json!({ "mcpServers": [{ "name": "shared ", "command": "profile-cmd", "args": [], "env": [] }] }),
        );
        let payload = request(
            "session/new",
            json!({
                "cwd": "/w",
                "mcpServers": [{ "name": " shared", "command": "client-cmd", "args": [], "env": [] }]
            }),
        );
        let applied = apply_session_profile(AgentId::Codex, &profile, payload);
        assert_eq!(
            applied["params"]["mcpServers"],
            json!([{ "name": " shared", "command": "client-cmd", "args": [], "env": [] }])
        );
    }

    #[test]
    fn method_filter() {
        assert!(is_profile_session_method("session/resume"));
        assert!(!is_profile_session_method("session/prompt"));
    }
}
