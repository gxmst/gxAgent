import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = process.argv.includes("--archive");
const noticesOnly = process.argv.includes("--notices-only");
const tauriConfig = JSON.parse(
  readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
const temporary = path.join(root, ".shots", "desktop-build");
mkdirSync(temporary, { recursive: true });

function run(command, args, capture = true) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr || "see output"}`,
    );
  return result.stdout?.trim() || "";
}

function fingerprint() {
  const files = run("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(
      existsSync(path.join(root, file))
        ? readFileSync(path.join(root, file))
        : "[deleted]",
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

function licenseFiles(directory, explicit) {
  const result = [];
  if (explicit && existsSync(path.resolve(directory, explicit)))
    result.push(path.resolve(directory, explicit));
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      !/^(licen[cs]e|copying|copyright|notice|unlicen[cs]e)([._-]|$)/i.test(
        entry.name,
      )
    )
      continue;
    const target = path.join(directory, entry.name);
    if (entry.isFile()) result.push(target);
    if (entry.isDirectory())
      for (const child of readdirSync(target, { withFileTypes: true })) {
        if (child.isFile()) result.push(path.join(target, child.name));
      }
  }
  return [...new Set(result)];
}

function repositoryKey(repository) {
  try {
    const url = new URL(
      (typeof repository === "string" ? repository : repository?.url || "")
        .replace(/^git\+/, "")
        .replace(/^git:/, "https:"),
    );
    return url.hostname === "github.com"
      ? url.pathname
          .split("/")
          .slice(1, 3)
          .join("/")
          .replace(/\.git$/, "")
      : "";
  } catch {
    return "";
  }
}

const downloaded = new Map();
const curl = process.platform === "win32" ? "curl.exe" : "curl";
// These published versions omit a standalone license file. Preserve their
// declared license and attribution with the corresponding complete terms.
const licenseFallbacks = {
  "format@0.2.2": [
    "https://sjs.mit-license.org/license.txt",
    "Copyright 2010 - 2014 Sami Samhuri sami@samhuri.net (package README).",
  ],
  "fxhash@0.2.1": [
    "https://www.apache.org/licenses/LICENSE-2.0.txt",
    "Apache-2.0 option selected from Apache-2.0/MIT. Copyright 2015 The Rust Project Developers (lib.rs).",
  ],
  "mac@0.1.1": [
    "https://www.apache.org/licenses/LICENSE-2.0.txt",
    "Apache-2.0 option selected from MIT/Apache-2.0. Package author: Jonathan Reem.",
  ],
  "highlightjs-vue@1.0.0": [
    "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/CC0-1.0.txt",
    "Package declares CC0-1.0; author: Sara Lissette.",
  ],
  "react-remove-scroll-bar@2.3.8": [
    "https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE",
    "Upstream MIT license; package author: Anton Korzunov.",
  ],
};
async function upstreamLicense(dependency) {
  const fallback = licenseFallbacks[dependency.name];
  if (fallback) {
    const [url, attribution] = fallback;
    const cache = path.join(
      temporary,
      createHash("sha256").update(`${dependency.name}:${url}`).digest("hex") +
        ".json",
    );
    if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
    const { stdout } = await promisify(execFile)(
      curl,
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--max-time",
        "60",
        url,
      ],
      { windowsHide: true },
    );
    if (stdout.length < 100 || /<html/i.test(stdout))
      throw new Error(`Invalid license response: ${url}`);
    const notice = {
      source: url,
      text: `${attribution}\nLicense text SHA-256: ${createHash("sha256").update(stdout).digest("hex")}\n\n${stdout}`,
    };
    writeFileSync(cache, JSON.stringify(notice));
    return notice;
  }
  if (!dependency.repository)
    throw new Error(`No upstream repository for ${dependency.name}`);
  let revision;
  if (dependency.ecosystem === "Cargo") {
    const vcs = path.join(dependency.directory, ".cargo_vcs_info.json");
    if (existsSync(vcs))
      revision = JSON.parse(readFileSync(vcs, "utf8")).git?.sha1;
  } else {
    const manifest = JSON.parse(
      readFileSync(path.join(dependency.directory, "package.json"), "utf8"),
    );
    const { stdout } = await promisify(execFile)(
      curl,
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        `https://registry.npmjs.org/${manifest.name}/${manifest.version}`,
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    revision = JSON.parse(stdout).gitHead;
  }
  if (!revision || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error(`Missing source revision for ${dependency.name}`);
  const key = `${dependency.repository}/${revision}`;
  if (downloaded.has(key)) return downloaded.get(key);
  const task = (async () => {
    const cache = path.join(
      temporary,
      createHash("sha256").update(key).digest("hex") + ".json",
    );
    if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
    for (const filename of [
      "LICENSE",
      "LICENSE-MIT",
      "license",
      "LICENSE.md",
      "LICENSE.txt",
      "COPYING",
    ]) {
      const url = `https://raw.githubusercontent.com/${key}/${filename}`;
      try {
        const { stdout } = await promisify(execFile)(
          curl,
          [
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            url,
          ],
          { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        );
        if (stdout.length < 100 || /<html/i.test(stdout)) continue;
        const notice = { source: url, text: stdout };
        writeFileSync(cache, JSON.stringify(notice));
        return notice;
      } catch {
        /* Try the upstream's next conventional license filename. */
      }
    }
    throw new Error(`No license file found at upstream revision ${key}`);
  })();
  downloaded.set(key, task);
  return task;
}

const rustVersion = run("rustc", ["-vV"]);
const host = rustVersion.match(/^host: (.+)$/m)?.[1];
if (!host || (!noticesOnly && !host.includes("windows")))
  throw new Error(
    "This desktop delivery script currently supports Windows hosts.",
  );
const metadata = JSON.parse(
  run("cargo", [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--filter-platform",
    host,
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]),
);
const crates = new Set(metadata.resolve.nodes.map((node) => node.id));
const dependencies = metadata.packages
  .filter((pkg) => crates.has(pkg.id) && pkg.source)
  .map((pkg) => ({
    name: `${pkg.name}@${pkg.version}`,
    ecosystem: "Cargo",
    license: pkg.license,
    directory: path.dirname(pkg.manifest_path),
    explicit: pkg.license_file,
    repository: repositoryKey(pkg.repository),
  }));
const npmLock = JSON.parse(
  readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
for (const [relative, info] of Object.entries(npmLock.packages)) {
  if (!relative || info.dev || info.devOptional) continue;
  const directory = path.join(root, relative);
  const manifest = path.join(directory, "package.json");
  if (!existsSync(manifest)) {
    if (info.optional) continue;
    throw new Error(`Missing installed dependency: ${relative}`);
  }
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  dependencies.push({
    name: `${pkg.name}@${pkg.version}`,
    ecosystem: "npm",
    license:
      typeof pkg.license === "string"
        ? pkg.license
        : pkg.license?.type ||
          pkg.licenses?.map((item) => item.type).join(" OR "),
    directory,
    repository: repositoryKey(pkg.repository),
  });
}

const sections = [
  "gxAgent third-party notices\n\nThis file includes installed production npm dependencies and Cargo dependencies for the build target, including build tools. Individual components retain their respective licenses.\n",
];
const localNotices = new Map();
for (const dependency of dependencies) {
  const files = licenseFiles(dependency.directory, dependency.explicit);
  dependency.notices = files.map((file) => ({
    source: path.relative(dependency.directory, file),
    text: readFileSync(file, "utf8"),
  }));
  if (dependency.repository && files.length)
    localNotices.set(dependency.repository, dependency.notices);
}
const resolvedNotices = await Promise.allSettled(
  dependencies
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(async (dependency) => {
      let notices = dependency.notices;
      if (!notices.length && dependency.repository)
        notices = localNotices.get(dependency.repository) || [];
      if (!notices.length) {
        for (const entry of readdirSync(dependency.directory)) {
          if (!/^readme(\.|$)/i.test(entry)) continue;
          const text = readFileSync(
            path.join(dependency.directory, entry),
            "utf8",
          );
          const start = text.search(/^#{1,6}\s+License\s*$/im);
          if (
            start >= 0 &&
            text.slice(start).includes("Permission is hereby granted") &&
            text.slice(start).includes("THE SOFTWARE IS PROVIDED")
          )
            notices = [
              { source: `${entry}, license section`, text: text.slice(start) },
            ];
        }
      }
      if (!notices.length) notices = [await upstreamLicense(dependency)];
      return (
        `\n${"=".repeat(72)}\n${dependency.ecosystem}: ${dependency.name}\nDeclared license: ${dependency.license || "See license text"}\nRepository: ${dependency.repository}\n` +
        notices
          .map((notice) => `\n--- ${notice.source} ---\n${notice.text}\n`)
          .join("")
      );
    }),
);
const missing = resolvedNotices.flatMap((result, index) =>
  result.status === "rejected"
    ? [`${dependencies[index].name}: ${result.reason}`]
    : [],
);
if (missing.length)
  throw new Error(`License notices need review:\n${missing.join("\n")}`);
sections.push(...resolvedNotices.map((result) => result.value));
const noticePath = path.join(temporary, "THIRD_PARTY_NOTICES.txt");
writeFileSync(noticePath, sections.join(""));
console.log(
  `Third-party notices: ${noticePath} (${dependencies.length} dependencies)`,
);
if (noticesOnly) process.exit(0);

const commit = run("git", ["rev-parse", "HEAD"]);
const dirty = Boolean(
  run("git", ["status", "--porcelain", "--untracked-files=all"]),
);
const sourceHash = fingerprint();
const started = new Date();
run(
  process.execPath,
  ["node_modules/@tauri-apps/cli/tauri.js", "build"],
  false,
);
if (sourceHash !== fingerprint())
  throw new Error(
    "Source files changed during the build; rebuild before archiving.",
  );
const appPackage = metadata.packages.find((pkg) =>
  metadata.workspace_members.includes(pkg.id),
);
const executable =
  appPackage.targets.find((target) => target.kind.includes("bin")).name +
  ".exe";
const releaseDirectory = path.join(metadata.target_directory, "release");
const deliverables = [path.join(releaseDirectory, executable)];
for (const [folder, extension] of [
  ["msi", ".msi"],
  ["nsis", ".exe"],
]) {
  const directory = path.join(releaseDirectory, "bundle", folder);
  const packages = readdirSync(directory).filter(
    (name) =>
      name.startsWith(`${tauriConfig.productName}_${tauriConfig.version}_`) &&
      name.endsWith(extension),
  );
  if (packages.length !== 1)
    throw new Error(
      `Expected one ${folder} package for this version, found ${packages.length}`,
    );
  deliverables.push(path.join(directory, packages[0]));
}
for (const file of deliverables) {
  if (!existsSync(file)) throw new Error(`Build did not produce ${file}`);
  console.log(`Built: ${file}`);
}
console.log(`Frontend bundle: ${path.join(root, "dist")}`);
console.log(`Disposable Cargo build cache: ${metadata.target_directory}`);
if (!archive) process.exit(0);

const stamp = [
  started.getFullYear(),
  String(started.getMonth() + 1).padStart(2, "0"),
  String(started.getDate()).padStart(2, "0"),
  "-",
  ...[started.getHours(), started.getMinutes(), started.getSeconds()].map((n) =>
    String(n).padStart(2, "0"),
  ),
].join("");
const leaf = `${stamp}-${commit.slice(0, 12)}${dirty ? "-dirty" : ""}`;
const projectArchive = path.resolve(
  process.env.GXAGENT_ARTIFACTS_DIR ||
    path.join(root, "..", "_build_artifacts"),
  path.basename(root),
);
const destination = path.join(projectArchive, leaf);
mkdirSync(projectArchive, { recursive: true });
mkdirSync(destination);
const copied = [];
for (const source of [...deliverables, noticePath]) {
  const name = path.basename(source);
  const target = path.join(destination, name);
  copyFileSync(source, target, 1);
  const sourceChecksum = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  const checksum = createHash("sha256")
    .update(readFileSync(target))
    .digest("hex");
  if (sourceChecksum !== checksum)
    throw new Error(`Checksum mismatch: ${name}`);
  copied.push({ file: name, sha256: checksum });
}
const manifest = {
  product: tauriConfig.productName,
  version: tauriConfig.version,
  builtAt: started.toISOString(),
  commit,
  dirty,
  sourceFingerprint: sourceHash,
  target: host,
  node: process.version,
  rustc: rustVersion,
  cargo: run("cargo", ["--version"]),
  validation:
    "Desktop build succeeded; copied payload hashes match. Interactive startup is verified separately.",
  signing: "Unsigned local build; not a public release",
  runtime:
    "Windows with Microsoft Edge WebView2 Runtime. Application data is stored in the normal user profile, separately from this archive.",
  files: copied,
};
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(path.join(destination, "BUILD_INFO.json"), manifestText, {
  flag: "wx",
});
copied.push({
  file: "BUILD_INFO.json",
  sha256: createHash("sha256").update(manifestText).digest("hex"),
});
writeFileSync(
  path.join(destination, "SHA256SUMS.txt"),
  copied.map((item) => `${item.sha256}  ${item.file}`).join("\n") + "\n",
  { flag: "wx" },
);
if (readdirSync(destination).length !== copied.length + 1)
  throw new Error("Unexpected files in delivery archive.");
writeFileSync(path.join(projectArchive, "LATEST.txt"), leaf + "\n");
console.log(`Archived deliverables: ${destination}`);
