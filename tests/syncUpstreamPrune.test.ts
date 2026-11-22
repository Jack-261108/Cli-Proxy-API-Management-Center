import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const workflowPath = new URL('../.github/workflows/sync-upstream.yml', import.meta.url);

function git(cwd: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function commitFile(cwd: string, path: string, content: string, message: string) {
  writeFileSync(join(cwd, path), content);
  git(cwd, ['add', path]);
  git(cwd, ['commit', '-qm', message]);
}

function extractPruneScript() {
  const workflow = readFileSync(workflowPath, 'utf8');
  const step = workflow.indexOf('      - name: Prune obsolete sync-conflict branches');
  if (step < 0) throw new Error('Prune step not found');
  const run = workflow.indexOf('        run: |', step) + '        run: |\n'.length;
  const next = workflow.indexOf('\n      - name:', run);
  return (
    workflow
      .slice(run, next)
      .split('\n')
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n') + '\n'
  );
}

const regressionTest = () => {
  const jq = spawnSync('jq', ['--version']);
  if (jq.status !== 0) {
    throw new Error('jq is required for the sync-upstream prune regression test');
  }
  const root = mkdtempSync(join(tmpdir(), 'sync-upstream-prune-'));
  try {
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, ['init', '-q', '--bare', origin]);
    git(root, ['clone', '-q', origin, work]);
    git(work, ['config', 'user.name', 'test']);
    git(work, ['config', 'user.email', 'test@example.com']);
    git(work, ['checkout', '-q', '-b', 'main']);
    commitFile(work, 'm.txt', 'base\n', 'M1');
    const m1 = git(work, ['rev-parse', 'HEAD']).stdout.trim();
    git(work, ['push', '-q', '-u', 'origin', 'main']);

    git(work, ['checkout', '-q', '-b', 'A', m1]);
    commitFile(work, 'x.txt', 'A\n', 'X');
    const x = git(work, ['rev-parse', 'HEAD']).stdout.trim();
    git(work, ['checkout', '-q', '-b', 'B', m1]);
    commitFile(work, 'x.txt', 'B\n', 'Y');

    // main: merge A, then merge B with a different resolution M.
    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '--no-ff', 'A', '-m', 'main merge A'], true);
    git(work, ['merge', '--no-ff', 'B', '-m', 'main merge B'], true);
    writeFileSync(join(work, 'x.txt'), 'M\n');
    git(work, ['add', 'x.txt']);
    git(work, ['commit', '-q', '--no-edit']);

    // Z merge: merge A into B and resolve the conflict to Z.
    git(work, ['checkout', '-q', 'B']);
    git(work, ['merge', '--no-ff', 'A', '-m', 'Z merge'], true);
    writeFileSync(join(work, 'x.txt'), 'Z\n');
    git(work, ['add', 'x.txt']);
    git(work, ['commit', '-q', '--no-edit']);
    const zMerge = git(work, ['rev-parse', 'HEAD']).stdout.trim();

    const handoff = (branch: string, parent: string) => {
      git(work, ['checkout', '-q', '-b', branch, m1]);
      git(work, ['merge', '--no-ff', parent, '-m', 'handoff'], true);
      writeFileSync(
        join(work, '.sync-conflict.json'),
        `${JSON.stringify({ upstream_sha: x, repo_sha_before: m1 })}\n`
      );
      git(work, ['add', '.']);
      git(work, ['commit', '-q', '--amend', '--no-edit']);
    };

    // Only the handoff merge: main already contains the upstream SHA, so it is
    // safe to delete.
    handoff('sync-conflict/only-handoff', x);
    // The only unique content is the conflict resolution inside the Z merge:
    // both parents are already in main, so this branch must be kept.
    handoff('sync-conflict/merge-only', zMerge);

    // A real conflicted handoff: the handoff merge itself carries the conflict
    // markers. It must be recognized and skipped; otherwise the markers look
    // like unique content and an obsolete branch is never pruned.
    git(work, ['checkout', '-q', '-b', 'before', m1]);
    commitFile(work, 'f.txt', 'L\n', 'BEFORE');
    const before = git(work, ['rev-parse', 'HEAD']).stdout.trim();
    git(work, ['checkout', '-q', '-b', 'upstream', m1]);
    commitFile(work, 'f.txt', 'U\n', 'UPSTREAM');
    const upstream = git(work, ['rev-parse', 'HEAD']).stdout.trim();

    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '--no-ff', 'before', '-m', 'main merge BEFORE']);
    git(work, ['merge', '--no-ff', 'upstream', '-m', 'main merge UPSTREAM'], true);
    writeFileSync(join(work, 'f.txt'), 'M2\n');
    git(work, ['add', 'f.txt']);
    git(work, ['commit', '-q', '--no-edit']);

    git(work, ['checkout', '-q', '-b', 'sync-conflict/real-handoff', before]);
    git(work, ['merge', '--no-ff', 'upstream', '-m', 'handoff'], true);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'handoff']);
    writeFileSync(
      join(work, '.sync-conflict.json'),
      `${JSON.stringify({ upstream_sha: upstream, repo_sha_before: before })}\n`
    );
    git(work, ['add', '.']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);

    // Resolution amended into the handoff merge itself, manifest kept: the
    // diff-tree still lists f.txt, but it no longer has markers, so it must be
    // kept.
    git(work, ['checkout', '-q', '-b', 'sync-conflict/amended-handoff', before]);
    git(work, ['merge', '--no-ff', 'upstream', '-m', 'handoff'], true);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'handoff']);
    writeFileSync(
      join(work, '.sync-conflict.json'),
      `${JSON.stringify({ upstream_sha: upstream, repo_sha_before: before })}\n`
    );
    git(work, ['add', '.']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);
    writeFileSync(join(work, 'f.txt'), 'R\n');
    git(work, ['add', 'f.txt']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);

    // Same, but the manifest is removed during the amend. The message is still
    // "handoff" and f.txt has no markers, so it must be kept.
    git(work, ['checkout', '-q', '-b', 'sync-conflict/amended-handoff-no-manifest', before]);
    git(work, ['merge', '--no-ff', 'upstream', '-m', 'handoff'], true);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'handoff']);
    writeFileSync(
      join(work, '.sync-conflict.json'),
      `${JSON.stringify({ upstream_sha: upstream, repo_sha_before: before })}\n`
    );
    git(work, ['add', '.']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);
    writeFileSync(join(work, 'f.txt'), 'R2\n');
    git(work, ['add', 'f.txt']);
    git(work, ['rm', '-q', '.sync-conflict.json']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);

    git(work, ['checkout', '-q', 'main']);
    git(work, ['push', '-q', 'origin', 'main']);
    git(work, [
      'push',
      '-q',
      'origin',
      'sync-conflict/only-handoff',
      'sync-conflict/merge-only',
      'sync-conflict/real-handoff',
      'sync-conflict/amended-handoff',
      'sync-conflict/amended-handoff-no-manifest',
    ]);

    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/bash\nurl="$2"\ncase "$url" in *state=open*) echo 0 ;; *state=closed*) : ;; esac\n'
    );
    chmodSync(join(bin, 'gh'), 0o755);

    const prunePath = join(root, 'prune.sh');
    writeFileSync(prunePath, extractPruneScript());
    const summaryPath = join(root, 'summary.md');
    writeFileSync(summaryPath, '');

    const result = spawnSync('bash', ['-e', prunePath], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        REPO: 'owner/repo',
        OWNER: 'owner',
        GH_TOKEN: 'x',
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    if (result.status !== 0) {
      throw new Error(`prune failed: ${result.stderr || result.stdout}`);
    }

    const branches = git(origin, ['branch', '--format=%(refname:short)']).stdout;
    expect(branches).toContain('sync-conflict/merge-only');
    expect(branches).toContain('sync-conflict/amended-handoff');
    expect(branches).toContain('sync-conflict/amended-handoff-no-manifest');
    expect(branches).not.toContain('sync-conflict/only-handoff');
    expect(branches).not.toContain('sync-conflict/real-handoff');

    // These shapes differ only in content, never in parent SHAs, so assert on
    // the reason text too: a resolution folded into the handoff merge must be
    // reported as unique work, and a markers-only handoff must not.
    const summary = readFileSync(summaryPath, 'utf8');
    const rowFor = (name: string) =>
      summary.split('\n').find((line) => line.startsWith('| `') && line.includes(name)) ?? '';
    expect(rowFor('sync-conflict/merge-only')).toContain('独有提交');
    expect(rowFor('sync-conflict/amended-handoff')).toContain('独有提交');
    expect(rowFor('sync-conflict/amended-handoff-no-manifest')).toContain('独有提交');
    expect(rowFor('sync-conflict/real-handoff')).toContain('已删除');
    expect(rowFor('sync-conflict/only-handoff')).toContain('已删除');
    expect(summary).toContain('保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('prune keeps unique resolutions and deletes markers-only handoffs', regressionTest);
