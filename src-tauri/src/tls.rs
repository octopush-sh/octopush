//! Outbound TLS policy for every HTTP client the Octopush core builds.
//!
//! **Why this exists.** In October 2026 the private keys of eight eMudhra
//! (emSign) intermediate CAs turned out to be recoverable from public data, so
//! anyone can mint a certificate for any hostname that chains to a publicly
//! trusted root. Octopush's outbound requests carry provider API keys, the
//! Clerk OAuth session, Jira credentials and GitHub tokens, so a forged
//! certificate on any of those hosts is credential theft. Browsers blocked the
//! keys within days; a non-browser client inherits whatever the operating
//! system's trust store does: Apple's trust supplement blocks them on macOS and
//! Microsoft's disallowed list on Windows, but a Linux CA bundle only loses the
//! emSign root (which does not cover Sectigo's cross-signs of the same keys),
//! and none of them do revocation checking for a Rust client. Go
//! (CVE-2026-111943), Node.js, Electron and Chrome answered with a hard-coded
//! denylist keyed on the SubjectPublicKeyInfo (SPKI) hash of the compromised
//! keys; this module is Octopush's equivalent.
//!
//! **Mechanism.** [`client_builder`] is the one place a `reqwest` client starts
//! from. It runs on rustls with `rustls_platform_verifier` — the OS trust store
//! and the OS's own policy are honoured exactly as before — wrapped in a
//! [`DenylistVerifier`] with three layers:
//!
//! 1. **Presented chain, before the OS sees it.** Any presented certificate
//!    whose SPKI hash is on [`DISTRUSTED_SPKI_SHA256`] is refused (keying on
//!    the key rather than the certificate fingerprint means Sectigo's
//!    cross-signs of the same keys match too).
//! 2. **Presented chain, issuer names.** Any presented certificate whose
//!    issuer `Name` matches the subject of one of the compromised
//!    intermediates ([`DISTRUSTED_CA_SUBJECTS`]) — byte for byte, or after
//!    normalization (case, whitespace, ASN.1 string type) — is refused, so a
//!    server cannot dodge layer 1 by sending only a forged leaf and letting the
//!    OS fetch the intermediate itself (AIA `caIssuers`, or a keychain copy).
//! 3. **The chain the OS built (macOS).** Octopush runs the single `SecTrust`
//!    evaluation itself (`evaluate_on_macos`, same policy, date and OCSP
//!    input as the platform verifier): an evaluation error rejects, and the
//!    chain `SecTrust` built is re-checked with layers 1 and 2. This is the
//!    chain Go filters; it covers paths the OS completed on its own through
//!    attacker-controlled sub-CAs. On Linux the platform verifier is webpki on
//!    the presented certificates plus the system roots, with no AIA fetching,
//!    so layers 1 and 2 already see every non-root certificate of the path.
//!    Windows (CryptoAPI, which does fetch AIA) is not a shipped platform and
//!    gets layers 1 and 2 only.
//!
//! If the platform verifier cannot be initialised (no CA bundle on an exotic
//! Linux box), the builder falls back to reqwest's default OS-backed TLS so the
//! app keeps working, and says so once in the log.

use std::fmt;
use std::sync::{Arc, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error as TlsError,
    OtherError, SignatureScheme,
};
use sha2::{Digest, Sha256};

/// SHA-256 over the DER `SubjectPublicKeyInfo` of the eight eMudhra intermediate
/// CA keys compromised in October 2026 (`EM DV/OV/EV TLS CA - G3B/G3C` and
/// `EM OV CS CA - G3B/G3C`). These are the same eight values Go hard-codes in
/// `crypto/x509` (`distrustedSPKIHashes`, CVE-2026-111943). Keyed on the key,
/// not the certificate, so a cross-signed copy of a compromised key matches too.
pub const DISTRUSTED_SPKI_SHA256: [[u8; 32]; 8] = [
    hex32("ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105"),
    hex32("49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f"),
    hex32("e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41"),
    hex32("5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0"),
    hex32("43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b"),
    hex32("63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8"),
    hex32("ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6"),
    hex32("92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30"),
];

/// Decode a hex string literal into a `&'static [u8]` at compile time.
macro_rules! hex {
    ($s:literal) => {{
        const S: &str = $s;
        const N: usize = S.len() / 2;
        const B: [u8; N] = hex_bytes::<N>(S);
        &B
    }};
}
const fn hex_bytes<const N: usize>(s: &str) -> [u8; N] {
    let b = s.as_bytes();
    assert!(b.len() == 2 * N, "odd-length hex literal");
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = (nibble(b[2 * i]) << 4) | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

/// Subject `Name`s of the eight compromised intermediates, as the exact DER bytes
/// of the certificates' `subject` field (each name is shared by the emSign-root
/// issued certificate and the Sectigo `AAA Certificate Services` cross-sign).
///
/// Source: the 16 certificates in Mozilla's incident data,
/// `impacted-intermediates.json` in github.com/galadran/we-have-a-problem.com
/// (the repo behind emudhra.we-have-a-problem.com). Each certificate was checked
/// before its subject was copied here: its SPKI SHA-256 equals the matching
/// entry of [`DISTRUSTED_SPKI_SHA256`] (Go's list), its signature verifies
/// against `emSign Root TLS/CS CA - G3` or `AAA Certificate Services`, and the
/// `EM DV TLS CA - G3B` certificate's SHA-256 (42c4accd…1493) matches Chromium's
/// `net/data/ssl/blocklist` entry.
pub const DISTRUSTED_CA_SUBJECTS: [DistrustedCa; 8] = [
    DistrustedCa { name: "EM DV TLS CA - G3B", subject_der: hex!("303f310b3009060355040613024e4c31133011060355040a0c0a654d7564687261204256311b301906035504030c12454d20445620544c53204341202d20473342") },
    DistrustedCa { name: "EM OV TLS CA - G3B", subject_der: hex!("303f310b3009060355040613024e4c31133011060355040a0c0a654d7564687261204256311b301906035504030c12454d204f5620544c53204341202d20473342") },
    DistrustedCa { name: "EM EV TLS CA - G3B", subject_der: hex!("303f310b3009060355040613024e4c31133011060355040a0c0a654d7564687261204256311b301906035504030c12454d20455620544c53204341202d20473342") },
    DistrustedCa { name: "EM DV TLS CA - G3C", subject_der: hex!("3040310b300906035504061302555331143012060355040a0c0b654d756468726120496e63311b301906035504030c12454d20445620544c53204341202d20473343") },
    DistrustedCa { name: "EM OV TLS CA - G3C", subject_der: hex!("3040310b300906035504061302555331143012060355040a0c0b654d756468726120496e63311b301906035504030c12454d204f5620544c53204341202d20473343") },
    DistrustedCa { name: "EM EV TLS CA - G3C", subject_der: hex!("3040310b300906035504061302555331143012060355040a0c0b654d756468726120496e63311b301906035504030c12454d20455620544c53204341202d20473343") },
    DistrustedCa { name: "EM OV CS CA - G3B", subject_der: hex!("303e310b3009060355040613024e4c31133011060355040a0c0a654d7564687261204256311a301806035504030c11454d204f56204353204341202d20473342") },
    DistrustedCa { name: "EM OV CS CA - G3C", subject_der: hex!("303f310b300906035504061302555331143012060355040a0c0b654d756468726120496e63311a301806035504030c11454d204f56204353204341202d20473343") },
];

/// A compromised intermediate, by display name and DER subject `Name`.
#[derive(Debug)]
pub struct DistrustedCa {
    pub name: &'static str,
    pub subject_der: &'static [u8],
}

/// Decode a 64-character hex string at compile time. A malformed entry in the
/// denylist is a build error, not a silently-missing block.
const fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert!(b.len() == 64, "an SPKI hash is 64 hex characters");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(b[2 * i]) << 4) | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex digit in an SPKI hash"),
    }
}

// ─── DER: locate the SubjectPublicKeyInfo ─────────────────────────────────

const TAG_SEQUENCE: u8 = 0x30;
const TAG_INTEGER: u8 = 0x02;
/// `[0] EXPLICIT Version` — present on v2/v3 certificates, absent on v1.
const TAG_VERSION: u8 = 0xa0;

/// A minimal DER cursor: just enough of X.509 to walk to the SPKI.
struct Der<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Der<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn peek_tag(&self) -> Option<u8> {
        self.buf.get(self.pos).copied()
    }

    /// Read one TLV. Returns `(tag, contents, whole element incl. header)`.
    fn next(&mut self) -> Option<(u8, &'a [u8], &'a [u8])> {
        let start = self.pos;
        let tag = *self.buf.get(self.pos)?;
        // High-tag-number form never occurs at the positions we walk.
        if tag & 0x1f == 0x1f {
            return None;
        }
        let mut p = self.pos + 1;
        let first = *self.buf.get(p)?;
        p += 1;
        let len = if first & 0x80 == 0 {
            first as usize
        } else {
            let n = (first & 0x7f) as usize;
            // 0 = indefinite (BER, not DER); > 4 bytes = not a certificate.
            if n == 0 || n > 4 {
                return None;
            }
            let mut len = 0usize;
            for _ in 0..n {
                len = (len << 8) | *self.buf.get(p)? as usize;
                p += 1;
            }
            len
        };
        let end = p.checked_add(len)?;
        if end > self.buf.len() {
            return None;
        }
        self.pos = end;
        Some((tag, &self.buf[p..end], &self.buf[start..end]))
    }

    fn expect(&mut self, tag: u8) -> Option<(&'a [u8], &'a [u8])> {
        let (t, contents, whole) = self.next()?;
        (t == tag).then_some((contents, whole))
    }
}

/// The DER-encoded `SubjectPublicKeyInfo` of an X.509 certificate — the exact
/// bytes SPKI hashes are computed over (Go's `RawSubjectPublicKeyInfo`,
/// Chrome's CRLSet, HPKP). `None` when the input is not a well-formed
/// certificate.
pub fn subject_public_key_info(cert_der: &[u8]) -> Option<&[u8]> {
    tbs_fields(cert_der).map(|f| f.spki)
}

/// The DER-encoded issuer `Name` of an X.509 certificate (the whole TLV, the
/// bytes a path builder matches against an issuer's subject). `None` when the
/// input is not a well-formed certificate.
pub fn issuer_name(cert_der: &[u8]) -> Option<&[u8]> {
    tbs_fields(cert_der).map(|f| f.issuer)
}

/// The two `TBSCertificate` fields the denylist looks at.
struct TbsFields<'a> {
    /// `issuer` `Name`, header included.
    issuer: &'a [u8],
    /// `subjectPublicKeyInfo`, header included.
    spki: &'a [u8],
}

fn tbs_fields(cert_der: &[u8]) -> Option<TbsFields<'_>> {
    let (cert, _) = Der::new(cert_der).expect(TAG_SEQUENCE)?;
    let (tbs, _) = Der::new(cert).expect(TAG_SEQUENCE)?;
    let mut tbs = Der::new(tbs);
    if tbs.peek_tag()? == TAG_VERSION {
        tbs.next()?;
    }
    tbs.expect(TAG_INTEGER)?; // serialNumber
    tbs.expect(TAG_SEQUENCE)?; // signature
    let (_, issuer) = tbs.expect(TAG_SEQUENCE)?; // issuer
    tbs.expect(TAG_SEQUENCE)?; // validity
    tbs.expect(TAG_SEQUENCE)?; // subject
    let (_, spki) = tbs.expect(TAG_SEQUENCE)?; // subjectPublicKeyInfo
    Some(TbsFields { issuer, spki })
}

/// SHA-256 of a certificate's SPKI, or `None` when it cannot be parsed.
pub fn spki_sha256(cert_der: &[u8]) -> Option<[u8; 32]> {
    subject_public_key_info(cert_der).map(|spki| Sha256::digest(spki).into())
}

// ─── Name comparison ──────────────────────────────────────────────────────

/// A `Name` reduced to what path builders compare: per RDN, the sorted
/// `(attribute OID, value)` pairs, with string values decoded whatever their
/// ASN.1 string type, case-folded and whitespace-collapsed (RFC 5280 §7.1 /
/// RFC 4518-style; macOS normalizes names this way when it builds paths).
/// Non-string values are kept as `tag:hex`. `None` when not a well-formed Name.
type NormalizedName = Vec<Vec<(Vec<u8>, String)>>;

const TAG_SET: u8 = 0x31;
const TAG_OID: u8 = 0x06;

fn normalized_name(der: &[u8]) -> Option<NormalizedName> {
    let (rdns, whole) = Der::new(der).expect(TAG_SEQUENCE)?;
    if whole.len() != der.len() {
        return None;
    }
    let mut rdns = Der::new(rdns);
    let mut out = Vec::new();
    while rdns.peek_tag().is_some() {
        let (set, _) = rdns.expect(TAG_SET)?;
        let mut set = Der::new(set);
        let mut rdn = Vec::new();
        while set.peek_tag().is_some() {
            let (atv, _) = set.expect(TAG_SEQUENCE)?;
            let mut atv = Der::new(atv);
            let (oid, _) = atv.expect(TAG_OID)?;
            let (tag, value, _) = atv.next()?;
            if atv.peek_tag().is_some() {
                return None;
            }
            rdn.push((oid.to_vec(), normalize_value(tag, value)));
        }
        rdn.sort();
        out.push(rdn);
    }
    Some(out)
}

fn normalize_value(tag: u8, v: &[u8]) -> String {
    let decoded: Option<String> = match tag {
        // UTF8String, PrintableString, IA5String, VisibleString
        0x0c | 0x13 | 0x16 | 0x1a => std::str::from_utf8(v).ok().map(str::to_owned),
        // TeletexString: treated as Latin-1, as most implementations do.
        0x14 => Some(v.iter().map(|&b| b as char).collect()),
        // BMPString: UTF-16BE.
        0x1e if v.len().is_multiple_of(2) => {
            char::decode_utf16(v.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])))
                .collect::<Result<String, _>>()
                .ok()
        }
        // UniversalString: UTF-32BE.
        0x1c if v.len().is_multiple_of(4) => v
            .chunks(4)
            .map(|c| char::from_u32(u32::from_be_bytes([c[0], c[1], c[2], c[3]])))
            .collect::<Option<String>>(),
        _ => None,
    };
    match decoded {
        Some(s) => s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" "),
        None => {
            let mut raw = format!("{tag:02x}:");
            for b in v {
                raw.push_str(&format!("{b:02x}"));
            }
            raw
        }
    }
}

/// The denylisted CA `issuer` names, matched exactly or after normalization
/// (so a PrintableString or case-changed re-encoding of a compromised CA's
/// name, which macOS would still chain to the real intermediate, is caught).
fn denylisted_issuer(issuers: &'static [DistrustedCa], issuer: &[u8]) -> Option<&'static DistrustedCa> {
    if let Some(ca) = issuers.iter().find(|ca| ca.subject_der == issuer) {
        return Some(ca);
    }
    let candidate = normalized_name(issuer)?;
    issuers
        .iter()
        .find(|ca| normalized_name(ca.subject_der).as_ref() == Some(&candidate))
}

// ─── The verifier ─────────────────────────────────────────────────────────

/// The error a connection fails with when its chain carries a compromised key.
pub struct DistrustedKey {
    spki_sha256: [u8; 32],
}

/// rustls renders `InvalidCertificate(Other(..))` with the inner error's
/// `Debug`, so that must read as the sentence, not as a field dump.
impl fmt::Debug for DistrustedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl fmt::Display for DistrustedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the server's certificate chain contains a compromised eMudhra intermediate CA key (SPKI SHA-256 "
        )?;
        for b in self.spki_sha256 {
            write!(f, "{b:02x}")?;
        }
        write!(f, "); refusing to connect")
    }
}

impl std::error::Error for DistrustedKey {}

/// The error a connection fails with when a certificate in its chain was issued
/// under the name of a compromised intermediate.
pub struct DistrustedIssuer {
    name: &'static str,
}

impl fmt::Debug for DistrustedIssuer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl fmt::Display for DistrustedIssuer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the server's certificate chain was issued by the compromised eMudhra intermediate CA \"{}\"; refusing to connect",
            self.name
        )
    }
}

impl std::error::Error for DistrustedIssuer {}

/// Wraps any `ServerCertVerifier` (in production, the OS platform verifier) and
/// rejects a chain when any certificate in it — leaf or intermediate — has an
/// SPKI hash on the key denylist or an issuer name on the subject denylist.
/// See the module docs for which chains are checked on which platform.
#[derive(Debug)]
pub struct DenylistVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    keys: &'static [[u8; 32]],
    issuers: &'static [DistrustedCa],
    /// macOS production mode: evaluate with `SecTrust` here (one evaluation
    /// whose verdict *and* built chain are both used) instead of delegating
    /// `verify_server_cert` to `inner`. Off everywhere else and in tests.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    os_eval: bool,
}

impl DenylistVerifier {
    /// Wrap `inner` with the production denylists, [`DISTRUSTED_SPKI_SHA256`]
    /// and [`DISTRUSTED_CA_SUBJECTS`].
    pub fn new(inner: Arc<dyn ServerCertVerifier>) -> Self {
        Self::with_denylists(inner, &DISTRUSTED_SPKI_SHA256, &DISTRUSTED_CA_SUBJECTS)
    }

    /// Wrap `inner` with explicit denylists (tests).
    pub fn with_denylists(
        inner: Arc<dyn ServerCertVerifier>,
        keys: &'static [[u8; 32]],
        issuers: &'static [DistrustedCa],
    ) -> Self {
        Self { inner, keys, issuers, os_eval: false }
    }

    /// Production: wrap the OS platform verifier. On macOS the server
    /// certificate is evaluated by `evaluate_on_macos` (same `SecTrust` policy
    /// as the platform verifier, plus the built-chain check); `inner` still
    /// verifies the handshake signatures. Elsewhere this is [`Self::new`].
    pub fn platform(inner: rustls_platform_verifier::Verifier) -> Self {
        Self { os_eval: cfg!(target_os = "macos"), ..Self::new(Arc::new(inner)) }
    }

    /// `Ok(())` when no certificate in `chain` carries a denylisted key or was
    /// issued under a denylisted name. A certificate we cannot parse fails
    /// closed as `BadEncoding` — the platform would reject it too, and a check
    /// that can be skipped by malforming the input is no check.
    fn check_chain<'a>(&self, chain: impl Iterator<Item = &'a [u8]>) -> Result<(), TlsError> {
        self.check_certs(&chain.collect::<Vec<_>>(), false)
    }

    /// The chain the OS built ends in the trust anchor it chose. An anchor is
    /// by definition not one of the compromised intermediates, so a quirky
    /// (corporate/MDM) root that our minimal DER walk cannot parse is skipped
    /// instead of breaking every connection; every other certificate still
    /// fails closed.
    #[cfg(any(target_os = "macos", test))]
    fn check_built_chain(&self, chain: &[Vec<u8>]) -> Result<(), TlsError> {
        if chain.is_empty() {
            return Err(TlsError::General("tls: the OS returned an empty certificate chain".into()));
        }
        self.check_certs(&chain.iter().map(|c| c.as_slice()).collect::<Vec<_>>(), true)
    }

    fn check_certs(
        &self,
        chain: &[&[u8]],
        tolerate_unparseable_anchor: bool,
    ) -> Result<(), TlsError> {
        let last = chain.len().saturating_sub(1);
        for (i, &der) in chain.iter().enumerate() {
            let Some(fields) = tbs_fields(der) else {
                if tolerate_unparseable_anchor && i == last && last > 0 {
                    continue;
                }
                return Err(TlsError::InvalidCertificate(CertificateError::BadEncoding));
            };
            let hash: [u8; 32] = Sha256::digest(fields.spki).into();
            if self.keys.contains(&hash) {
                return Err(TlsError::InvalidCertificate(CertificateError::Other(OtherError(
                    Arc::new(DistrustedKey { spki_sha256: hash }),
                ))));
            }
            if let Some(ca) = denylisted_issuer(self.issuers, fields.issuer) {
                return Err(TlsError::InvalidCertificate(CertificateError::Other(OtherError(
                    Arc::new(DistrustedIssuer { name: ca.name }),
                ))));
            }
        }
        Ok(())
    }
}

// MIRRORS rustls-platform-verifier 0.6.2, `src/verification/apple.rs`
// (`Verifier::verify_certificate` and its error mapping), minus `extra_roots`
// (unused here) and the test-only root override. Re-diff against that file on
// every rustls-platform-verifier bump: a change upstream (policy, date, OCSP,
// error mapping) is not picked up automatically, because this function
// replaces the platform verifier's certificate evaluation on macOS.
/// Evaluates the presented certificates with macOS `SecTrust` exactly as
/// `rustls_platform_verifier` does (SSL server policy for `server_name`, the
/// handshake's verify date, the stapled OCSP response) and returns the chain
/// it built — leaf first, anchor last, including intermediates the OS found
/// on its own via AIA or the keychain. One evaluation: its verdict is the
/// verdict (an error is a rejection), and its chain is what the denylist then
/// re-checks, so the two can never disagree.
#[cfg(target_os = "macos")]
fn evaluate_on_macos(
    end_entity: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    server_name: &ServerName<'_>,
    ocsp_response: &[u8],
    now: UnixTime,
) -> Result<Vec<Vec<u8>>, TlsError> {
    use core_foundation::date::CFDate;
    use security_framework::certificate::SecCertificate;
    use security_framework::policy::SecPolicy;
    use security_framework::secure_transport::SslProtocolSide;
    use security_framework::trust::SecTrust;

    /// Seconds between the UNIX epoch and Apple's (2001-01-01T00:00:00Z),
    /// i.e. `kCFAbsoluteTimeIntervalSince1970`.
    const APPLE_EPOCH_OFFSET: u64 = 978_307_200;
    // OSStatus codes, as in security-framework-sys `base.rs`.
    const ERR_SEC_HOST_NAME_MISMATCH: isize = -67602;
    const ERR_SEC_CREATE_CHAIN_FAILED: isize = -25318;
    const ERR_SEC_CERTIFICATE_REVOKED: isize = -67820;

    let invalid = |reason: String| {
        TlsError::InvalidCertificate(CertificateError::Other(OtherError(Arc::from(Box::<
            dyn std::error::Error + Send + Sync,
        >::from(reason)))))
    };

    let certs = std::iter::once(end_entity.as_ref())
        .chain(intermediates.iter().map(|c| c.as_ref()))
        .map(|der| {
            SecCertificate::from_der(der)
                .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let name = server_name.to_str();
    let policy = SecPolicy::create_ssl(SslProtocolSide::SERVER, Some(name.as_ref()));
    let mut trust = SecTrust::create_with_certificates(&certs, &[policy])
        .map_err(|e| TlsError::General(e.to_string()))?;
    let secs = now
        .as_secs()
        .checked_sub(APPLE_EPOCH_OFFSET)
        .ok_or(TlsError::FailedToGetCurrentTime)?;
    trust
        .set_trust_verify_date(&CFDate::new(secs as f64))
        .map_err(|e| invalid(e.to_string()))?;
    if !ocsp_response.is_empty() {
        trust
            .set_trust_ocsp_response(std::iter::once(ocsp_response))
            .map_err(|e| invalid(e.to_string()))?;
    }
    if let Err(e) = trust.evaluate_with_error() {
        let code = e.code();
        return Err(match code {
            ERR_SEC_HOST_NAME_MISMATCH => TlsError::InvalidCertificate(CertificateError::NotValidForName),
            ERR_SEC_CREATE_CHAIN_FAILED => TlsError::InvalidCertificate(CertificateError::UnknownIssuer),
            ERR_SEC_CERTIFICATE_REVOKED => TlsError::InvalidCertificate(CertificateError::Revoked),
            _ => invalid(format!("{e}: {code}")),
        });
    }
    Ok(evaluated_chain(&trust))
}

/// `SecTrustCopyCertificateChain` needs macOS 12 (security-framework's
/// `macos-12` feature); the index API it deprecates works on every release.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn evaluated_chain(trust: &security_framework::trust::SecTrust) -> Vec<Vec<u8>> {
    let mut chain = Vec::new();
    let mut ix = 0;
    while let Some(cert) = trust.certificate_at_index(ix) {
        chain.push(cert.to_der());
        ix += 1;
    }
    chain
}

impl ServerCertVerifier for DenylistVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        self.check_chain(
            std::iter::once(end_entity.as_ref()).chain(intermediates.iter().map(|c| c.as_ref())),
        )?;
        #[cfg(target_os = "macos")]
        if self.os_eval {
            let built = evaluate_on_macos(end_entity, intermediates, server_name, ocsp_response, now)?;
            self.check_built_chain(&built)?;
            return Ok(ServerCertVerified::assertion());
        }
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }

    fn root_hint_subjects(&self) -> Option<&[DistinguishedName]> {
        self.inner.root_hint_subjects()
    }
}

/// A rustls client configuration: the OS trust store (via the platform
/// verifier) behind the compromised-key denylist. Fails only when the platform
/// verifier itself cannot start (e.g. no CA bundle at all on Linux).
pub fn rustls_client_config() -> Result<ClientConfig, TlsError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let platform = rustls_platform_verifier::Verifier::new(provider.clone())?;
    let verifier = DenylistVerifier::platform(platform);
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    // Parity with the native-tls backend this replaces (`native-tls-no-alpn`,
    // so it never negotiated h2): providers keep streaming over HTTP/1.1
    // exactly as before. reqwest leaves a preconfigured config's ALPN alone.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

// ─── Error text ───────────────────────────────────────────────────────────

/// The rustls error behind a request error, if any. Walks the `source()` chain
/// and looks inside `io::Error`s, which is where hyper leaves the rustls error
/// (`io::Error::source` skips the wrapped error itself).
fn find_tls_error<'a>(err: &'a (dyn std::error::Error + 'static)) -> Option<&'a TlsError> {
    let mut cur: Option<&'a (dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(tls) = e.downcast_ref::<TlsError>() {
            return Some(tls);
        }
        if let Some(tls) = e
            .downcast_ref::<std::io::Error>()
            .and_then(|io| io.get_ref())
            .and_then(|inner| inner.downcast_ref::<TlsError>())
        {
            return Some(tls);
        }
        cur = e.source();
    }
    None
}

/// True for the failures retrying cannot fix: a denylist refusal, or a server
/// that only offers TLS versions / suites this client does not speak.
fn is_permanent(err: &TlsError) -> bool {
    use rustls::AlertDescription as A;
    match err {
        TlsError::InvalidCertificate(CertificateError::Other(OtherError(inner))) => {
            inner.downcast_ref::<DistrustedKey>().is_some()
                || inner.downcast_ref::<DistrustedIssuer>().is_some()
        }
        TlsError::PeerIncompatible(_)
        | TlsError::AlertReceived(A::ProtocolVersion | A::HandshakeFailure | A::InsufficientSecurity) => true,
        _ => false,
    }
}

/// The TLS failure behind a request error, as one sentence a developer can act
/// on, or `None` when the failure was not TLS.
pub fn tls_failure(err: &(dyn std::error::Error + 'static)) -> Option<String> {
    find_tls_error(err).map(explain)
}

/// Whether a request failed for a TLS reason no retry can fix (see
/// [`is_permanent`]); the provider retry layer treats these as non-transient.
pub fn is_permanent_tls_failure(err: &(dyn std::error::Error + 'static)) -> bool {
    find_tls_error(err).is_some_and(is_permanent)
}

fn explain(err: &TlsError) -> String {
    match err {
        TlsError::InvalidCertificate(CertificateError::Other(OtherError(inner))) if is_permanent(err) => {
            inner.to_string()
        }
        _ if is_permanent(err) => format!(
            "TLS handshake failed ({err}). Octopush requires TLS 1.2 or newer with modern cipher suites (ECDHE with AES-GCM or ChaCha20); this server, or a proxy in front of it, offers only older ones"
        ),
        _ => format!("TLS error: {err}"),
    }
}

/// `reqwest`'s own `Display` stops at "error sending request for url (…)";
/// this appends the TLS reason when there is one. Use it wherever a request
/// error reaches the user.
pub fn describe_request_error(err: &reqwest::Error) -> String {
    match tls_failure(err) {
        Some(why) => format!("{err}: {why}"),
        None => err.to_string(),
    }
}

// ─── reqwest glue ─────────────────────────────────────────────────────────

/// Built once per process. `None` means the platform verifier could not start;
/// the warning is logged exactly once.
fn shared_config() -> Option<ClientConfig> {
    static CONFIG: OnceLock<Option<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| match rustls_client_config() {
            Ok(cfg) => Some(cfg),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "tls: platform verifier unavailable; outbound HTTPS falls back to the OS TLS stack without the eMudhra key denylist"
                );
                None
            }
        })
        .clone()
}

/// The builder every Octopush HTTP client starts from. Chain `timeout`,
/// `user_agent`, … and `build()` exactly as with `reqwest::Client::builder()`.
pub fn client_builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    match shared_config() {
        // reqwest 0.13 downcasts this to `rustls::ClientConfig`; the rustls
        // crate must be the same version reqwest links (a mismatch builds an
        // "unknown preconfigured TLS" error, caught by `client()` / tests).
        Some(cfg) => builder.tls_backend_preconfigured(cfg),
        None => builder,
    }
}

/// A ready client with default options, for call sites that used
/// `reqwest::Client::new()`. Like `Client::new()` it never fails: should the
/// build error (reqwest documents this as "the TLS backend cannot be
/// initialised"), it falls back to reqwest's own default client.
pub fn client() -> reqwest::Client {
    client_builder().build().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "tls: could not build the hardened HTTP client; using reqwest's default");
        reqwest::Client::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    // Three self-signed certificates generated with `openssl req -x509`; the
    // expected values come from `openssl x509 -pubkey | openssl pkey -pubin
    // -outform DER | sha256sum`.

    /// EC P-256, v3 (has the `[0] version` field and extensions). SPKI = 91 bytes.
    const EC_V3: &str = "\
3082018b30820131a00302010202142a779b4aa601e2de18f318015c3fca9df3969732300a06082a8648ce3d04030230\
1b3119301706035504030c106f63746f707573682d746573742d6563301e170d3236313032313233323032335a170d32\
36313132303233323032335a301b3119301706035504030c106f63746f707573682d746573742d65633059301306072a\
8648ce3d020106082a8648ce3d030107034200049d25990a94525fb6f72d485bf4b167275d0371b45f5b133bb9786213\
005dd84bc9ed712197ca7265e825f8955ba50c3c5847c6b813b4382d805a5963975107a5a3533051301d0603551d0e04\
1604145e830c69c0dd00d348cb88e28a702808c4332e12301f0603551d230418301680145e830c69c0dd00d348cb88e2\
8a702808c4332e12300f0603551d130101ff040530030101ff300a06082a8648ce3d040302034800304502207392c0d1\
ec85df4a9d0c18fd4c55402a3b258462873a1231d8892b1908f52ae0022100cf66adc33b8cc4bb9943e394dafee728ae\
09069c1351a0deead5b481a2ed5704";
    const EC_SPKI_SHA256: &str = "ebdc24ae81942ef0f80dea02e3f97c8a6039bf08c16fb657850907880a779a46";

    /// Same EC key, but a v1 certificate: no version field, no extensions.
    const EC_V1: &str = "\
308201303081d702144bfe27e9a2b06ba0b605f937fafb7372188d4f44300a06082a8648ce3d040302301b3119301706\
035504030c106f63746f707573682d746573742d7631301e170d3236313032313233323032335a170d32363131323032\
33323032335a301b3119301706035504030c106f63746f707573682d746573742d76313059301306072a8648ce3d0201\
06082a8648ce3d030107034200049d25990a94525fb6f72d485bf4b167275d0371b45f5b133bb9786213005dd84bc9ed\
712197ca7265e825f8955ba50c3c5847c6b813b4382d805a5963975107a5300a06082a8648ce3d040302034800304502\
2048d9f2638092409a8a867f8bc7fbc504c8c93bfd7b8818389e5a7db0eeee60b3022100b7b992de037e087561c62294\
eb05d750dc95006ac31d071df737a0fb064a8740";

    /// RSA-2048, v3. SPKI = 294 bytes.
    const RSA_V3: &str = "\
3082031930820201a003020102021411b2bcd3675913a4a98d4403f35309c5e362c789300d06092a864886f70d01010b\
0500301c311a301806035504030c116f63746f707573682d746573742d727361301e170d323631303231323332303233\
5a170d3236313132303233323032335a301c311a301806035504030c116f63746f707573682d746573742d7273613082\
0122300d06092a864886f70d01010105000382010f003082010a0282010100ba5a99e3646c1a7bce9e3e9b02c500e724\
5ac645efbd980a9f27a95c57febadc7bce71542661f473af3a5d77ca5a6c8df0630fa540471c4ec75620795c6a7ffa1b\
bc9503f088beca4ac0bab6122af4d5ff1575c96e24db2748bbb7ed095a7a21a211904fd593d97740115cc87a3119cfde\
9ae184e7eb39c2b7208a97960b3c20cea12afeaec256c354667a66c38a6e8dc5d9be62f20b4b897f4c1fdee58b25ad03\
31b55520234d2877cda70345062333019549ff963ca0191e514b3ecef8f439625519648faf0aca5a012dd9ed132fa895\
4473c6167c79a359e54225887f5b53f8f29b226fbbafea4d79739776dd8ec1686299a348511b5cf31fa73661b0f18702\
03010001a3533051301d0603551d0e041604141247909981c167c0c461aaf134b8d0d8b92ab964301f0603551d230418\
301680141247909981c167c0c461aaf134b8d0d8b92ab964300f0603551d130101ff040530030101ff300d06092a8648\
86f70d01010b050003820101007d5904fe69a3a31a4e3bb10ac9a72ed6c23459f41ef9b1e2519c4c7fe348a90501709c\
4fcb1e9f1e440294edd174e477fa03123775c265a29be7a240d0a9fc0830488f814e3bab7508b37b33f7b0d306b80b5a\
2f7b8a52c6628e4f416f6d4f2e83904d1ab72277609de5d258600ffb8a4712fb99dd310d7734f009e8f4db8c3dd400e4\
4fa6ccd8d0218376fefdac3ff8ec3eada8b8c494acceb2ed9e001021238dbc3a85c3cfd2b4c153249b4dd8cb28a2dc42\
350f20390db3e33210e3846b4c4bbe48b2b6c37123126f42a88fd40227d98f97f9b2b5d888266a893439240b013c86ca\
fc57f0acf12ceb666d9665a6f1fa9f1d3c5e2454b8d0837fe4fd95e9a7";
    const RSA_SPKI_SHA256: &str = "7cf26b7ec7e9dc7932503ba447bc97c948c221b0c2111140ebad3c44d1466bfa";

    /// EC P-256 leaf for `forged.example`, signed by a throwaway key whose CA
    /// certificate carries the exact subject of `EM DV TLS CA - G3B`
    /// (`openssl req -subj "/C=NL/O=eMudhra BV/CN=EM DV TLS CA - G3B"`): what an
    /// attacker holding the real key would send, minus the intermediate.
    const LEAF_UNDER_DV_G3B: &str = "\
308201b93082015fa0030201020208056ceee85f720eb7300a06082a8648ce3d040302303f310b300906035504061302\
4e4c31133011060355040a0c0a654d7564687261204256311b301906035504030c12454d20445620544c53204341202d\
20473342301e170d3236313033313230353334355a170d3236313133303230353334355a30193117301506035504030c\
0e666f726765642e6578616d706c653059301306072a8648ce3d020106082a8648ce3d030107034200049c08d1811cd1\
ee2ec7f43cca61561bfe4052ad44dc9649ebd122e56a92c022734b63f6f2ecdb7c9e09f48a91a50d394ef843368de031\
cf3b1179ee5dba978e3ea36b3069300c0603551d130101ff0402300030190603551d1104123010820e666f726765642e\
6578616d706c65301d0603551d0e0416041407a9cb5d2abdd03d2905edd0d68c8f6681b7c188301f0603551d23041830\
1680144c030ce3036080e90d8c5907d6b10e63398b3415300a06082a8648ce3d040302034800304502207834d5e1821e\
641a5256b557d960e9997dbb6d4b90d11ed0872fd648f3862b78022100e61e49befd6064b27377d28b38ac542ce22699\
55888f967b85afc2c9a60c3c32";

    /// Same forged leaf, but its issuer is `EM DV TLS CA - G3B` re-encoded as
    /// PrintableString and lower-cased (`C=NL, O=emudhra bv, CN=em dv tls ca -
    /// g3b`, `openssl req` with `string_mask=default`): different bytes, a name
    /// macOS would still chain to the real intermediate.
    const LEAF_UNDER_REENCODED_DV_G3B: &str = "\
30820200308201a7a0030201020209008609a696e02e6c03300a06082a8648ce3d040302303f310b3009060355040613\
024e4c31133011060355040a130a656d7564687261206276311b301906035504031312656d20647620746c7320636120\
2d20673362301e170d3236313033313231303835375a170d3236313133303231303835375a3019311730150603550403\
0c0e666f726765642e6578616d706c653059301306072a8648ce3d020106082a8648ce3d030107034200040de0313561\
d5f92615d07aea3cad8c3acbde4f9da6e0daef114453965aacb1b93126d14d6731c2b6dc3b1d95a2c87c15b58f2f2718\
16421812f2739d8c80fb40a381b13081ae300c0603551d130101ff0402300030190603551d1104123010820e666f7267\
65642e6578616d706c65301d0603551d0e04160414b15f175fa02dcaccc10de335ab71a6cd112b910c30640603551d23\
045d305ba143a441303f310b3009060355040613024e4c31133011060355040a130a656d7564687261206276311b3019\
06035504031312656d20647620746c73206361202d2067336282142991c65b2c96cdfab7ef630479e76b47557131ec30\
0a06082a8648ce3d040302034700304402201c96a84f52b3cacee9d0926abcbecfb33becdaae93b3b6fb1696640ea19d\
7d360220330f6c96a6c938fe40b15648cfa1fc5f835081bc66d3fe7261a6b0413e251082";

    /// Same leaf, issued under the near-miss name `EM DV TLS CA - G3D`.
    const LEAF_UNDER_LOOKALIKE: &str = "\
308201b93082015fa0030201020208282d6ba072aafc35300a06082a8648ce3d040302303f310b300906035504061302\
4e4c31133011060355040a0c0a654d7564687261204256311b301906035504030c12454d20445620544c53204341202d\
20473344301e170d3236313033313230353334355a170d3236313133303230353334355a30193117301506035504030c\
0e666f726765642e6578616d706c653059301306072a8648ce3d020106082a8648ce3d030107034200049c08d1811cd1\
ee2ec7f43cca61561bfe4052ad44dc9649ebd122e56a92c022734b63f6f2ecdb7c9e09f48a91a50d394ef843368de031\
cf3b1179ee5dba978e3ea36b3069300c0603551d130101ff0402300030190603551d1104123010820e666f726765642e\
6578616d706c65301d0603551d0e0416041407a9cb5d2abdd03d2905edd0d68c8f6681b7c188301f0603551d23041830\
1680144c030ce3036080e90d8c5907d6b10e63398b3415300a06082a8648ce3d0403020348003045022100d0b37195f2\
c247eaebe3d4d78c71e133a51c8e9bb83ce12ebdc924ed589e00bb02204e69b100d475bd34aee1f54d49cfe3b131d5cb\
1d1171ada8887a298f89736336";

    #[test]
    fn spki_of_a_v3_ec_certificate_matches_openssl() {
        let cert = unhex(EC_V3);
        assert_eq!(subject_public_key_info(&cert).unwrap().len(), 91);
        assert_eq!(spki_sha256(&cert).unwrap().to_vec(), unhex(EC_SPKI_SHA256));
    }

    #[test]
    fn spki_of_a_v3_rsa_certificate_matches_openssl() {
        let cert = unhex(RSA_V3);
        assert_eq!(subject_public_key_info(&cert).unwrap().len(), 294);
        assert_eq!(spki_sha256(&cert).unwrap().to_vec(), unhex(RSA_SPKI_SHA256));
    }

    #[test]
    fn a_v1_certificate_without_the_version_field_parses_to_the_same_key() {
        let cert = unhex(EC_V1);
        assert_eq!(subject_public_key_info(&cert).unwrap().len(), 91);
        assert_eq!(spki_sha256(&cert).unwrap().to_vec(), unhex(EC_SPKI_SHA256));
    }

    #[test]
    fn malformed_input_is_none_not_a_panic() {
        let cert = unhex(EC_V3);
        assert!(subject_public_key_info(&[]).is_none());
        assert!(subject_public_key_info(b"not a certificate").is_none());
        assert!(subject_public_key_info(&cert[..cert.len() - 10]).is_none());
        assert!(subject_public_key_info(&cert[..5]).is_none());
        // Indefinite (BER) length is not DER.
        assert!(subject_public_key_info(&[0x30, 0x80, 0x00, 0x00]).is_none());
        // An absurd length prefix must not allocate or overflow.
        assert!(subject_public_key_info(&[0x30, 0x84, 0xff, 0xff, 0xff, 0xff]).is_none());
    }

    #[test]
    fn the_denylist_is_the_eight_go_hashes() {
        // Verbatim from Go's `crypto/x509` (`distrustedSPKIHashes`), so the
        // compile-time hex decoding is checked against the source strings.
        const GO: [&str; 8] = [
            "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105",
            "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f",
            "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41",
            "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0",
            "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b",
            "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8",
            "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6",
            "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30",
        ];
        for (i, expected) in GO.iter().enumerate() {
            assert_eq!(DISTRUSTED_SPKI_SHA256[i].to_vec(), unhex(expected), "entry {i}");
        }
        let distinct: std::collections::HashSet<_> = DISTRUSTED_SPKI_SHA256.iter().collect();
        assert_eq!(distinct.len(), 8);
        // Sanity: the fixtures are ordinary keys.
        for cert in [EC_V3, EC_V1, RSA_V3] {
            assert!(!DISTRUSTED_SPKI_SHA256.contains(&spki_sha256(&unhex(cert)).unwrap()));
        }
    }

    /// An inner verifier that accepts everything, so the tests exercise only
    /// the denylist layer in front of it.
    #[derive(Debug)]
    struct Permissive;

    impl ServerCertVerifier for Permissive {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, TlsError> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, TlsError> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, TlsError> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![SignatureScheme::ECDSA_NISTP256_SHA256]
        }
    }

    /// A denylist naming the EC fixture's key, standing in for a compromised key.
    static EC_KEY_ONLY: [[u8; 32]; 1] =
        [hex32("ebdc24ae81942ef0f80dea02e3f97c8a6039bf08c16fb657850907880a779a46")];

    fn verify(
        verifier: &DenylistVerifier,
        leaf: &str,
        intermediates: &[&str],
    ) -> Result<ServerCertVerified, TlsError> {
        let leaf = CertificateDer::from(unhex(leaf));
        let intermediates: Vec<CertificateDer<'static>> =
            intermediates.iter().map(|c| CertificateDer::from(unhex(c))).collect();
        let name = ServerName::try_from("example.com").unwrap();
        verifier.verify_server_cert(&leaf, &intermediates, &name, &[], UnixTime::now())
    }

    #[test]
    fn a_clean_chain_reaches_the_inner_verifier() {
        let v = DenylistVerifier::with_denylists(Arc::new(Permissive), &EC_KEY_ONLY, &[]);
        assert!(verify(&v, RSA_V3, &[]).is_ok());
        assert!(verify(&v, RSA_V3, &[RSA_V3]).is_ok());
        // The production list never matches an ordinary key either.
        let prod = DenylistVerifier::new(Arc::new(Permissive));
        assert!(verify(&prod, EC_V3, &[RSA_V3]).is_ok());
    }

    #[test]
    fn a_denylisted_leaf_is_rejected() {
        let v = DenylistVerifier::with_denylists(Arc::new(Permissive), &EC_KEY_ONLY, &[]);
        let err = verify(&v, EC_V3, &[]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("compromised eMudhra intermediate CA key"), "{msg}");
        assert!(msg.contains(&EC_SPKI_SHA256[..16]), "{msg}");
    }

    #[test]
    fn a_denylisted_intermediate_is_rejected_whatever_the_leaf() {
        let v = DenylistVerifier::with_denylists(Arc::new(Permissive), &EC_KEY_ONLY, &[]);
        assert!(verify(&v, RSA_V3, &[EC_V3]).is_err());
        assert!(verify(&v, RSA_V3, &[RSA_V3, EC_V1]).is_err());
    }

    #[test]
    fn the_subject_denylist_has_the_eight_names_in_der() {
        assert_eq!(DISTRUSTED_CA_SUBJECTS.len(), 8);
        let distinct: std::collections::HashSet<_> =
            DISTRUSTED_CA_SUBJECTS.iter().map(|ca| ca.subject_der).collect();
        assert_eq!(distinct.len(), 8);
        for ca in &DISTRUSTED_CA_SUBJECTS {
            // Each entry is one well-formed DER SEQUENCE and carries its CN.
            let (_, whole) = Der::new(ca.subject_der).expect(TAG_SEQUENCE).expect(ca.name);
            assert_eq!(whole.len(), ca.subject_der.len(), "{}", ca.name);
            assert!(ca.subject_der.windows(ca.name.len()).any(|w| w == ca.name.as_bytes()), "{}", ca.name);
        }
    }

    #[test]
    fn the_fixture_issuer_is_byte_for_byte_a_denylisted_name() {
        let leaf = unhex(LEAF_UNDER_DV_G3B);
        assert_eq!(issuer_name(&leaf).unwrap(), DISTRUSTED_CA_SUBJECTS[0].subject_der);
        assert_ne!(issuer_name(&unhex(LEAF_UNDER_LOOKALIKE)).unwrap(), DISTRUSTED_CA_SUBJECTS[0].subject_der);
    }

    #[test]
    fn a_leaf_issued_under_a_denylisted_name_is_refused_without_its_intermediate() {
        // Only the leaf is presented: the key denylist sees nothing, the issuer
        // name gives it away.
        let v = DenylistVerifier::new(Arc::new(Permissive));
        let err = verify(&v, LEAF_UNDER_DV_G3B, &[]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("issued by the compromised eMudhra intermediate CA"), "{msg}");
        assert!(msg.contains("EM DV TLS CA - G3B"), "{msg}");
        // Same when the server sends an unrelated certificate alongside it.
        assert!(verify(&v, RSA_V3, &[LEAF_UNDER_DV_G3B]).is_err());
    }

    #[test]
    fn a_reencoded_or_case_changed_denylisted_issuer_is_refused() {
        let leaf = unhex(LEAF_UNDER_REENCODED_DV_G3B);
        let issuer = issuer_name(&leaf).unwrap();
        assert_ne!(issuer, DISTRUSTED_CA_SUBJECTS[0].subject_der, "the fixture must differ in bytes");
        assert_eq!(normalized_name(issuer), normalized_name(DISTRUSTED_CA_SUBJECTS[0].subject_der));
        let v = DenylistVerifier::new(Arc::new(Permissive));
        let msg = verify(&v, LEAF_UNDER_REENCODED_DV_G3B, &[]).unwrap_err().to_string();
        assert!(msg.contains("EM DV TLS CA - G3B"), "{msg}");
    }

    #[test]
    fn name_normalization_folds_case_whitespace_and_string_type() {
        assert_eq!(normalize_value(0x0c, "EM DV  TLS CA - G3B ".as_bytes()), "em dv tls ca - g3b");
        assert_eq!(normalize_value(0x13, b"em dv tls ca - g3b"), "em dv tls ca - g3b");
        let bmp: Vec<u8> = "EM".encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        assert_eq!(normalize_value(0x1e, &bmp), "em");
        // Non-string values are compared raw, never folded.
        assert_eq!(normalize_value(0x04, &[0xAB]), "04:ab");
        // The near-miss name stays different after normalization.
        let near = unhex(LEAF_UNDER_LOOKALIKE);
        assert_ne!(
            normalized_name(issuer_name(&near).unwrap()),
            normalized_name(DISTRUSTED_CA_SUBJECTS[0].subject_der)
        );
        assert!(normalized_name(b"garbage").is_none());
    }

    #[test]
    fn the_built_chain_check_tolerates_only_an_unparseable_anchor() {
        let v = DenylistVerifier::new(Arc::new(Permissive));
        let leaf = unhex(RSA_V3);
        let quirky_root = b"not DER the minimal walk understands".to_vec();
        // Anchor last: skipped.
        assert!(v.check_built_chain(&[leaf.clone(), quirky_root.clone()]).is_ok());
        // Anywhere else, or as the only certificate: fails closed.
        assert!(v.check_built_chain(&[quirky_root.clone(), leaf.clone()]).is_err());
        assert!(v.check_built_chain(&[quirky_root]).is_err());
        assert!(v.check_built_chain(&[]).is_err());
        // A denylisted issuer in the built chain is still refused.
        assert!(v.check_built_chain(&[unhex(LEAF_UNDER_DV_G3B), leaf]).is_err());
    }

    /// A real public chain: `letsencrypt.org` (EC leaf) and its intermediate
    /// `Let's Encrypt E6`, anchored in ISRG Root X1 in the macOS system store.
    /// Captured 2025-08-13 by rustls-platform-verifier 0.6.2
    /// (`src/tests/verification_real_world/letsencrypt_org_valid_{1,2}.crt`,
    /// SHA-256 8589023b…ab43 and 76e9e288…ab85), which runs the same success
    /// case on macOS CI with the same verification time.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    const LETSENCRYPT_ORG_LEAF: &str = "\
308203de30820364a0030201020212062c2f9447974e6eebd163f15bc14f492887300a06082a8648ce3d040303303231\
0b300906035504061302555331163014060355040a130d4c6574277320456e6372797074310b30090603550403130245\
36301e170d3235303830343131323430345a170d3235313130323131323430335a301a311830160603550403130f6c65\
7473656e63727970742e6f72673059301306072a8648ce3d020106082a8648ce3d0301070342000478b408de11de66c2\
2fc9354e6b75a0dcb577ba5e1d3f0a77dc166b8fa4ebdb76fdb1977331a587eb6878e8f35030dd1ff3f36418d4a87a03\
22fa7686dc4967dea38202703082026c300e0603551d0f0101ff040403020780301d0603551d250416301406082b0601\
050507030106082b06010505070302300c0603551d130101ff04023000301d0603551d0e04160414bc89fab9832a1cfc\
e35e5fdfa3aabada1b8c71ad301f0603551d230418301680149327469803a951688e98d6c44248db23bf5894d2303206\
082b0601050507010104263024302206082b060105050730028616687474703a2f2f65362e692e6c656e63722e6f7267\
2f306f0603551d110468306682096c656e63722e6f7267820f6c657473656e63727970742e636f6d820f6c657473656e\
63727970742e6f7267820d7777772e6c656e63722e6f726782137777772e6c657473656e63727970742e636f6d821377\
77772e6c657473656e63727970742e6f726730130603551d20040c300a3008060667810c010201302c0603551d1f0425\
30233021a01fa01d861b687474703a2f2f65362e632e6c656e63722e6f72672f382e63726c30820103060a2b06010401\
d6790204020481f40481f100ef007500ed3c4bd6e806c2a4a20057dbcb24e23801df512fedc486c5700f20ddb73e3fe0\
000001987508995800000403004630440220538edb08e32fbcf3fc2ced0ad43cc5b262888f9c98b923b580814cc3d8e2\
effe02202ae9cd901c8debe5af651bb78e7dac5a8243abbeb6e0a90cb8074f4fd6923219007600dddcca3495d7e11605\
e79532fac79ff83d1c50dfdb003a1412760a2cacbbc82a000001987508997c0000040300473045022100ab40271c3bc6\
e961415c40d77c01fe5fdab844c0baa4905411f0b90494ca8be40220158d22d924979f3044ea477f4736eb7b20ea1c28\
0de88ce37c2da556f618cb67300a06082a8648ce3d0403030368003065023100c5e61827963f7bc9dd90e758fff305db\
47830a37d5a758623f1cb477c42f514976d80b22579963c0167d660ab1b07d9e0230078ae30393305944fc02119fbf65\
8e77e4f9197f21d4b71ff44190fd43287874ae285b47d4d5fcf4be5cf32d31d27be9";
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    const LETSENCRYPT_E6: &str = "\
308204573082023fa003020102021100b0573e9173972770dbb487cb3a452b38300d06092a864886f70d01010b050030\
4f310b300906035504061302555331293027060355040a1320496e7465726e6574205365637572697479205265736561\
7263682047726f7570311530130603550403130c4953524720526f6f74205831301e170d323430333133303030303030\
5a170d3237303331323233353935395a3032310b300906035504061302555331163014060355040a130d4c6574277320\
456e6372797074310b30090603550403130245363076301006072a8648ce3d020106052b8104002203620004d9f19e46\
87f8217160a826eba3fab9eada1db912a7d426d95114b1617c7596bf220b391fd5bed10a46aa2d3c4a09842ebe409555\
e91940376675ed324e770449f8707bc318e7cef77110feac74d800d4ed6d1c731633109c3ab2ea6c62f4bdb8a381f830\
81f5300e0603551d0f0101ff040403020186301d0603551d250416301406082b0601050507030206082b060105050703\
0130120603551d130101ff040830060101ff020100301d0603551d0e041604149327469803a951688e98d6c44248db23\
bf5894d2301f0603551d2304183016801479b459e67bb6e5e40173800888c81a58f6e99b6e303206082b060105050701\
0104263024302206082b060105050730028616687474703a2f2f78312e692e6c656e63722e6f72672f30130603551d20\
040c300a3008060667810c01020130270603551d1f0420301e301ca01aa0188616687474703a2f2f78312e632e6c656e\
63722e6f72672f300d06092a864886f70d01010b050003820201007d8b7b4a2035b20586088a6e9e4e3aaf8004c4845c\
33190a81484d96baefd41db584e69737fe66884f8b3936eb72653f33dcaf0ba31563bdf418d1682fc22127c8fcbeb38b\
a4c636d8e3fa6da4b593d60caed0d3970247a066f2d384e14d47810e4b12f518ae1ef89c66a05e75074817ae6966e869\
78370605c2e261ab10aff10ee60c71b4bc939a0b0748e55205c14e9fd960bfb2c408fabd8bb99f1f79a9c60ad1292c47\
a4ea19d0a5cc701fa11eebe59251e7b6f708d2630c4349a1623eaab4c152b64175469086dc83dd230a55090aaef0657b\
b3cb9b927473b3edc2fc19b5f5114ea223e90e4c2fc8d7ef990d785e4caaa8a2b9a19f33843df69054509316bcb994ae\
878693226171927bb7f70681c484571388cac6502641ce108c5668ab52a642a420d09ff5245f11945bc96acd557232ef\
625bd4076b7a9e93baa108c1de5f8f35fd03a501fb894c775b3e408d00a2e8bdb9163c84d3aaba059fd0966b58765ffc\
6586a8e1246a3c4b3fe9c02217e41fe73836524696b43a619752ca32e4cd2e8b6fb17f7d1cfebd5767da3727a0a1d434\
2f24c0a6bfef4f4d583c4e3abcdb032e02bee1c2fa4ebcc2fdae1672617949127ddfccebbff76e2472d740892ee6fd3e\
1303b2e7d1dd9b43d3fc4afff387435740928dd47fd97b99337929cac48a2e00f570a88303e21182e3830b17cef5cc98\
220e3abfd985981bf21f4e";

    /// Guards the success path of `evaluate_on_macos`: a broken verify date,
    /// policy or chain extraction would otherwise reject every connection on
    /// macOS while the failure-path tests stayed green.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_accepts_a_real_public_chain_and_returns_the_built_chain() {
        use std::time::Duration;
        // Wed, 13 August 2025 19:31:46 UTC: inside both certificates' validity.
        let now = UnixTime::since_unix_epoch(Duration::from_secs(1_755_113_506));
        let leaf = CertificateDer::from(unhex(LETSENCRYPT_ORG_LEAF));
        let intermediates = [CertificateDer::from(unhex(LETSENCRYPT_E6))];
        let name = ServerName::try_from("letsencrypt.org").unwrap();

        let built = evaluate_on_macos(&leaf, &intermediates, &name, &[], now).expect("SecTrust accepts");
        assert!(built.len() >= 3, "leaf, intermediate and anchor, got {}", built.len());
        assert_eq!(built[0], leaf.as_ref());
        assert_eq!(built[1], intermediates[0].as_ref());

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let v = DenylistVerifier::platform(rustls_platform_verifier::Verifier::new(provider).unwrap());
        v.verify_server_cert(&leaf, &intermediates, &name, &[], now).expect("production verifier accepts");
        // And the hostname is enforced on the same chain.
        let other = ServerName::try_from("example.com").unwrap();
        assert_eq!(
            v.verify_server_cert(&leaf, &intermediates, &other, &[], now).unwrap_err(),
            TlsError::InvalidCertificate(CertificateError::NotValidForName)
        );
    }

    /// macOS only: the production verifier evaluates with `SecTrust` itself and
    /// a chain the OS cannot build to a trusted anchor is rejected (fail closed),
    /// not waved through on the strength of a partial chain.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_rejects_a_chain_sectrust_cannot_build() {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let platform = rustls_platform_verifier::Verifier::new(provider).unwrap();
        let v = DenylistVerifier::platform(platform);
        assert!(v.os_eval);
        assert!(verify(&v, LEAF_UNDER_LOOKALIKE, &[]).is_err());
        assert!(verify(&v, RSA_V3, &[]).is_err());
    }

    #[test]
    fn an_unrelated_issuer_passes() {
        let v = DenylistVerifier::new(Arc::new(Permissive));
        assert!(verify(&v, LEAF_UNDER_LOOKALIKE, &[]).is_ok());
        assert!(verify(&v, EC_V3, &[RSA_V3]).is_ok());
    }

    #[test]
    fn tls_failures_are_explained_through_io_errors() {
        let v = DenylistVerifier::new(Arc::new(Permissive));
        let refused = verify(&v, LEAF_UNDER_DV_G3B, &[]).unwrap_err();
        // hyper hands rustls errors up wrapped in `io::Error`.
        let wrapped = std::io::Error::new(std::io::ErrorKind::InvalidData, refused);
        let why = tls_failure(&wrapped).unwrap();
        assert!(why.starts_with("the server's certificate chain was issued by"), "{why}");

        let old = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            TlsError::AlertReceived(rustls::AlertDescription::ProtocolVersion),
        );
        let why = tls_failure(&old).unwrap();
        assert!(why.contains("requires TLS 1.2 or newer"), "{why}");

        let plain = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        assert!(tls_failure(&plain).is_none());

        // Retry classification: denylist and incompatibility are permanent,
        // everything else (incl. ordinary certificate errors) is left alone.
        assert!(is_permanent_tls_failure(&wrapped));
        assert!(is_permanent_tls_failure(&old));
        assert!(!is_permanent_tls_failure(&plain));
        let expired = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            TlsError::InvalidCertificate(CertificateError::Expired),
        );
        assert!(!is_permanent_tls_failure(&expired));
    }

    #[test]
    fn an_unparseable_certificate_fails_closed() {
        let v = DenylistVerifier::with_denylists(Arc::new(Permissive), &EC_KEY_ONLY, &[]);
        let leaf = CertificateDer::from(b"garbage".to_vec());
        let name = ServerName::try_from("example.com").unwrap();
        let err = v
            .verify_server_cert(&leaf, &[], &name, &[], UnixTime::now())
            .unwrap_err();
        assert_eq!(
            err,
            TlsError::InvalidCertificate(CertificateError::BadEncoding)
        );
    }

    #[test]
    fn reqwest_accepts_the_preconfigured_rustls_config() {
        // Guards the `Any` downcast in `tls_backend_preconfigured`: a rustls
        // version skew against reqwest would make `build()` fail here.
        assert!(shared_config().is_some(), "platform verifier");
        client_builder().build().expect("hardened client builds");
    }

    #[test]
    fn the_platform_backed_config_builds() {
        // Needs an OS trust store, which every supported platform has.
        let config = rustls_client_config().expect("platform verifier");
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }
}
