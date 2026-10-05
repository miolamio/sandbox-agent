use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_error::SandboxError;
use serde_json::Value;

use super::model::{
    profile_invalid, profile_not_found, validate_profile_name, AgentProfile, ProfilePlugin,
    ProfileProcess, ProfileSession,
};

/// Merges `derived` over `base` by the spec table: `process.env` and
/// `session.pluginConfigs` by key, `session.mcpServers` by `name`,
/// `session.plugins` by `path` (derived wins in all of them); every other field
/// is replaced whole when the derived profile sets it.
pub fn merge_profiles(base: &AgentProfile, derived: &AgentProfile) -> AgentProfile {
    let mut env = base.process.env.clone();
    env.extend(
        derived
            .process
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone())),
    );
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
            args: derived
                .process
                .args
                .clone()
                .or_else(|| base.process.args.clone()),
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
        let position = mcp_server_name(server).and_then(|name| {
            merged
                .iter()
                .position(|existing| mcp_server_name(existing) == Some(name))
        });
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
        match merged
            .iter()
            .position(|existing| existing.path == plugin.path)
        {
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
        let paths: Vec<&str> = merged
            .session
            .plugins
            .iter()
            .map(|plugin| plugin.path.as_str())
            .collect();
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
            (
                "root".to_string(),
                p(json!({ "process": { "env": { "A": "root", "B": "root", "C": "root" } } })),
            ),
            (
                "mid".to_string(),
                p(json!({ "extends": "root", "process": { "env": { "B": "mid", "C": "mid" } } })),
            ),
            (
                "leaf".to_string(),
                p(json!({ "extends": "mock/mid", "process": { "env": { "C": "leaf" } } })),
            ),
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
        let (message, fields) =
            invalid(resolve_chain(AgentId::Mock, "a", |name| profiles.get(name)).unwrap_err());
        assert_eq!(fields, vec!["extends"]);
        assert!(message.contains("cycle: a -> b -> a"), "{message}");
    }

    #[test]
    fn resolve_chain_reports_missing_parent() {
        let profiles: BTreeMap<String, AgentProfile> =
            [("leaf".to_string(), p(json!({ "extends": "ghost" })))]
                .into_iter()
                .collect();
        let (message, fields) =
            invalid(resolve_chain(AgentId::Mock, "leaf", |name| profiles.get(name)).unwrap_err());
        assert_eq!(fields, vec!["extends"]);
        assert_eq!(
            message,
            "profile 'mock/leaf' extends 'ghost', which does not exist"
        );
    }

    #[test]
    fn resolve_chain_rejects_other_agent() {
        let profiles: BTreeMap<String, AgentProfile> =
            [("leaf".to_string(), p(json!({ "extends": "codex/base" })))]
                .into_iter()
                .collect();
        let (message, fields) =
            invalid(resolve_chain(AgentId::Mock, "leaf", |name| profiles.get(name)).unwrap_err());
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
