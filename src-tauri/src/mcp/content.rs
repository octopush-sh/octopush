//! What a model reads of an MCP `tools/call` result.
//!
//! The result is a list of content blocks (MCP spec: `text`, `image`,
//! `audio`, `resource`, `resource_link`). Text is passed through; binary
//! blocks are base64, and base64 sent to a model as text costs a token every
//! few characters and means nothing to it: a single screenshot can fill most
//! of a context window. Every binary payload therefore becomes a one-line
//! placeholder naming its type and size, wherever it sits.

use serde_json::Value;

/// Shortest run treated as an encoded payload rather than text. Short
/// base64-looking strings (ids, hashes, tokens) are left alone.
const PAYLOAD_MIN_LEN: usize = 256;

/// A `data:` URI carrying base64 inside text ("data:image/png;base64,…").
static DATA_URI: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"data:([A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+)?(?:;[A-Za-z0-9.+=-]+)*;base64,([A-Za-z0-9+/=_-]{256,})")
        .unwrap()
});

/// The text of a `tools/call` result: its blocks in order, one per line, with
/// binary content as placeholders. A result with no readable block falls back
/// to its JSON, with any base64 payload in it replaced too.
pub fn render_call_result(result: &Value) -> String {
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| blocks.iter().filter_map(render_block).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    if text.is_empty() {
        let mut copy = result.clone();
        scrub_payloads(&mut copy);
        copy.to_string()
    } else {
        text
    }
}

fn render_block(block: &Value) -> Option<String> {
    let str_of = |v: &Value, key: &str| v.get(key).and_then(|s| s.as_str()).map(str::to_string);
    match block.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        kind @ ("image" | "audio") => Some(placeholder(
            kind,
            str_of(block, "mimeType").as_deref(),
            str_of(block, "data").as_deref().unwrap_or(""),
        )),
        "resource" => {
            let resource = block.get("resource")?;
            if let Some(text) = str_of(resource, "text") {
                return Some(scrub_text(&text));
            }
            let blob = str_of(resource, "blob")?;
            let what = match str_of(resource, "uri") {
                Some(uri) => format!("resource {uri}"),
                None => "resource".to_string(),
            };
            Some(placeholder(&what, str_of(resource, "mimeType").as_deref(), &blob))
        }
        "resource_link" => str_of(block, "uri").map(|uri| format!("[resource link: {uri}]")),
        // `text`, and any block that carries text under an unknown type.
        _ => str_of(block, "text").map(|t| scrub_text(&t)),
    }
}

/// "[image omitted: image/png, 48 KB]" for `encoded` base64 bytes.
fn placeholder(what: &str, mime: Option<&str>, encoded: &str) -> String {
    let size = kb(encoded.len());
    match mime {
        Some(mime) => format!("[{what} omitted: {mime}, {size}]"),
        None => format!("[{what} omitted: {size}]"),
    }
}

/// The decoded size of `encoded_len` base64 characters, in whole KB (≥ 1).
fn kb(encoded_len: usize) -> String {
    let bytes = encoded_len / 4 * 3;
    format!("{} KB", bytes.div_ceil(1024).max(1))
}

/// Whether `s` is an encoded payload: long, one token of the base64 alphabet
/// (standard or URL-safe), with both letter cases. The case rule keeps hex
/// digests, decimal runs and other long single-case tokens as text.
fn is_payload(s: &str) -> bool {
    s.len() >= PAYLOAD_MIN_LEN
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=' | b'-' | b'_'))
        && s.bytes().any(|c| c.is_ascii_uppercase())
        && s.bytes().any(|c| c.is_ascii_lowercase())
}

/// `text` with every `data:` URI's payload replaced, or the whole text when
/// it is one bare payload (a server that returns a file as base64 text).
fn scrub_text(text: &str) -> String {
    if is_payload(text.trim()) {
        return placeholder("base64 data", None, text.trim());
    }
    DATA_URI
        .replace_all(text, |caps: &regex::Captures| {
            placeholder("data URI", caps.get(1).map(|m| m.as_str()), &caps[2])
        })
        .into_owned()
}

/// Replace, in place, every string in `v` that is a payload or holds a
/// `data:` URI.
fn scrub_payloads(v: &mut Value) {
    match v {
        Value::String(s) => *s = scrub_text(s),
        Value::Array(items) => items.iter_mut().for_each(scrub_payloads),
        Value::Object(map) => map.values_mut().for_each(scrub_payloads),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A realistic base64 payload: ~12 KB of PNG-ish bytes.
    fn png_b64() -> String {
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
            .repeat(160)
    }

    #[test]
    fn text_blocks_pass_through_joined_in_order() {
        let r = json!({ "content": [
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]});
        assert_eq!(render_call_result(&r), "first\nsecond");
    }

    #[test]
    fn an_image_only_result_is_a_placeholder_never_its_base64() {
        let data = png_b64();
        let r = json!({ "content": [{ "type": "image", "data": data, "mimeType": "image/png" }] });
        let out = render_call_result(&r);
        assert!(!out.contains("iVBORw0KGgo"), "{out}");
        assert_eq!(out, format!("[image omitted: image/png, {}]", kb(data.len())));
        assert!(out.len() < 80, "{out}");
    }

    #[test]
    fn mixed_blocks_keep_the_text_and_mark_the_binary() {
        let r = json!({ "content": [
            { "type": "text", "text": "Screenshot of the page:" },
            { "type": "image", "data": png_b64(), "mimeType": "image/jpeg" },
            { "type": "audio", "data": png_b64() },
            { "type": "resource", "resource": { "uri": "file:///a.pdf", "mimeType": "application/pdf", "blob": png_b64() } },
            { "type": "resource", "resource": { "uri": "file:///a.md", "text": "# notes" } },
            { "type": "resource_link", "uri": "file:///b.txt", "name": "b" },
        ]});
        let out = render_call_result(&r);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "Screenshot of the page:");
        assert!(lines[1].starts_with("[image omitted: image/jpeg, "), "{out}");
        assert!(lines[2].starts_with("[audio omitted: "), "{out}");
        assert!(lines[3].starts_with("[resource file:///a.pdf omitted: application/pdf, "), "{out}");
        assert_eq!(lines[4], "# notes");
        assert_eq!(lines[5], "[resource link: file:///b.txt]");
        assert!(!out.contains("iVBORw0KGgo"), "{out}");
    }

    #[test]
    fn data_uris_and_bare_base64_inside_text_are_replaced() {
        let uri = format!("see data:image/png;base64,{} for the chart", png_b64());
        let out = render_call_result(&json!({ "content": [{ "type": "text", "text": uri }] }));
        assert!(out.starts_with("see [data URI omitted: image/png, "), "{out}");
        assert!(out.ends_with(" for the chart"), "{out}");
        let bare = render_call_result(&json!({ "content": [{ "type": "text", "text": png_b64() }] }));
        assert!(bare.starts_with("[base64 data omitted: "), "{bare}");
    }

    #[test]
    fn ordinary_long_tokens_stay_text() {
        // Hex digests, commit lists and prose are not payloads.
        let hex = "0123456789abcdef".repeat(40);
        let commits = format!("{hex}\n{hex}");
        for text in [hex.clone(), commits, "word ".repeat(200), "a".repeat(300)] {
            let r = json!({ "content": [{ "type": "text", "text": text }] });
            assert_eq!(render_call_result(&r), text);
        }
    }

    #[test]
    fn a_result_with_no_readable_block_falls_back_to_scrubbed_json() {
        let r = json!({ "content": [{ "type": "blob", "data": png_b64() }], "structuredContent": { "n": 1 } });
        let out = render_call_result(&r);
        assert!(!out.contains("iVBORw0KGgo"), "{out}");
        assert!(out.contains("[base64 data omitted: "), "{out}");
        assert!(out.contains("\"structuredContent\":{\"n\":1}"), "{out}");
        // No content array at all: the JSON, as before.
        assert_eq!(render_call_result(&json!({ "ok": true })), "{\"ok\":true}");
    }
}
