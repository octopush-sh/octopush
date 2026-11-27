//! Workspace ports (#1219) — each workspace owns a block of local ports, so
//! two workspaces in flight never fight over the same dev-server port.
//!
//! A block is [`BLOCK_SIZE`] ports from a fixed range ([`RANGE_START`] up to
//! [`RANGE_END`], below macOS's ephemeral ports). It is allocated the first
//! time a workspace needs one (a Run terminal, the Talk shell, the header
//! showing it) and stored in `workspaces.port_base`. A block whose base
//! can't be bound on `127.0.0.1` right now is skipped. Allocations are unique
//! across every workspace row: archiving keeps the block, deleting the row
//! frees it for the next workspace.
//!
//! Processes started in the workspace read their block from [`PORT_ENV`] (the
//! base) and [`PORT_COUNT_ENV`]. [`CONDUCTOR_PORT`] carries the same base, for
//! setup scripts imported from a Conductor repo (`workspace_setup`), which
//! read that name.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, TcpListener};

use crate::db::Db;

/// Ports per workspace.
pub const BLOCK_SIZE: u16 = 10;
/// The first base handed out.
pub const RANGE_START: u16 = 40000;
/// One past the last port of the range (macOS's ephemeral ports start at 49152).
pub const RANGE_END: u16 = 49000;

/// The block's first port.
pub const PORT_ENV: &str = "OCTOPUSH_PORT";
/// How many ports the block holds.
pub const PORT_COUNT_ENV: &str = "OCTOPUSH_PORT_COUNT";
/// The base again, under the name Conductor's setup scripts read.
pub const CONDUCTOR_PORT: &str = "CONDUCTOR_PORT";

/// A workspace's block of ports, as the frontend reads it.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortBlock {
    pub base: u16,
    pub count: u16,
}

impl PortBlock {
    pub fn new(base: u16) -> Self {
        Self { base, count: BLOCK_SIZE }
    }

    /// The variables a process started in the workspace gets.
    pub fn env(&self) -> Vec<(String, String)> {
        vec![
            (PORT_ENV.to_string(), self.base.to_string()),
            (PORT_COUNT_ENV.to_string(), self.count.to_string()),
            (CONDUCTOR_PORT.to_string(), self.base.to_string()),
        ]
    }

    /// Add [`Self::env`] to a spawn env, keeping any value already there.
    pub fn apply_env(&self, env: &mut HashMap<String, String>) {
        for (k, v) in self.env() {
            env.entry(k).or_insert(v);
        }
    }
}

/// Whether `port` can be bound on `127.0.0.1` right now (nothing listens on it).
pub fn base_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// The lowest base in the range that no workspace holds and `is_free` accepts.
/// `None` when the range is used up.
pub fn pick_base(taken: &HashSet<u16>, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    (RANGE_START..RANGE_END)
        .step_by(BLOCK_SIZE as usize)
        .find(|b| !taken.contains(b) && is_free(*b))
}

/// The block of workspace `workspace_id`, allocated now if it has none. `None`
/// when the workspace doesn't exist, the range is used up or the database
/// can't be read; spawning goes on without the variables then.
pub fn ensure(db: &Db, workspace_id: &str) -> Option<PortBlock> {
    match db.ensure_workspace_port_base(workspace_id, base_is_free) {
        Ok(base) => base.map(PortBlock::new),
        Err(e) => {
            tracing::warn!(workspace = %workspace_id, error = %e, "workspace ports unavailable");
            None
        }
    }
}

/// The block of the workspace whose worktree is `root` (a Run session's
/// project root), allocated now if it has none.
pub fn ensure_for_root(db: &Db, root: &str) -> Option<PortBlock> {
    let (id, _) = db.workspace_by_path(root).ok().flatten()?;
    ensure(db, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_lowest_free_block() {
        assert_eq!(pick_base(&HashSet::new(), |_| true), Some(RANGE_START));
        let taken = HashSet::from([RANGE_START, RANGE_START + BLOCK_SIZE]);
        assert_eq!(pick_base(&taken, |_| true), Some(RANGE_START + 2 * BLOCK_SIZE));
    }

    #[test]
    fn skips_a_base_that_fails_the_bind_test() {
        let busy = RANGE_START + BLOCK_SIZE;
        let got = pick_base(&HashSet::from([RANGE_START]), |b| b != busy);
        assert_eq!(got, Some(RANGE_START + 2 * BLOCK_SIZE));
    }

    #[test]
    fn a_used_up_range_gives_none() {
        assert_eq!(pick_base(&HashSet::new(), |_| false), None);
        let all: HashSet<u16> = (RANGE_START..RANGE_END).step_by(BLOCK_SIZE as usize).collect();
        assert_eq!(pick_base(&all, |_| true), None);
    }

    #[test]
    fn every_block_fits_in_the_range() {
        let last = (RANGE_START..RANGE_END).step_by(BLOCK_SIZE as usize).last().unwrap();
        assert!(last + BLOCK_SIZE <= RANGE_END);
    }

    #[test]
    fn a_listening_port_is_not_free() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!base_is_free(port));
        drop(listener);
    }

    #[test]
    fn env_carries_the_base_the_count_and_conductor_port() {
        let env: HashMap<_, _> = PortBlock::new(40020).env().into_iter().collect();
        assert_eq!(env[PORT_ENV], "40020");
        assert_eq!(env[PORT_COUNT_ENV], "10");
        assert_eq!(env[CONDUCTOR_PORT], "40020");
    }

    #[test]
    fn apply_env_keeps_a_value_already_set() {
        let mut env = HashMap::from([(CONDUCTOR_PORT.to_string(), "3000".to_string())]);
        PortBlock::new(40020).apply_env(&mut env);
        assert_eq!(env[CONDUCTOR_PORT], "3000");
        assert_eq!(env[PORT_ENV], "40020");
    }
}
