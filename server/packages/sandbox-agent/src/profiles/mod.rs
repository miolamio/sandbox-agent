//! Server-side agent profiles: named, per-agent settings applied when an agent
//! process starts (`process`) and to every session of that process (`session`).

mod merge;
mod model;

pub use merge::{merge_profiles, parse_extends, resolve_chain};
pub use model::{
    validate_profile_name, validate_profile_shape, AgentProfile, ProfilePlugin, ProfileProcess,
    ProfileSession, SystemPrompt, SystemPromptMode,
};
