#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules','.git','admin-app-dist','pages'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (p.endsWith('.js') && !p.includes('.bak')) targets.push(p);
  }
}
walk(path.join(root, 'src'));
let failed = 0;
for (const f of targets) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    console.error(path.relative(root, f), (r.stderr || '').trim());
  }
}
console.log(JSON.stringify({ files: targets.length, failed }));
process.exit(failed ? 1 : 0);
