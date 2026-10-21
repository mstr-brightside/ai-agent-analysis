// Type-checks every tsconfig in the repo in parallel. Each package keeps its own
// compiler settings (core and contract compile without Node types, web-plain with the DOM).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const projects: string[] = ['scripts'];
for (const group of ['packages', 'tools']) {
  for (const name of readdirSync(path.join(root, group))) {
    for (const sub of ['', 'test']) {
      const dir = path.join(group, name, sub);
      if (existsSync(path.join(root, dir, 'tsconfig.json'))) projects.push(dir);
    }
  }
}

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const results = await Promise.all(
  projects.map(
    (project) =>
      new Promise<{ project: string; code: number; output: string }>((resolve) => {
        const child = spawn(process.execPath, [tsc, '-p', project, '--pretty'], { cwd: root });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.on('close', (code) => {
          resolve({ project, code: code ?? 1, output });
        });
      }),
  ),
);

let failed = 0;
for (const r of results) {
  if (r.code === 0) continue;
  failed++;
  process.stdout.write(`\n✗ ${r.project}\n${r.output}`);
}
process.stdout.write(`typecheck: ${results.length - failed}/${results.length} projects clean\n`);
process.exitCode = failed === 0 ? 0 : 1;
