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
    profile_invalid, profile_not_found, validate_profile_name, validate_profile_shape, AgentProfile,
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
        message: format!(
            "invalid profiles file {}: {}",
            path.display(),
            describe_json_error(&err)
        ),
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
        Self {
            dir: None,
            entries: RwLock::new(BTreeMap::new()),
        }
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
                    let Some(name) = path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .map(str::to_string)
                    else {
                        continue;
                    };
                    match read_profile_file(&path, agent, &name) {
                        Ok(profile) => {
                            entries.insert(
                                key(agent, &name),
                                StoredProfile {
                                    agent,
                                    name,
                                    source: ProfileSource::Api,
                                    profile,
                                },
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
        Self {
            dir: Some(dir),
            entries: RwLock::new(entries),
        }
    }

    /// Adds the read-only profiles from `--profiles`. They replace API
    /// profiles with the same agent and name.
    pub fn install_file_profiles(&self, profiles: Vec<AgentProfile>) -> Result<(), SandboxError> {
        let mut entries = self.entries.write().expect("profile store lock");
        let mut seen = std::collections::BTreeSet::new();
        for mut profile in profiles {
            let agent_raw = profile.agent.clone().ok_or_else(|| {
                profile_invalid("a profile in the profiles file has no 'agent'", &["agent"])
            })?;
            let agent =
                AgentId::parse(&agent_raw).ok_or_else(|| SandboxError::UnsupportedAgent {
                    agent: agent_raw.clone(),
                })?;
            let name = profile.name.clone().ok_or_else(|| {
                profile_invalid(
                    format!("a '{agent_raw}' profile in the profiles file has no 'name'"),
                    &["name"],
                )
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
                StoredProfile {
                    agent,
                    name,
                    source: ProfileSource::File,
                    profile,
                },
            );
        }
        for stored in entries
            .values()
            .filter(|stored| stored.source == ProfileSource::File)
        {
            let resolved = resolve_in(&entries, stored.agent, &stored.name)?;
            validate_customization(stored.agent, &resolved)?;
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<StoredProfile> {
        self.entries
            .read()
            .expect("profile store lock")
            .values()
            .cloned()
            .collect()
    }

    pub fn get(&self, agent: AgentId, name: &str) -> Option<StoredProfile> {
        self.entries
            .read()
            .expect("profile store lock")
            .get(&key(agent, name))
            .cloned()
    }

    /// The profile merged through its `extends` chain.
    pub fn resolve(&self, agent: AgentId, name: &str) -> Result<AgentProfile, SandboxError> {
        let entries = self.entries.read().expect("profile store lock");
        resolve_in(&entries, agent, name)
    }

    /// Creates or replaces an API profile. Nothing changes when any check fails.
    pub fn put(
        &self,
        agent: AgentId,
        name: &str,
        mut profile: AgentProfile,
    ) -> Result<StoredProfile, SandboxError> {
        validate_profile_name(name)?;
        if let Some(body_agent) = profile.agent.as_deref() {
            if body_agent != agent.as_str() {
                return Err(profile_invalid(
                    format!(
                        "body agent '{body_agent}' does not match '{}' in the path",
                        agent.as_str()
                    ),
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

        let body = serde_json::to_vec_pretty(&stored.profile).map_err(|err| {
            SandboxError::StreamError {
                message: err.to_string(),
            }
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
        match self
            .profile_path(agent, name)
            .map(fs::remove_file)
            .unwrap_or(Ok(()))
        {
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
        self.dir
            .as_ref()
            .map(|dir| dir.join(agent.as_str()).join(format!("{name}.json")))
    }
}

fn resolve_in(
    entries: &BTreeMap<Key, StoredProfile>,
    agent: AgentId,
    name: &str,
) -> Result<AgentProfile, SandboxError> {
    resolve_chain(agent, name, |candidate| {
        entries
            .get(&key(agent, candidate))
            .map(|stored| &stored.profile)
    })
}

fn read_profile_file(path: &Path, agent: AgentId, name: &str) -> Result<AgentProfile, String> {
    validate_profile_name(name).map_err(|err| err.to_string())?;
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut profile: AgentProfile =
        serde_json::from_str(&text).map_err(|err| describe_json_error(&err))?;
    profile.agent = Some(agent.as_str().to_string());
    profile.name = Some(name.to_string());
    Ok(profile)
}

/// Category and position of a JSON error. The serde message itself is left
/// out: it can quote values from the file, and profile values are secrets.
pub(crate) fn describe_json_error(err: &serde_json::Error) -> String {
    let category = match err.classify() {
        serde_json::error::Category::Io => "read error",
        serde_json::error::Category::Syntax => "JSON syntax error",
        serde_json::error::Category::Data => "value does not match the profile format",
        serde_json::error::Category::Eof => "unexpected end of JSON",
    };
    format!("{category} at line {} column {}", err.line(), err.column())
}

/// Creates `dir` and missing parents. New directories are owner-only on unix
/// (they hold secrets); existing ones keep their permissions.
fn create_private_dir_all(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Writes to a temporary file next to `path`, then renames it over `path`.
/// The file is readable only by its owner: it holds secrets.
fn write_atomic(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "profile path has no parent",
        )
    })?;
    create_private_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("profile.json");
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
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "TOKEN": "s3cret" } } })),
            )
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
        let stored = reloaded
            .get(AgentId::Mock, "base")
            .expect("reloaded profile");
        assert_eq!(stored.source, ProfileSource::Api);
        assert_eq!(stored.profile.process.env["TOKEN"], "s3cret");
        assert_eq!(stored.profile.agent.as_deref(), Some("mock"));
        assert_eq!(stored.profile.name.as_deref(), Some("base"));
    }

    #[test]
    fn put_keeps_secret_sent_as_mask() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "TOKEN": "s3cret" } } })),
            )
            .unwrap();
        store
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "TOKEN": "***", "OTHER": "x" } } })),
            )
            .unwrap();
        let stored = store.get(AgentId::Mock, "base").unwrap();
        assert_eq!(stored.profile.process.env["TOKEN"], "s3cret");
        assert_eq!(stored.profile.process.env["OTHER"], "x");
    }

    #[test]
    fn put_rejects_body_for_another_profile() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let error = store
            .put(AgentId::Mock, "base", p(json!({ "agent": "claude" })))
            .unwrap_err();
        assert_eq!(invalid_fields(error), vec!["agent"]);
        let error = store
            .put(AgentId::Mock, "base", p(json!({ "name": "other" })))
            .unwrap_err();
        assert_eq!(invalid_fields(error), vec!["name"]);
    }

    #[test]
    fn put_rejects_extends_cycle_and_keeps_old_profile() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "base", p(json!({}))).unwrap();
        store
            .put(AgentId::Mock, "review", p(json!({ "extends": "base" })))
            .unwrap();
        let error = store
            .put(AgentId::Mock, "base", p(json!({ "extends": "review" })))
            .unwrap_err();
        assert_eq!(invalid_fields(error), vec!["extends"]);
        assert_eq!(
            store.get(AgentId::Mock, "base").unwrap().profile.extends,
            None
        );
        let on_disk = fs::read_to_string(dir.path().join("profiles/mock/base.json")).unwrap();
        assert!(!on_disk.contains("review"), "{on_disk}");
    }

    #[test]
    fn put_rejects_missing_parent_and_unsupported_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let error = store
            .put(AgentId::Mock, "review", p(json!({ "extends": "ghost" })))
            .unwrap_err();
        assert_eq!(invalid_fields(error), vec!["extends"]);
        let error = store
            .put(
                AgentId::Codex,
                "p",
                p(json!({ "session": { "systemPrompt": { "mode": "replace", "text": "x" } } })),
            )
            .unwrap_err();
        assert_eq!(invalid_fields(error), vec!["session.systemPrompt"]);
        assert!(store.get(AgentId::Codex, "p").is_none());
    }

    #[test]
    fn file_profiles_win_and_are_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store
            .put(
                AgentId::Mock,
                "ops",
                p(json!({ "process": { "env": { "A": "api" } } })),
            )
            .unwrap();
        store
            .install_file_profiles(vec![p(
                json!({ "agent": "mock", "name": "ops", "process": { "env": { "A": "file" } } }),
            )])
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
            invalid_fields(
                store
                    .install_file_profiles(vec![p(json!({ "name": "x" }))])
                    .unwrap_err()
            ),
            vec!["agent"]
        );
        assert_eq!(
            invalid_fields(
                store
                    .install_file_profiles(vec![p(json!({ "agent": "mock" }))])
                    .unwrap_err()
            ),
            vec!["name"]
        );
        assert_eq!(
            invalid_fields(
                store
                    .install_file_profiles(vec![p(
                        json!({ "agent": "mock", "name": "a", "extends": "ghost" })
                    )])
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
        store
            .put(
                AgentId::Mock,
                "review",
                p(json!({ "extends": "mock/base" })),
            )
            .unwrap();
        match store.delete(AgentId::Mock, "base").unwrap_err() {
            SandboxError::Conflict { message } => {
                assert!(message.contains("mock/review"), "{message}")
            }
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
        fs::write(
            agent_dir.join("good.json"),
            r#"{"session":{"plugins":[{"path":"/p"}]}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("profiles").join("not-an-agent.json"), "{}").unwrap();
        let store = store_in(&dir);
        assert!(store.get(AgentId::Mock, "broken").is_none());
        assert_eq!(
            store
                .get(AgentId::Mock, "good")
                .unwrap()
                .profile
                .session
                .plugins
                .len(),
            1
        );
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn resolve_merges_chain() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "A": "1", "B": "1" } } })),
            )
            .unwrap();
        store
            .put(
                AgentId::Mock,
                "review",
                p(json!({ "extends": "base", "process": { "env": { "B": "2" } } })),
            )
            .unwrap();
        let resolved = store.resolve(AgentId::Mock, "review").unwrap();
        assert_eq!(
            serde_json::to_value(&resolved.process.env).unwrap(),
            json!({ "A": "1", "B": "2" })
        );
    }

    #[test]
    fn state_dir_env_overrides_default() {
        assert!(server_state_dir_from(Some("/srv/sa-state".into())).ends_with("sa-state"));
        assert!(server_state_dir_from(None).ends_with(Path::new("sandbox-agent").join("state")));
    }

    #[test]
    fn in_memory_store_never_touches_disk() {
        let store = ProfileStore::in_memory();
        store
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "TOKEN": "s3cret" } } })),
            )
            .unwrap();
        assert_eq!(
            store
                .get(AgentId::Mock, "base")
                .unwrap()
                .profile
                .process
                .env["TOKEN"],
            "s3cret"
        );
        store.delete(AgentId::Mock, "base").unwrap();
        assert!(store.get(AgentId::Mock, "base").is_none());
        // No directory: no path is ever built, so nothing is read, written or removed.
        assert!(store.profile_path(AgentId::Mock, "base").is_none());
    }

    #[test]
    fn debug_does_not_print_secrets() {
        let store = ProfileStore::in_memory();
        let stored = store
            .put(
                AgentId::Mock,
                "base",
                p(json!({
                    "process": { "env": { "TOKEN": "env-s3cret" } },
                    "session": {
                        "pluginConfigs": { "plug": { "key": "plugin-s3cret" } },
                        "mcpServers": [
                            { "name": "fs", "command": "mcp", "args": [], "env": [{ "name": "K", "value": "mcp-env-s3cret" }] },
                            { "name": "web", "type": "http", "url": "https://x", "headers": [{ "name": "Authorization", "value": "mcp-header-s3cret" }] }
                        ]
                    }
                })),
            )
            .unwrap();
        for text in [format!("{store:?}"), format!("{stored:?}")] {
            for secret in [
                "env-s3cret",
                "plugin-s3cret",
                "mcp-env-s3cret",
                "mcp-header-s3cret",
            ] {
                assert!(!text.contains(secret), "{secret} leaked: {text}");
            }
            assert!(text.contains("TOKEN"), "{text}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn profile_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "TOKEN": "s3cret" } } })),
            )
            .unwrap();
        let path = dir.path().join("profiles/mock/base.json");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        store
            .put(
                AgentId::Mock,
                "base",
                p(json!({ "process": { "env": { "TOKEN": "***" } } })),
            )
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn corrupt_profile_errors_do_not_echo_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("base.json");
        fs::write(&path, r#"{"process":{"env":"s3cret-token"}}"#).unwrap();
        let error = read_profile_file(&path, AgentId::Mock, "base").unwrap_err();
        assert!(!error.contains("s3cret-token"), "{error}");
        assert!(error.contains("line 1"), "{error}");

        let file = dir.path().join("profiles.json");
        fs::write(
            &file,
            r#"[{"agent":"mock","name":"a","process":{"env":{"TOKEN":["s3cret-token"]}}}]"#,
        )
        .unwrap();
        let message = load_profiles_file(&file).unwrap_err().to_string();
        assert!(!message.contains("s3cret-token"), "{message}");
        assert!(
            message.contains("profiles.json") && message.contains("line 1"),
            "{message}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn profile_dirs_are_owner_only_and_existing_dirs_are_kept() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.put(AgentId::Mock, "base", p(json!({}))).unwrap();
        assert_eq!(mode(&dir.path().join("profiles")), 0o700);
        assert_eq!(mode(&dir.path().join("profiles/mock")), 0o700);

        let claude_dir = dir.path().join("profiles/claude");
        fs::create_dir(&claude_dir).unwrap();
        fs::set_permissions(&claude_dir, fs::Permissions::from_mode(0o750)).unwrap();
        store.put(AgentId::Claude, "base", p(json!({}))).unwrap();
        assert_eq!(mode(&claude_dir), 0o750);
    }
}
