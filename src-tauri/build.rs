fn main() {
    // Expose the Rust target triple to lib.rs at compile time so the sidecar
    // spawn code can locate the per-platform PyInstaller binary.
    if let Ok(triple) = std::env::var("TARGET") {
        println!("cargo:rustc-env=PARAFORM_TARGET_TRIPLE={triple}");
    }
    tauri_build::build()
}
