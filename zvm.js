#!/usr/bin/env node
// zvm.js (Zig Version Manager)
// A cross-platform script to install and manage multiple Zig versions.
// Compatible with Node.js, Deno, and Bun.
//
// This script relies on the 'tar' command being available in the system's PATH.
// On Windows, this is commonly available through Git for Windows.

import { spawn } from "child_process";
import os from "os";
import path from "path";
import fs from "fs/promises";

// --- Configuration ---
const ZIG_CANONICAL_URL = 'https://ziglang.org';
const ZIG_INDEX_URL = 'https://ziglang.org/download/index.json';
const MIRRORS_URL = 'https://ziglang.org/download/community-mirrors.txt';
const ZVM_DIR = path.join(os.homedir(), '.zvm');
const INSTALL_BASE_DIR = path.join(ZVM_DIR, 'versions');
const SHIMS_DIR = path.join(ZVM_DIR, 'shims');
const ACTIVE_VERSION_LINK = path.join(SHIMS_DIR, 'active'); // A symlink to the active version
const ALIASES_FILE = path.join(ZVM_DIR, 'aliases.json');

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const log = (msg) => console.log(msg);
const logInfo = (msg) => console.log(`${colors.cyan}${msg}${colors.reset}`);
const logSuccess = (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`);
const logError = (msg) => console.error(`${colors.red}❌ ${msg}${colors.reset}`);
const logWarn = (msg) => console.warn(`${colors.yellow}⚠️  ${msg}${colors.reset}`);

/**
 * A promise-based wrapper for spawning child processes.
 * @param {string} command - The command to execute.
 * @param {string[]} args - Arguments for the command.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed with code ${code}: ${command} ${args.join(' ')}\n${stderr}`));
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Gets the target specifiers for the current operating system and architecture.
 * @returns {{os_target: string, arch_target: string}}
 */
function getPlatformInfo() {
  const platformMap = { "linux": "linux", "darwin": "macos", "win32": "windows" };
  const archMap = { "x64": "x86_64", "arm64": "aarch64" };
  const platform = os.platform();
  const arch = os.arch();
  const os_target = platformMap[platform];
  const arch_target = archMap[arch];
  if (!os_target || !arch_target) throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
  return { os_target, arch_target };
}

/**
 * Reads aliases from the aliases file.
 * @returns {Promise<Object.<string, string>>}
 */
async function getAliases() {
  try {
    const content = await fs.readFile(ALIASES_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // No aliases file yet
    throw e;
  }
}

/**
 * Resolves a version string or alias to a full installed directory name.
 * @param {string} versionOrAlias - The user-provided version string or alias.
 * @returns {Promise<string|null>} The full directory name or null if not found.
 */
async function resolveVersion(versionOrAlias) {
  if (!versionOrAlias) return null;
  const aliases = await getAliases();
  const targetVersion = aliases[versionOrAlias] || versionOrAlias;

  try {
    const dirs = await fs.readdir(INSTALL_BASE_DIR);
    // Find a directory that uniquely contains the version string.
    const matchingDirs = dirs.filter(dir => dir.includes(targetVersion));
    if (matchingDirs.length === 1) return matchingDirs[0];
    // If multiple match, prefer an exact match
    if (matchingDirs.includes(targetVersion)) return targetVersion;
    return matchingDirs[0] || null; // Fallback to the first partial match
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}


/**
 * Lists all available Zig versions for the current platform from the official JSON index.
 */
async function handleListRemote() {
  logInfo("Fetching available Zig versions...");
  const response = await fetch(ZIG_INDEX_URL);
  if (!response.ok) throw new Error(`Failed to fetch Zig index: ${response.statusText}`);
  const index = await response.json();

  const { os_target, arch_target } = getPlatformInfo();
  const platformKey = `${arch_target}-${os_target}`;

  log("\n--- Available Zig Versions ---");
  log(`${colors.yellow}Stable Releases:${colors.reset}`);
  Object.keys(index)
    .filter(v => v !== 'master' && !v.includes('-dev'))
    .forEach(version => {
      if (index[version]?.[platformKey]) {
        log(`  - ${version}`);
      }
    });

  log(`\n${colors.yellow}Latest Development Build:${colors.reset}`);
  if (index.master?.[platformKey]) {
    log(`  - ${index.master.version}`);
  } else {
    log("  (Not available for this platform)");
  }
}

/**
 * Lists all locally installed Zig versions, indicating the active one and any aliases.
 */
async function handleList() {
  logInfo(`Installed Zig versions in ${INSTALL_BASE_DIR}:`);
  try {
    let activeVersionDir = null;
    try {
      const linkTarget = await fs.readlink(ACTIVE_VERSION_LINK);
      activeVersionDir = path.basename(linkTarget);
    } catch (e) { /* no active version */ }

    const aliases = await getAliases();
    const reverseAliases = Object.entries(aliases).reduce((acc, [alias, versionDir]) => {
      acc[versionDir] = acc[versionDir] ? [...acc[versionDir], alias] : [alias];
      return acc;
    }, {});

    const dirs = await fs.readdir(INSTALL_BASE_DIR);
    const zigDirs = dirs.filter(dir => dir.startsWith('zig-'));

    if (zigDirs.length === 0) {
      log("  (No versions installed yet)");
    } else {
      zigDirs.forEach(dir => {
        const isActive = dir === activeVersionDir;
        const aliasText = reverseAliases[dir] ? `${colors.gray} (alias: ${reverseAliases[dir].join(', ')})` : '';
        const prefix = isActive ? `${colors.green}-> ` : '   ';
        log(`${prefix}${colors.cyan}${dir}${colors.reset}${aliasText}`);
      });
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      log("  (No versions installed yet)");
    } else {
      throw e;
    }
  }
}

/**
 * Removes a specific installed version of Zig and cleans up aliases.
 * @param {string} versionToRemove - The version string or alias to remove.
 */
async function handleRemove(versionToRemove) {
  if (!versionToRemove) {
    logError("Please specify which version to remove.");
    return;
  }
  try {
    const dirToRemove = await resolveVersion(versionToRemove);

    if (!dirToRemove) {
      logError(`Version "${versionToRemove}" not found.`);
      return;
    }

    // Check if the version to be removed is currently active.
    let isActive = false;
    try {
      const linkTarget = await fs.readlink(ACTIVE_VERSION_LINK);
      if (path.basename(linkTarget) === dirToRemove) {
        isActive = true;
      }
    } catch (e) { /* not active, ignore */ }

    if (isActive) {
      logInfo(`Version ${dirToRemove} is currently active. Deactivating it first...`);
      await handleDeactivate();
    }

    // Remove the version directory
    const fullPath = path.join(INSTALL_BASE_DIR, dirToRemove);
    logInfo(`Removing ${fullPath}...`);
    await fs.rm(fullPath, { recursive: true, force: true });
    logSuccess(`Successfully removed ${dirToRemove}.`);

    // Clean up any aliases pointing to the removed version
    const aliases = await getAliases();
    const cleanedAliases = {};
    const removedAliases = [];
    for (const [alias, versionDir] of Object.entries(aliases)) {
      if (versionDir !== dirToRemove) {
        cleanedAliases[alias] = versionDir;
      } else {
        removedAliases.push(alias);
      }
    }

    if (removedAliases.length > 0) {
      await fs.writeFile(ALIASES_FILE, JSON.stringify(cleanedAliases, null, 2));
      logInfo(`Removed associated aliases: ${removedAliases.join(', ')}`);
    }

  } catch (e) {
    if (e.code === 'ENOENT') {
      logError("No versions installed.");
    } else {
      throw e;
    }
  }
}

/**
 * Generates potential package filenames and the canonical download URL for a given Zig version.
 * @param {string} zigVersion - The version of Zig to install.
 * @returns {{canonicalUrl: string, potentialFilenames: string[]}}
 */
function getZigPackageInfo(zigVersion) {
  const { os_target, arch_target } = getPlatformInfo();
  const isWindows = os_target === 'windows';
  const extension = isWindows ? 'zip' : 'tar.xz';

  const isDevBuild = zigVersion.includes("-dev");
  let zigVersionNorm = zigVersion;
  if (!isDevBuild) {
    zigVersionNorm = zigVersion.match(/\d+\.\d+\.\d+(-dev\.\d+\+[0-9a-f]+)?/)[0];
  }

  const potentialFilenames = [
    `zig-${os_target}-${arch_target}-${zigVersionNorm}.${extension}`,
    `zig-${arch_target}-${os_target}-${zigVersionNorm}.${extension}`
  ];

  const canonicalBase = isDevBuild
    ? `${ZIG_CANONICAL_URL}/builds`
    : `${ZIG_CANONICAL_URL}/download/${zigVersion}`;

  return { canonicalUrl: canonicalBase, potentialFilenames };
}

/**
 * Attempts to download a file from multiple sources in serial order using native fetch.
 * @param {string[]} baseUrls - An array of base URLs (mirrors) to try.
 * @param {string[]} filenames - An array of potential filenames to try.
 * @returns {Promise<{downloadedFile: string}>} The temporary path of the downloaded file.
 */
async function attemptDownload(baseUrls, filenames) {
  const tempFile = path.join(os.tmpdir(), `zig-download-${Date.now()}`);

  for (const baseUrl of baseUrls) {
    for (const filename of filenames) {
      const url = `${baseUrl}/${filename}`;
      try {
        const headResponse = await fetch(url, { method: 'HEAD' });
        if (!headResponse.ok) continue;

        logInfo(`  Attempting download from: ${url}`);
        const getResponse = await fetch(url);
        if (!getResponse.ok) continue;

        await fs.writeFile(tempFile, getResponse.body);
        logSuccess(`Download successful from: ${url}`);
        return { downloadedFile: tempFile };
      } catch (e) {
        logWarn(`Failed to process URL ${url}. Error: ${e.message}. Trying next...`);
      }
    }
  }
  throw new Error("Failed to download Zig from all available mirrors and the canonical source.");
}

/**
 * Helper function to rename a directory with retries on Windows.
 * This helps prevent EPERM errors from antivirus scans.
 * @param {string} oldPath - The original path.
 * @param {string} newPath - The new path.
 */
async function renameWithRetry(oldPath, newPath) {
  const retries = 5;
  const delay = 300; // ms
  for (let i = 0; i < retries; i++) {
    try {
      await fs.rename(oldPath, newPath);
      return; // Success
    } catch (e) {
      if (e.code === 'EPERM' && i < retries - 1) {
        logWarn(`Rename failed, retrying in ${delay}ms... (${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw e; // Rethrow on final attempt or different error
      }
    }
  }
}


/**
 * Installs a specific version of Zig.
 * @param {string} zigVersion - The version string to install.
 * @param {string|null} alias - An optional alias to assign after installation.
 */
async function handleInstall(zigVersion, alias) {
  if (!zigVersion) {
    logError("Please specify which version to install.");
    return;
  }

  if (alias) {
    const aliases = await getAliases();
    if (aliases[alias]) {
      logError(`Alias "${alias}" is already in use for ${aliases[alias]}. Please choose another name or unset it first.`);
      return;
    }
  }

  logInfo(`[1/4] Target Zig version: ${zigVersion}`);

  // 1. Determine package info by constructing URLs
  const { canonicalUrl, potentialFilenames } = getZigPackageInfo(zigVersion);
  logInfo(`[2/4] Determined potential packages: ${potentialFilenames.join(', ')}`);

  // 2. Fetch mirrors and attempt download
  logInfo("[3/4] Fetching mirrors and downloading Zig archive...");
  let mirrors = [];
  try {
    const response = await fetch(MIRRORS_URL);
    if (response.ok) {
      mirrors = (await response.text()).split('\n').filter(url => url.startsWith("https://"));
      logInfo(`  Found ${mirrors.length} community mirrors.`);
    }
  } catch (e) {
    logWarn("Could not fetch community mirrors. Will use the official URL as a fallback.");
  }

  // Priortize download from mirrors first
  const downloadBaseUrls = [...mirrors, canonicalUrl];
  const { downloadedFile } = await attemptDownload(downloadBaseUrls, potentialFilenames);

  // 3. Extract the archive atomically
  logInfo(`[4/4] Installing...`);
  const { stdout: tarOutput } = await runCommand('tar', ['-tf', downloadedFile]);
  const unpackedDirName = tarOutput.split('\n')[0].trim().replace(/\/$/, "");
  const finalInstallPath = path.join(INSTALL_BASE_DIR, unpackedDirName);
  const tempInstallPath = `${finalInstallPath}.tmp`;

  // Check if it's already installed.
  try {
    await fs.access(finalInstallPath);
    logError(`Zig version already installed at ${finalInstallPath}`);
    await fs.unlink(downloadedFile);
    return;
  } catch (e) { /* Expected */ }

  await fs.mkdir(tempInstallPath, { recursive: true });
  await runCommand('tar', ['-xf', downloadedFile, '--strip-components=1', '-C', tempInstallPath]);

  // Use the new rename function with retries
  await renameWithRetry(tempInstallPath, finalInstallPath);

  await fs.unlink(downloadedFile);

  if (alias) {
    await handleAlias(alias, unpackedDirName);
  }

  logSuccess(`Zig version ${zigVersion} is installed at: ${finalInstallPath}`);
  log("\nTo use it, run:");
  log(`  zvm use ${alias || zigVersion}`);
}

/**
 * Deactivates any active version by removing the symlink.
 */
async function handleDeactivate() {
  try {
    await fs.unlink(ACTIVE_VERSION_LINK);
    logSuccess("Deactivated Zig. No version is currently active.");
    if (process.env.ZVM_INITIALIZED !== 'true') {
      logWarn("\nRun 'zvm init' and follow its instructions to apply this change to your shell.");
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      logInfo("No version is currently active.");
    } else {
      logError(`Error during deactivation: ${e.message}`);
      throw e;
    }
  }
}

/**
 * Looks for a .zig-version file and returns its content.
 * @returns {Promise<string|null>}
 */
async function findLocalVersionFile() {
  let currentDir = process.cwd();
  while (true) {
    const filePath = path.join(currentDir, '.zig-version');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null; // Reached root
    currentDir = parentDir;
  }
}

/**
 * Sets a version as the active one by creating a symlink.
 * @param {string} versionToUse - The version or alias to activate.
 */
async function handleUse(versionToUse) {
  let target = versionToUse;
  if (!target) {
    target = await findLocalVersionFile();
    if (!target) {
      logError("No version specified and no .zig-version file found in the current directory or parents.");
      return;
    }
    logInfo(`Found .zig-version file, attempting to use: ${target}`);
  }

  const dirToActivate = await resolveVersion(target);
  if (!dirToActivate) {
    logError(`Version "${target}" is not installed.`);
    logInfo(`To install it, run: zvm install ${target}`);
    return;
  }

  const sourceDir = path.join(INSTALL_BASE_DIR, dirToActivate);

  try { await fs.unlink(ACTIVE_VERSION_LINK); } catch (e) { if (e.code !== 'ENOENT') throw e; }

  logInfo(`Activating ${dirToActivate}...`);
  const linkType = os.platform() === 'win32' ? 'junction' : 'dir';
  await fs.symlink(sourceDir, ACTIVE_VERSION_LINK, linkType);

  logSuccess(`Now using ${dirToActivate}.`);
  if (process.env.ZVM_INITIALIZED !== 'true') {
    logWarn("\nRun 'zvm init' and follow its instructions to apply this change to your shell.");
  }
}

/**
 * Manages version aliases.
 * @param {string} alias - The alias name.
 * @param {string} version - The version to associate with the alias.
 */
async function handleAlias(alias, version) {
  if (!alias) {
    logError("Usage: zvm alias <name> <version> OR zvm alias --unset <name>");
    return;
  }

  const aliases = await getAliases();

  if (version === '--unset') {
    if (aliases[alias]) {
      delete aliases[alias];
      await fs.writeFile(ALIASES_FILE, JSON.stringify(aliases, null, 2));
      logSuccess(`Unset alias "${alias}".`);
    } else {
      logError(`Alias "${alias}" not found.`);
    }
    return;
  }

  if (!version) {
    logError("Please specify a version for the alias.");
    return;
  }

  const dirToAlias = await resolveVersion(version);
  if (!dirToAlias) {
    logError(`Version "${version}" not found.`);
    return;
  }

  aliases[alias] = dirToAlias;
  await fs.writeFile(ALIASES_FILE, JSON.stringify(aliases, null, 2));
  logSuccess(`"${alias}" is now an alias for ${dirToAlias}.`);
}

/**
 * Displays the currently active Zig version.
 */
async function handleCurrent() {
  try {
    const linkTarget = await fs.readlink(ACTIVE_VERSION_LINK);
    const activeVersionDir = path.basename(linkTarget);
    const zigExePath = path.join(linkTarget, 'zig');
    const { stdout } = await runCommand(`"${zigExePath}"`, ['version']);
    log(`${colors.green}Active version:${colors.reset} ${stdout.trim()} (${activeVersionDir})`);
    log(`${colors.gray}Path: ${linkTarget}${colors.reset}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      logInfo("No version is currently active.");
    } else {
      logError(`Could not determine current version: ${e.message}`);
    }
  }
}

/**
 * Generates shell setup scripts and provides instructions.
 */
async function handleInit() {
  logInfo("Configuring your shell for zvm...");
  await fs.mkdir(SHIMS_DIR, { recursive: true });

  if (os.platform() === 'win32') {
    const psScriptContent = `
# zvm shell setup
$env:ZVM_DIR = "${ZVM_DIR}"
$env:PATH = "${path.join(SHIMS_DIR, 'active')};" + $env:PATH
$env:ZVM_INITIALIZED = "true"
`;
    await fs.writeFile(path.join(ZVM_DIR, 'zvm.ps1'), psScriptContent);
    log("\n--- PowerShell Setup ---");
    log("1. Add the following line to your PowerShell profile (usually at $PROFILE):");
    log(`   . "${path.join(ZVM_DIR, 'zvm.ps1')}"`);
    log("2. Restart your shell.");
  } else { // Linux and macOS
    const shScriptContent = `#!/bin/sh
# zvm shell setup
export ZVM_DIR="${ZVM_DIR}"
# The 'active' symlink points to the current version directory
export PATH="${path.join(SHIMS_DIR, 'active')}:$PATH"
export ZVM_INITIALIZED="true"
`;
    await fs.writeFile(path.join(ZVM_DIR, 'zvm.sh'), shScriptContent);
    log("\n--- Setup for bash/zsh/etc. ---");
    log("1. Add the following line to your shell's startup file (e.g., ~/.bashrc, ~/.zshrc):");
    log(`   source "${path.join(ZVM_DIR, 'zvm.sh')}"`);
    log("\n2. Restart your shell or run the command above in your current session to apply changes.");
  }
}


/**
 * Main command router.
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const positionalArgs = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].substring(2)] = args[i + 1];
      i++;
    } else {
      positionalArgs.push(args[i]);
    }
  }

  const usage = () => {
    log(`\n${colors.yellow}Zig Version Manager (zvm)${colors.reset}
Usage: zvm <command> [arguments]

${colors.cyan}Setup:${colors.reset}
  init                           Display setup instructions for your shell.

${colors.cyan}Commands:${colors.reset}
  install, i <v> [--alias <n>]   Install a specific version, optionally with an alias.
  uninstall, rm <v|a>            Remove a specific installed version.
  use, activate [v|a]            Set a version as active. If no version is given,
                                 looks for a .zig-version file.
  deactivate, unuse              Deactivate the current version.
  current                        Display the currently active version.
  alias <name> <v|a>             Create an alias for a version.
  alias --unset <name>           Remove an alias.
  list, ls                       List all installed versions.
  list-remote, ls-remote         List all available versions for download.`);
  };

  await fs.mkdir(INSTALL_BASE_DIR, { recursive: true });

  switch (command) {
    case 'install':
    case 'i':
      await handleInstall(positionalArgs[0], flags.alias);
      break;
    case 'uninstall':
    case 'remove':
    case 'rm':
      await handleRemove(positionalArgs[0]);
      break;
    case 'use':
    case 'activate':
      await handleUse(positionalArgs[0]);
      break;
    case 'deactivate':
    case 'unuse':
      await handleDeactivate();
      break;
    case 'current':
      await handleCurrent();
      break;
    case 'alias':
      await handleAlias(flags.unset || positionalArgs[0], positionalArgs[1] || (flags.unset ? '--unset' : undefined));
      break;
    case 'init':
      await handleInit();
      break;
    case 'list':
    case 'ls':
      await handleList();
      break;
    case 'list-remote':
    case 'ls-remote':
      await handleListRemote();
      break;
    default:
      usage();
      break;
  }
}

main().catch(err => {
  logError(`An error occurred: ${err.message}`);
  process.exit(1);
});
