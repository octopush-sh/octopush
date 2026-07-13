use std::path::{Path, PathBuf};

fn main() {
    // Tauri's externalBin validates that a triple-suffixed copy of each sidecar
    // binary exists at a path relative to CARGO_MANIFEST_DIR (the src-tauri/
    // folder). We copy `target/<profile>/<bin>` →
    //   `<manifest-dir>/<bin>-<target-triple>`
    // so the bundler can find it during `tauri build`.
    //
    // Path computation for OUT_DIR:
    //   OUT_DIR = .../target/<profile>/build/<pkg>-<hash>/out
    //   ancestors():
    //     nth(0) = .../target/<profile>/build/<pkg>-<hash>/out  (the dir itself)
    //     nth(1) = .../target/<profile>/build/<pkg>-<hash>
    //     nth(2) = .../target/<profile>/build
    //     nth(3) = .../target/<profile>        ← this is what we want

    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());

    if !target_triple.is_empty() && manifest_dir.exists() {
        // Every binary listed in tauri.conf.json's `externalBin` must be staged.
        for bin in ["octopush-pty-server", "octopush-mcp", "octopush-run-worker"] {
            stage_external_bin(bin, &target_triple, &manifest_dir, &out_dir);
        }
    }

    tauri_build::build();
}

/// Copy `target/<profile>/<bin>` to `<manifest>/<bin>-<triple>` so Tauri's
/// bundler picks it up. If the binary isn't built yet, drop an empty placeholder
/// so `tauri-build`'s externalBin validation passes — the real binary overwrites
/// it during `tauri build` (the build scripts compile each sidecar first).
fn stage_external_bin(bin: &str, target_triple: &str, manifest_dir: &Path, out_dir: &Path) {
    let dst = manifest_dir.join(format!("{bin}-{target_triple}"));

    // The compiled sidecar lives at target/<profile>/<bin>. Watch that path
    // unconditionally so that the FIRST time the binary is actually built (it
    // doesn't exist yet when this script runs in a clean tree), cargo re-runs
    // this script and we overwrite the empty placeholder with the real binary.
    // Without this, a 0-byte placeholder can survive into the bundle.
    let src = out_dir.ancestors().nth(3).map(|p| p.join(bin));
    if let Some(src) = &src {
        println!("cargo:rerun-if-changed={}", src.display());
    }

    let src_opt = src.filter(|p| p.exists() && p.metadata().map(|m| m.len() > 0).unwrap_or(false));

    if let Some(src) = src_opt {
        if let Err(e) = std::fs::copy(&src, &dst) {
            println!(
                "cargo:warning=build.rs: could not copy {} → {}: {e}",
                src.display(),
                dst.display()
            );
        }
    } else if !dst.exists() {
        if let Err(e) = std::fs::write(&dst, b"") {
            println!(
                "cargo:warning=build.rs: could not create placeholder {}: {e}",
                dst.display()
            );
        } else {
            println!(
                "cargo:warning=build.rs: created placeholder {}; \
                 run `cargo build --bin {bin}` first",
                dst.display()
            );
        }
    }
    // If dst already exists but src is empty/missing, leave dst in place.
}
