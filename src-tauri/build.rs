//! Build script invoking `tauri-build` to embed app metadata and capabilities.

use std::env;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=resources/pdfium.dll");
    println!("cargo:rerun-if-env-changed=PDFIUM_LIB_PATH");
    println!("cargo:rerun-if-env-changed=PDFIUM_DYNAMIC_LIB_PATH");

    let has_bundled = Path::new("resources/pdfium.dll").is_file();
    let has_env = env::var_os("PDFIUM_LIB_PATH").is_some()
        || env::var_os("PDFIUM_DYNAMIC_LIB_PATH").is_some();
    if !has_bundled && !has_env {
        println!(
            "cargo:warning=PDFium binary not found at src-tauri/resources/pdfium.dll; run `scripts/fetch-pdfium.ps1` before running tests or bundling."
        );
    }

    tauri_build::build();
}
