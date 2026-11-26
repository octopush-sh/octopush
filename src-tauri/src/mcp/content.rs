//! What a model reads of an MCP `tools/call` result.
//!
//! The result is a list of content blocks (MCP spec: `text`, `image`,
//! `audio`, `resource`, `resource_link`). Text is passed through. Binary
//! content is base64, and base64 sent to a model as text costs a token every
//! few characters and means nothing to it: a single screenshot can fill most
//! of a context window. So a payload is replaced with a one-line placeholder
//! naming its type and size, but only where it is known to be binary:
//!
//! - a block the server declares binary: `image`, `audio`, a `resource`
//!   `blob`;
//! - a base64 `data:` URL of 256+ characters, wherever it appears in text;
//! - inside a text block that is JSON (and in the JSON fallback), a base64
//!   string of 256+ characters that decodes to the magic bytes of a binary
//!   format (PNG, JPEG, GIF, WebP, PDF, zip, gzip).
//!
//! Any other base64 stays as it is: it is ordinary developer output (a
//! Kubernetes secret, a JWT, an encoded config), and the director's 24 KB
//! cap on an MCP result already bounds it. The unscrubbed rendering is kept
//! next to the scrubbed one ([`McpOutput::original`]), so `recall_tool_output`
//! can return exactly what the server sent.

use base64::Engine as _;
use serde_json::Value;

/// Shortest base64 run treated as a payload. A data URL or string shorter
/// than this costs less than its placeholder would say.
const PAYLOAD_MIN_LEN: usize = 256;

/// A base64 `data:` URL ("data:image/png;base64,…"), with its media type.
static DATA_URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"data:([A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+)?(?:;[A-Za-z0-9.+=-]+)*;base64,([A-Za-z0-9+/=_-]{256,})")
        .unwrap()
});

/// A rendered `tools/call` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpOutput {
    /// What the model reads, the tool card shows and later turns replay:
    /// binary payloads replaced with placeholders.
    pub text: String,
    /// The result as the server sent it (text blocks joined, a binary block
    /// as its JSON), when it differs from `text`. The tool row keeps it for
    /// `recall_tool_output`.
    pub original: Option<String>,
}

/// Render a `tools/call` result: its blocks in order, one per line. A result
/// with no readable block falls back to its JSON.
pub fn render_call_result(result: &Value) -> McpOutput {
    let text = render(result, true);
    let original = render(result, false);
    McpOutput { original: (original != text).then_some(original), text }
}

fn render(result: &Value, scrub: bool) -> String {
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| blocks.iter().filter_map(|b| render_block(b, scrub)).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    if !text.is_empty() {
        return text;
    }
    if scrub {
        let mut copy = result.clone();
        scrub_value(&mut copy);
        copy.to_string()
    } else {
        result.to_string()
    }
}

fn render_block(block: &Value, scrub: bool) -> Option<String> {
    let str_of = |v: &Value, key: &str| v.get(key).and_then(|s| s.as_str()).map(str::to_string);
    match block.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        kind @ ("image" | "audio") => Some(if scrub {
            placeholder(kind, str_of(block, "mimeType").as_deref(), str_of(block, "data").as_deref().unwrap_or(""))
        } else {
            block.to_string()
        }),
        "resource" => {
            let resource = block.get("resource")?;
            if let Some(text) = str_of(resource, "text") {
                return Some(if scrub { scrub_text(&text) } else { text });
            }
            let blob = str_of(resource, "blob")?;
            if !scrub {
                return Some(block.to_string());
            }
            let what = match str_of(resource, "uri") {
                Some(uri) => format!("resource {uri}"),
                None => "resource".to_string(),
            };
            Some(placeholder(&what, str_of(resource, "mimeType").as_deref(), &blob))
        }
        "resource_link" => str_of(block, "uri").map(|uri| format!("[resource link: {uri}]")),
        // `text`, and any block that carries text under an unknown type.
        _ => str_of(block, "text").map(|t| if scrub { scrub_text(&t) } else { t }),
    }
}

/// "[image omitted: image/png, 48 KB]" for `encoded` base64 characters.
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

/// The binary format `s` holds, when it is one base64 token of 256+
/// characters (standard or URL-safe alphabet) whose first bytes are that
/// format's magic number. Anything else, including base64 of text, is not a
/// payload.
fn binary_format(s: &str) -> Option<&'static str> {
    if s.len() < PAYLOAD_MIN_LEN
        || !s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=' | b'-' | b'_'))
    {
        return None;
    }
    // 16 characters decode to the 12 bytes the longest magic (WebP) needs.
    let head: String = s[..16]
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(head).ok()?;
    magic(&bytes)
}

/// The format named by `bytes`' magic number, for the binary formats a tool
/// returns as base64: images, PDF and archives.
fn magic(bytes: &[u8]) -> Option<&'static str> {
    const FORMATS: &[(&[u8], &str)] = &[
        (b"\x89PNG\r\n\x1a\n", "PNG"),
        (b"\xff\xd8\xff", "JPEG"),
        (b"GIF87a", "GIF"),
        (b"GIF89a", "GIF"),
        (b"%PDF-", "PDF"),
        (b"PK\x03\x04", "zip"),
        (b"PK\x05\x06", "zip"),
        (b"PK\x07\x08", "zip"),
        (b"\x1f\x8b", "gzip"),
    ];
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("WebP");
    }
    FORMATS.iter().find(|(m, _)| bytes.starts_with(m)).map(|(_, name)| *name)
}

/// One string value with its base64 `data:` URLs replaced, or replaced
/// whole when it is a base64 binary payload ([`binary_format`]).
fn scrub_string(s: &str) -> String {
    if let Some(format) = binary_format(s) {
        return placeholder(&format!("base64 {format} data"), None, s);
    }
    scrub_data_urls(s)
}

/// `text` with its base64 `data:` URLs replaced.
fn scrub_data_urls(text: &str) -> String {
    DATA_URL
        .replace_all(text, |caps: &regex::Captures| placeholder("data URL", caps.get(1).map(|m| m.as_str()), &caps[2]))
        .into_owned()
}

/// Replace, in place, every payload in the strings of `v`.
fn scrub_value(v: &mut Value) {
    match v {
        Value::String(s) => *s = scrub_string(s),
        Value::Array(items) => items.iter_mut().for_each(scrub_value),
        Value::Object(map) => map.values_mut().for_each(scrub_value),
        _ => {}
    }
}

/// Collect `(payload, replacement)` for every string in `v` that
/// [`scrub_string`] changes.
fn payload_strings(v: &Value, out: &mut Vec<(String, String)>) {
    match v {
        Value::String(s) => {
            let scrubbed = scrub_string(s);
            if scrubbed != *s {
                out.push((s.clone(), scrubbed));
            }
        }
        Value::Array(items) => items.iter().for_each(|i| payload_strings(i, out)),
        Value::Object(map) => map.values().for_each(|i| payload_strings(i, out)),
        _ => {}
    }
}

/// A text block with its payloads replaced. Plain text: only its `data:`
/// URLs. JSON text (an object or array, as many MCP servers return): every
/// string value that is a base64 binary payload or holds a `data:` URL,
/// replaced where it stands so the rest keeps its formatting; the JSON is
/// re-serialized only when a payload is written with escapes.
fn scrub_text(text: &str) -> String {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(mut value) = serde_json::from_str::<Value>(text) {
            let mut found = Vec::new();
            payload_strings(&value, &mut found);
            if found.is_empty() {
                return text.to_string();
            }
            let mut out = text.to_string();
            let mut in_place = true;
            for (payload, replacement) in &found {
                // The value as it appears between its quotes.
                let raw = serde_json::to_string(payload).unwrap_or_default();
                let raw = &raw[1..raw.len().saturating_sub(1)];
                let quoted = serde_json::to_string(replacement).unwrap_or_default();
                if !raw.is_empty() && out.contains(raw) {
                    out = out.replace(raw, &quoted[1..quoted.len().saturating_sub(1)]);
                } else {
                    in_place = false;
                }
            }
            if in_place {
                return out;
            }
            scrub_value(&mut value);
            return if text.contains('\n') {
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            } else {
                value.to_string()
            };
        }
    }
    scrub_data_urls(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `bytes` repeated to a realistic payload size, base64-encoded.
    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes.repeat(1 + 3000 / bytes.len().max(1)))
    }

    fn png() -> String {
        b64(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01")
    }

    #[test]
    fn text_blocks_pass_through_joined_in_order() {
        let r = json!({ "content": [
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]});
        assert_eq!(render_call_result(&r), McpOutput { text: "first\nsecond".into(), original: None });
    }

    #[test]
    fn an_image_only_result_is_a_placeholder_and_keeps_its_original() {
        let data = png();
        let r = json!({ "content": [{ "type": "image", "data": data, "mimeType": "image/png" }] });
        let out = render_call_result(&r);
        assert_eq!(out.text, format!("[image omitted: image/png, {}]", kb(data.len())));
        let original = out.original.expect("the original is kept");
        assert!(original.contains(&data), "the original is what the server sent");
    }

    #[test]
    fn declared_binary_blocks_become_placeholders_text_stays() {
        let r = json!({ "content": [
            { "type": "text", "text": "Screenshot of the page:" },
            { "type": "image", "data": png(), "mimeType": "image/jpeg" },
            { "type": "audio", "data": png() },
            { "type": "resource", "resource": { "uri": "file:///a.pdf", "mimeType": "application/pdf", "blob": png() } },
            { "type": "resource", "resource": { "uri": "file:///a.md", "text": "# notes" } },
            { "type": "resource_link", "uri": "file:///b.txt", "name": "b" },
        ]});
        let out = render_call_result(&r);
        let lines: Vec<&str> = out.text.lines().collect();
        assert_eq!(lines[0], "Screenshot of the page:");
        assert!(lines[1].starts_with("[image omitted: image/jpeg, "), "{}", out.text);
        assert!(lines[2].starts_with("[audio omitted: "), "{}", out.text);
        assert!(lines[3].starts_with("[resource file:///a.pdf omitted: application/pdf, "), "{}", out.text);
        assert_eq!(lines[4], "# notes");
        assert_eq!(lines[5], "[resource link: file:///b.txt]");
        assert!(!out.text.contains(&png()[..40]));
        assert!(out.original.unwrap().contains(&png()));
    }

    #[test]
    fn data_urls_in_text_are_replaced() {
        let text = format!("see data:image/png;base64,{} for the chart", png());
        let out = render_call_result(&json!({ "content": [{ "type": "text", "text": text }] }));
        assert!(out.text.starts_with("see [data URL omitted: image/png, "), "{}", out.text);
        assert!(out.text.ends_with(" for the chart"), "{}", out.text);
        assert_eq!(out.original.as_deref(), Some(text.as_str()));
    }

    #[test]
    fn binary_base64_inside_json_text_is_replaced_where_it_stands() {
        let shot = png();
        let text = format!("{{\n  \"title\": \"Login page\",\n  \"screenshot\": \"{shot}\",\n  \"size\": 2\n}}");
        let out = render_call_result(&json!({ "content": [{ "type": "text", "text": text }] }));
        assert_eq!(
            out.text,
            format!(
                "{{\n  \"title\": \"Login page\",\n  \"screenshot\": \"[base64 PNG data omitted: {}]\",\n  \"size\": 2\n}}",
                kb(shot.len())
            ),
        );
        assert_eq!(out.original, Some(text));
    }

    #[test]
    fn every_known_binary_format_is_recognised() {
        let cases: [(&[u8], &str); 7] = [
            (b"\x89PNG\r\n\x1a\n....", "PNG"),
            (b"\xff\xd8\xff\xe0\0\x10JFIF\0", "JPEG"),
            (b"GIF89a\x01\0\x01\0\0\0", "GIF"),
            (b"RIFF\x24\0\0\0WEBPVP8 ", "WebP"),
            (b"%PDF-1.7\n%\xe2\xe3", "PDF"),
            (b"PK\x03\x04\x14\0\0\0\x08\0", "zip"),
            (b"\x1f\x8b\x08\0\0\0\0\0\0\x03", "gzip"),
        ];
        for (bytes, name) in cases {
            assert_eq!(binary_format(&b64(bytes)), Some(name), "{name}");
            // URL-safe base64 too.
            let url_safe = b64(bytes).replace('+', "-").replace('/', "_");
            assert_eq!(binary_format(&url_safe), Some(name), "{name} url-safe");
        }
        assert_eq!(binary_format(&png()[..200]), None, "too short to be a payload");
    }

    #[test]
    fn ordinary_base64_stays_as_it_is() {
        // A Kubernetes secret (base64 of text), a JWT and a long config blob:
        // developer output, never binary.
        let secret = base64::engine::general_purpose::STANDARD
            .encode("postgres://app:s3cret@db:5432/app?sslmode=require&".repeat(10));
        let jwt = format!(
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.{}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("{\"sub\":\"1234567890\",\"name\":\"John\"}".repeat(10)),
        );
        let k8s = format!(
            "{{\"apiVersion\":\"v1\",\"kind\":\"Secret\",\"data\":{{\"DATABASE_URL\":\"{secret}\",\"token\":\"{jwt}\"}}}}"
        );
        let hex = "0123456789abcdef".repeat(40);
        for text in [secret.clone(), jwt.clone(), k8s, hex, "word ".repeat(200)] {
            let out = render_call_result(&json!({ "content": [{ "type": "text", "text": text }] }));
            assert_eq!(out, McpOutput { text, original: None });
        }
        // A bare base64 PNG in plain text isn't declared binary: left alone.
        let bare = render_call_result(&json!({ "content": [{ "type": "text", "text": png() }] }));
        assert_eq!(bare.text, png());
    }

    #[test]
    fn a_result_with_no_readable_block_falls_back_to_json() {
        let note = base64::engine::general_purpose::STANDARD.encode("plain words ".repeat(40));
        let r = json!({ "content": [{ "type": "blob", "data": png(), "note": note }], "structuredContent": { "n": 1 } });
        let out = render_call_result(&r);
        assert!(out.text.contains("[base64 PNG data omitted: "), "{}", out.text);
        assert!(!out.text.contains(&png()[..40]));
        assert!(out.text.contains(&note), "base64 of text stays: {}", out.text);
        assert!(out.text.contains("\"structuredContent\":{\"n\":1}"), "{}", out.text);
        assert_eq!(out.original, Some(r.to_string()));
        // No content array at all: the JSON, as before.
        assert_eq!(render_call_result(&json!({ "ok": true })).text, "{\"ok\":true}");
    }
}
