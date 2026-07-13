import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDurableWorkLease, getDurableWorkUnit } from './db.js';
import { recordDurableEffect } from './durable-work-continuity.js';
import type { DurableEffectReceipt } from './types.js';

export const REPOSITORY_EXECUTION_SCOPE_VERSION = 1 as const;

export const REPOSITORY_EXECUTION_ACTION_CLASSES = [
  'repository_read',
  'repository_state',
  'repository_write',
  'verification_test',
  'verification_typecheck',
  'verification_build',
  'verification_lint',
  'verification_format',
] as const;

export type RepositoryExecutionActionClass =
  (typeof REPOSITORY_EXECUTION_ACTION_CLASSES)[number];

export interface RepositoryExecutionContext {
  invocationId: string;
  workId: string;
  checkpointId: string;
  planId: string;
  planVersion: number;
  turnId: string;
}

export interface RepositoryExecutionPrivacy {
  metadataOnly: true;
  rawCommandsStored: false;
  rawPathsStored: false;
  resultBodiesStored: false;
}

export interface RepositoryStateSnapshotV1 {
  version: 1;
  repositoryIdentityFingerprint: string;
  branch: string | null;
  currentHeadSha: string;
  dirtyPathCount: number;
  dirtyPathsDigest: string;
  dirtyContentDigest: string;
  stateFingerprint: string;
  capturedAt: string;
  privacy: RepositoryExecutionPrivacy;
}

export interface RepositoryExecutionScopeBindingV1 extends RepositoryExecutionContext {
  version: 1;
  scopeId: string;
  canonicalRootFingerprint: string;
  allowedRootFingerprint: string;
  gitDirectoryFingerprint: string;
  worktreeFingerprint: string;
  repositoryIdentityFingerprint: string;
  branch: string | null;
  baseHeadSha: string;
  currentHeadSha: string;
  dirtyPathCount: number;
  dirtyPathsDigest: string;
  dirtyContentDigest: string;
  baseStateFingerprint: string;
  allowedActionClasses: readonly RepositoryExecutionActionClass[];
  capturedAt: string;
  privacy: RepositoryExecutionPrivacy;
}

export type RepositoryReceiptKind = 'read' | 'write' | 'verification';
export type RepositoryReceiptOutcome = 'succeeded' | 'failed' | 'unresolved';

export interface RepositoryActionPreflightV1 extends RepositoryExecutionContext {
  version: 1;
  preflightId: string;
  scopeId: string;
  actionId: string;
  actionClass: RepositoryExecutionActionClass;
  receiptKind: RepositoryReceiptKind;
  targetFingerprint: string | null;
  sequence: number;
  preState: RepositoryStateSnapshotV1;
  startedAt: string;
  privacy: RepositoryExecutionPrivacy;
}

export interface RepositoryExecutionReceiptV1 extends RepositoryExecutionContext {
  version: 1;
  receiptId: string;
  preflightId: string;
  scopeId: string;
  actionId: string;
  actionClass: RepositoryExecutionActionClass;
  receiptKind: RepositoryReceiptKind;
  outcome: RepositoryReceiptOutcome;
  targetFingerprint: string | null;
  sequence: number;
  preState: RepositoryStateSnapshotV1;
  postState: RepositoryStateSnapshotV1;
  stateChanged: boolean;
  startedAt: string;
  completedAt: string;
  privacy: RepositoryExecutionPrivacy;
}

export type RepositoryPostVerificationCheck =
  | 'repository_identity'
  | 'expected_branch'
  | 'expected_head'
  | 'expected_dirty_paths'
  | 'clean_worktree'
  | 'state_changed_from_baseline'
  | 'successful_write_receipt'
  | 'successful_verification_after_last_write';

export interface RepositoryPostVerificationV1 extends RepositoryExecutionContext {
  version: 1;
  verificationId: string;
  scopeId: string;
  status: 'passed' | 'failed';
  checks: ReadonlyArray<{
    check: RepositoryPostVerificationCheck;
    passed: boolean;
  }>;
  state: RepositoryStateSnapshotV1;
  supportingReceiptIds: readonly string[];
  lastWriteReceiptId: string | null;
  latestVerificationReceiptId: string | null;
  verifiedAt: string;
  privacy: RepositoryExecutionPrivacy;
}

export type RepositoryExecutionScopeErrorCode =
  | 'invalid_context'
  | 'invalid_action'
  | 'invalid_repository_root'
  | 'invalid_allowed_root'
  | 'repository_root_symlink'
  | 'allowed_root_symlink'
  | 'repository_outside_allowed_root'
  | 'repository_root_not_worktree'
  | 'git_metadata_unavailable'
  | 'git_directory_symlink'
  | 'repository_identity_mismatch'
  | 'repository_state_stale'
  | 'execution_context_mismatch'
  | 'action_not_allowed'
  | 'action_id_reused'
  | 'target_required'
  | 'target_path_escape'
  | 'target_symlink'
  | 'unknown_preflight'
  | 'preflight_mismatch'
  | 'invalid_verification_expectation'
  | 'verification_failed'
  | 'durable_binding_invalid';

const ERROR_MESSAGES: Record<RepositoryExecutionScopeErrorCode, string> = {
  invalid_context: 'Repository execution context is invalid.',
  invalid_action: 'Repository execution action is invalid.',
  invalid_repository_root: 'Repository root is unavailable or invalid.',
  invalid_allowed_root: 'Allowed repository root is unavailable or invalid.',
  repository_root_symlink: 'Repository root may not be a symbolic link.',
  allowed_root_symlink: 'Allowed repository root may not be a symbolic link.',
  repository_outside_allowed_root:
    'Repository is outside the host-enforced allowed root.',
  repository_root_not_worktree:
    'Repository root must be the canonical Git worktree root.',
  git_metadata_unavailable: 'Required Git identity metadata is unavailable.',
  git_directory_symlink: 'Git directory may not be a symbolic link.',
  repository_identity_mismatch:
    'Repository identity does not match the bound execution scope.',
  repository_state_stale:
    'Repository state changed outside the bound execution sequence.',
  execution_context_mismatch:
    'Execution context does not match the bound execution scope.',
  action_not_allowed: 'Action class is not allowed by this execution scope.',
  action_id_reused: 'Action identifier has already been used in this scope.',
  target_required: 'This repository action requires a target.',
  target_path_escape: 'Target is outside the bound repository worktree.',
  target_symlink: 'Repository action targets may not traverse symbolic links.',
  unknown_preflight: 'Action preflight is unavailable or already consumed.',
  preflight_mismatch: 'Action preflight does not match the bound scope.',
  invalid_verification_expectation:
    'Repository post-verification expectation is invalid.',
  verification_failed:
    'Repository execution did not pass its bound post-verification.',
  durable_binding_invalid:
    'Repository evidence does not match the durable work binding.',
};

export class RepositoryExecutionScopeError extends Error {
  constructor(readonly code: RepositoryExecutionScopeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'RepositoryExecutionScopeError';
  }
}

export interface CreateRepositoryExecutionScopeInput extends RepositoryExecutionContext {
  repositoryRoot: string;
  allowedRoot: string;
  allowedActionClasses: readonly RepositoryExecutionActionClass[];
  expectedBaseHeadSha?: string;
  now?: () => Date;
}

export interface RepositoryActionInput extends RepositoryExecutionContext {
  repositoryRoot: string;
  actionId: string;
  actionClass: RepositoryExecutionActionClass;
  targetPath?: string;
}

export interface CompleteRepositoryActionInput extends RepositoryExecutionContext {
  repositoryRoot: string;
  outcome: RepositoryReceiptOutcome;
}

export interface VerifyRepositoryPostStateInput extends RepositoryExecutionContext {
  repositoryRoot: string;
  expectedBranch?: string | null;
  expectedHeadSha?: string;
  expectedDirtyPathsDigest?: string;
  requireCleanWorktree?: boolean;
  requireStateChangeFromBaseline?: boolean;
  requireSuccessfulWriteReceipt?: boolean;
  requireVerificationAfterLastWrite?: boolean;
}

interface RepositoryIdentity {
  canonicalRoot: string;
  canonicalRootFingerprint: string;
  gitDirectoryFingerprint: string;
  worktreeFingerprint: string;
  repositoryIdentityFingerprint: string;
}

interface ActivePreflight {
  record: RepositoryActionPreflightV1;
}

const PRIVACY: RepositoryExecutionPrivacy = Object.freeze({
  metadataOnly: true,
  rawCommandsStored: false,
  rawPathsStored: false,
  resultBodiesStored: false,
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,159}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const MAX_DIRTY_PATHS = 5_000;
const FILE_HASH_BUFFER_BYTES = 64 * 1024;
const ACTION_CLASS_SET = new Set<string>(REPOSITORY_EXECUTION_ACTION_CLASSES);

function fail(code: RepositoryExecutionScopeErrorCode): never {
  throw new RepositoryExecutionScopeError(code);
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertSafeId(value: string): void {
  if (!SAFE_ID.test(value)) fail('invalid_context');
}

function normalizeContext(
  input: RepositoryExecutionContext,
): RepositoryExecutionContext {
  assertSafeId(input.invocationId);
  assertSafeId(input.workId);
  assertSafeId(input.checkpointId);
  assertSafeId(input.planId);
  assertSafeId(input.turnId);
  if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 1) {
    fail('invalid_context');
  }
  return {
    invocationId: input.invocationId,
    workId: input.workId,
    checkpointId: input.checkpointId,
    planId: input.planId,
    planVersion: input.planVersion,
    turnId: input.turnId,
  };
}

function contextsEqual(
  left: RepositoryExecutionContext,
  right: RepositoryExecutionContext,
): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.workId === right.workId &&
    left.checkpointId === right.checkpointId &&
    left.planId === right.planId &&
    left.planVersion === right.planVersion &&
    left.turnId === right.turnId
  );
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function canonicalDirectory(
  candidate: string,
  invalidCode: 'invalid_repository_root' | 'invalid_allowed_root',
  symlinkCode: 'repository_root_symlink' | 'allowed_root_symlink',
): string {
  try {
    const resolved = path.resolve(candidate);
    const lexicalStat = fs.lstatSync(resolved);
    if (lexicalStat.isSymbolicLink()) fail(symlinkCode);
    if (!lexicalStat.isDirectory()) fail(invalidCode);
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error instanceof RepositoryExecutionScopeError) throw error;
    fail(invalidCode);
  }
}

function gitOutput(
  root: string,
  args: readonly string[],
  trim: boolean,
): string {
  try {
    const output = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return trim ? output.trim() : output;
    // Git errors can contain repository paths or command details; fail closed
    // with a stable metadata-only error instead of rethrowing them.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    fail('git_metadata_unavailable');
  }
}

function git(root: string, args: readonly string[]): string {
  return gitOutput(root, args, true);
}

function gitRaw(root: string, args: readonly string[]): string {
  return gitOutput(root, args, false);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function normalizeHead(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA.test(normalized)) fail('git_metadata_unavailable');
  return normalized;
}

function normalizeExpectedHead(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA.test(normalized)) fail('invalid_verification_expectation');
  return normalized;
}

function normalizeBranch(value: string): string | null {
  const branch = value.trim();
  if (branch === 'HEAD') return null;
  if (
    branch.length < 1 ||
    branch.length > 255 ||
    hasControlCharacters(branch)
  ) {
    fail('git_metadata_unavailable');
  }
  return branch;
}

function statIdentity(candidate: string): string {
  try {
    const stat = fs.statSync(candidate);
    return `${stat.dev}:${stat.ino}`;
    // Filesystem race errors can contain host paths. Convert them to the
    // metadata-only boundary error used for Git identity failures.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    fail('git_metadata_unavailable');
  }
}

function inspectIdentity(repositoryRoot: string): RepositoryIdentity {
  const canonicalRoot = canonicalDirectory(
    repositoryRoot,
    'invalid_repository_root',
    'repository_root_symlink',
  );
  const worktreeRoot = canonicalDirectory(
    git(canonicalRoot, ['rev-parse', '--show-toplevel']),
    'invalid_repository_root',
    'repository_root_symlink',
  );
  if (worktreeRoot !== canonicalRoot) fail('repository_root_not_worktree');

  const gitDirectoryValue = git(canonicalRoot, [
    'rev-parse',
    '--absolute-git-dir',
  ]);
  let gitDirectory: string;
  try {
    const lexicalGitDirectory = path.resolve(gitDirectoryValue);
    if (fs.lstatSync(lexicalGitDirectory).isSymbolicLink()) {
      fail('git_directory_symlink');
    }
    gitDirectory = fs.realpathSync(lexicalGitDirectory);
  } catch (error) {
    if (error instanceof RepositoryExecutionScopeError) throw error;
    fail('git_metadata_unavailable');
  }

  const canonicalRootFingerprint = fingerprint(
    `canonical-root\0${canonicalRoot}`,
  );
  const gitDirectoryFingerprint = fingerprint(
    `git-directory\0${gitDirectory}\0${statIdentity(gitDirectory)}`,
  );
  const worktreeFingerprint = fingerprint(
    `worktree\0${canonicalRoot}\0${statIdentity(canonicalRoot)}\0${gitDirectoryFingerprint}`,
  );
  return {
    canonicalRoot,
    canonicalRootFingerprint,
    gitDirectoryFingerprint,
    worktreeFingerprint,
    repositoryIdentityFingerprint: fingerprint(
      `repository-identity\0${canonicalRootFingerprint}\0${gitDirectoryFingerprint}\0${worktreeFingerprint}`,
    ),
  };
}

function dirtyPaths(status: string): string[] {
  const fields = status.split('\0').filter(Boolean);
  const paths: string[] = [];
  let renameSourceExpected = false;
  for (const field of fields) {
    if (renameSourceExpected) {
      paths.push(field);
      renameSourceExpected = false;
      continue;
    }
    if (field.length < 4) fail('git_metadata_unavailable');
    const statusCode = field.slice(0, 2);
    paths.push(field.slice(3));
    renameSourceExpected = /[RC]/.test(statusCode);
  }
  if (renameSourceExpected) fail('git_metadata_unavailable');
  const normalized = [
    ...new Set(paths.map((entry) => entry.replaceAll('\\', '/'))),
  ].sort();
  if (
    normalized.some(
      (entry) =>
        entry.length === 0 ||
        entry.startsWith('../') ||
        entry === '..' ||
        path.posix.isAbsolute(entry) ||
        entry.includes('\0'),
    )
  ) {
    fail('git_metadata_unavailable');
  }
  return normalized;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function sameFileVersion(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function worktreeEntryDigest(root: string, relativePath: string): string {
  const candidate = path.resolve(root, ...relativePath.split('/'));
  if (!isInsideOrEqual(root, candidate)) fail('git_metadata_unavailable');
  let before: fs.Stats;
  try {
    before = fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return fingerprint('worktree-entry\0missing');
    }
    fail('git_metadata_unavailable');
  }
  if (before.isSymbolicLink()) {
    let target: string;
    let after: fs.Stats;
    try {
      target = fs.readlinkSync(candidate);
      after = fs.lstatSync(candidate);
    } catch {
      fail('git_metadata_unavailable');
    }
    if (!sameFileVersion(before, after)) fail('git_metadata_unavailable');
    return fingerprint(`worktree-entry\0symlink\0${target}`);
  }
  if (!before.isFile()) fail('git_metadata_unavailable');

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
    const opened = fs.fstatSync(descriptor);
    if (!sameFileIdentity(before, opened) || !opened.isFile()) {
      fail('git_metadata_unavailable');
    }
    const hash = createHash('sha256');
    hash.update('worktree-entry\0file\0');
    const buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES);
    let offset = 0;
    for (;;) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        offset,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (!sameFileVersion(opened, after)) fail('git_metadata_unavailable');
    return `sha256:${hash.digest('hex')}`;
  } catch (error) {
    if (error instanceof RepositoryExecutionScopeError) throw error;
    fail('git_metadata_unavailable');
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The bounded metadata capture has already failed or completed; never
        // surface a host path from a close error.
      }
    }
  }
  return fail('git_metadata_unavailable');
}

function dirtyContentDigest(
  root: string,
  scopeId: string,
  changedPaths: readonly string[],
): string {
  if (changedPaths.length > MAX_DIRTY_PATHS) fail('git_metadata_unavailable');
  const hash = createHash('sha256');
  hash.update(`dirty-content\0${scopeId}\0`);
  for (const relativePath of changedPaths) {
    const indexState = gitRaw(root, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      relativePath,
    ]);
    hash.update(relativePath);
    hash.update('\0index\0');
    hash.update(indexState);
    hash.update('\0worktree\0');
    hash.update(worktreeEntryDigest(root, relativePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function freezeState(
  identity: RepositoryIdentity,
  scopeId: string,
  now: () => Date,
): RepositoryStateSnapshotV1 {
  const currentIdentity = inspectIdentity(identity.canonicalRoot);
  if (
    currentIdentity.repositoryIdentityFingerprint !==
    identity.repositoryIdentityFingerprint
  ) {
    fail('repository_identity_mismatch');
  }
  const branch = normalizeBranch(
    git(identity.canonicalRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
  );
  const currentHeadSha = normalizeHead(
    git(identity.canonicalRoot, ['rev-parse', 'HEAD']),
  );
  const changedPaths = dirtyPaths(
    gitRaw(identity.canonicalRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
    ]),
  );
  const dirtyContent = dirtyContentDigest(
    identity.canonicalRoot,
    scopeId,
    changedPaths,
  );
  const confirmedBranch = normalizeBranch(
    git(identity.canonicalRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
  );
  const confirmedHeadSha = normalizeHead(
    git(identity.canonicalRoot, ['rev-parse', 'HEAD']),
  );
  const confirmedPaths = dirtyPaths(
    gitRaw(identity.canonicalRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
    ]),
  );
  const confirmedContent = dirtyContentDigest(
    identity.canonicalRoot,
    scopeId,
    confirmedPaths,
  );
  if (
    confirmedBranch !== branch ||
    confirmedHeadSha !== currentHeadSha ||
    confirmedPaths.length !== changedPaths.length ||
    confirmedPaths.some((entry, index) => entry !== changedPaths[index]) ||
    confirmedContent !== dirtyContent
  ) {
    fail('git_metadata_unavailable');
  }
  const dirtyPathsDigest = fingerprint(
    `dirty-paths\0${scopeId}\0${changedPaths.join('\0')}`,
  );
  const capturedAt = now().toISOString();
  const stateFingerprint = fingerprint(
    [
      'repository-state',
      currentIdentity.repositoryIdentityFingerprint,
      branch || 'detached',
      currentHeadSha,
      dirtyPathsDigest,
      dirtyContent,
      String(changedPaths.length),
    ].join('\0'),
  );
  return Object.freeze({
    version: 1,
    repositoryIdentityFingerprint:
      currentIdentity.repositoryIdentityFingerprint,
    branch,
    currentHeadSha,
    dirtyPathCount: changedPaths.length,
    dirtyPathsDigest,
    dirtyContentDigest: dirtyContent,
    stateFingerprint,
    capturedAt,
    privacy: PRIVACY,
  });
}

function receiptKindFor(
  actionClass: RepositoryExecutionActionClass,
): RepositoryReceiptKind {
  if (actionClass === 'repository_write') return 'write';
  if (actionClass.startsWith('verification_')) return 'verification';
  return 'read';
}

function normalizeAllowedActions(
  actions: readonly RepositoryExecutionActionClass[],
): readonly RepositoryExecutionActionClass[] {
  if (actions.length === 0) fail('invalid_action');
  const unique = [...new Set(actions)];
  if (unique.some((action) => !ACTION_CLASS_SET.has(action))) {
    fail('invalid_action');
  }
  return Object.freeze(unique.sort((left, right) => left.localeCompare(right)));
}

export class RepositoryExecutionScope {
  readonly binding: RepositoryExecutionScopeBindingV1;

  readonly #context: RepositoryExecutionContext;
  readonly #declaredRoot: string;
  readonly #identity: RepositoryIdentity;
  readonly #allowedActions: ReadonlySet<RepositoryExecutionActionClass>;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActivePreflight>();
  readonly #usedActionIds = new Set<string>();
  readonly #receipts: RepositoryExecutionReceiptV1[] = [];
  #sequence = 0;
  #expectedStateFingerprint: string;

  constructor(input: CreateRepositoryExecutionScopeInput) {
    this.#context = normalizeContext(input);
    this.#now = input.now || (() => new Date());
    const allowedActions = normalizeAllowedActions(input.allowedActionClasses);
    this.#allowedActions = new Set(allowedActions);
    this.#declaredRoot = path.resolve(input.repositoryRoot);

    const allowedRoot = canonicalDirectory(
      input.allowedRoot,
      'invalid_allowed_root',
      'allowed_root_symlink',
    );
    this.#identity = inspectIdentity(input.repositoryRoot);
    if (!isInsideOrEqual(allowedRoot, this.#identity.canonicalRoot)) {
      fail('repository_outside_allowed_root');
    }

    const scopeId = randomUUID();
    const baseline = freezeState(this.#identity, scopeId, this.#now);
    this.#expectedStateFingerprint = baseline.stateFingerprint;
    if (
      input.expectedBaseHeadSha &&
      normalizeExpectedHead(input.expectedBaseHeadSha) !==
        baseline.currentHeadSha
    ) {
      fail('repository_identity_mismatch');
    }
    this.binding = Object.freeze({
      version: 1,
      scopeId,
      ...this.#context,
      canonicalRootFingerprint: this.#identity.canonicalRootFingerprint,
      allowedRootFingerprint: fingerprint(`allowed-root\0${allowedRoot}`),
      gitDirectoryFingerprint: this.#identity.gitDirectoryFingerprint,
      worktreeFingerprint: this.#identity.worktreeFingerprint,
      repositoryIdentityFingerprint:
        this.#identity.repositoryIdentityFingerprint,
      branch: baseline.branch,
      baseHeadSha: baseline.currentHeadSha,
      currentHeadSha: baseline.currentHeadSha,
      dirtyPathCount: baseline.dirtyPathCount,
      dirtyPathsDigest: baseline.dirtyPathsDigest,
      dirtyContentDigest: baseline.dirtyContentDigest,
      baseStateFingerprint: baseline.stateFingerprint,
      allowedActionClasses: allowedActions,
      capturedAt: baseline.capturedAt,
      privacy: PRIVACY,
    });
  }

  #assertContext(input: RepositoryExecutionContext): void {
    const context = normalizeContext(input);
    if (!contextsEqual(this.#context, context)) {
      fail('execution_context_mismatch');
    }
  }

  #assertRepository(repositoryRoot: string): void {
    const identity = inspectIdentity(repositoryRoot);
    if (
      identity.repositoryIdentityFingerprint !==
      this.#identity.repositoryIdentityFingerprint
    ) {
      fail('repository_identity_mismatch');
    }
  }

  #targetFingerprint(targetPath: string | undefined): string | null {
    if (!targetPath) return null;
    if (targetPath.includes('\0') || targetPath.length > 4_096) {
      fail('target_path_escape');
    }
    const lexicalTarget = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.#declaredRoot, targetPath);
    const lexicalRelative = path.relative(this.#declaredRoot, lexicalTarget);
    if (
      lexicalRelative === '..' ||
      lexicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(lexicalRelative)
    ) {
      fail('target_path_escape');
    }

    const components = lexicalRelative
      .split(path.sep)
      .filter((component) => component.length > 0);
    let cursor = this.#declaredRoot;
    for (const component of components) {
      cursor = path.join(cursor, component);
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) fail('target_symlink');
      } catch (error) {
        if (error instanceof RepositoryExecutionScopeError) throw error;
        break;
      }
    }

    let existing = lexicalTarget;
    const missing: string[] = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) fail('target_path_escape');
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    let canonicalTarget: string;
    try {
      canonicalTarget = path.resolve(fs.realpathSync(existing), ...missing);
      // Filesystem errors may contain host paths; expose only the bounded
      // scope error at this trust boundary.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      fail('target_path_escape');
    }
    if (!isInsideOrEqual(this.#identity.canonicalRoot, canonicalTarget)) {
      fail('target_path_escape');
    }
    const relativeTarget = path
      .relative(this.#identity.canonicalRoot, canonicalTarget)
      .replaceAll(path.sep, '/');
    return fingerprint(
      `repository-target\0${this.binding.scopeId}\0${relativeTarget || '.'}`,
    );
  }

  captureState(
    input: RepositoryExecutionContext & { repositoryRoot: string },
  ): RepositoryStateSnapshotV1 {
    this.#assertContext(input);
    this.#assertRepository(input.repositoryRoot);
    return freezeState(this.#identity, this.binding.scopeId, this.#now);
  }

  preflightAction(input: RepositoryActionInput): RepositoryActionPreflightV1 {
    this.#assertContext(input);
    this.#assertRepository(input.repositoryRoot);
    assertSafeId(input.actionId);
    if (!ACTION_CLASS_SET.has(input.actionClass)) fail('invalid_action');
    if (!this.#allowedActions.has(input.actionClass)) {
      fail('action_not_allowed');
    }
    if (this.#usedActionIds.has(input.actionId)) fail('action_id_reused');
    if (
      (input.actionClass === 'repository_read' ||
        input.actionClass === 'repository_write') &&
      !input.targetPath
    ) {
      fail('target_required');
    }

    const targetFingerprint = this.#targetFingerprint(input.targetPath);
    const preflightId = randomUUID();
    const startedAt = this.#now().toISOString();
    const preState = freezeState(
      this.#identity,
      this.binding.scopeId,
      this.#now,
    );
    if (preState.stateFingerprint !== this.#expectedStateFingerprint) {
      fail('repository_state_stale');
    }
    const record = Object.freeze({
      version: 1 as const,
      preflightId,
      scopeId: this.binding.scopeId,
      ...this.#context,
      actionId: input.actionId,
      actionClass: input.actionClass,
      receiptKind: receiptKindFor(input.actionClass),
      targetFingerprint,
      sequence: ++this.#sequence,
      preState,
      startedAt,
      privacy: PRIVACY,
    });
    this.#usedActionIds.add(input.actionId);
    this.#active.set(preflightId, { record });
    return record;
  }

  completeAction(
    preflight: RepositoryActionPreflightV1,
    input: CompleteRepositoryActionInput,
  ): RepositoryExecutionReceiptV1 {
    this.#assertContext(input);
    this.#assertRepository(input.repositoryRoot);
    const active = this.#active.get(preflight.preflightId);
    if (!active) fail('unknown_preflight');
    if (
      active.record !== preflight ||
      preflight.scopeId !== this.binding.scopeId ||
      !contextsEqual(preflight, this.#context)
    ) {
      fail('preflight_mismatch');
    }
    if (
      input.outcome !== 'succeeded' &&
      input.outcome !== 'failed' &&
      input.outcome !== 'unresolved'
    ) {
      fail('invalid_action');
    }

    const postState = freezeState(
      this.#identity,
      this.binding.scopeId,
      this.#now,
    );
    const receipt = Object.freeze({
      version: 1 as const,
      receiptId: randomUUID(),
      preflightId: preflight.preflightId,
      scopeId: this.binding.scopeId,
      ...this.#context,
      actionId: preflight.actionId,
      actionClass: preflight.actionClass,
      receiptKind: preflight.receiptKind,
      outcome: input.outcome,
      targetFingerprint: preflight.targetFingerprint,
      sequence: preflight.sequence,
      preState: preflight.preState,
      postState,
      stateChanged:
        preflight.preState.stateFingerprint !== postState.stateFingerprint,
      startedAt: preflight.startedAt,
      completedAt: this.#now().toISOString(),
      privacy: PRIVACY,
    });
    this.#active.delete(preflight.preflightId);
    this.#receipts.push(receipt);
    this.#expectedStateFingerprint = postState.stateFingerprint;
    return receipt;
  }

  listReceipts(): readonly RepositoryExecutionReceiptV1[] {
    return Object.freeze([...this.#receipts]);
  }

  verifyPostState(
    input: VerifyRepositoryPostStateInput,
  ): RepositoryPostVerificationV1 {
    this.#assertContext(input);
    this.#assertRepository(input.repositoryRoot);
    const state = freezeState(this.#identity, this.binding.scopeId, this.#now);
    if (state.stateFingerprint !== this.#expectedStateFingerprint) {
      fail('repository_state_stale');
    }
    const checks: Array<{
      check: RepositoryPostVerificationCheck;
      passed: boolean;
    }> = [{ check: 'repository_identity', passed: true }];

    if (input.expectedBranch !== undefined) {
      if (
        input.expectedBranch !== null &&
        (input.expectedBranch.length < 1 ||
          input.expectedBranch.length > 255 ||
          hasControlCharacters(input.expectedBranch))
      ) {
        fail('invalid_verification_expectation');
      }
      checks.push({
        check: 'expected_branch',
        passed: state.branch === input.expectedBranch,
      });
    }
    if (input.expectedHeadSha !== undefined) {
      checks.push({
        check: 'expected_head',
        passed:
          state.currentHeadSha === normalizeExpectedHead(input.expectedHeadSha),
      });
    }
    if (input.expectedDirtyPathsDigest !== undefined) {
      if (!FINGERPRINT.test(input.expectedDirtyPathsDigest)) {
        fail('invalid_verification_expectation');
      }
      checks.push({
        check: 'expected_dirty_paths',
        passed: state.dirtyPathsDigest === input.expectedDirtyPathsDigest,
      });
    }
    if (input.requireCleanWorktree) {
      checks.push({
        check: 'clean_worktree',
        passed: state.dirtyPathCount === 0,
      });
    }
    if (input.requireStateChangeFromBaseline) {
      checks.push({
        check: 'state_changed_from_baseline',
        passed: state.stateFingerprint !== this.binding.baseStateFingerprint,
      });
    }

    const lastWrite = [...this.#receipts]
      .reverse()
      .find((receipt) => receipt.receiptKind === 'write');
    const successfulWrite = this.#receipts.find(
      (receipt) =>
        receipt.receiptKind === 'write' && receipt.outcome === 'succeeded',
    );
    const latestVerification = [...this.#receipts]
      .reverse()
      .find((receipt) => receipt.receiptKind === 'verification');
    if (input.requireSuccessfulWriteReceipt) {
      checks.push({
        check: 'successful_write_receipt',
        passed: Boolean(successfulWrite),
      });
    }
    if (input.requireVerificationAfterLastWrite) {
      checks.push({
        check: 'successful_verification_after_last_write',
        passed: Boolean(
          lastWrite &&
          latestVerification &&
          latestVerification.outcome === 'succeeded' &&
          latestVerification.sequence > lastWrite.sequence,
        ),
      });
    }

    const supportingReceiptIds = this.#receipts.map(
      (receipt) => receipt.receiptId,
    );
    const verifiedAt = this.#now().toISOString();
    return Object.freeze({
      version: 1,
      verificationId: randomUUID(),
      scopeId: this.binding.scopeId,
      ...this.#context,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks: Object.freeze(checks.map((check) => Object.freeze(check))),
      state,
      supportingReceiptIds: Object.freeze(supportingReceiptIds),
      lastWriteReceiptId: lastWrite?.receiptId || null,
      latestVerificationReceiptId: latestVerification?.receiptId || null,
      verifiedAt,
      privacy: PRIVACY,
    });
  }
}

export function createRepositoryExecutionScope(
  input: CreateRepositoryExecutionScopeInput,
): RepositoryExecutionScope {
  return new RepositoryExecutionScope(input);
}

/** Stable, metadata-only key used to bind durable work before execution. */
export function repositoryExecutionTargetScopeKey(
  repositoryRoot: string,
): string {
  return `repository:${inspectIdentity(repositoryRoot).repositoryIdentityFingerprint}`;
}

/**
 * Persist only host-issued, metadata-only repository receipts into the
 * canonical durable-work ledger. The caller retains raw paths and execution
 * details; continuity receives fingerprints and action classes only.
 */
export function persistRepositoryExecutionProof(input: {
  execution: RepositoryExecutionScope;
  verification: RepositoryPostVerificationV1;
  targetScopeKey: string;
}): readonly DurableEffectReceipt[] {
  const binding = input.execution.binding;
  const receipts = input.execution.listReceipts();
  const verification = input.verification;
  const durableWork = getDurableWorkUnit(binding.workId);
  const durableLease = durableWork?.leaseId
    ? getDurableWorkLease(durableWork.leaseId)
    : null;
  if (
    input.targetScopeKey !==
      `repository:${binding.repositoryIdentityFingerprint}` ||
    !durableWork ||
    durableWork.status !== 'executing' ||
    !durableWork.leaseId ||
    !durableLease ||
    durableLease.status !== 'active' ||
    durableWork.planVersion !== binding.planVersion ||
    durableWork.checkpointHeadId !== binding.checkpointId
  ) {
    fail('durable_binding_invalid');
  }
  if (
    verification.status !== 'passed' ||
    verification.scopeId !== binding.scopeId ||
    !contextsEqual(verification, binding) ||
    verification.state.repositoryIdentityFingerprint !==
      binding.repositoryIdentityFingerprint
  ) {
    fail('verification_failed');
  }
  if (
    receipts.length === 0 ||
    verification.supportingReceiptIds.length !== receipts.length ||
    receipts.some(
      (receipt) =>
        receipt.scopeId !== binding.scopeId ||
        !contextsEqual(receipt, binding) ||
        !verification.supportingReceiptIds.includes(receipt.receiptId),
    )
  ) {
    fail('durable_binding_invalid');
  }

  return Object.freeze(
    receipts.map((receipt) =>
      recordDurableEffect({
        workId: binding.workId,
        checkpointId: binding.checkpointId,
        planVersion: binding.planVersion,
        nodeId: receipt.actionId,
        invocationId: binding.invocationId,
        actionClass: receipt.actionClass,
        leaseId: durableLease.leaseId,
        processGeneration: durableLease.processGeneration,
        leaseAssertionNow: receipt.completedAt,
        effectClass:
          receipt.actionClass === 'repository_write'
            ? 'repository_write'
            : 'read_only',
        status: receipt.outcome === 'unresolved' ? 'unknown' : receipt.outcome,
        targetScopeKey: input.targetScopeKey,
        preStateFingerprint: receipt.preState.stateFingerprint,
        postStateFingerprint: receipt.postState.stateFingerprint,
        verificationFingerprint:
          receipt.receiptKind === 'verification'
            ? verification.state.stateFingerprint
            : null,
        metadata: {
          receiptClass: 'repository_execution_scope_v1',
          verificationClass: receipt.actionClass,
          resultCode: `base_head:${binding.baseHeadSha}:sequence:${receipt.sequence}`,
          source: 'host_enforced_repository_scope',
        },
        now: receipt.completedAt,
      }),
    ),
  );
}
