use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCredentials {
    pub api_key: String,
    pub source: String,
    pub auth_type: AuthType,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    ApiKey,
    Oauth,
    /// Claude Code obtains its key at runtime from the `apiKeyHelper` command
    /// configured in `~/.claude/settings.json`. There is no static key.
    ApiKeyHelper,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractedCredentials {
    pub anthropic: Option<ProviderCredentials>,
    pub openai: Option<ProviderCredentials>,
    pub other: HashMap<String, ProviderCredentials>,
}

#[derive(Debug, Clone, Default)]
pub struct CredentialExtractionOptions {
    pub home_dir: Option<PathBuf>,
    pub include_oauth: bool,
}

impl CredentialExtractionOptions {
    pub fn new() -> Self {
        Self {
            home_dir: None,
            include_oauth: true,
        }
    }
}

pub fn extract_claude_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let keychain = claude_keychain_reader(options);
    extract_claude_credentials_with_keychain(
        options,
        keychain
            .as_ref()
            .map(|reader| reader as &dyn Fn() -> Option<String>),
    )
}

/// Reads Claude credentials in order: API key configs, OAuth credential files,
/// `apiKeyHelper` from settings, then the OS keychain (when a reader is given).
fn extract_claude_credentials_with_keychain(
    options: &CredentialExtractionOptions,
    keychain: Option<&dyn Fn() -> Option<String>>,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;

    let config_paths = [
        home_dir.join(".claude.json.api"),
        home_dir.join(".claude.json"),
        home_dir.join(".claude.json.nathan"),
    ];

    let key_paths = [
        vec!["primaryApiKey"],
        vec!["apiKey"],
        vec!["anthropicApiKey"],
        vec!["customApiKey"],
    ];

    for path in config_paths {
        let Some(data) = read_json_file(&path) else {
            continue;
        };
        for key_path in &key_paths {
            if let Some(key) = read_string_field(&data, key_path) {
                if key.starts_with("sk-ant-") {
                    return Some(ProviderCredentials {
                        api_key: key,
                        source: "claude-code".to_string(),
                        auth_type: AuthType::ApiKey,
                        provider: "anthropic".to_string(),
                    });
                }
            }
        }
    }

    if include_oauth {
        let oauth_paths = [
            home_dir.join(".claude").join(".credentials.json"),
            home_dir.join(".claude-oauth-credentials.json"),
        ];
        for path in oauth_paths {
            let data = match read_json_file(&path) {
                Some(value) => value,
                None => continue,
            };
            if let Some(cred) = extract_claude_oauth_from_json(&data) {
                return Some(cred);
            }
        }
    }

    let settings_path = home_dir.join(".claude").join("settings.json");
    if let Some(settings) = read_json_file(&settings_path) {
        if let Some(helper) = read_string_field(&settings, &["apiKeyHelper"]) {
            if !helper.trim().is_empty() {
                return Some(ProviderCredentials {
                    api_key: String::new(),
                    source: "claude-code-api-key-helper".to_string(),
                    auth_type: AuthType::ApiKeyHelper,
                    provider: "anthropic".to_string(),
                });
            }
        }
    }

    if include_oauth {
        if let Some(read_keychain) = keychain {
            if let Some(raw) = read_keychain() {
                if let Ok(data) = serde_json::from_str::<Value>(raw.trim()) {
                    if let Some(cred) = extract_claude_oauth_from_json(&data) {
                        return Some(cred);
                    }
                }
            }
        }
    }

    None
}

fn extract_claude_oauth_from_json(data: &Value) -> Option<ProviderCredentials> {
    let oauth = data.get("claudeAiOauth")?;
    let token = oauth.get("accessToken").and_then(Value::as_str)?;
    if token.is_empty() {
        return None;
    }
    if oauth.get("expiresAt").is_some_and(is_expired) {
        return None;
    }
    Some(ProviderCredentials {
        api_key: token.to_string(),
        source: "claude-code".to_string(),
        auth_type: AuthType::Oauth,
        provider: "anthropic".to_string(),
    })
}

/// Returns the keychain reader to use for Claude OAuth credentials, if any.
///
/// The keychain is only consulted on macOS, when OAuth is enabled, and when the
/// caller did not override `home_dir`. An overridden home means the caller wants
/// credentials from that directory only (tests, `--home-dir`), so host keychain
/// entries must not leak in.
fn claude_keychain_reader(options: &CredentialExtractionOptions) -> Option<fn() -> Option<String>> {
    if options.home_dir.is_some() || !options.include_oauth {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        Some(read_claude_keychain_entry)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn read_claude_keychain_entry() -> Option<String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

pub fn extract_codex_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;
    let path = home_dir.join(".codex").join("auth.json");
    let data = read_json_file(&path)?;

    if let Some(key) = data.get("OPENAI_API_KEY").and_then(Value::as_str) {
        if !key.is_empty() {
            return Some(ProviderCredentials {
                api_key: key.to_string(),
                source: "codex".to_string(),
                auth_type: AuthType::ApiKey,
                provider: "openai".to_string(),
            });
        }
    }

    if include_oauth {
        if let Some(token) = read_string_field(&data, &["tokens", "access_token"]) {
            return Some(ProviderCredentials {
                api_key: token,
                source: "codex".to_string(),
                auth_type: AuthType::Oauth,
                provider: "openai".to_string(),
            });
        }
    }

    None
}

pub fn extract_opencode_credentials(options: &CredentialExtractionOptions) -> ExtractedCredentials {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;
    let path = home_dir
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");

    let mut result = ExtractedCredentials::default();
    let data = match read_json_file(&path) {
        Some(value) => value,
        None => return result,
    };

    let obj = match data.as_object() {
        Some(obj) => obj,
        None => return result,
    };

    for (provider_name, value) in obj {
        let config = match value.as_object() {
            Some(config) => config,
            None => continue,
        };

        let auth_type = config.get("type").and_then(Value::as_str).unwrap_or("");

        let credentials = if auth_type == "api" {
            config
                .get("key")
                .and_then(Value::as_str)
                .map(|key| ProviderCredentials {
                    api_key: key.to_string(),
                    source: "opencode".to_string(),
                    auth_type: AuthType::ApiKey,
                    provider: provider_name.to_string(),
                })
        } else if auth_type == "oauth" && include_oauth {
            let expires = config.get("expires").and_then(Value::as_i64);
            if let Some(expires) = expires {
                if expires < current_epoch_millis() {
                    None
                } else {
                    config
                        .get("access")
                        .and_then(Value::as_str)
                        .map(|token| ProviderCredentials {
                            api_key: token.to_string(),
                            source: "opencode".to_string(),
                            auth_type: AuthType::Oauth,
                            provider: provider_name.to_string(),
                        })
                }
            } else {
                config
                    .get("access")
                    .and_then(Value::as_str)
                    .map(|token| ProviderCredentials {
                        api_key: token.to_string(),
                        source: "opencode".to_string(),
                        auth_type: AuthType::Oauth,
                        provider: provider_name.to_string(),
                    })
            }
        } else {
            None
        };

        if let Some(credentials) = credentials {
            if provider_name == "anthropic" {
                result.anthropic = Some(credentials.clone());
            } else if provider_name == "openai" {
                result.openai = Some(credentials.clone());
            } else {
                result
                    .other
                    .insert(provider_name.to_string(), credentials.clone());
            }
        }
    }

    result
}

pub fn extract_amp_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let path = home_dir.join(".amp").join("config.json");
    let data = read_json_file(&path)?;

    let key_paths: Vec<Vec<&str>> = vec![
        vec!["anthropicApiKey"],
        vec!["anthropic_api_key"],
        vec!["apiKey"],
        vec!["api_key"],
        vec!["accessToken"],
        vec!["access_token"],
        vec!["token"],
        vec!["auth", "anthropicApiKey"],
        vec!["auth", "apiKey"],
        vec!["auth", "token"],
        vec!["anthropic", "apiKey"],
        vec!["anthropic", "token"],
    ];

    for key_path in key_paths {
        if let Some(key) = read_string_field(&data, &key_path) {
            if !key.is_empty() {
                return Some(ProviderCredentials {
                    api_key: key,
                    source: "amp".to_string(),
                    auth_type: AuthType::ApiKey,
                    provider: "anthropic".to_string(),
                });
            }
        }
    }

    None
}

pub fn extract_all_credentials(options: &CredentialExtractionOptions) -> ExtractedCredentials {
    let mut result = ExtractedCredentials::default();

    if let Ok(value) = std::env::var("ANTHROPIC_API_KEY") {
        result.anthropic = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        });
    } else if let Ok(value) = std::env::var("CLAUDE_API_KEY") {
        result.anthropic = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        });
    } else if options.include_oauth {
        if let Ok(value) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
            result.anthropic = Some(ProviderCredentials {
                api_key: value,
                source: "environment".to_string(),
                auth_type: AuthType::Oauth,
                provider: "anthropic".to_string(),
            });
        } else if let Ok(value) = std::env::var("ANTHROPIC_AUTH_TOKEN") {
            result.anthropic = Some(ProviderCredentials {
                api_key: value,
                source: "environment".to_string(),
                auth_type: AuthType::Oauth,
                provider: "anthropic".to_string(),
            });
        }
    }

    if let Ok(value) = std::env::var("OPENAI_API_KEY") {
        result.openai = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        });
    } else if let Ok(value) = std::env::var("CODEX_API_KEY") {
        result.openai = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        });
    }

    if result.anthropic.is_none() {
        result.anthropic = extract_amp_credentials(options);
    }

    if result.anthropic.is_none() {
        result.anthropic = extract_claude_credentials(options);
    }

    if result.openai.is_none() {
        result.openai = extract_codex_credentials(options);
    }

    let opencode_credentials = extract_opencode_credentials(options);
    if result.anthropic.is_none() {
        result.anthropic = opencode_credentials.anthropic.clone();
    }
    if result.openai.is_none() {
        result.openai = opencode_credentials.openai.clone();
    }

    for (key, value) in opencode_credentials.other {
        result.other.entry(key).or_insert(value);
    }

    result
}

pub fn get_anthropic_api_key(options: &CredentialExtractionOptions) -> Option<String> {
    extract_all_credentials(options)
        .anthropic
        .map(|cred| cred.api_key)
}

pub fn get_openai_api_key(options: &CredentialExtractionOptions) -> Option<String> {
    extract_all_credentials(options)
        .openai
        .map(|cred| cred.api_key)
}

pub fn set_credentials_as_env_vars(credentials: &ExtractedCredentials) {
    if let Some(cred) = &credentials.anthropic {
        // apiKeyHelper credentials have no static key; the agent runs the helper itself.
        if cred.auth_type != AuthType::ApiKeyHelper {
            std::env::set_var("ANTHROPIC_API_KEY", &cred.api_key);
        }
    }
    if let Some(cred) = &credentials.openai {
        std::env::set_var("OPENAI_API_KEY", &cred.api_key);
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn read_string_field(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn default_home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn current_epoch_millis() -> i64 {
    let now = OffsetDateTime::now_utc();
    (now.unix_timestamp() * 1000) + (now.millisecond() as i64)
}

/// Returns true if an OAuth expiry value is in the past.
///
/// Claude Code writes `expiresAt` as epoch milliseconds (a number). Other configs
/// may use an RFC3339 string or milliseconds stored as a string. Values that
/// cannot be interpreted are treated as not expired, so credentials we cannot
/// judge are never discarded.
fn is_expired(value: &Value) -> bool {
    match value {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .map(|millis| millis < current_epoch_millis())
            .unwrap_or(false),
        Value::String(s) => is_expired_timestamp_str(s),
        _ => false,
    }
}

fn is_expired_timestamp_str(value: &str) -> bool {
    if let Ok(expiry) = OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
    {
        return expiry < OffsetDateTime::now_utc();
    }
    if let Ok(millis) = value.trim().parse::<i64>() {
        return millis < current_epoch_millis();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const ANTHROPIC_ENV_KEYS: [&str; 5] = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_API_KEY",
    ];

    fn with_env(mutations: &[(&str, Option<&str>)], test_fn: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");

        let mut snapshot: HashMap<String, Option<String>> = HashMap::new();
        for key in ANTHROPIC_ENV_KEYS {
            snapshot.insert(key.to_string(), std::env::var(key).ok());
        }

        for (key, value) in mutations {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        test_fn();

        for (key, value) in snapshot {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    fn empty_home_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "sandbox-agent-agent-credentials-test-{pid}-{seq}-{nanos}"
        ));
        fs::create_dir_all(&path).expect("failed to create temp home dir");
        path
    }

    #[test]
    fn extract_all_credentials_reads_claude_code_oauth_env() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from oauth env");

                assert_eq!(anthropic.api_key, "oauth-token-123");
                assert_eq!(anthropic.source, "environment");
                assert_eq!(anthropic.auth_type, AuthType::Oauth);
                assert_eq!(anthropic.provider, "anthropic");
            },
        );
    }

    #[test]
    fn extract_all_credentials_ignores_oauth_env_when_disabled() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: false,
                };
                let creds = extract_all_credentials(&options);
                assert!(
                    creds.anthropic.is_none(),
                    "oauth env should be ignored when include_oauth is false"
                );
            },
        );
    }

    #[test]
    fn extract_all_credentials_prefers_api_key_over_oauth_env() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", Some("sk-ant-priority")),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", Some("oauth-token-456")),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from api key env");

                assert_eq!(anthropic.api_key, "sk-ant-priority");
                assert_eq!(anthropic.auth_type, AuthType::ApiKey);
            },
        );
    }

    fn home_with_codex_auth(auth: &str) -> PathBuf {
        let home = empty_home_dir();
        fs::create_dir_all(home.join(".codex")).expect("failed to create .codex dir");
        fs::write(home.join(".codex").join("auth.json"), auth).expect("failed to write auth.json");
        home
    }

    const CODEX_OAUTH_AUTH_JSON: &str =
        r#"{"OPENAI_API_KEY": null, "tokens": {"access_token": "fake-access-token"}}"#;

    #[test]
    fn extract_codex_credentials_reads_oauth_tokens() {
        let options = CredentialExtractionOptions {
            home_dir: Some(home_with_codex_auth(CODEX_OAUTH_AUTH_JSON)),
            include_oauth: true,
        };
        let creds = extract_codex_credentials(&options).expect("expected codex oauth credentials");

        assert_eq!(creds.api_key, "fake-access-token");
        assert_eq!(creds.source, "codex");
        assert_eq!(creds.auth_type, AuthType::Oauth);
        assert_eq!(creds.provider, "openai");
    }

    #[test]
    fn extract_codex_credentials_ignores_oauth_when_disabled() {
        let options = CredentialExtractionOptions {
            home_dir: Some(home_with_codex_auth(CODEX_OAUTH_AUTH_JSON)),
            include_oauth: false,
        };
        assert!(
            extract_codex_credentials(&options).is_none(),
            "codex oauth tokens should be ignored when include_oauth is false"
        );
    }

    #[test]
    fn extract_codex_credentials_prefers_api_key_over_oauth() {
        let options = CredentialExtractionOptions {
            home_dir: Some(home_with_codex_auth(
                r#"{"OPENAI_API_KEY": "sk-fake", "tokens": {"access_token": "fake-access-token"}}"#,
            )),
            include_oauth: true,
        };
        let creds =
            extract_codex_credentials(&options).expect("expected codex api key credentials");

        assert_eq!(creds.api_key, "sk-fake");
        assert_eq!(creds.auth_type, AuthType::ApiKey);
    }

    fn write_claude_oauth_json(home: &Path, body: serde_json::Value) {
        let dir = home.join(".claude");
        fs::create_dir_all(&dir).expect("failed to create .claude dir");
        fs::write(dir.join(".credentials.json"), body.to_string())
            .expect("failed to write credentials file");
    }

    fn write_claude_oauth(home: &Path, expires_at: serde_json::Value) {
        write_claude_oauth_json(
            home,
            serde_json::json!({
                "claudeAiOauth": {
                    "accessToken": "fake-oauth-token",
                    "expiresAt": expires_at,
                }
            }),
        );
    }

    fn oauth_options(home: PathBuf) -> CredentialExtractionOptions {
        CredentialExtractionOptions {
            home_dir: Some(home),
            include_oauth: true,
        }
    }

    #[test]
    fn claude_oauth_rejected_when_numeric_millis_expired() {
        let home = empty_home_dir();
        write_claude_oauth(&home, serde_json::json!(1000));
        assert!(
            extract_claude_credentials(&oauth_options(home)).is_none(),
            "expired numeric (millisecond) expiresAt must be rejected"
        );
    }

    #[test]
    fn claude_oauth_accepted_when_numeric_millis_valid() {
        let home = empty_home_dir();
        let future = current_epoch_millis() + 3_600_000;
        write_claude_oauth(&home, serde_json::json!(future));
        let creds = extract_claude_credentials(&oauth_options(home))
            .expect("valid numeric expiresAt should yield oauth credentials");
        assert_eq!(creds.auth_type, AuthType::Oauth);
        assert_eq!(creds.api_key, "fake-oauth-token");
        assert_eq!(creds.source, "claude-code");
        assert_eq!(creds.provider, "anthropic");
    }

    #[test]
    fn claude_oauth_rejected_when_string_millis_expired() {
        let home = empty_home_dir();
        write_claude_oauth(&home, serde_json::json!("1000"));
        assert!(
            extract_claude_credentials(&oauth_options(home)).is_none(),
            "expired millisecond string expiresAt must be rejected"
        );
    }

    #[test]
    fn claude_oauth_rejected_when_rfc3339_expired() {
        let home = empty_home_dir();
        write_claude_oauth(&home, serde_json::json!("2000-01-01T00:00:00Z"));
        assert!(
            extract_claude_credentials(&oauth_options(home)).is_none(),
            "expired RFC3339 expiresAt must be rejected"
        );
    }

    #[test]
    fn claude_oauth_accepted_when_rfc3339_valid() {
        let home = empty_home_dir();
        write_claude_oauth(&home, serde_json::json!("2099-01-01T00:00:00Z"));
        let creds = extract_claude_credentials(&oauth_options(home))
            .expect("future RFC3339 expiresAt should yield oauth credentials");
        assert_eq!(creds.auth_type, AuthType::Oauth);
    }

    #[test]
    fn claude_oauth_accepted_when_expiresat_missing() {
        let home = empty_home_dir();
        write_claude_oauth_json(
            &home,
            serde_json::json!({"claudeAiOauth": {"accessToken": "fake-oauth-token"}}),
        );
        let creds = extract_claude_credentials(&oauth_options(home))
            .expect("missing expiresAt should not discard credentials");
        assert_eq!(creds.auth_type, AuthType::Oauth);
        assert_eq!(creds.api_key, "fake-oauth-token");
    }

    #[test]
    fn claude_oauth_ignores_empty_access_token() {
        let home = empty_home_dir();
        write_claude_oauth_json(
            &home,
            serde_json::json!({"claudeAiOauth": {"accessToken": "", "expiresAt": 9_999_999_999_999_i64}}),
        );
        assert!(
            extract_claude_credentials(&oauth_options(home)).is_none(),
            "empty accessToken must not produce credentials"
        );
    }

    fn write_claude_settings(home: &Path, body: &str) {
        let dir = home.join(".claude");
        fs::create_dir_all(&dir).expect("failed to create .claude dir");
        fs::write(dir.join("settings.json"), body).expect("failed to write settings.json");
    }

    const CLEAR_ANTHROPIC_ENV: [(&str, Option<&str>); 4] = [
        ("ANTHROPIC_API_KEY", None),
        ("CLAUDE_API_KEY", None),
        ("CLAUDE_CODE_OAUTH_TOKEN", None),
        ("ANTHROPIC_AUTH_TOKEN", None),
    ];

    #[test]
    fn extract_claude_credentials_detects_api_key_helper() {
        with_env(&CLEAR_ANTHROPIC_ENV, || {
            let home = empty_home_dir();
            write_claude_settings(
                &home,
                r#"{"apiKeyHelper": "/usr/local/bin/fake-key-helper"}"#,
            );

            let creds = extract_all_credentials(&oauth_options(home));
            let anthropic = creds
                .anthropic
                .expect("expected anthropic credentials from apiKeyHelper");

            assert_eq!(anthropic.source, "claude-code-api-key-helper");
            assert_eq!(anthropic.auth_type, AuthType::ApiKeyHelper);
            assert_eq!(anthropic.provider, "anthropic");
            assert!(anthropic.api_key.is_empty());
        });
    }

    #[test]
    fn extract_claude_credentials_ignores_empty_api_key_helper() {
        with_env(&CLEAR_ANTHROPIC_ENV, || {
            let home = empty_home_dir();
            write_claude_settings(&home, r#"{"apiKeyHelper": ""}"#);

            let creds = extract_all_credentials(&oauth_options(home));
            assert!(
                creds.anthropic.is_none(),
                "empty apiKeyHelper should not produce credentials"
            );
        });
    }

    #[test]
    fn claude_oauth_file_takes_precedence_over_api_key_helper() {
        let home = empty_home_dir();
        write_claude_oauth(&home, serde_json::json!(current_epoch_millis() + 3_600_000));
        write_claude_settings(
            &home,
            r#"{"apiKeyHelper": "/usr/local/bin/fake-key-helper"}"#,
        );

        let creds = extract_claude_credentials(&oauth_options(home))
            .expect("expected oauth credentials from file");
        assert_eq!(creds.auth_type, AuthType::Oauth);
    }

    fn fake_keychain_entry(expires_at: serde_json::Value) -> String {
        serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "fake-keychain-token",
                "expiresAt": expires_at,
            }
        })
        .to_string()
    }

    #[test]
    fn api_key_helper_takes_precedence_over_keychain() {
        let home = empty_home_dir();
        write_claude_settings(
            &home,
            r#"{"apiKeyHelper": "/usr/local/bin/fake-key-helper"}"#,
        );
        let called = std::cell::Cell::new(false);
        let keychain = || {
            called.set(true);
            Some(fake_keychain_entry(serde_json::json!(
                current_epoch_millis() + 3_600_000
            )))
        };

        let creds = extract_claude_credentials_with_keychain(&oauth_options(home), Some(&keychain))
            .expect("expected apiKeyHelper credentials");
        assert_eq!(creds.auth_type, AuthType::ApiKeyHelper);
        assert!(
            !called.get(),
            "keychain must not be read when apiKeyHelper is set"
        );
    }

    #[test]
    fn keychain_used_when_no_file_credentials() {
        let keychain = || {
            Some(fake_keychain_entry(serde_json::json!(
                current_epoch_millis() + 3_600_000
            )))
        };
        let creds = extract_claude_credentials_with_keychain(
            &oauth_options(empty_home_dir()),
            Some(&keychain),
        )
        .expect("expected oauth credentials from keychain");
        assert_eq!(creds.auth_type, AuthType::Oauth);
        assert_eq!(creds.api_key, "fake-keychain-token");
    }

    #[test]
    fn keychain_entry_uses_same_expiry_parser() {
        let keychain = || Some(fake_keychain_entry(serde_json::json!(1000)));
        assert!(
            extract_claude_credentials_with_keychain(
                &oauth_options(empty_home_dir()),
                Some(&keychain)
            )
            .is_none(),
            "expired keychain entry must be rejected"
        );
    }

    #[test]
    fn keychain_not_consulted_when_home_dir_overridden() {
        assert!(
            claude_keychain_reader(&oauth_options(empty_home_dir())).is_none(),
            "keychain must be skipped when home_dir is overridden"
        );
        // With an empty overridden home, nothing from the host (files or keychain) may leak in.
        assert!(extract_claude_credentials(&oauth_options(empty_home_dir())).is_none());
    }

    #[test]
    fn keychain_not_consulted_when_oauth_disabled() {
        let options = CredentialExtractionOptions {
            home_dir: None,
            include_oauth: false,
        };
        assert!(claude_keychain_reader(&options).is_none());
    }

    #[test]
    fn set_credentials_as_env_vars_skips_api_key_helper() {
        with_env(&CLEAR_ANTHROPIC_ENV, || {
            let credentials = ExtractedCredentials {
                anthropic: Some(ProviderCredentials {
                    api_key: String::new(),
                    source: "claude-code-api-key-helper".to_string(),
                    auth_type: AuthType::ApiKeyHelper,
                    provider: "anthropic".to_string(),
                }),
                ..Default::default()
            };
            set_credentials_as_env_vars(&credentials);
            assert!(
                std::env::var("ANTHROPIC_API_KEY").is_err(),
                "ANTHROPIC_API_KEY must not be set for apiKeyHelper credentials"
            );
        });
    }
}
