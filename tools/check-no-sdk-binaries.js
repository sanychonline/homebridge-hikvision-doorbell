"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PACKAGE_SURFACE = packageFiles();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
]);
const SDK_DIR_NAMES = new Set([
  "HCNetSDKCom",
  "PlayCtrl",
]);
const BINARY_EXTENSIONS = new Set([
  ".a",
  ".exe",
  ".lib",
  ".so",
  ".dll",
  ".dylib",
]);
const SDK_ARCHIVE_PATTERNS = [
  /hcnetsdk/i,
  /hcnet[_-]?sdk/i,
  /playsdk/i,
  /playctrl/i,
];
const SDK_BINARY_NAME_PATTERNS = [
  /hcnetsdk/i,
  /hcnet[_-]?sdk/i,
  /playctrl/i,
  /playsdk/i,
  /libcrypto\.so/i,
  /libssl\.so/i,
  /libz\.so/i,
];
const ARCHIVE_EXTENSIONS = [
  ".7z",
  ".rar",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".zip",
];
const SDK_WRAPPER_SCRIPT_PATTERNS = [
  /hikvision-hcnet-.*\.(py|js)$/i,
  /hcnet.*\.(py|js)$/i,
];

const findings = [];

for (const entry of PACKAGE_SURFACE) {
  const fullPath = path.join(ROOT, entry);
  if (fs.existsSync(fullPath)) {
    walk(fullPath);
  }
}

if (findings.length > 0) {
  console.error("SDK binary/runtime files must not be bundled with homebridge-hikvision-doorbell.");
  for (const finding of findings) {
    console.error(`- ${path.relative(ROOT, finding)}`);
  }
  console.error("Keep HCNetSDK downloads and experiments outside this repository and outside the public npm package.");
  process.exit(1);
}

function walk(directory) {
  const stat = fs.statSync(directory);
  if (stat.isFile()) {
    inspectFile(directory);
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (SDK_DIR_NAMES.has(entry.name)) {
        findings.push(fullPath);
        continue;
      }
      walk(fullPath);
      continue;
    }

    if (entry.isFile()) {
      inspectFile(fullPath);
    }
  }
}

function inspectFile(fullPath) {
  const entryName = path.basename(fullPath);
  const lowerName = entryName.toLowerCase();
  if (BINARY_EXTENSIONS.has(path.extname(lowerName))) {
    findings.push(fullPath);
    return;
  }
  if (SDK_BINARY_NAME_PATTERNS.some((pattern) => pattern.test(entryName))
    && (lowerName.includes(".so") || lowerName.endsWith(".dll") || lowerName.endsWith(".dylib") || lowerName.endsWith(".lib") || lowerName.endsWith(".exe"))) {
    findings.push(fullPath);
    return;
  }
  if (ARCHIVE_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
    && SDK_ARCHIVE_PATTERNS.some((pattern) => pattern.test(entryName))) {
    findings.push(fullPath);
    return;
  }
  if (SDK_WRAPPER_SCRIPT_PATTERNS.some((pattern) => pattern.test(entryName))) {
    findings.push(fullPath);
  }
}

function packageFiles() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (!Array.isArray(packageJson.files) || !packageJson.files.length) {
    throw new Error("package.json must declare files before running the SDK package guard");
  }
  return uniqueStrings(["package.json", ...packageJson.files]);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
