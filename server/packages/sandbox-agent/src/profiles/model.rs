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
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
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
        assert_eq!(
            parsed.session.system_prompt.as_ref().unwrap().mode,
            SystemPromptMode::Replace
        );
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    }

    #[test]
    fn profile_rejects_unknown_fields() {
        assert!(serde_json::from_value::<AgentProfile>(json!({ "sesion": {} })).is_err());
        assert!(
            serde_json::from_value::<AgentProfile>(json!({ "session": { "prompt": "x" } }))
                .is_err()
        );
    }

    #[test]
    fn validate_name_rules() {
        for ok in ["review", "base-1", "a.b_c", "0x"] {
            assert!(validate_profile_name(ok).is_ok(), "{ok}");
        }
        let too_long = "x".repeat(65);
        for bad in ["", "-x", ".hidden", "a/b", "with space", too_long.as_str()] {
            assert_eq!(
                invalid_fields(validate_profile_name(bad).unwrap_err()),
                vec!["name"],
                "{bad}"
            );
        }
    }

    #[test]
    fn validate_shape_requires_unique_named_mcp_servers_and_plugins() {
        let unnamed = profile(json!({ "session": { "mcpServers": [{ "command": "x" }] } }));
        assert_eq!(
            invalid_fields(validate_profile_shape(&unnamed).unwrap_err()),
            vec!["session.mcpServers"]
        );
        let twice =
            profile(json!({ "session": { "mcpServers": [{ "name": "a" }, { "name": "a" }] } }));
        assert_eq!(
            invalid_fields(validate_profile_shape(&twice).unwrap_err()),
            vec!["session.mcpServers"]
        );
        let plugins =
            profile(json!({ "session": { "plugins": [{ "path": "/p" }, { "path": "/p" }] } }));
        assert_eq!(
            invalid_fields(validate_profile_shape(&plugins).unwrap_err()),
            vec!["session.plugins"]
        );
        let empty_extends = profile(json!({ "extends": " " }));
        assert_eq!(
            invalid_fields(validate_profile_shape(&empty_extends).unwrap_err()),
            vec!["extends"]
        );
        assert!(validate_profile_shape(&profile(json!({}))).is_ok());
    }

    #[test]
    fn process_fingerprint_changes_with_process_only() {
        let a = profile(json!({ "process": { "env": { "A": "1" } } }));
        let b = profile(
            json!({ "process": { "env": { "A": "1" } }, "session": { "plugins": [{ "path": "/p" }] } }),
        );
        let c = profile(json!({ "process": { "env": { "A": "2" } } }));
        assert_eq!(a.process_fingerprint(), b.process_fingerprint());
        assert_ne!(a.process_fingerprint(), c.process_fingerprint());
    }
}
