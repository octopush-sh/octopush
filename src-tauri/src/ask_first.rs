//! Ask first (#1231): a call the policy holds (`permissions::decide`) waits
//! on an approval card that shows what it would change, and goes on only if
//! that is still what it would change once approved. A file call's card
//! carries the diff; a command's, the command. No answer grants anything
//! beyond the one call: Edit freely is the mode for not being asked.

use crate::chat_engine::{ApprovalDecision, ApprovalRequestEvent};
use crate::talk_guard::{CardKind, Reach};
use serde_json::Value;
use std::path::Path;

/// Lines of context around each change.
const CONTEXT: usize = 3;
/// The preview's caps: lines in all, and characters per line.
const PREVIEW_LINES: usize = 160;
const LINE_CHARS: usize = 300;
/// A file (or a new content) past this size gets no preview.
const PREVIEW_BYTES: usize = 1 << 20;
/// Past this many cells, the changed middle shows as removed, then added.
const LCS_CELLS: usize = 250_000;

/// What an Ask first card shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskCard {
    /// `AskRun` for a command, `Ask` for a file or another tool.
    pub kind: CardKind,
    pub reason: String,
    /// The path, the command, or the tool and its arguments.
    pub shown: String,
    /// A file call's unified diff, when it can be shown.
    pub diff: Option<String>,
}

impl AskCard {
    /// The card as the broker raises it. It never offers "don't ask again".
    pub fn request(&self, workspace_id: &str, thread_id: &str, call_id: &str) -> ApprovalRequestEvent {
        ApprovalRequestEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
            command: self.shown.clone(),
            reason: self.reason.clone(),
            secret: false,
            covers_uncommitted: false,
            kind: Some(self.kind),
            sensitive: false,
            remember_dir: None,
            diff: self.diff.clone(),
        }
    }
}

/// The card for a call Ask first holds, read now. `label` names the
/// sub-agent that asks.
pub fn card(workspace: &Path, reach: &Reach, label: Option<&str>, name: &str, input: &Value) -> AskCard {
    let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let says = |what: String| match label {
        Some(l) => format!("Sub-agent \u{201c}{l}\u{201d}: {what}"),
        None => what,
    };
    match name {
        "run_command" => AskCard {
            kind: CardKind::AskRun,
            reason: says("runs a command that may change files".into()),
            shown: field("command"),
            diff: None,
        },
        "write_file" | "edit_file" => {
            let verb = if name == "write_file" { "writes a file" } else { "edits a file" };
            match file_diff(workspace, reach, name, input) {
                Ok(diff) => AskCard { kind: CardKind::Ask, reason: says(verb.into()), shown: field("path"), diff: Some(diff) },
                Err(why) => AskCard { kind: CardKind::Ask, reason: says(format!("{verb} \u{b7} {why}")), shown: field("path"), diff: None },
            }
        }
        _ => AskCard {
            kind: CardKind::Ask,
            reason: says("a tool that may change something".into()),
            shown: format!("{name} {}", crate::talk_guard::mcp_args_shown(input)),
            diff: None,
        },
    }
}

/// The change a file call would make, as a capped unified diff, or why
/// none is shown. A path outside the workspace or in a credentials location
/// is never read for it: its own card asks next.
fn file_diff(workspace: &Path, reach: &Reach, name: &str, input: &Value) -> Result<String, &'static str> {
    if reach.outside_card(None, name, input, false).is_some() {
        return Err("no preview outside the workspace");
    }
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    let path = workspace.join(text("path"));
    let before = match std::fs::metadata(&path) {
        Err(_) => Vec::new(),
        Ok(m) if !m.is_file() => return Err("no preview: not a file"),
        Ok(m) if m.len() > PREVIEW_BYTES as u64 => return Err("no preview: the file is over 1 MB"),
        Ok(_) => std::fs::read(&path).map_err(|_| "no preview: the file can't be read")?,
    };
    if before.contains(&0) {
        return Err("no preview: a binary file");
    }
    let before = String::from_utf8_lossy(&before);
    let after = if name == "write_file" {
        text("content").to_string()
    } else {
        let (old, new) = (text("old_string"), text("new_string"));
        let all = input.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
        let count = if old.is_empty() { 0 } else { before.matches(old).count() };
        if count == 0 || (count > 1 && !all) {
            return Err("no preview: the edit doesn't match the file as it is");
        }
        if all { before.replace(old, new) } else { before.replacen(old, new, 1) }
    };
    if after.len() > PREVIEW_BYTES {
        return Err("no preview: the new content is over 1 MB");
    }
    if after == before {
        return Err("no change to the file");
    }
    Ok(unified_diff(&before, &after))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Same,
    Gone,
    Added,
}

/// The lines of `a` and `b` as kept, removed and added: the common head and
/// tail, then the longest common subsequence of the middle when it is small
/// enough, else the middle as removed, then added.
fn line_ops(a: &[&str], b: &[&str]) -> Vec<Op> {
    let head = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[head..], &b[head..]);
    let tail = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[..a.len() - tail], &b[..b.len() - tail]);
    let (n, m) = (a.len(), b.len());
    let mut ops = vec![Op::Same; head];
    if n == 0 || m == 0 || n.saturating_mul(m) > LCS_CELLS {
        ops.extend(std::iter::repeat_n(Op::Gone, n).chain(std::iter::repeat_n(Op::Added, m)));
    } else {
        // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
        let w = m + 1;
        let mut lcs = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * w + j] = if a[i] == b[j] { lcs[(i + 1) * w + j + 1] + 1 } else { lcs[(i + 1) * w + j].max(lcs[i * w + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if a[i] == b[j] {
                ops.push(Op::Same);
                (i, j) = (i + 1, j + 1);
            } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
                ops.push(Op::Gone);
                i += 1;
            } else {
                ops.push(Op::Added);
                j += 1;
            }
        }
        ops.extend(std::iter::repeat_n(Op::Gone, n - i).chain(std::iter::repeat_n(Op::Added, m - j)));
    }
    ops.extend(std::iter::repeat_n(Op::Same, tail));
    ops
}

/// `before` against `after` as unified-diff hunks (`@@ -a,b +c,d @@`, then
/// ` `, `-` and `+` lines) with [`CONTEXT`] lines around each change; no
/// file headers, since the card names the file. Each line is cut to
/// [`LINE_CHARS`] with credential-looking values redacted
/// (`secret_scan::redact_line`), and past [`PREVIEW_LINES`] a last line says
/// how many more there are. Pure.
pub fn unified_diff(before: &str, after: &str) -> String {
    let (a, b): (Vec<&str>, Vec<&str>) = (before.lines().collect(), after.lines().collect());
    // Each line with its op and the old and new line indexes it sits at.
    let mut rows: Vec<(Op, &str, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    for op in line_ops(&a, &b) {
        match op {
            Op::Same => {
                rows.push((op, a[i], i, j));
                (i, j) = (i + 1, j + 1);
            }
            Op::Gone => {
                rows.push((op, a[i], i, j));
                i += 1;
            }
            Op::Added => {
                rows.push((op, b[j], i, j));
                j += 1;
            }
        }
    }
    let mut hunks: Vec<(usize, usize)> = Vec::new();
    for (k, _) in rows.iter().enumerate().filter(|(_, r)| r.0 != Op::Same) {
        let (start, end) = (k.saturating_sub(CONTEXT), (k + 1 + CONTEXT).min(rows.len()));
        match hunks.last_mut() {
            Some(h) if start <= h.1 => h.1 = h.1.max(end),
            _ => hunks.push((start, end)),
        }
    }
    let mut lines: Vec<String> = Vec::new();
    for (start, end) in hunks {
        let hunk = &rows[start..end];
        let olds = hunk.iter().filter(|r| r.0 != Op::Added).count();
        let news = hunk.iter().filter(|r| r.0 != Op::Gone).count();
        // Lines count from 1; a side with no lines names the line before.
        let from = |at: usize, count: usize| if count == 0 { at } else { at + 1 };
        lines.push(format!("@@ -{},{olds} +{},{news} @@", from(hunk[0].2, olds), from(hunk[0].3, news)));
        for (op, text, ..) in hunk {
            let sign = match op {
                Op::Same => ' ',
                Op::Gone => '-',
                Op::Added => '+',
            };
            let shown = crate::secret_scan::redact_line(crate::chat_engine::truncate_char_safe(text, LINE_CHARS), &[]);
            lines.push(format!("{sign}{shown}"));
        }
    }
    if lines.len() > PREVIEW_LINES {
        let more = lines.len() - PREVIEW_LINES;
        lines.truncate(PREVIEW_LINES);
        lines.push(format!("\u{2026} {more} more lines"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Ask about the card `preview` builds and, once it is approved, build it
/// again: the call goes on only if it would still make the change the card
/// showed. One that changed while the card waited asks again, with what it
/// now shows. `Some` is the fixed result of a declined call.
pub async fn ask_first<F, Fut>(preview: impl Fn() -> AskCard, ask: F) -> Option<String>
where
    F: Fn(AskCard) -> Fut,
    Fut: std::future::Future<Output = ApprovalDecision>,
{
    let mut card = preview();
    loop {
        if ask(card.clone()).await == ApprovalDecision::Deny {
            return Some(crate::permissions::ASK_DECLINED.to_string());
        }
        let now = preview();
        if now == card {
            return None;
        }
        card = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_engine::ApprovalBroker;
    use crate::permissions::{decide, Decision, Mode, PolicyCtx, ToolCall, ASK_DECLINED};
    use serde_json::json;
    use std::collections::HashSet;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// Ask first holds an edit; its card carries the diff the edit would
    /// make, parks on the broker the user answers, and nothing is written
    /// while it waits.
    #[test]
    fn ask_edit_parks_with_diff() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir(ws.path().join("src")).unwrap();
        std::fs::write(ws.path().join("src/a.rs"), "fn a() {\n    1\n}\n").unwrap();
        let reach = Reach::new(ws.path(), None, None);
        let input = json!({ "path": "src/a.rs", "old_string": "    1", "new_string": "    2" });
        let ro = HashSet::new();
        let ctx = PolicyCtx { exec_roots: None, mcp_read_only: &ro, delegate_writes: false, forced: false };
        assert!(matches!(decide(Mode::Ask, &ToolCall { name: "edit_file", input: &input }, &ctx), Decision::Ask { .. }));

        let card = card(ws.path(), &reach, None, "edit_file", &input);
        assert_eq!(card.diff.as_deref(), Some("@@ -1,3 +1,3 @@\n fn a() {\n-    1\n+    2\n }\n"));
        assert_eq!((card.shown.as_str(), card.reason.as_str()), ("src/a.rs", "edits a file"));

        let broker = ApprovalBroker::default();
        let mut answer = broker.park(card.request("w1", "t1", "c1"), 1);
        let waiting = broker.pending_for_thread("t1");
        assert_eq!(waiting.len(), 1);
        let shown = serde_json::to_value(&waiting[0]).unwrap();
        assert_eq!((shown["kind"].as_str(), shown["diff"].as_str()), (Some("ask"), card.diff.as_deref()));
        assert!(shown.get("rememberDir").is_none() && shown.get("secret").is_none());
        assert!(answer.try_recv().is_err(), "it waits for the user");
        assert_eq!(std::fs::read_to_string(ws.path().join("src/a.rs")).unwrap(), "fn a() {\n    1\n}\n");
        broker.respond("c1", ApprovalDecision::Approve);
        assert_eq!(answer.try_recv().unwrap(), ApprovalDecision::Approve);
        // Its approval grants nothing: the next card asks again.
        assert_eq!(broker.record("t1", ApprovalDecision::ApproveAlways, !CardKind::Ask.grantable()), ApprovalDecision::Approve);
        assert!(!broker.grant_answers("t1", Some(CardKind::Ask)));

        // A command's card is its own kind, with no diff.
        let run = serde_json::to_value(card(ws.path(), &reach, None, "run_command", &json!({ "command": "cargo fmt" })).request("w1", "t1", "c2")).unwrap();
        assert_eq!((run["kind"].as_str(), run["command"].as_str(), run.get("diff")), (Some("ask-run"), Some("cargo fmt"), None));
        assert!(!CardKind::AskRun.grantable());

        // A sub-agent's card names it; a new file shows as added lines.
        let new = card_for_new(ws.path(), &reach);
        assert_eq!(new.diff.as_deref(), Some("@@ -0,0 +1,2 @@\n+one\n+two\n"));
        assert!(new.reason.starts_with("Sub-agent \u{201c}Scout\u{201d}: writes a file"));
    }

    fn card_for_new(ws: &Path, reach: &Reach) -> AskCard {
        card(ws, reach, Some("Scout"), "write_file", &json!({ "path": "new.txt", "content": "one\ntwo\n" }))
    }

    /// A declined card gives the call one fixed result, whatever it was, and
    /// a sub-agent's gate returns it before its own guards see the call.
    #[test]
    fn deny_returns_fixed_result() {
        let rt = runtime();
        let cards = [
            AskCard { kind: CardKind::Ask, reason: "edits a file".into(), shown: "a.rs".into(), diff: Some("@@ -1 +1 @@\n-a\n+b\n".into()) },
            AskCard { kind: CardKind::AskRun, reason: "runs a command that may change files".into(), shown: "cargo fmt".into(), diff: None },
        ];
        for c in cards {
            let out = rt.block_on(ask_first(|| c.clone(), |_| async { ApprovalDecision::Deny }));
            assert_eq!(out.as_deref(), Some(ASK_DECLINED));
        }
        assert!(ASK_DECLINED.contains("Ask first") && ASK_DECLINED.contains("Nothing was run or changed"));

        struct Inner(std::sync::Arc<std::sync::atomic::AtomicUsize>);
        #[async_trait::async_trait]
        impl crate::orchestrator::agentic::ToolGate for Inner {
            async fn check(&self, _: &str, _: &Value) -> Option<String> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                None
            }
        }
        struct Declines;
        #[async_trait::async_trait]
        impl crate::permissions::Asker for Declines {
            async fn ask(&self, _: &str, _: &Value) -> Option<String> {
                Some(ASK_DECLINED.to_string())
            }
        }
        use crate::orchestrator::agentic::ToolGate;
        let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate = |asker: bool| {
            let g = crate::permissions::ModeGate::new(
                std::sync::Arc::new(|| Mode::Ask),
                None,
                false,
                HashSet::new(),
                Some(Box::new(Inner(std::sync::Arc::clone(&seen)))),
            );
            if asker { g.with_asker(Box::new(Declines)) } else { g }
        };
        let write = json!({ "path": "a.rs", "content": "x" });
        assert_eq!(rt.block_on(gate(true).check("write_file", &write)).as_deref(), Some(ASK_DECLINED));
        assert_eq!(seen.load(std::sync::atomic::Ordering::Relaxed), 0, "a declined call never reaches the guards");
        assert_eq!(rt.block_on(gate(true).check("read_file", &json!({ "path": "a.rs" }))), None);
        assert_eq!(seen.load(std::sync::atomic::Ordering::Relaxed), 1, "what Ask first lets through meets the guards");
        // A gate that can't ask refuses what Ask first holds.
        assert_eq!(rt.block_on(gate(false).check("write_file", &write)).as_deref(), Some(crate::permissions::ASK_UNAVAILABLE));
    }

    /// An approval covers the change the card showed: a file that changed
    /// while the card waited asks again, with the diff it would now make.
    #[test]
    fn a_change_that_moved_while_its_card_waited_asks_again() {
        let ws = tempfile::tempdir().unwrap();
        let file = ws.path().join("a.txt");
        std::fs::write(&file, "one\n").unwrap();
        let reach = Reach::new(ws.path(), None, None);
        let input = json!({ "path": "a.txt", "content": "three\n" });
        let shown = std::sync::Mutex::new(Vec::new());
        let out = runtime().block_on(ask_first(
            || card(ws.path(), &reach, None, "write_file", &input),
            |c: AskCard| {
                let first = shown.lock().unwrap().is_empty();
                shown.lock().unwrap().push(c.diff.clone().unwrap_or_default());
                // The user edits the file while the first card waits.
                if first {
                    std::fs::write(&file, "two\n").unwrap();
                }
                async { ApprovalDecision::Approve }
            },
        ));
        assert_eq!(out, None);
        assert_eq!(*shown.lock().unwrap(), ["@@ -1,1 +1,1 @@\n-one\n+three\n", "@@ -1,1 +1,1 @@\n-two\n+three\n"]);
    }

    /// The preview never reads outside the workspace, shows only the hunks
    /// with their context, redacts what looks like a credential and is capped.
    #[test]
    fn the_diff_preview_stays_in_the_workspace_and_is_capped() {
        let ws = tempfile::tempdir().unwrap();
        let reach = Reach::new(ws.path(), None, None);
        let outside = card(ws.path(), &reach, None, "write_file", &json!({ "path": "../elsewhere.txt", "content": "x" }));
        assert_eq!((outside.diff, outside.reason.as_str()), (None, "writes a file \u{b7} no preview outside the workspace"));

        let before: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let after = before.replace("line 2\n", "line two\n").replace("line 18\n", "API_TOKEN=s3cr3t-value-123\n");
        let diff = unified_diff(&before, &after);
        assert!(diff.starts_with("@@ -1,5 +1,5 @@\n line 1\n-line 2\n+line two\n line 3\n"), "{diff}");
        assert!(diff.contains("@@ -15,6 +15,6 @@\n line 15\n"), "{diff}");
        assert!(!diff.contains("line 10") && !diff.contains("s3cr3t-value-123") && diff.contains("+API_TOKEN="), "{diff}");

        let big: String = (0..400).map(|n| format!("{n}\n")).collect();
        let capped = unified_diff("", &big);
        assert_eq!(capped.lines().count(), PREVIEW_LINES + 1);
        assert!(capped.ends_with("\u{2026} 241 more lines\n"), "{capped}");
    }
}
