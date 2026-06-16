//! Role definitions — the single source of truth for DIRECT-mode stage roles.
//! Built-ins are seeded into the `roles` table (db.rs); custom roles are rows
//! with is_builtin=0. The runner composes a stage's system prompt from a role's
//! prompt_body + the preamble its environment contract selects.

use serde::{Deserialize, Serialize};
use crate::orchestrator::types::{ArtifactKind, LoopMode, RoleEnvironment};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDef {
    pub key: String,
    pub label: String,
    pub description: String,
    pub prompt_body: String,
    pub artifact_kind: ArtifactKind,
    pub environment: RoleEnvironment,
    pub can_loop: bool,
    pub default_tools: Vec<String>,
    pub default_substrate: String, // "api" | "cli"
    pub default_checkpoint: bool,
    pub token_est_in: i64,
    pub token_est_out: i64,
    pub is_builtin: bool,
}

/// Worktree preamble — the historical default: a non-interactive pipeline worker
/// that leaves changes uncommitted for the next stage and never touches git.
pub const PREAMBLE_WORKTREE: &str = "You are one stage in an automated, headless build pipeline. \
    There is NO human watching this stage and no way to answer you — never ask questions, never \
    present options or menus, and never wait for input, confirmation, or approval. Work \
    autonomously to completion using your tools, then end with a brief summary of what you did \
    and anything still outstanding. Do not commit, push, or otherwise manage git: leave any code \
    changes uncommitted in the working tree — the next stage reads them from there, and that is \
    expected and correct.";

/// Action preamble — for roles whose job IS a side-effect (commit/push/PR/merge/
/// release). They may use git/gh/the release script as instructed.
pub const PREAMBLE_ACTION: &str = "You are one stage in an automated, headless build pipeline. \
    There is NO human watching this stage and no way to answer you — never ask questions, never \
    present options or menus, and never wait for input, confirmation, or approval. This is an \
    ACTION stage: you may commit, push, and run git/gh/release or deploy commands as the role \
    instructs — that is your job. Complete the action autonomously, then end with a brief summary \
    of exactly what you did (branch, PR URL, version, etc.) and anything still outstanding.";

/// Appended to a stage prompt when the stage is in auto-loop mode (verbatim copy
/// of the historical VERDICT_INSTRUCTION).
pub const VERDICT_INSTRUCTION: &str = "\n\nThis is an automated review. After your findings, end your \
    response with EXACTLY ONE line, on its own line: `VERDICT: PASS` if the changes are acceptable, \
    or `VERDICT: CHANGES_REQUESTED` if they must be revised. Emit nothing after that line.";

/// Compose the full system prompt: environment preamble + role body + author
/// instructions + (auto-loop only) the verdict line.
pub fn compose_system_prompt(
    prompt_body: &str,
    environment: RoleEnvironment,
    loop_mode: Option<LoopMode>,
    instructions: Option<&str>,
) -> String {
    let preamble = match environment {
        RoleEnvironment::Worktree => PREAMBLE_WORKTREE,
        RoleEnvironment::Action => PREAMBLE_ACTION,
    };
    let mut s = format!("{preamble}\n\n{prompt_body}");
    if let Some(instr) = instructions.map(str::trim).filter(|i| !i.is_empty()) {
        s.push_str("\n\nAdditional instructions for this stage, from the pipeline author:\n");
        s.push_str(instr);
    }
    if matches!(loop_mode, Some(LoopMode::Auto)) {
        s.push_str(VERDICT_INSTRUCTION);
    }
    s
}

fn ro() -> Vec<String> { vec!["read_file".into(), "list_files".into()] }
fn run_() -> Vec<String> { vec!["read_file".into(), "list_files".into(), "run_command".into()] }
fn full() -> Vec<String> { vec!["read_file".into(), "list_files".into(), "write_file".into(), "run_command".into()] }

/// All 15 built-in roles. The first 10 reproduce the historical archetypes
/// (prompt bodies copied verbatim from the old `system_prompt_for`); the last 5
/// are new. Keys, prompts, artifact kinds, loop eligibility, default tools and
/// token estimates here are the single source of truth.
pub fn builtin_roles() -> Vec<RoleDef> {
    use ArtifactKind::*;
    use RoleEnvironment::*;
    let r = |key:&str,label:&str,desc:&str,body:&str,kind:ArtifactKind,env:RoleEnvironment,can_loop:bool,tools:Vec<String>,sub:&str,cp:bool,ti:i64,to:i64| RoleDef{
        key:key.into(),label:label.into(),description:desc.into(),prompt_body:body.into(),artifact_kind:kind,environment:env,can_loop,default_tools:tools,default_substrate:sub.into(),default_checkpoint:cp,token_est_in:ti,token_est_out:to,is_builtin:true,
    };
    vec![
      // ---- existing 10 (bodies VERBATIM from old system_prompt_for) ----
      r("plan","Plan","Outline the approach before any code",
        "You are a senior engineer. Produce a concise, concrete implementation plan \
            for the task. Do not write code; describe the steps, files, and approach.",
        Plan, Worktree, false, ro(), "api", false, 4000, 1500),
      r("plan_review","Plan review","Critique the plan — can loop back",
        "You are a critical reviewer. Review the proposed plan for \
            gaps, risks, and better approaches. Be specific and concise.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("implement","Implement","Write the code in the worktree",
        "You are a skilled engineer. Implement the plan by editing files in \
            the workspace using your tools. Make the changes; do not just describe them.",
        Diff, Worktree, false, full(), "api", false, 12000, 6000),
      r("code_review","Code review","Review the diff — can loop back",
        "You are a code reviewer. Inspect the current changes in the \
            workspace and report concrete issues. Do not modify files.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("test","Tests","Write and run the tests",
        "You are a test engineer. Write unit tests for the recent changes using your \
            tools to create the test files. Run them if a test command is obvious.",
        Tests, Worktree, false, full(), "api", false, 6000, 2000),
      r("repro","Reproduce","Reproduce the reported problem",
        "You are a debugger. Reproduce the reported issue and describe the root cause.",
        Review, Worktree, false, run_(), "api", false, 8000, 1000),
      r("fix","Fix","Apply the fix",
        "You are a skilled engineer. Implement the plan by editing files in \
            the workspace using your tools. Make the changes; do not just describe them.",
        Diff, Worktree, false, full(), "api", false, 12000, 6000),
      r("verify","Verify","Confirm the fix holds — can loop back",
        "You are a code reviewer. Inspect the current changes in the \
            workspace and report concrete issues. Do not modify files.",
        Review, Worktree, true, run_(), "api", false, 8000, 1000),
      r("critique","Critique","Critique the artifact — can loop back",
        "You are a critical reviewer. Review the proposed plan for \
            gaps, risks, and better approaches. Be specific and concise.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("refine","Refine","Polish from the critique",
        "You are an editor. Refine and finalize the plan based on the prior review.",
        Plan, Worktree, false, ro(), "api", false, 4000, 1500),
      // ---- 5 new ----
      r("architect","Architect","High-level approach & trade-offs",
        "You are a senior software architect. Propose the high-level approach, system structure, and key trade-offs for the task before any detailed plan or code. Describe alternatives and your recommendation. Do not write code.",
        Plan, Worktree, false, ro(), "api", false, 4000, 1500),
      r("security_review","Security review","Security-focused review — can loop back",
        "You are a security reviewer. Inspect the current changes for vulnerabilities — injection, broken authz, exposed secrets, unsafe deserialization, path traversal, SSRF, and similar. Report concrete issues with severity and a fix. Do not modify files.",
        Review, Worktree, true, ro(), "api", false, 8000, 1000),
      r("pull_request","Pull request","Commit, push & open a PR",
        "You are a release engineer. Commit the accumulated worktree changes on a feature branch with a clear message, push it, and open a pull request with a concise title and body describing the change. Report the PR URL.",
        Note, Action, false, full(), "cli", true, 6000, 1500),
      r("merge","Merge","Merge the pull request",
        "You are a release engineer. Merge the open pull request for this work once its checks pass. Report the merge result.",
        Note, Action, false, full(), "cli", true, 4000, 1000),
      r("release","Release","Run the release process",
        "You are a release engineer. Run the project's release process (e.g. the release script) to publish the next version. Report the released version and any follow-up.",
        Note, Action, false, full(), "cli", true, 6000, 1500),
    ]
}
