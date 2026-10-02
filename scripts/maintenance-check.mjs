import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const registryPath = 'workers/stats/src/public-resource-registry.ts';
export function classifyChanges(files) {
  const full = files.filter(f => /^(packages\/domain\/|\.github\/(?:workflows|actions)\/|scripts\/|apps\/site\/scripts\/|apps\/site\/src\/lib\/(?:catalog-projection|types)\.ts$|tools\/arcaea-apk-updat|package(?:-lock)?\.json$|.*(?:tsconfig[^/]*\.json|astro\.config\.[^/]+)$)/u.test(f));
  const worker = files.some(f => f.startsWith('workers/stats/') && f !== registryPath && !f.endsWith('.md'));
  const content = files.some(f => f.startsWith('catalog/') || f === registryPath || f === 'apps/site/src/lib/site-data.ts');
  const site = files.some(f => f.startsWith('apps/site/') && !f.endsWith('.md'));
  return { mode: full.length ? 'FULL' : 'FAST', reasons: full, worker, content, site, registry: content || files.includes('apps/site/src/lib/game-config.ts'),
    deployWorker: files.some(f => f.startsWith('workers/stats/') && !f.endsWith('.md') && !f.startsWith('workers/stats/tests/')) || files.includes('packages/domain/src/identifiers.ts') };
}
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr.trim() || 'Git failed');
  return r.stdout.trim();
}
export function changedFiles(base) {
  git(['rev-parse', '--show-toplevel']);
  if (base) return [...new Set([...git(['diff', '--name-only', base]).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))];
  return [...new Set([...git(['diff', '--name-only', 'HEAD']).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))];
}
export function runQuiet(command) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const r = spawnSync(executable, args, { env: { ...process.env, npm_config_logs_max: process.env.RHYTHM_TASK_RUNTIME ? '10' : '0' }, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${command}\n${r.error?.message || ''}\n${((r.stdout || '') + (r.stderr || '')).slice(-6000)}`);
  for (const line of (r.stdout || '').split('\n').filter(line => /^(FAST CONTENT PASS|ROS DELTA|Public stats resource registry)/u.test(line))) console.log(line);
  console.log(`PASS: ${command}`);
}
export function commandsFor(plan, ci = false) {
  if (plan.mode === 'FULL') return ['npm run ci:check'];
  const commands = [];
  if (plan.content) commands.push('node --import tsx apps/site/scripts/check-content-fast.ts');
  if (plan.registry && !plan.content) commands.push('npm run stats:registry:check');
  if (plan.worker) commands.push('npm run worker:check');
  if (plan.site && !ci) commands.push('npm run typecheck', 'npm run site:check');
  if (ci) commands.push('npm run site:build', 'npm run traffic:check', 'npm run site:smoke');
  return commands;
}
function main(args) {
  const baseIndex = args.indexOf('--base');
  if (baseIndex >= 0 && !args[baseIndex + 1]) throw new Error('--base requires a Git revision');
  const files = changedFiles(baseIndex >= 0 ? args[baseIndex + 1] : undefined);
  if (baseIndex >= 0) process.env.RHYTHM_COMPARE_BASE = args[baseIndex + 1];
  const plan = classifyChanges(files);
  if (args.includes('--full')) plan.mode = 'FULL';
  console.log(`${plan.mode}: ${files.length} changed paths; content=${plan.content}; worker=${plan.worker}; deployWorker=${plan.deployWorker}`);
  if (args.includes('--plan')) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\ndeploy_worker=${plan.deployWorker}\n`);
    return;
  }
  if (plan.mode === 'FULL' && !args.includes('--allow-full') && !args.includes('--full')) throw new Error(`FULL MAINTENANCE required by explicit paths: ${plan.reasons.join(', ')}. Use npm run ci:check once.`);
  if (args.includes('--update')) runQuiet('npm run stats:registry');
  if (args.includes('--update')) plan.content = true;
  const commands = commandsFor(plan, args.includes('--ci'));
  for (const command of commands) runQuiet(command);
  git(['diff', '--check']);
  if (commands.length === 0) {
    console.log('No affected checks: content / registry / Pages NOT_RUN; diff check passed.');
    return;
  }
  console.log(`${plan.mode} CHECK PASS: content=${plan.content} / Stats registry ${plan.content ? 'valid' : 'unchanged'} / ${args.includes('--ci') ? 'Pages build valid' : 'target checks valid'}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
