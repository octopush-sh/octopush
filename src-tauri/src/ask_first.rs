//! Ask first (#1231): a call the policy holds (`permissions::decide`) waits
//! on an approval card that shows what it would change, and goes on only if
//! that is still exactly what it would change once approved. A file call's
//! card carries the diff, and its approval binds to a hash of the whole file
//! before and after, so a change anywhere, past the preview too, asks again.
//! A command's card carries the command. No answer grants anything beyond
//! the one call: Edit freely is the mode for not being asked.

use crate::chat_engine::{ApprovalDecision, ApprovalRequestEvent};
use crate::secret_scan::KnownSecret;
use crate::talk_guard::{CardKind, Reach};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Lines of context around each change.
const CONTEXT: usize = 3;
/// The preview's caps: lines in all, and characters per line.
const PREVIEW_LINES: usize = 160;
const LINE_CHARS: usize = 300;
/// A file (or a new content) past this size gets no preview.
const PREVIEW_BYTES: usize = 1 << 20;
/// Past this size a file isn't read at all, so its change can't be bound.
const HASH_BYTES: u64 = 64 << 20;
/// Past this many cells, the changed middle shows as removed, then added.
const LCS_CELLS: usize = 250_000;

/// What an Ask first card shows, and what its approval binds to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskCard {
    /// `AskRun` for a command, `Ask` for a file or another tool.
    pub kind: CardKind,
    pub reason: String,
    /// The path, the command, or the tool and its arguments.
    pub shown: String,
    /// A file call's unified diff, when it can be shown.
    pub diff: Option<String>,
    /// Why no diff is shown, in plain words.
    pub note: Option<String>,
    /// A hash of the whole file before and after the call: an approval
    /// holds only while it is the same. Never sent to the webview.
    pub bound: Option<String>,
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
            preview_note: self.note.clone(),
            ask_first: true,
        }
    }
}

/// The card for a call Ask first holds, read now. `label` names the
/// sub-agent that asks; `known` are the user's own credentials, redacted
/// from the preview like any other credential-looking value.
pub fn card(workspace: &Path, reach: &Reach, label: Option<&str>, name: &str, input: &Value, known: &[KnownSecret]) -> AskCard {
    let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let says = |what: &str| match label {
        Some(l) => format!("Sub-agent \u{201c}{l}\u{201d}: {what}"),
        None => what.to_string(),
    };
    let blank = AskCard { kind: CardKind::Ask, reason: String::new(), shown: String::new(), diff: None, note: None, bound: None };
    match name {
        "run_command" => {
            AskCard { kind: CardKind::AskRun, reason: says("runs a command that may change files"), shown: field("command"), ..blank }
        }
        "write_file" | "edit_file" => {
            let preview = file_preview(workspace, reach, name, input, known);
            let verb = if name == "write_file" { "writes a file" } else { "edits a file" };
            AskCard { reason: says(verb), shown: field("path"), diff: preview.diff, note: preview.note, bound: preview.bound, ..blank }
        }
        _ => AskCard {
            reason: says("a tool that may change something"),
            shown: format!("{name} {}", crate::talk_guard::mcp_args_shown(input)),
            ..blank
        },
    }
}

/// What a file call's card shows: the diff, or why there is none, and the
/// hash its approval binds to.
#[derive(Default)]
struct FilePreview {
    diff: Option<String>,
    note: Option<String>,
    bound: Option<String>,
}

fn noted(note: &str, bound: Option<String>) -> FilePreview {
    FilePreview { diff: None, note: Some(note.to_string()), bound }
}

/// The whole of `before` and `after`, hashed so neither can pass for the
/// other's tail.
fn bind(before: &[u8], after: &[u8]) -> String {
    let mut h = Sha256::new();
    for part in [before, after] {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The change a file call would make. A path outside the workspace or in a
/// credentials location is never read for it: its own card asks next.
fn file_preview(workspace: &Path, reach: &Reach, name: &str, input: &Value, known: &[KnownSecret]) -> FilePreview {
    if reach.outside_card(None, name, input, false).is_some() {
        return noted("No preview: the file is outside the workspace or in a credentials location, so it isn't read here.", None);
    }
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    let path = workspace.join(text("path"));
    let before = match std::fs::metadata(&path) {
        Err(_) => Vec::new(),
        Ok(m) if !m.is_file() => return noted("No preview: the path isn't a file.", None),
        Ok(m) if m.len() > HASH_BYTES => return noted("No preview: the file is over 64 MB, so the change can't be shown or checked.", None),
        Ok(_) => match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return noted("No preview: the file can't be read.", None),
        },
    };
    let after: Vec<u8> = if name == "write_file" {
        text("content").as_bytes().to_vec()
    } else {
        let (old, new) = (text("old_string"), text("new_string"));
        let all = input.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
        let Ok(current) = std::str::from_utf8(&before) else {
            return noted("No preview: the file isn't text, so the edit can't apply.", Some(bind(&before, &before)));
        };
        let count = if old.is_empty() { 0 } else { current.matches(old).count() };
        if count == 0 || (count > 1 && !all) {
            return noted("No preview: the edit doesn't match the file as it is now, so it will fail.", Some(bind(&before, &before)));
        }
        let edited = if all { current.replace(old, new) } else { current.replacen(old, new, 1) };
        edited.into_bytes()
    };
    let bound = Some(bind(&before, &after));
    if before == after {
        return noted("No change: the file already reads this way.", bound);
    }
    if before.contains(&0) || after.contains(&0) {
        return noted("No preview: a binary file. Approving writes it without showing the change.", bound);
    }
    if before.len() > PREVIEW_BYTES || after.len() > PREVIEW_BYTES {
        return noted("No preview: the file is over 1 MB. Approving writes it without showing the change.", bound);
    }
    let (Ok(b), Ok(a)) = (std::str::from_utf8(&before), std::str::from_utf8(&after)) else {
        return noted("No preview: the file isn't UTF-8 text. Approving writes it without showing the change.", bound);
    };
    FilePreview { diff: Some(unified_diff(b, a, known)), note: None, bound }
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
/// file headers, since the card names the file. Each line has
/// credential-looking values and `known` redacted
/// (`secret_scan::redact_line`), then is cut to [`LINE_CHARS`] with a
/// marker saying so. Past [`PREVIEW_LINES`] a line says how many are not
/// shown. A change to line endings or the final newline, which the lines
/// alone don't show, gets a `\ ` note. Pure.
pub fn unified_diff(before: &str, after: &str, known: &[KnownSecret]) -> String {
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
    for &(start, end) in &hunks {
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
            // Redacted whole, then cut: a cut can't split a secret past its rule.
            let redacted = crate::secret_scan::redact_line(text, known);
            let shown = crate::chat_engine::truncate_char_safe(&redacted, LINE_CHARS);
            lines.push(match redacted.len() - shown.len() {
                0 => format!("{sign}{shown}"),
                more => format!("{sign}{shown} \u{2026} [line cut: {more} more bytes]"),
            });
        }
    }
    if lines.len() > PREVIEW_LINES {
        let more = lines.len() - PREVIEW_LINES;
        lines.truncate(PREVIEW_LINES);
        lines.push(format!("\u{2026} [{more} more lines not shown]"));
    }
    // What the lines alone don't show.
    let crlf = |s: &str| s.split_inclusive('\n').map(|l| l.ends_with("\r\n")).collect::<Vec<_>>();
    let count = |v: Vec<bool>| v.into_iter().filter(|&c| c).count();
    let endings_change = if hunks.is_empty() { crlf(before) != crlf(after) } else { count(crlf(before)) != count(crlf(after)) };
    if endings_change {
        lines.push("\\ Line endings change (CRLF and LF)".to_string());
    }
    if !before.is_empty() && before.ends_with('\n') != after.ends_with('\n') {
        lines.push(if after.ends_with('\n') { "\\ A final newline is added" } else { "\\ The final newline is removed" }.to_string());
    }
    if lines.is_empty() && before != after {
        lines.push("\\ The change is in characters the preview can't show".to_string());
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

        let card = card(ws.path(), &reach, None, "edit_file", &input, &[]);
        assert_eq!(card.diff.as_deref(), Some("@@ -1,3 +1,3 @@\n fn a() {\n-    1\n+    2\n }\n"));
        assert_eq!((card.shown.as_str(), card.reason.as_str()), ("src/a.rs", "edits a file"));

        let broker = ApprovalBroker::default();
        let mut answer = broker.park(card.request("w1", "t1", "c1"), 1);
        let waiting = broker.pending_for_thread("t1");
        assert_eq!(waiting.len(), 1);
        let shown = serde_json::to_value(&waiting[0]).unwrap();
        assert_eq!((shown["kind"].as_str(), shown["diff"].as_str()), (Some("ask"), card.diff.as_deref()));
        assert_eq!(shown["askFirst"].as_bool(), Some(true));
        assert!(shown.get("rememberDir").is_none() && shown.get("secret").is_none() && shown.get("previewNote").is_none());
        assert!(card.bound.is_some() && shown.get("bound").is_none(), "the approval binds to a hash the webview never sees");
        assert!(answer.try_recv().is_err(), "it waits for the user");
        assert_eq!(std::fs::read_to_string(ws.path().join("src/a.rs")).unwrap(), "fn a() {\n    1\n}\n");
        broker.respond("c1", ApprovalDecision::Approve);
        assert_eq!(answer.try_recv().unwrap(), ApprovalDecision::Approve);
        // Its approval grants nothing: the next card asks again.
        assert_eq!(broker.record("t1", ApprovalDecision::ApproveAlways, !CardKind::Ask.grantable()), ApprovalDecision::Approve);
        assert!(!broker.grant_answers("t1", Some(CardKind::Ask)));

        // A command's card is its own kind, with no diff.
        let run = serde_json::to_value(super::card(ws.path(), &reach, None, "run_command", &json!({ "command": "cargo fmt" }), &[]).request("w1", "t1", "c2")).unwrap();
        assert_eq!((run["kind"].as_str(), run["command"].as_str(), run.get("diff")), (Some("ask-run"), Some("cargo fmt"), None));
        assert!(!CardKind::AskRun.grantable());

        // A sub-agent's card names it; a new file shows as added lines.
        let new = card_for_new(ws.path(), &reach);
        assert_eq!(new.diff.as_deref(), Some("@@ -0,0 +1,2 @@\n+one\n+two\n"));
        assert!(new.reason.starts_with("Sub-agent \u{201c}Scout\u{201d}: writes a file"));
    }

    fn card_for_new(ws: &Path, reach: &Reach) -> AskCard {
        card(ws, reach, Some("Scout"), "write_file", &json!({ "path": "new.txt", "content": "one\ntwo\n" }), &[])
    }

    /// A declined card gives the call one fixed result, whatever it was, and
    /// a sub-agent's gate returns it before its own guards see the call.
    #[test]
    fn deny_returns_fixed_result() {
        let rt = runtime();
        let cards = [
            AskCard {
                kind: CardKind::Ask,
                reason: "edits a file".into(),
                shown: "a.rs".into(),
                diff: Some("@@ -1 +1 @@\n-a\n+b\n".into()),
                note: None,
                bound: Some("h".into()),
            },
            AskCard {
                kind: CardKind::AskRun,
                reason: "runs a command that may change files".into(),
                shown: "cargo fmt".into(),
                diff: None,
                note: None,
                bound: None,
            },
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
            || card(ws.path(), &reach, None, "write_file", &input, &[]),
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

    /// An approval binds to the whole change: a file that changed past what
    /// the preview shows (here, beyond a cut line) still asks again.
    #[test]
    fn a_change_past_the_preview_asks_again() {
        let ws = tempfile::tempdir().unwrap();
        let file = ws.path().join("a.txt");
        let line = "a".repeat(500);
        std::fs::write(&file, format!("{line}\n")).unwrap();
        let reach = Reach::new(ws.path(), None, None);
        let input = json!({ "path": "a.txt", "content": "short\n" });
        let shown = std::sync::Mutex::new(Vec::new());
        let out = runtime().block_on(ask_first(
            || card(ws.path(), &reach, None, "write_file", &input, &[]),
            |c: AskCard| {
                let first = shown.lock().unwrap().is_empty();
                shown.lock().unwrap().push(c.diff.clone().unwrap_or_default());
                if first {
                    // Past the 300 bytes the cut line shows.
                    std::fs::write(&file, format!("{}b\n", "a".repeat(499))).unwrap();
                }
                async { ApprovalDecision::Approve }
            },
        ));
        assert_eq!(out, None);
        let shown = shown.into_inner().unwrap();
        assert_eq!(shown.len(), 2, "the second card asks about the file as it now is");
        assert_eq!(shown[0], shown[1], "even though both previews read the same");
        assert!(shown[0].contains(" \u{2026} [line cut: 200 more bytes]"), "{}", shown[0]);
    }

    /// The preview never reads outside the workspace, shows only the hunks
    /// with their context, redacts what looks like a credential (and the
    /// user's own keys), marks what it cuts, and says plainly what it can't
    /// show.
    #[test]
    fn the_diff_preview_stays_in_the_workspace_and_marks_what_it_leaves_out() {
        let ws = tempfile::tempdir().unwrap();
        let reach = Reach::new(ws.path(), None, None);
        let outside = card(ws.path(), &reach, None, "write_file", &json!({ "path": "../elsewhere.txt", "content": "x" }), &[]);
        assert_eq!((outside.diff, outside.bound, outside.reason.as_str()), (None, None, "writes a file"));
        assert!(outside.note.unwrap().starts_with("No preview: the file is outside the workspace"));

        let before: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let after = before.replace("line 2\n", "line two\n").replace("line 18\n", "API_TOKEN=s3cr3t-value-123\n");
        let diff = unified_diff(&before, &after, &[]);
        assert!(diff.starts_with("@@ -1,5 +1,5 @@\n line 1\n-line 2\n+line two\n line 3\n"), "{diff}");
        assert!(diff.contains("@@ -15,6 +15,6 @@\n line 15\n"), "{diff}");
        assert!(!diff.contains("line 10") && !diff.contains("s3cr3t-value-123") && diff.contains("+API_TOKEN="), "{diff}");

        let big: String = (0..400).map(|n| format!("{n}\n")).collect();
        let capped = unified_diff("", &big, &[]);
        assert_eq!(capped.lines().count(), PREVIEW_LINES + 1);
        assert!(capped.ends_with("\u{2026} [241 more lines not shown]\n"), "{capped}");

        // A line-ending or final-newline change says so instead of nothing.
        assert_eq!(unified_diff("a\r\nb\r\n", "a\nb\n", &[]), "\\ Line endings change (CRLF and LF)\n");
        assert_eq!(unified_diff("a\nb", "a\nb\n", &[]), "\\ A final newline is added\n");
        assert!(unified_diff("a\nb\n", "a\nc", &[]).ends_with("+c\n\\ The final newline is removed\n"));

        // An env file's preview hides the user's own key, whatever its name.
        let mine = [KnownSecret::new("your Anthropic API key", "qwerty-my-own-key-1234567890")];
        let env = card(ws.path(), &reach, None, "write_file", &json!({ "path": ".env", "content": "MODEL_HOST=qwerty-my-own-key-1234567890\n" }), &mine);
        let env = env.diff.unwrap();
        assert!(env.starts_with("@@ -0,0 +1,1 @@\n+MODEL_HOST=") && !env.contains("qwerty-my-own-key"), "{env}");

        // A binary file, or one too large, says plainly that the change isn't shown.
        std::fs::write(ws.path().join("logo.png"), b"\x89PNG\0\0").unwrap();
        let png = card(ws.path(), &reach, None, "write_file", &json!({ "path": "logo.png", "content": "x" }), &[]);
        assert_eq!(png.diff, None);
        assert_eq!(png.note.as_deref(), Some("No preview: a binary file. Approving writes it without showing the change."));
        assert!(png.bound.is_some(), "its approval still binds to the bytes");
        let huge = "x\n".repeat(PREVIEW_BYTES);
        let large = card(ws.path(), &reach, None, "write_file", &json!({ "path": "big.txt", "content": huge }), &[]);
        assert_eq!(large.note.as_deref(), Some("No preview: the file is over 1 MB. Approving writes it without showing the change."));
    }
}
