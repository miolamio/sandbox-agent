//! Server-side agent profiles: named, per-agent settings applied when an agent
//! process starts (`process`) and to every session of that process (`session`).

mod capability;
mod merge;
mod model;
mod secrets;
mod session;
mod store;

pub use capability::{
    agent_customization_for, unsupported_fields, validate_customization, AgentCustomization,
    ProcessCustomization, SessionCustomization,
};
pub use merge::{merge_profiles, parse_extends, resolve_chain};
pub use model::{
    validate_profile_name, validate_profile_shape, AgentProfile, ProfilePlugin, ProfileProcess,
    ProfileSession, SystemPrompt, SystemPromptMode,
};
pub use secrets::{mask_profile, restore_masked_secrets, SECRET_MASK};
pub use session::{apply_session_profile, is_profile_session_method, PROFILE_SESSION_METHODS};
pub use store::{
    load_profiles_file, server_state_dir, ProfileSource, ProfileStore, StoredProfile, STATE_DIR_ENV,
};
