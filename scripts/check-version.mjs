import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER_2_0_0_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJsonVersion(relativePath) {
  const fullPath = resolve(rootDir, relativePath);
  const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${relativePath} is missing a string "version" field`);
  }
  return parsed.version;
}

function readCargoPackageVersion(relativePath) {
  const fullPath = resolve(rootDir, relativePath);
  const raw = readFileSync(fullPath, "utf8");
  let inPackage = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    if (!inPackage) {
      continue;
    }
    const match = trimmed.match(/^version\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }

  throw new Error(`${relativePath} is missing [package] version`);
}

const entries = [
  ["package.json", readJsonVersion("package.json")],
  ["src-tauri/Cargo.toml", readCargoPackageVersion("src-tauri/Cargo.toml")],
  ["src-tauri/tauri.conf.json", readJsonVersion("src-tauri/tauri.conf.json")],
];

let failed = false;
for (const [file, version] of entries) {
  if (!SEMVER_2_0_0_RE.test(version)) {
    console.error(
      `Invalid SemVer 2.0.0 version in ${file}: "${version}" (expected MAJOR.MINOR.PATCH)`,
    );
    failed = true;
  }
}

const uniqueVersions = new Set(entries.map(([, version]) => version));
if (uniqueVersions.size !== 1) {
  console.error("Version mismatch across manifests:");
  for (const [file, version] of entries) {
    console.error(`  - ${file}: ${version}`);
  }
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`SemVer check passed: ${entries[0][1]}`);
