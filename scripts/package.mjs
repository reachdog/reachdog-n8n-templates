// Builds the distribution ZIP from the committed tree (git archive HEAD),
// so the archive is reproducible from any commit. Fails if the working copy
// of a packaged file differs from HEAD, if a listed file is missing, or if a
// template contains credentials or a non-empty configuration value.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const FILES = [
  'templates/product-feed-audit.json',
  'templates/shopify-catalog-groups.json',
  'templates/shopify-product-keywords.json',
  'sql/template3-budget.sql',
  'README.md',
  'LICENSE',
];
const name = `reachdog-n8n-templates-${pkg.version}`;
const out = `dist/${name}.zip`;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const dirty = git('status', '--porcelain', '--', ...FILES).trim();
if (dirty) {
  console.error(`Packaged files differ from HEAD; commit them first:\n${dirty}`);
  process.exit(1);
}
const tracked = git('ls-files', '--', ...FILES).trim().split('\n').filter(Boolean);
const missing = FILES.filter(f => !tracked.includes(f));
if (missing.length) {
  console.error(`Not tracked in git: ${missing.join(', ')}`);
  process.exit(1);
}

for (const f of FILES.filter(f => f.startsWith('templates/'))) {
  const wf = JSON.parse(git('show', `HEAD:${f}`));
  const problems = [];
  if (wf.active !== false) problems.push('active is not false');
  if (wf.pinData && Object.keys(wf.pinData).length) problems.push('pinData is not empty');
  for (const node of wf.nodes) {
    if (node.credentials) problems.push(`node "${node.name}" has a credentials block`);
  }
  if (problems.length) {
    console.error(`${f}: ${problems.join('; ')}`);
    process.exit(1);
  }
}

mkdirSync('dist', { recursive: true });
git('archive', '--format=zip', `--prefix=${name}/`, '-o', out, 'HEAD', '--', ...FILES);
console.log(`${out} from ${git('rev-parse', 'HEAD').trim()}`);
for (const f of FILES) console.log(`  ${name}/${f}`);
