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

/// A JSON value counts as set unless it is null, an empty array or an empty object.
fn value_is_set(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Array(items) => !items.is_empty(),
        serde_json::Value::Object(map) => !map.is_empty(),
        _ => true,
    }
}

/// Fields set in `profile` that `agent` does not support, as dotted paths.
/// Empty arrays and objects count as unset.
pub fn unsupported_fields(agent: AgentId, profile: &AgentProfile) -> Vec<String> {
    let caps = agent_customization_for(agent);
    let mut fields = Vec::new();
    let mut check = |set: bool, supported: bool, field: &str| {
        if set && !supported {
            fields.push(field.to_string());
        }
    };
    check(
        !profile.process.env.is_empty(),
        caps.process.env,
        "process.env",
    );
    check(
        profile
            .process
            .args
            .as_ref()
            .is_some_and(|args| !args.is_empty()),
        caps.process.args,
        "process.args",
    );
    check(
        profile.process.config.as_ref().is_some_and(value_is_set),
        caps.process.config.is_some(),
        "process.config",
    );
    check(
        profile.session.system_prompt.is_some(),
        profile
            .session
            .system_prompt
            .as_ref()
            .is_some_and(|prompt| caps.session.system_prompt.contains(&prompt.mode)),
        "session.systemPrompt",
    );
    check(
        !profile.session.mcp_servers.is_empty(),
        caps.session.mcp_servers,
        "session.mcpServers",
    );
    check(
        profile
            .session
            .skills
            .as_ref()
            .is_some_and(|skills| !skills.is_empty()),
        caps.session.skills,
        "session.skills",
    );
    check(
        !profile.session.plugins.is_empty(),
        caps.session.plugins,
        "session.plugins",
    );
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
        format!(
            "agent '{}' does not support: {}",
            agent.as_str(),
            fields.join(", ")
        ),
        &refs,
    ))
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
            assert_eq!(
                caps.session.system_prompt,
                vec![SystemPromptMode::Replace, SystemPromptMode::Append]
            );
            assert!(
                caps.session.plugins && caps.session.plugin_configs && caps.session.mcp_servers
            );
            assert!(!caps.session.skills);
        }
    }

    #[test]
    fn unsupported_fields_lists_every_field() {
        let profile = p(json!({
            "process": { "env": { "A": "1" }, "args": ["--x"], "config": { "model": "x" } },
            "session": {
                "systemPrompt": { "mode": "replace", "text": "x" },
                "mcpServers": [{ "name": "fs" }],
                "skills": [{ "name": "s" }],
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
    fn empty_fields_count_as_unset() {
        let profile = p(json!({
            "process": { "env": {}, "args": [], "config": {} },
            "session": {
                "mcpServers": [],
                "skills": [],
                "plugins": [],
                "pluginConfigs": {}
            }
        }));
        for agent in [AgentId::Codex, AgentId::Claude, AgentId::Pi] {
            assert!(unsupported_fields(agent, &profile).is_empty(), "{agent:?}");
        }
        let null_config = p(json!({ "process": { "config": null } }));
        assert!(unsupported_fields(AgentId::Codex, &null_config).is_empty());
        let scalar_config = p(json!({ "process": { "config": "x" } }));
        assert_eq!(
            unsupported_fields(AgentId::Codex, &scalar_config),
            vec!["process.config"]
        );
    }

    #[test]
    fn spec_example_profile_is_valid_for_claude() {
        let profile = p(json!({
            "agent": "claude",
            "extends": "base",
            "process": {
                "env": { "ANTHROPIC_BASE_URL": "x", "CLAUDE_CODE_PLUGIN_DIRS": "y" },
                "args": [],
                "config": {}
            },
            "session": {
                "systemPrompt": { "mode": "replace", "text": "x" },
                "mcpServers": [],
                "skills": [],
                "plugins": [{ "path": "/opt/mods/first-mod" }],
                "pluginConfigs": {}
            }
        }));
        assert!(validate_customization(AgentId::Claude, &profile).is_ok());
    }

    #[test]
    fn validate_customization_returns_profile_invalid() {
        let profile =
            p(json!({ "session": { "systemPrompt": { "mode": "append", "text": "x" } } }));
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
