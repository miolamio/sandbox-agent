//! Process groups for spawned children.
//!
//! Agent processes (and the Sandbox Agent server's user processes) are started
//! as leaders of their own process group. Stopping them then signals every
//! descendant at once instead of only the direct child, which would leave
//! tools and dev servers started by the agent running as orphans.

use std::time::Duration;

/// Default time between SIGTERM and SIGKILL when a process group is stopped.
pub const DEFAULT_GRACE: Duration = Duration::from_secs(1);

/// Interval at which [`group_alive`] is polled while waiting for a group.
pub const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[cfg(unix)]
pub use libc::{SIGKILL, SIGTERM};

/// Groups that must never be signalled: 0 and 1 have special meanings for
/// `kill(2)`, and our own group would take the caller down with it.
#[cfg(unix)]
fn is_foreign_group(pgid: u32) -> bool {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return false;
    };
    pgid > 1 && pgid != unsafe { libc::getpgrp() }
}

/// Sends `signal` to every process in group `pgid`. A group that no longer
/// exists is not an error.
#[cfg(unix)]
pub fn signal_group(pgid: u32, signal: i32) -> std::io::Result<()> {
    if !is_foreign_group(pgid) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to signal process group {pgid}"),
        ));
    }
    if unsafe { libc::kill(-(pgid as libc::pid_t), signal) } == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(err)
}

/// True while group `pgid` still has a member that is not a zombie. Zombies
/// are ignored on Linux, where an orphan whose new parent never reaps it (a
/// server running as PID 1 without an init) would otherwise keep the group
/// "alive" forever.
#[cfg(unix)]
pub fn group_alive(pgid: u32) -> bool {
    if !is_foreign_group(pgid) {
        return false;
    }
    if unsafe { libc::kill(-(pgid as libc::pid_t), 0) } != 0 {
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(target_os = "linux")]
    {
        linux_group_has_live_member(pgid).unwrap_or(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(target_os = "linux")]
fn linux_group_has_live_member(pgid: u32) -> Option<bool> {
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // `pid (comm) state ppid pgrp ...`; comm may contain spaces and ')'.
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        let mut fields = stat[close + 1..].split_whitespace();
        let state = fields.next();
        let pgrp = fields.nth(1).and_then(|raw| raw.parse::<u32>().ok());
        if pgrp == Some(pgid) && !matches!(state, Some("Z") | Some("X")) {
            return Some(true);
        }
    }
    Some(false)
}
