//! Server-sent events (`text/event-stream`, as the HTML Living Standard
//! defines them), read from a response body as it arrives. Lines end in
//! CRLF, LF or CR; a blank line dispatches; `:` starts a comment; `data`
//! lines join with `\n`; an unfinished event at the end is dropped. `id` and
//! `retry` only serve reconnecting, which a one-shot request never does.

use crate::error::AppResult;
use bytes::Bytes;
use std::collections::VecDeque;
use std::time::Duration;

/// One dispatched event: its `event:` type (empty when the stream gave none)
/// and its `data:` lines joined with `\n`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Turns bytes into events, however the body is split into chunks (a line,
/// a CRLF or a UTF-8 character can straddle two).
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    /// The leading byte-order mark, if any, has been dealt with.
    started: bool,
    event: String,
    data: String,
    has_data: bool,
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

impl SseParser {
    /// The body ended: a CR left waiting for a possible LF ends its line, so
    /// an event whose blank line is that lone CR is dispatched. An event left
    /// unfinished is dropped, as the format says.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        if self.buf.last() == Some(&b'\r') {
            // A CR then an LF is one line end, as the CR alone was.
            return self.push(b"\n");
        }
        Vec::new()
    }

    /// Feed the next chunk; returns the events it completed, in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        if !self.started {
            if self.buf.len() < BOM.len() && BOM.starts_with(&self.buf) {
                return Vec::new();
            }
            if self.buf.starts_with(BOM) {
                self.buf.drain(..BOM.len());
            }
            self.started = true;
        }
        let mut out = Vec::new();
        let (mut start, mut i) = (0, 0);
        while i < self.buf.len() {
            let byte = self.buf[i];
            if byte != b'\n' && byte != b'\r' {
                i += 1;
                continue;
            }
            // A CR at the end of the chunk may be the first half of a CRLF.
            if byte == b'\r' && i + 1 == self.buf.len() {
                break;
            }
            let next = if byte == b'\r' && self.buf[i + 1] == b'\n' { i + 2 } else { i + 1 };
            let line = String::from_utf8_lossy(&self.buf[start..i]).into_owned();
            if let Some(event) = self.line(&line) {
                out.push(event);
            }
            start = next;
            i = next;
        }
        self.buf.drain(..start);
        out
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(at) => {
                let value = &line[at + 1..];
                (&line[..at], value.strip_prefix(' ').unwrap_or(value))
            }
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event = std::mem::take(&mut self.event);
        if !std::mem::take(&mut self.has_data) {
            return None;
        }
        Some(SseEvent { event, data: std::mem::take(&mut self.data) })
    }
}

/// Where a reader takes its bytes from: a response body, or a fixture.
#[async_trait::async_trait]
pub trait ByteSource: Send {
    /// The next piece of the body; `None` at its end.
    async fn next_chunk(&mut self) -> AppResult<Option<Bytes>>;
}

/// A streamed response body, and how its read errors open ("Anthropic
/// request failed"). A connection lost mid-answer is final, as for a whole body.
pub struct Body(pub reqwest::Response, pub &'static str);

#[async_trait::async_trait]
impl ByteSource for Body {
    async fn next_chunk(&mut self) -> AppResult<Option<Bytes>> {
        self.0.chunk().await.map_err(|e| super::body_error(self.1, &e))
    }
}

/// Reads events off a [`ByteSource`].
pub struct SseReader<S> {
    source: S,
    parser: SseParser,
    ready: VecDeque<SseEvent>,
    /// How long the body may send nothing; `None` = no bound.
    idle: Option<Duration>,
    what: &'static str,
    ended: bool,
}

impl<S: ByteSource> SseReader<S> {
    pub fn new(source: S, idle: Option<Duration>, what: &'static str) -> Self {
        Self { source, parser: SseParser::default(), ready: VecDeque::new(), idle, what, ended: false }
    }

    /// The next event, or `None` once the body has ended. A body that sends
    /// nothing for `idle` fails, for good, instead of hanging.
    pub async fn next(&mut self) -> AppResult<Option<SseEvent>> {
        loop {
            if let Some(event) = self.ready.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                return Ok(None);
            }
            let chunk = match self.idle {
                Some(idle) => tokio::time::timeout(idle, self.source.next_chunk())
                    .await
                    .map_err(|_| super::silent_stream_error(self.what, idle))??,
                None => self.source.next_chunk().await?,
            };
            match chunk {
                Some(bytes) => self.ready.extend(self.parser.push(&bytes)),
                None => {
                    self.ready.extend(self.parser.finish());
                    self.ended = true;
                }
            }
        }
    }
}
