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
import { dirname, join } from 'node:path';
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
  const full = join(cwd, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
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

    git(work, ['checkout', '-q', '-b', 'before', m1]);
    commitFile(work, 'f.txt', 'L\n', 'BEFORE');
    // A sponsor/ad asset that exists in the upstream tip, so the handoff's
    // "auto-discard" step has something real to remove. Without this the
    // add+rm pair is a no-op and the P2-3 path never fires.
    commitFile(work, 'assets/sponsorQuickStart.css', 'ad\n', 'SPONSOR');
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

    // Creates the conflicted handoff merge (markers + manifest). The manifest
    // lists f.txt in conflict_files, like the workflow's real handoff.
    //
    // IMPORTANT: commit with `git commit` while MERGE_HEAD is present so the
    // result is a real two-parent merge. `git commit --amend` on top of a merge
    // flattens it to a single parent, which silently stops exercising the merge
    // branch of the prune logic.
    const conflictedHandoff = (branch: string) => {
      git(work, ['checkout', '-q', '-b', branch, before]);
      git(work, ['merge', '--no-ff', 'upstream', '-m', 'ci: sync-conflict handoff'], true);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'ci: sync-conflict handoff']);
      writeFileSync(
        join(work, '.sync-conflict.json'),
        `${JSON.stringify({
          upstream_sha: upstream,
          repo_sha_before: before,
          conflict_files: ['f.txt'],
        })}\n`
      );
      git(work, ['add', '.']);
      // amend is safe HERE because the merge commit already exists; amend only
      // rewrites that commit (it does not flatten a merge into a non-merge).
      git(work, ['commit', '-q', '--amend', '--no-edit']);
    };
    const amendHandoff = (content: string | null, removeManifest = false) => {
      if (content !== null) {
        writeFileSync(join(work, 'f.txt'), content);
        git(work, ['add', 'f.txt']);
      }
      if (removeManifest) git(work, ['rm', '-q', '.sync-conflict.json']);
      git(work, ['commit', '-q', '--amend', '--no-edit']);
    };

    // Unresolved scene: complete markers, must be deleted.
    conflictedHandoff('sync-conflict/real-handoff');
    // Resolution amended into the handoff merge, manifest kept, must be kept.
    conflictedHandoff('sync-conflict/amended-manifest');
    amendHandoff('R\n');
    // Same, manifest removed during the amend, must be kept.
    conflictedHandoff('sync-conflict/amended-nomanifest');
    amendHandoff('R2\n', true);
    // Setext heading underline is not a conflict marker.
    conflictedHandoff('sync-conflict/setext');
    amendHandoff('Title\n=======\n');
    // A lone <<<<<<< example is not a complete conflict block.
    conflictedHandoff('sync-conflict/marker-text');
    amendHandoff('<<<<<<< example\n');
    // Deleted during resolution: the deletion is the resolution result.
    conflictedHandoff('sync-conflict/delete-file');
    git(work, ['rm', '-q', 'f.txt']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);
    // take-ours: the result equals the first parent, so diff-tree -c omits it;
    // the manifest's conflict_files must still catch it.
    conflictedHandoff('sync-conflict/take-ours');
    amendHandoff('L\n');
    // P2-1 is asserted separately below (file_state unit check): an open/close
    // pair without a separator is legal text, not an unresolved conflict.
    // P2-3: the handoff auto-discards upstream sponsor/ad files (git rm during the
    // merge, before the conflict list is written). Those paths are NOT in
    // conflict_files, so deleting them is handoff noise, not a resolution —
    // counting them would keep every synced branch alive as stale.
    // The asset is committed in `before`, so removing it here is a real deletion
    // (an add+rm pair would be a no-op and would not exercise this path).
    // f.txt stays UNRESOLVED: pure scene + noise, so the branch must be pruned.
    conflictedHandoff('sync-conflict/auto-discarded');
    git(work, ['rm', '-qf', 'assets/sponsorQuickStart.css']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);
    // Contrast: same sponsor drop, but f.txt IS resolved (take-ours) — real work
    // exists, so the branch must survive regardless of the noise.
    conflictedHandoff('sync-conflict/auto-discarded-resolved');
    writeFileSync(join(work, 'f.txt'), 'L\n');
    git(work, ['add', 'f.txt']);
    git(work, ['rm', '-qf', 'assets/sponsorQuickStart.css']);
    git(work, ['commit', '-q', '--amend', '--no-edit']);
    // Resolving by deleting a file that IS listed in conflict_files counts as
    // work: that deletion is the resolution (covered by delete-file above, kept
    // here as the contrasting shape for auto-discarded).
    // P1: take-ours with the manifest deleted. f.txt resolves to L, which equals
    // the first parent, so `diff-tree -c` reports NO files for the merge — the
    // branch has no visible unique content, and only the manifest could have
    // proven the conflict existed. It must still be KEPT: git cannot distinguish
    // this from "never conflicted", and deleting loses the resolution.
    conflictedHandoff('sync-conflict/take-ours-nomanifest');
    amendHandoff('L\n', true);
    // P2-3 (P2 后续): an older manifest stored conflict_files as a STRING rather
    // than an array. `.[]` on a string yields nothing, which silently disabled
    // the take-ours fallback and deleted the resolved branch.
    conflictedHandoff('sync-conflict/legacy-string-manifest');
    amendHandoff('L\n');
    writeFileSync(
      join(work, '.sync-conflict.json'),
      `${JSON.stringify({ upstream_sha: upstream, repo_sha_before: before, conflict_files: 'f.txt' })}\n`
    );
    git(work, ['add', '.']);
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
      'sync-conflict/amended-manifest',
      'sync-conflict/amended-nomanifest',
      'sync-conflict/setext',
      'sync-conflict/marker-text',
      'sync-conflict/delete-file',
      'sync-conflict/take-ours',
      'sync-conflict/auto-discarded',
      'sync-conflict/auto-discarded-resolved',
      'sync-conflict/take-ours-nomanifest',
      'sync-conflict/legacy-string-manifest',
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
    const branchList = branches.split('\n').map((line) => line.trim());
    expect(branchList).toContain('sync-conflict/merge-only');
    expect(branchList).toContain('sync-conflict/amended-manifest');
    expect(branchList).toContain('sync-conflict/amended-nomanifest');
    expect(branchList).toContain('sync-conflict/setext');
    expect(branchList).toContain('sync-conflict/marker-text');
    expect(branchList).toContain('sync-conflict/delete-file');
    expect(branchList).toContain('sync-conflict/take-ours');
    expect(branchList).not.toContain('sync-conflict/only-handoff');
    expect(branchList).not.toContain('sync-conflict/real-handoff');

    // These shapes differ only in content, never in parent SHAs, so assert on
    // the reason text too: a resolution folded into the handoff merge must be
    // reported as unique work, and a markers-only handoff must not.
    const summary = readFileSync(summaryPath, 'utf8');
    const rowFor = (name: string) =>
      summary.split('\n').find((line) => line.includes(`| \`${name}\` |`)) ?? '';
    expect(rowFor('sync-conflict/merge-only')).toContain('独有提交');
    expect(rowFor('sync-conflict/amended-manifest')).toContain('独有提交');
    expect(rowFor('sync-conflict/amended-nomanifest')).toContain('独有提交');
    expect(rowFor('sync-conflict/setext')).toContain('独有提交');
    expect(rowFor('sync-conflict/marker-text')).toContain('独有提交');
    expect(rowFor('sync-conflict/delete-file')).toContain('独有提交');
    expect(rowFor('sync-conflict/take-ours')).toContain('独有提交');
    // take-ours with the manifest deleted: git cannot distinguish this from a
    // handoff that never had a conflict, so the branch must be KEPT (either as
    // recognised work or explicitly as unverifiable) — never deleted.
    expect(rowFor('sync-conflict/take-ours-nomanifest')).toContain('保留');
    // Legacy string-format manifest must still protect the take-ours resolution.
    expect(branchList).toContain('sync-conflict/legacy-string-manifest');
    expect(rowFor('sync-conflict/legacy-string-manifest')).toContain('独有提交');
    // P2-3: an auto-discarded sponsor file is handoff noise, not a resolution.
    expect(branchList).not.toContain('sync-conflict/auto-discarded');
    expect(branchList).toContain('sync-conflict/auto-discarded-resolved');
    expect(rowFor('sync-conflict/real-handoff')).toContain('已删除');
    expect(rowFor('sync-conflict/only-handoff')).toContain('已删除');
    expect(summary).toContain('保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('prune keeps unique resolutions and deletes markers-only handoffs', regressionTest);

/**
 * P2-1: `file_state` must only call a file "unresolved" when it holds a COMPLETE
 * conflict block (open, separator, close). A document that merely quotes an
 * open/close pair — no separator line — is legal text, and treating it as an
 * unresolved scene pins the branch forever.
 */
const fileStateTest = () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-upstream-markers-'));
  try {
    const work = join(root, 'w');
    mkdirSync(work);
    git(work, ['init', '-q']);
    git(work, ['config', 'user.email', 't@example.com']);
    git(work, ['config', 'user.name', 't']);

    const script = extractPruneScript();
    const start = script.indexOf('file_state() {');
    if (start < 0) throw new Error('file_state not found in the prune step');
    const end = script.indexOf('while IFS= read -r b; do', start);
    const fn = script.slice(start, end);
    const harness = join(root, 'fs.sh');
    writeFileSync(harness, `#!/bin/bash\n${fn}\nfile_state "$1" "$2"; echo "state=$?"\n`);
    chmodSync(harness, 0o755);

    const commit = (content: string) => {
      writeFileSync(join(work, 'f.txt'), content);
      git(work, ['add', 'f.txt']);
      git(work, ['commit', '-qm', 'c']);
      return git(work, ['rev-parse', 'HEAD']).stdout.trim();
    };

    const stateOf = (content: string) => {
      const sha = commit(content);
      const out = spawnSync('bash', [harness, sha, 'f.txt'], { cwd: work, encoding: 'utf8' });
      const m = /state=(\d)/.exec(out.stdout ?? '');
      if (!m) throw new Error(`no state in output: ${out.stdout}${out.stderr}`);
      return Number(m[1]);
    };

    // 0 = unresolved, 1 = resolved/legal, 2 = deleted, 3 = error
    expect(stateOf('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> upstream\n')).toBe(0);
    // P2-1: no separator -> legal text, NOT an unresolved scene.
    expect(stateOf('Example:\n<<<<<<< HEAD\nours\n>>>>>>> upstream\ndone\n')).toBe(1);
    expect(stateOf('Title\n=======\n')).toBe(1);
    expect(stateOf('<<<<<<< example\n')).toBe(1);
    expect(stateOf('plain\n')).toBe(1);
    // P2-1 (P2 后续): these are all genuine unresolved scenes and must be seen
    // as such -- missing them leaves the branch stale forever.
    // CRLF line endings (a Windows checkout).
    expect(stateOf('<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> upstream\r\n')).toBe(0);
    // Marker runs longer than seven characters (git lengthens them when the
    // content itself contains a run of the same character).
    expect(stateOf('<<<<<<<<< HEAD\na\n=========\nb\n>>>>>>>>> upstream\n')).toBe(0);
    // diff3 conflict style carries an extra ||||||| base section.
    expect(stateOf('<<<<<<< HEAD\na\n||||||| base\nx\n=======\nb\n>>>>>>> upstream\n')).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('file_state treats only complete conflict blocks as unresolved', fileStateTest);

