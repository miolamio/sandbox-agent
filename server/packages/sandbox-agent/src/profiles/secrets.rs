use std::collections::BTreeMap;

use sandbox_agent_error::SandboxError;
use serde_json::Value;

use super::model::{profile_invalid, AgentProfile};

pub const SECRET_MASK: &str = "***";

/// Fields of an MCP server entry whose values are secrets: `env` (stdio) and
/// `headers` (http/sse), both lists of `{ "name", "value" }` in the session
/// request format.
const MCP_SECRET_FIELDS: [&str; 2] = ["env", "headers"];

/// `(trimmed server name, field, entry name, value)` for every string `value` of the
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
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        for (field, entries) in server.iter_mut() {
            let Some(field) = MCP_SECRET_FIELDS
                .iter()
                .copied()
                .find(|name| *name == field.as_str())
            else {
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

/// Stored value of `server`/`field`/`entry` in `servers`, if any. Server
/// names are compared trimmed, as in `merge_profiles`.
fn previous_mcp_secret(
    servers: &[Value],
    server: &str,
    field: &str,
    entry: &str,
) -> Option<String> {
    servers
        .iter()
        .find(|candidate| {
            candidate.get("name").and_then(Value::as_str).map(str::trim) == Some(server)
        })?
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
        has_value.insert(
            format!("session.mcpServers.{server}.{field}.{entry}"),
            !value.is_empty(),
        );
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
        let previous = p(
            json!({ "process": { "env": { "TOKEN": "s3cret" } }, "session": { "pluginConfigs": { "mod": { "key": "v" } } } }),
        );
        let mut incoming = p(
            json!({ "process": { "env": { "TOKEN": "***", "NEW": "n" } }, "session": { "pluginConfigs": { "mod": "***" } } }),
        );
        restore_masked_secrets(&mut incoming, Some(&previous)).unwrap();
        assert_eq!(incoming.process.env["TOKEN"], "s3cret");
        assert_eq!(incoming.process.env["NEW"], "n");
        assert_eq!(
            incoming.session.plugin_configs["mod"],
            json!({ "key": "v" })
        );
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
        assert_eq!(
            incoming.session.mcp_servers[0]["env"][0]["value"],
            "s3cret-env"
        );
        assert_eq!(incoming.session.mcp_servers[0]["env"][1]["value"], "n");
        assert_eq!(
            incoming.session.mcp_servers[1]["headers"][0]["value"],
            "Bearer old"
        );
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

    #[test]
    fn restore_matches_mcp_servers_by_trimmed_name() {
        let previous = p(json!({ "session": { "mcpServers": [
            { "name": " fs ", "command": "node", "env": [{ "name": "FS_TOKEN", "value": "s3cret-env" }] }
        ] } }));
        let mut incoming = p(json!({ "session": { "mcpServers": [
            { "name": "fs", "command": "node", "env": [{ "name": "FS_TOKEN", "value": "***" }] }
        ] } }));
        restore_masked_secrets(&mut incoming, Some(&previous)).unwrap();
        assert_eq!(
            incoming.session.mcp_servers[0]["env"][0]["value"],
            "s3cret-env"
        );
    }
}
