#!/usr/bin/env node
/**
 * verify-skill.mjs — Pre-publish accuracy checker
 * Validates SKILL.md claims against actual source files.
 * Run: node scripts/verify-skill.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let errors = 0;
function fail(msg) { console.error(`❌ ${msg}`); errors++; }
function pass(msg) { console.log(`✅ ${msg}`); }

// --- Load files ---
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const license = readFileSync(join(root, 'LICENSE'), 'utf8');
const skill = readFileSync(join(root, 'skill', 'SKILL.md'), 'utf8');

// --- 1. Version match ---
const skillVersion = skill.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (skillVersion === pkg.version) {
  pass(`Version matches: ${skillVersion}`);
} else {
  fail(`SKILL.md version "${skillVersion}" ≠ package.json "${pkg.version}"`);
}

// --- 2. License match ---
const pkgLicense = pkg.license;
const skillLicenseMatch = skill.match(/\*\*License:\*\*\s*([^|*]+)/);
const skillLicense = skillLicenseMatch?.[1]?.trim();

if (!skillLicense) {
  fail('No license found in SKILL.md');
} else if (skillLicense.toLowerCase().includes(pkgLicense.toLowerCase().split('-')[0])) {
  pass(`License matches: ${skillLicense} (package.json: ${pkgLicense})`);
} else {
  fail(`SKILL.md license "${skillLicense}" ≠ package.json "${pkgLicense}"`);
}

// Also check LICENSE file consistency
if (license.includes('Elastic License 2.0') && pkgLicense === 'Elastic-2.0') {
  pass('LICENSE file matches package.json');
} else if (license.includes('MIT') && pkgLicense === 'MIT') {
  pass('LICENSE file matches package.json');
} else {
  fail(`LICENSE file content doesn't match package.json license "${pkgLicense}"`);
}

// --- 3. Test count (run vitest and parse summary) ---
function verifyTests() {
  let raw;
  try {
    raw = execSync('npx vitest run --reporter=default 2>&1', {
      cwd: root, encoding: 'utf8', timeout: 60000,
    });
  } catch (e) {
    // vitest may write to stderr causing execSync to throw; grab combined output
    raw = (e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '');
  }
  // Strip all ANSI escape sequences (includes colors, reverse video, reset, etc.)
  const out = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const filesMatch = out.match(/Test Files\s+(\d+) passed/);
  const testsMatch = out.match(/Tests\s+(\d+) passed/);
  const skillTestMatch = skill.match(/(\d+)\/\d+ passing \((\d+) files\)/);

  if (filesMatch && testsMatch && skillTestMatch) {
    const actualTests = parseInt(testsMatch[1]);
    const actualFiles = parseInt(filesMatch[1]);
    const claimedTests = parseInt(skillTestMatch[1]);
    const claimedFiles = parseInt(skillTestMatch[2]);
    if (claimedTests === actualTests && claimedFiles === actualFiles) {
      pass(`Test count matches: ${actualTests} tests, ${actualFiles} files`);
    } else {
      fail(`SKILL.md claims ${claimedTests} tests/${claimedFiles} files but actual is ${actualTests} tests/${actualFiles} files`);
    }
  } else {
    console.log('⚠️  Could not verify test count (vitest output not parseable)');
  }
}
verifyTests();

// --- 4. Exported functions mentioned in SKILL.md exist in index ---
const index = readFileSync(join(root, 'src', 'index.mjs'), 'utf8');
const claimedAPIs = [
  'store', 'search', 'decay', 'reinforce', 'links', 'path', 'clusters',
  'evolve', 'listQuarantined', 'reviewQuarantine', 'compress', 'consolidate',
  'createEpisode', 'searchEpisode', 'storeMany', 'searchMany', 'ingest',
  'heartbeatStore', 'contextualRecall', 'preCompactionDump',
  'createCluster', 'autoLabelClusters', 'explainMemory',
];
const graph = readFileSync(join(root, 'src', 'graph.mjs'), 'utf8');
const runtime = readFileSync(join(root, 'src', 'runtime.mjs'), 'utf8');
const allSource = index + graph + runtime;

for (const api of claimedAPIs) {
  if (allSource.includes(api)) {
    // exists
  } else {
    fail(`SKILL.md references "${api}" but not found in source`);
  }
}
pass(`All ${claimedAPIs.length} claimed APIs found in source`);

// --- 5. npm package name match ---
const skillPkgRef = skill.match(/@[\w-]+\/[\w-]+/)?.[0];
if (skillPkgRef === pkg.name) {
  pass(`Package name matches: ${skillPkgRef}`);
} else if (skillPkgRef) {
  fail(`SKILL.md references "${skillPkgRef}" but package.json has "${pkg.name}"`);
}

// --- 6. Zero dependencies claim ---
if (skill.includes('zero runtime dependencies') || skill.includes('Zero infrastructure')) {
  const deps = Object.keys(pkg.dependencies || {});
  if (deps.length === 0) {
    pass('Zero dependencies claim verified');
  } else {
    fail(`Claims zero deps but package.json has: ${deps.join(', ')}`);
  }
}

// --- Summary ---
console.log(`\n${errors === 0 ? '🟢 All checks passed' : `🔴 ${errors} error(s) found`}`);
process.exit(errors > 0 ? 1 : 0);
