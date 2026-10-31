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
//! [`DenylistVerifier`] that refuses any presented chain containing a
//! certificate whose SPKI hash is on [`DISTRUSTED_SPKI_SHA256`], before the
//! platform ever sees it. Keying on the key rather than the certificate
//! fingerprint means cross-signed copies of the same keys are rejected too. The
//! check covers the chain the server *presents*; a chain the platform completes
//! on its own (AIA fetching on macOS/Windows) is the platform's call, and there
//! the OS blocklists apply.
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
    let (cert, _) = Der::new(cert_der).expect(TAG_SEQUENCE)?;
    let (tbs, _) = Der::new(cert).expect(TAG_SEQUENCE)?;
    let mut tbs = Der::new(tbs);
    if tbs.peek_tag()? == TAG_VERSION {
        tbs.next()?;
    }
    tbs.expect(TAG_INTEGER)?; // serialNumber
    tbs.expect(TAG_SEQUENCE)?; // signature
    tbs.expect(TAG_SEQUENCE)?; // issuer
    tbs.expect(TAG_SEQUENCE)?; // validity
    tbs.expect(TAG_SEQUENCE)?; // subject
    let (_, spki) = tbs.expect(TAG_SEQUENCE)?; // subjectPublicKeyInfo
    Some(spki)
}

/// SHA-256 of a certificate's SPKI, or `None` when it cannot be parsed.
pub fn spki_sha256(cert_der: &[u8]) -> Option<[u8; 32]> {
    subject_public_key_info(cert_der).map(|spki| Sha256::digest(spki).into())
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

/// Wraps any `ServerCertVerifier` (in production, the OS platform verifier) and
/// rejects a presented chain outright when any certificate in it — leaf or
/// intermediate — has an SPKI hash on the denylist.
#[derive(Debug)]
pub struct DenylistVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    denylist: &'static [[u8; 32]],
}

impl DenylistVerifier {
    /// Wrap `inner` with the production denylist, [`DISTRUSTED_SPKI_SHA256`].
    pub fn new(inner: Arc<dyn ServerCertVerifier>) -> Self {
        Self::with_denylist(inner, &DISTRUSTED_SPKI_SHA256)
    }

    /// Wrap `inner` with an explicit denylist (tests).
    pub fn with_denylist(inner: Arc<dyn ServerCertVerifier>, denylist: &'static [[u8; 32]]) -> Self {
        Self { inner, denylist }
    }

    /// `Ok(())` when no certificate in `chain` carries a denylisted key. A
    /// certificate we cannot parse fails closed as `BadEncoding` — the platform
    /// would reject it too, and a check that can be skipped by malforming the
    /// input is no check.
    fn check_chain<'a>(&self, chain: impl Iterator<Item = &'a [u8]>) -> Result<(), TlsError> {
        for der in chain {
            match spki_sha256(der) {
                None => return Err(TlsError::InvalidCertificate(CertificateError::BadEncoding)),
                Some(hash) if self.denylist.contains(&hash) => {
                    return Err(TlsError::InvalidCertificate(CertificateError::Other(OtherError(
                        Arc::new(DistrustedKey { spki_sha256: hash }),
                    ))));
                }
                Some(_) => {}
            }
        }
        Ok(())
    }
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
    let verifier = DenylistVerifier::new(Arc::new(platform));
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
        let v = DenylistVerifier::with_denylist(Arc::new(Permissive), &EC_KEY_ONLY);
        assert!(verify(&v, RSA_V3, &[]).is_ok());
        assert!(verify(&v, RSA_V3, &[RSA_V3]).is_ok());
        // The production list never matches an ordinary key either.
        let prod = DenylistVerifier::new(Arc::new(Permissive));
        assert!(verify(&prod, EC_V3, &[RSA_V3]).is_ok());
    }

    #[test]
    fn a_denylisted_leaf_is_rejected() {
        let v = DenylistVerifier::with_denylist(Arc::new(Permissive), &EC_KEY_ONLY);
        let err = verify(&v, EC_V3, &[]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("compromised eMudhra intermediate CA key"), "{msg}");
        assert!(msg.contains(&EC_SPKI_SHA256[..16]), "{msg}");
    }

    #[test]
    fn a_denylisted_intermediate_is_rejected_whatever_the_leaf() {
        let v = DenylistVerifier::with_denylist(Arc::new(Permissive), &EC_KEY_ONLY);
        assert!(verify(&v, RSA_V3, &[EC_V3]).is_err());
        assert!(verify(&v, RSA_V3, &[RSA_V3, EC_V1]).is_err());
    }

    #[test]
    fn an_unparseable_certificate_fails_closed() {
        let v = DenylistVerifier::with_denylist(Arc::new(Permissive), &EC_KEY_ONLY);
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
