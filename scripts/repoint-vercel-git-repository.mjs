import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  boundedFetch,
  boundedOperation,
  delayWithinDeadline,
} from "./bounded-fetch.mjs";

export const VERCEL_GIT_RELINK_TARGET_REPOSITORY = "brendonlee1006/novel";
export const VERCEL_GIT_RELINK_TARGET_URL =
  "https://github.com/brendonlee1006/novel.git";
export const VERCEL_GIT_RELINK_EXPECTED_SOURCE_REPOSITORY = "bobobo-org/novel";
export const VERCEL_GIT_RELINK_SOURCE_URL =
  "https://github.com/bobobo-org/novel.git";

const TARGET_GITHUB_REPOSITORY_ID = "1357493987";
const TARGET_GITHUB_REPOSITORY_NODE_ID = "R_kgDOUOm24w";
const SOURCE_GITHUB_REPOSITORY_ID = "1292526682";
const SOURCE_GITHUB_REPOSITORY_NODE_ID = "R_kgDOTQpkWg";
const TARGET_GITHUB_API_URL =
  "https://api.github.com/repos/brendonlee1006/novel";
const SOURCE_GITHUB_API_URL =
  "https://api.github.com/repos/bobobo-org/novel";
const TARGET_OWNER = "brendonlee1006";
const TARGET_REPOSITORY = "novel";
const SOURCE_OWNER = "bobobo-org";
const SOURCE_REPOSITORY = "novel";
const EXPECTED_PRODUCTION_BRANCH = "main";
const FORMAL_ALIAS = "novel-orcin.vercel.app";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERCEL_CLI_ENTRY_PATH = join(
  REPOSITORY_ROOT,
  "node_modules",
  "vercel",
  "dist",
  "index.js",
);
const FETCH_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 120_000;
const TOTAL_OPERATION_DEADLINE_MS = 180_000;
const POSTCONDITION_ATTEMPTS = 3;
const POSTCONDITION_RETRY_DELAY_MS = 1_000;
const SAFE_SCOPE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const SAFE_TEAM_ID = /^team_[A-Za-z0-9]{8,128}$/u;
const SAFE_PROJECT_ID = /^prj_[A-Za-z0-9]{8,128}$/u;
const SAFE_SIGNAL = /^[A-Z][A-Z0-9]{1,31}$/u;
const CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "LANG",
  "LC_ALL",
]);

export const VERCEL_GIT_RELINK_SAFE_ERROR_CODES = Object.freeze([
  "VERCEL_GIT_RELINK_CONFIGURATION_INVALID",
  "VERCEL_GIT_RELINK_TARGET_REPOSITORY_UNAVAILABLE",
  "VERCEL_GIT_RELINK_TARGET_REPOSITORY_IDENTITY_MISMATCH",
  "VERCEL_GIT_RELINK_TARGET_REPOSITORY_NOT_VISIBLE_TO_VERCEL",
  "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_UNAVAILABLE",
  "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_IDENTITY_MISMATCH",
  "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_NOT_VISIBLE_TO_VERCEL",
  "VERCEL_GIT_RELINK_AUTH_REJECTED",
  "VERCEL_GIT_RELINK_ACCESS_FORBIDDEN",
  "VERCEL_GIT_RELINK_TEAM_NOT_FOUND_OR_INACCESSIBLE",
  "VERCEL_GIT_RELINK_PROJECT_NOT_FOUND_OR_INACCESSIBLE",
  "VERCEL_GIT_RELINK_RATE_LIMITED",
  "VERCEL_GIT_RELINK_SERVICE_UNAVAILABLE",
  "VERCEL_GIT_RELINK_NETWORK_UNAVAILABLE",
  "VERCEL_GIT_RELINK_TIMEOUT",
  "VERCEL_GIT_RELINK_RESPONSE_INVALID",
  "VERCEL_GIT_RELINK_TEAM_IDENTITY_MISMATCH",
  "VERCEL_GIT_RELINK_PROJECT_IDENTITY_MISMATCH",
  "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_FOUND_OR_INACCESSIBLE",
  "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_PRODUCTION_READY",
  "VERCEL_GIT_RELINK_FORMAL_ALIAS_PROJECT_MISMATCH",
  "VERCEL_GIT_RELINK_SOURCE_NOT_EXPECTED",
  "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_ID_UNAVAILABLE",
  "VERCEL_GIT_RELINK_COMMAND_FAILED",
  "VERCEL_GIT_RELINK_COMMAND_TIMEOUT",
  "VERCEL_GIT_RELINK_TARGET_CONNECT_FAILED_COMPENSATED",
  "VERCEL_GIT_RELINK_TARGET_POSTCONDITION_FAILED_COMPENSATED",
  "VERCEL_GIT_RELINK_COMPENSATION_FAILED",
  "VERCEL_GIT_RELINK_RESTORE_SOURCE_STATE_INVALID",
  "VERCEL_GIT_RELINK_SOURCE_RESTORE_FAILED",
  "VERCEL_GIT_RELINK_LOCAL_WORKSPACE_FAILED",
  "VERCEL_GIT_RELINK_LOCAL_CLEANUP_FAILED",
  "VERCEL_GIT_RELINK_POSTCONDITION_FAILED",
  "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE",
]);

const SAFE_ERROR_CODE_SET = new Set(VERCEL_GIT_RELINK_SAFE_ERROR_CODES);
const SAFE_STAGES = new Set([
  "configuration",
  "target-repository",
  "team",
  "project-before",
  "formal-alias",
  "connect",
  "compensate-source",
  "restore-source",
  "project-after",
  "complete",
]);
const SAFE_LINK_STATES = new Set([
  "unchecked",
  "expected-source",
  "expected-source-id-unavailable",
  "expected-target",
  "unlinked",
  "unexpected",
]);
const SAFE_MODES = new Set(["apply", "dry-run", "restore-source"]);
const SAFE_POST_COMMAND_FAILURE_STATES = new Set([
  "not-applicable",
  "known-old",
  "known-new",
  "known-unlinked",
  "unknown",
]);
const SAFE_COMPENSATION_STATES = new Set([
  "not-required",
  "restored-source",
  "failed",
  "unknown",
]);

class VercelGitRelinkError extends Error {
  constructor(code, stage, safeState = {}) {
    super(code);
    this.name = "VercelGitRelinkError";
    this.code = SAFE_ERROR_CODE_SET.has(code)
      ? code
      : "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE";
    this.stage = SAFE_STAGES.has(stage) ? stage : "configuration";
    this.safeState = sanitizeState(safeState);
  }
}

function normalizedString(value) {
  return String(value ?? "").trim();
}

function configurationError() {
  throw new VercelGitRelinkError(
    "VERCEL_GIT_RELINK_CONFIGURATION_INVALID",
    "configuration",
  );
}

export function vercelGitRelinkConfigurationFromEnvironment(environment = process.env) {
  const token = normalizedString(environment.VERCEL_TOKEN);
  const teamId = normalizedString(environment.VERCEL_ORG_ID);
  const projectId = normalizedString(environment.VERCEL_PROJECT_ID);
  const scope = normalizedString(environment.VERCEL_SCOPE).toLowerCase();
  if (
    !token
    || token.length > 4096
    || !SAFE_TEAM_ID.test(teamId)
    || !SAFE_PROJECT_ID.test(projectId)
    || !SAFE_SCOPE.test(scope)
  ) configurationError();
  return Object.freeze({ token, teamId, projectId, scope });
}

function initialState(mode) {
  return {
    mode,
    targetRepositoryReadable: false,
    targetRepositoryIdentityMatches: false,
    sourceRepositoryReadable: false,
    sourceRepositoryIdentityMatches: false,
    vercelGitNamespaceReadable: false,
    vercelTargetRepositoryVisible: false,
    vercelSourceRepositoryVisible: false,
    teamReadable: false,
    teamIdentityMatches: false,
    projectReadable: false,
    projectIdentityMatches: false,
    formalAliasReadable: false,
    formalAliasProjectMatches: false,
    formalAliasProductionReady: false,
    initialLinkState: "unchecked",
    finalLinkState: "unchecked",
    productionBranchIsMain: false,
    postCommandFailureState: "not-applicable",
    postCommandFailureCheckCompleted: false,
    gitLinkMutationAttemptCount: 0,
    gitLinkMutationVerifiedCount: 0,
    sourceRestoreMutationAttemptCount: 0,
    sourceRestoreMutationVerifiedCount: 0,
    compensationState: "not-required",
    environmentMutationCount: 0,
    deploymentMutationCount: 0,
    aliasMutationCount: 0,
    supabaseMutationCount: 0,
  };
}

function sanitizeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1 ? value : 0;
}

function sanitizeState(state = {}) {
  return Object.freeze({
    mode: SAFE_MODES.has(state.mode) ? state.mode : "dry-run",
    targetRepositoryReadable: state.targetRepositoryReadable === true,
    targetRepositoryIdentityMatches: state.targetRepositoryIdentityMatches === true,
    sourceRepositoryReadable: state.sourceRepositoryReadable === true,
    sourceRepositoryIdentityMatches: state.sourceRepositoryIdentityMatches === true,
    vercelGitNamespaceReadable: state.vercelGitNamespaceReadable === true,
    vercelTargetRepositoryVisible: state.vercelTargetRepositoryVisible === true,
    vercelSourceRepositoryVisible: state.vercelSourceRepositoryVisible === true,
    teamReadable: state.teamReadable === true,
    teamIdentityMatches: state.teamIdentityMatches === true,
    projectReadable: state.projectReadable === true,
    projectIdentityMatches: state.projectIdentityMatches === true,
    formalAliasReadable: state.formalAliasReadable === true,
    formalAliasProjectMatches: state.formalAliasProjectMatches === true,
    formalAliasProductionReady: state.formalAliasProductionReady === true,
    initialLinkState: SAFE_LINK_STATES.has(state.initialLinkState)
      ? state.initialLinkState
      : "unchecked",
    finalLinkState: SAFE_LINK_STATES.has(state.finalLinkState)
      ? state.finalLinkState
      : "unchecked",
    productionBranchIsMain: state.productionBranchIsMain === true,
    postCommandFailureState: SAFE_POST_COMMAND_FAILURE_STATES.has(
      state.postCommandFailureState,
    ) ? state.postCommandFailureState : "unknown",
    postCommandFailureCheckCompleted: state.postCommandFailureCheckCompleted === true,
    gitLinkMutationAttemptCount: sanitizeCount(state.gitLinkMutationAttemptCount),
    gitLinkMutationVerifiedCount: sanitizeCount(state.gitLinkMutationVerifiedCount),
    sourceRestoreMutationAttemptCount: sanitizeCount(state.sourceRestoreMutationAttemptCount),
    sourceRestoreMutationVerifiedCount: sanitizeCount(state.sourceRestoreMutationVerifiedCount),
    compensationState: SAFE_COMPENSATION_STATES.has(state.compensationState)
      ? state.compensationState
      : "unknown",
    environmentMutationCount: 0,
    deploymentMutationCount: 0,
    aliasMutationCount: 0,
    supabaseMutationCount: 0,
  });
}

function fail(code, stage, state = {}) {
  throw new VercelGitRelinkError(code, stage, state);
}

function responseFailureCode(status, resource) {
  if (status === 401) return "VERCEL_GIT_RELINK_AUTH_REJECTED";
  if (status === 403) return "VERCEL_GIT_RELINK_ACCESS_FORBIDDEN";
  if (status === 404) {
    if (resource === "target-repository") {
      return "VERCEL_GIT_RELINK_TARGET_REPOSITORY_UNAVAILABLE";
    }
    if (resource === "source-repository") {
      return "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_UNAVAILABLE";
    }
    if (resource === "git-namespace" || resource === "git-target-repository") {
      return "VERCEL_GIT_RELINK_TARGET_REPOSITORY_NOT_VISIBLE_TO_VERCEL";
    }
    if (resource === "git-source-repository") {
      return "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_NOT_VISIBLE_TO_VERCEL";
    }
    if (resource === "formal-alias") {
      return "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_FOUND_OR_INACCESSIBLE";
    }
    if (resource === "team") {
      return "VERCEL_GIT_RELINK_TEAM_NOT_FOUND_OR_INACCESSIBLE";
    }
    return "VERCEL_GIT_RELINK_PROJECT_NOT_FOUND_OR_INACCESSIBLE";
  }
  if (status === 429) return "VERCEL_GIT_RELINK_RATE_LIMITED";
  if (status >= 500 && status <= 599) {
    return "VERCEL_GIT_RELINK_SERVICE_UNAVAILABLE";
  }
  return resource === "target-repository"
    ? "VERCEL_GIT_RELINK_TARGET_REPOSITORY_UNAVAILABLE"
    : "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE";
}

async function readJsonWithoutFailureBody({
  url,
  token,
  resource,
  stage,
  fetcher,
  deadlineAt,
}) {
  let response;
  try {
    response = await boundedFetch(fetcher, url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: token
        ? { Accept: "application/json", Authorization: `Bearer ${token}` }
        : { Accept: "application/vnd.github+json" },
    }, {
      timeoutMs: FETCH_TIMEOUT_MS,
      deadlineAt,
      timeoutCode: "VERCEL_GIT_RELINK_TIMEOUT",
    });
  } catch (error) {
    if (error?.code === "VERCEL_GIT_RELINK_TIMEOUT") {
      fail("VERCEL_GIT_RELINK_TIMEOUT", stage);
    }
    fail("VERCEL_GIT_RELINK_NETWORK_UNAVAILABLE", stage);
  }

  if (!response?.ok) {
    await response?.body?.cancel?.().catch(() => undefined);
    fail(responseFailureCode(Number(response?.status), resource), stage);
  }

  try {
    return await boundedOperation(() => response.json(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      deadlineAt,
      timeoutCode: "VERCEL_GIT_RELINK_TIMEOUT",
      onTimeout: () => response.body?.cancel?.().catch(() => undefined),
    });
  } catch (error) {
    if (error?.code === "VERCEL_GIT_RELINK_TIMEOUT") {
      fail("VERCEL_GIT_RELINK_TIMEOUT", stage);
    }
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", stage);
  }
}

async function readPinnedRepository({
  fetcher,
  deadlineAt,
  apiUrl,
  resource,
  expectedId,
  expectedNodeId,
  expectedFullName,
  expectedOwner,
  expectedRepository,
  identityMismatchCode,
}) {
  const body = await readJsonWithoutFailureBody({
    url: new URL(apiUrl),
    token: null,
    resource,
    stage: "target-repository",
    fetcher,
    deadlineAt,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", "target-repository");
  }
  const identityMatches = String(body.id ?? "") === expectedId
    && normalizedString(body.node_id) === expectedNodeId
    && normalizedString(body.full_name).toLowerCase()
      === expectedFullName
    && normalizedString(body.owner?.login).toLowerCase() === expectedOwner
    && normalizedString(body.name).toLowerCase() === expectedRepository
    && normalizedString(body.default_branch) === EXPECTED_PRODUCTION_BRANCH
    && body.archived === false
    && body.disabled === false;
  if (!identityMatches) {
    fail(
      identityMismatchCode,
      "target-repository",
    );
  }
  return Object.freeze({ readable: true, identityMatches: true });
}

async function readTargetRepository({ fetcher, deadlineAt }) {
  return readPinnedRepository({
    fetcher,
    deadlineAt,
    apiUrl: TARGET_GITHUB_API_URL,
    resource: "target-repository",
    expectedId: TARGET_GITHUB_REPOSITORY_ID,
    expectedNodeId: TARGET_GITHUB_REPOSITORY_NODE_ID,
    expectedFullName: VERCEL_GIT_RELINK_TARGET_REPOSITORY,
    expectedOwner: TARGET_OWNER,
    expectedRepository: TARGET_REPOSITORY,
    identityMismatchCode: "VERCEL_GIT_RELINK_TARGET_REPOSITORY_IDENTITY_MISMATCH",
  });
}

async function readSourceRepository({ fetcher, deadlineAt }) {
  return readPinnedRepository({
    fetcher,
    deadlineAt,
    apiUrl: SOURCE_GITHUB_API_URL,
    resource: "source-repository",
    expectedId: SOURCE_GITHUB_REPOSITORY_ID,
    expectedNodeId: SOURCE_GITHUB_REPOSITORY_NODE_ID,
    expectedFullName: VERCEL_GIT_RELINK_EXPECTED_SOURCE_REPOSITORY,
    expectedOwner: SOURCE_OWNER,
    expectedRepository: SOURCE_REPOSITORY,
    identityMismatchCode: "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_IDENTITY_MISMATCH",
  });
}

function safeNamespaceIdentifier(value) {
  const normalized = normalizedString(value);
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(normalized) ? normalized : null;
}

function isExplicitFalse(value) {
  return value === false || value === "false";
}

function repositoryCandidates(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const candidates = [];
  const containers = [body];
  if (body.data && typeof body.data === "object") containers.push(body.data);
  if (body.result && typeof body.result === "object") containers.push(body.result);
  for (const container of containers) {
    if (Array.isArray(container)) {
      candidates.push(...container);
      continue;
    }
    for (const key of ["repositories", "repos", "results", "items", "data"]) {
      if (Array.isArray(container?.[key])) candidates.push(...container[key]);
    }
  }
  if (candidates.length === 0 && !Array.isArray(body)) candidates.push(body);
  return candidates;
}

function repositoryCandidateMatchesPinned(candidate, specification) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const repositoryId = normalizedString(
    candidate.repoId ?? candidate.repositoryId ?? candidate.id,
  );
  const path = normalizedString(
    candidate.full_name
      ?? candidate.fullName
      ?? candidate.path
      ?? candidate.slug
      ?? candidate.repo,
  ).replace(/\.git$/iu, "").toLowerCase();
  const owner = normalizedString(
    candidate.owner?.login ?? candidate.owner ?? candidate.org ?? candidate.namespace,
  ).toLowerCase();
  const name = normalizedString(
    candidate.name ?? candidate.repository ?? candidate.repo,
  ).replace(/\.git$/iu, "").toLowerCase();
  const identityMatches = path === specification.fullName
    || (owner === specification.owner && name === specification.repository);
  return repositoryId === specification.repositoryId && identityMatches;
}

async function readVercelRepositoryInNamespace({
  specification,
  namespaces,
  configuration,
  fetcher,
  deadlineAt,
}) {
  const namespaceCandidates = namespaces.filter((entry) => (
    entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && normalizedString(entry.provider).toLowerCase() === "github"
    && normalizedString(entry.slug).toLowerCase() === specification.owner
    && isExplicitFalse(entry.requireReauth)
    && safeNamespaceIdentifier(entry.id)
    && safeNamespaceIdentifier(entry.installationId)
  ));
  if (namespaceCandidates.length !== 1) {
    fail(
      specification.notVisibleCode,
      "target-repository",
    );
  }
  const namespace = namespaceCandidates[0];
  const repositoriesUrl = new URL(
    "https://api.vercel.com/v1/integrations/search-repo",
  );
  repositoriesUrl.searchParams.set("query", specification.repository);
  repositoriesUrl.searchParams.set("namespaceId", normalizedString(namespace.id));
  repositoriesUrl.searchParams.set("provider", "github");
  repositoriesUrl.searchParams.set(
    "installationId",
    normalizedString(namespace.installationId),
  );
  repositoriesUrl.searchParams.set("teamId", configuration.teamId);
  repositoriesUrl.searchParams.set("slug", configuration.scope);
  const repositories = await readJsonWithoutFailureBody({
    url: repositoriesUrl,
    token: configuration.token,
    resource: specification.resource,
    stage: "target-repository",
    fetcher,
    deadlineAt,
  });
  const matches = repositoryCandidates(repositories)
    .filter((candidate) => repositoryCandidateMatchesPinned(candidate, specification));
  if (matches.length !== 1) {
    fail(
      specification.notVisibleCode,
      "target-repository",
    );
  }
  return true;
}

async function readVercelRepositoryAvailability({
  configuration,
  fetcher,
  deadlineAt,
  requireTarget,
}) {
  const namespacesUrl = new URL(
    "https://api.vercel.com/v1/integrations/git-namespaces",
  );
  namespacesUrl.searchParams.set("provider", "github");
  namespacesUrl.searchParams.set("viewerMetadata", "true");
  const namespaces = await readJsonWithoutFailureBody({
    url: namespacesUrl,
    token: configuration.token,
    resource: "git-namespace",
    stage: "target-repository",
    fetcher,
    deadlineAt,
  });
  if (!Array.isArray(namespaces)) {
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", "target-repository");
  }
  const sourceVisible = await readVercelRepositoryInNamespace({
    specification: {
      owner: SOURCE_OWNER,
      repository: SOURCE_REPOSITORY,
      repositoryId: SOURCE_GITHUB_REPOSITORY_ID,
      fullName: VERCEL_GIT_RELINK_EXPECTED_SOURCE_REPOSITORY,
      resource: "git-source-repository",
      notVisibleCode: "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_NOT_VISIBLE_TO_VERCEL",
    },
    namespaces,
    configuration,
    fetcher,
    deadlineAt,
  });
  let targetVisible = false;
  if (requireTarget) {
    targetVisible = await readVercelRepositoryInNamespace({
      specification: {
        owner: TARGET_OWNER,
        repository: TARGET_REPOSITORY,
        repositoryId: TARGET_GITHUB_REPOSITORY_ID,
        fullName: VERCEL_GIT_RELINK_TARGET_REPOSITORY,
        resource: "git-target-repository",
        notVisibleCode: "VERCEL_GIT_RELINK_TARGET_REPOSITORY_NOT_VISIBLE_TO_VERCEL",
      },
      namespaces,
      configuration,
      fetcher,
      deadlineAt,
    });
  }
  return Object.freeze({
    namespaceReadable: true,
    sourceRepositoryVisible: sourceVisible,
    targetRepositoryVisible: targetVisible,
  });
}

async function readTeam({ configuration, fetcher, deadlineAt }) {
  const url = new URL(
    `https://api.vercel.com/v2/teams/${encodeURIComponent(configuration.teamId)}`,
  );
  const body = await readJsonWithoutFailureBody({
    url,
    token: configuration.token,
    resource: "team",
    stage: "team",
    fetcher,
    deadlineAt,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", "team");
  }
  if (
    normalizedString(body.id) !== configuration.teamId
    || normalizedString(body.slug).toLowerCase() !== configuration.scope
  ) {
    fail("VERCEL_GIT_RELINK_TEAM_IDENTITY_MISMATCH", "team");
  }
  return Object.freeze({ readable: true, identityMatches: true });
}

function classifyLink(link, stage) {
  if (link == null) {
    return Object.freeze({ state: "unlinked", productionBranchIsMain: false });
  }
  if (typeof link !== "object" || Array.isArray(link)) {
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", stage);
  }
  const provider = normalizedString(link.type).toLowerCase();
  const owner = normalizedString(link.org).toLowerCase();
  const repository = normalizedString(link.repo).toLowerCase();
  const repositoryId = normalizedString(link.repoId);
  const productionBranch = normalizedString(link.productionBranch)
    || EXPECTED_PRODUCTION_BRANCH;
  const productionBranchIsMain = productionBranch === EXPECTED_PRODUCTION_BRANCH;
  if (
    provider === "github"
    && owner === TARGET_OWNER
    && repository === TARGET_REPOSITORY
    && repositoryId === TARGET_GITHUB_REPOSITORY_ID
  ) {
    return Object.freeze({ state: "expected-target", productionBranchIsMain });
  }
  if (
    provider === "github"
    && owner === SOURCE_OWNER
    && repository === SOURCE_REPOSITORY
    && repositoryId === SOURCE_GITHUB_REPOSITORY_ID
  ) {
    return Object.freeze({ state: "expected-source", productionBranchIsMain });
  }
  if (
    provider === "github"
    && owner === SOURCE_OWNER
    && repository === SOURCE_REPOSITORY
    && !repositoryId
  ) {
    return Object.freeze({
      state: "expected-source-id-unavailable",
      productionBranchIsMain,
    });
  }
  return Object.freeze({ state: "unexpected", productionBranchIsMain });
}

async function readProject({ configuration, fetcher, deadlineAt, stage }) {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(configuration.projectId)}`,
  );
  url.searchParams.set("teamId", configuration.teamId);
  const body = await readJsonWithoutFailureBody({
    url,
    token: configuration.token,
    resource: "project",
    stage,
    fetcher,
    deadlineAt,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", stage);
  }
  if (
    normalizedString(body.id) !== configuration.projectId
    || normalizedString(body.accountId) !== configuration.teamId
  ) {
    fail("VERCEL_GIT_RELINK_PROJECT_IDENTITY_MISMATCH", stage);
  }
  return Object.freeze({
    readable: true,
    identityMatches: true,
    ...classifyLink(body.link, stage),
  });
}

async function readFormalAliasDeployment({ configuration, fetcher, deadlineAt }) {
  const url = new URL(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(FORMAL_ALIAS)}`,
  );
  url.searchParams.set("url", FORMAL_ALIAS);
  url.searchParams.set("teamId", configuration.teamId);
  const body = await readJsonWithoutFailureBody({
    url,
    token: configuration.token,
    resource: "formal-alias",
    stage: "formal-alias",
    fetcher,
    deadlineAt,
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("VERCEL_GIT_RELINK_RESPONSE_INVALID", "formal-alias");
  }
  const deploymentState = body.readyState ?? body.state;
  return Object.freeze({
    readable: true,
    projectMatches: typeof body.projectId === "string"
      && body.projectId === configuration.projectId,
    productionReady: body.target === "production" && deploymentState === "READY",
  });
}

function safeProcessStatus(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : null;
}

function safeProcessSignal(value) {
  const normalized = normalizedString(value);
  return SAFE_SIGNAL.test(normalized) ? normalized : null;
}

export function vercelGitRelinkChildEnvironment(
  configuration,
  sourceEnvironment = process.env,
) {
  const allowedNames = new Set(CHILD_ENVIRONMENT_ALLOWLIST);
  const childEnvironment = {};
  for (const [key, rawValue] of Object.entries(sourceEnvironment ?? {})) {
    const normalizedKey = String(key).toUpperCase();
    if (!allowedNames.has(normalizedKey)) continue;
    const value = String(rawValue ?? "");
    if (!value) continue;
    childEnvironment[normalizedKey] = value;
  }
  childEnvironment.CI = "1";
  childEnvironment.NO_COLOR = "1";
  childEnvironment.VERCEL_TELEMETRY_DISABLED = "1";
  childEnvironment.VERCEL_ORG_ID = configuration.teamId;
  childEnvironment.VERCEL_PROJECT_ID = configuration.projectId;
  childEnvironment.VERCEL_SCOPE = configuration.scope;
  childEnvironment.VERCEL_TOKEN = configuration.token;
  return Object.freeze(childEnvironment);
}

async function runVercelGitConnectCommand(configuration, destination) {
  const repositoryUrl = destination === "target"
    ? VERCEL_GIT_RELINK_TARGET_URL
    : destination === "source"
      ? VERCEL_GIT_RELINK_SOURCE_URL
      : null;
  if (!repositoryUrl) {
    return Object.freeze({
      ok: false,
      errorCode: "VERCEL_GIT_RELINK_CONFIGURATION_INVALID",
      exitStatus: null,
      signal: null,
    });
  }
  let workspace;
  let result;
  let operationCode = "VERCEL_GIT_RELINK_COMMAND_FAILED";
  let cleanupFailed = false;
  try {
    workspace = await mkdtemp(join(tmpdir(), "novel-vercel-git-relink-"));
    const projectFile = join(workspace, ".vercel", "project.json");
    await mkdir(dirname(projectFile), { recursive: true });
    await writeFile(projectFile, `${JSON.stringify({
      orgId: configuration.teamId,
      projectId: configuration.projectId,
    })}\n`, { encoding: "utf8", flag: "wx" });

    result = spawnSync(process.execPath, [
      VERCEL_CLI_ENTRY_PATH,
      "git",
      "connect",
      repositoryUrl,
      "--yes",
      "--scope",
      configuration.scope,
    ], {
      cwd: workspace,
      env: vercelGitRelinkChildEnvironment(configuration),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      timeout: OPERATION_TIMEOUT_MS,
    });
    if (result?.error?.code === "ETIMEDOUT") {
      operationCode = "VERCEL_GIT_RELINK_COMMAND_TIMEOUT";
    }
  } catch {
    operationCode = "VERCEL_GIT_RELINK_LOCAL_WORKSPACE_FAILED";
  } finally {
    if (workspace) {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (cleanupFailed) {
    return Object.freeze({
      ok: false,
      errorCode: "VERCEL_GIT_RELINK_LOCAL_CLEANUP_FAILED",
      exitStatus: safeProcessStatus(result?.status),
      signal: safeProcessSignal(result?.signal),
    });
  }
  if (result?.status !== 0 || result?.signal || result?.error) {
    return Object.freeze({
      ok: false,
      errorCode: operationCode,
      exitStatus: safeProcessStatus(result?.status),
      signal: safeProcessSignal(result?.signal),
    });
  }
  return Object.freeze({ ok: true, exitStatus: 0, signal: null });
}

function safeCommandFailureCode(result) {
  return SAFE_ERROR_CODE_SET.has(result?.errorCode)
    ? result.errorCode
    : "VERCEL_GIT_RELINK_COMMAND_FAILED";
}

function recordObservedProject(state, project) {
  state.finalLinkState = project.state;
  state.productionBranchIsMain = project.productionBranchIsMain;
}

function recordPostTargetState(state, project) {
  state.postCommandFailureCheckCompleted = true;
  recordObservedProject(state, project);
  if (project.state === "expected-target" && project.productionBranchIsMain) {
    state.postCommandFailureState = "known-new";
    state.gitLinkMutationVerifiedCount = 1;
  } else if (project.state === "expected-source" && project.productionBranchIsMain) {
    state.postCommandFailureState = "known-old";
  } else if (project.state === "unlinked") {
    state.postCommandFailureState = "known-unlinked";
  } else {
    state.postCommandFailureState = "unknown";
  }
}

function projectMutationIdentityVerified(state) {
  return state.teamReadable === true
    && state.teamIdentityMatches === true
    && state.projectReadable === true
    && state.projectIdentityMatches === true
    && state.formalAliasReadable === true
    && state.formalAliasProjectMatches === true
    && state.formalAliasProductionReady === true;
}

async function readBoundedProjectPostcondition({
  configuration,
  fetcher,
  deadlineAt,
  postconditionAttempts,
  retryDelay,
  expectedState,
}) {
  let project;
  for (let attempt = 1; attempt <= postconditionAttempts; attempt += 1) {
    project = await readProject({
      configuration,
      fetcher,
      deadlineAt,
      stage: "project-after",
    });
    if (project.state === expectedState && project.productionBranchIsMain) break;
    if (attempt < postconditionAttempts) {
      await retryDelay(POSTCONDITION_RETRY_DELAY_MS, deadlineAt);
    }
  }
  return project;
}

async function connectSourceAndVerify({
  state,
  configuration,
  fetcher,
  deadlineAt,
  connectRepository,
  postconditionAttempts,
  retryDelay,
  compensation,
}) {
  if (!projectMutationIdentityVerified(state)) {
    fail(
      "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE",
      compensation ? "compensate-source" : "restore-source",
      state,
    );
  }
  state.sourceRestoreMutationAttemptCount = 1;
  if (compensation) state.compensationState = "unknown";
  let commandResult;
  try {
    commandResult = await connectRepository(configuration, "source");
  } catch {
    commandResult = { ok: false, errorCode: "VERCEL_GIT_RELINK_COMMAND_FAILED" };
  }
  let after;
  try {
    after = await readBoundedProjectPostcondition({
      configuration,
      fetcher,
      deadlineAt,
      postconditionAttempts,
      retryDelay,
      expectedState: "expected-source",
    });
    recordObservedProject(state, after);
  } catch {
    state.finalLinkState = "unchecked";
    if (compensation) state.compensationState = "unknown";
    return Object.freeze({ restored: false, commandOk: commandResult?.ok === true });
  }
  const restored = after?.state === "expected-source" && after.productionBranchIsMain;
  if (restored) {
    state.sourceRestoreMutationVerifiedCount = 1;
    if (compensation) state.compensationState = "restored-source";
  } else if (compensation) {
    state.compensationState = "failed";
  }
  return Object.freeze({ restored, commandOk: commandResult?.ok === true });
}

function successResult(state, outcome) {
  return Object.freeze({
    schemaVersion: "novel-vercel-git-relink-result-v1",
    status: "PASS",
    outcome,
    targetRepository: VERCEL_GIT_RELINK_TARGET_REPOSITORY,
    ...sanitizeState(state),
    projectAndTeamPreserved: true,
    rawChildOutputIncluded: false,
    secretValuesIncluded: false,
  });
}

function enrichFailure(error, state) {
  const code = SAFE_ERROR_CODE_SET.has(error?.code)
    ? error.code
    : "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE";
  const stage = SAFE_STAGES.has(error?.stage) ? error.stage : "configuration";
  const safeState = sanitizeState({ ...state, ...error?.safeState });
  throw new VercelGitRelinkError(code, stage, safeState);
}

export async function repointVercelGitRepository({
  mode = "dry-run",
  configuration,
  fetcher = fetch,
  connectRepository = runVercelGitConnectCommand,
  postconditionAttempts = POSTCONDITION_ATTEMPTS,
  retryDelay = delayWithinDeadline,
  now = () => Date.now(),
} = {}) {
  if (!SAFE_MODES.has(mode) || typeof fetcher !== "function") configurationError();
  if (typeof connectRepository !== "function" || typeof retryDelay !== "function") {
    configurationError();
  }
  if (
    !configuration
    || !normalizedString(configuration.token)
    || !SAFE_TEAM_ID.test(normalizedString(configuration.teamId))
    || !SAFE_PROJECT_ID.test(normalizedString(configuration.projectId))
    || !SAFE_SCOPE.test(normalizedString(configuration.scope))
    || !Number.isSafeInteger(postconditionAttempts)
    || postconditionAttempts < 1
    || postconditionAttempts > POSTCONDITION_ATTEMPTS
  ) configurationError();

  const state = initialState(mode);
  const deadlineAt = now() + TOTAL_OPERATION_DEADLINE_MS;
  try {
    const targetRepository = await readTargetRepository({ fetcher, deadlineAt });
    state.targetRepositoryReadable = targetRepository.readable;
    state.targetRepositoryIdentityMatches = targetRepository.identityMatches;

    const sourceRepository = await readSourceRepository({ fetcher, deadlineAt });
    state.sourceRepositoryReadable = sourceRepository.readable;
    state.sourceRepositoryIdentityMatches = sourceRepository.identityMatches;

    const team = await readTeam({ configuration, fetcher, deadlineAt });
    state.teamReadable = team.readable;
    state.teamIdentityMatches = team.identityMatches;

    const repositoryAvailability = await readVercelRepositoryAvailability({
      configuration,
      fetcher,
      deadlineAt,
      requireTarget: true,
    });
    state.vercelGitNamespaceReadable = repositoryAvailability.namespaceReadable;
    state.vercelTargetRepositoryVisible = repositoryAvailability.targetRepositoryVisible;
    state.vercelSourceRepositoryVisible = repositoryAvailability.sourceRepositoryVisible;

    const before = await readProject({
      configuration,
      fetcher,
      deadlineAt,
      stage: "project-before",
    });
    state.projectReadable = before.readable;
    state.projectIdentityMatches = before.identityMatches;
    state.initialLinkState = before.state;
    state.productionBranchIsMain = before.productionBranchIsMain;

    const formalAlias = await readFormalAliasDeployment({
      configuration,
      fetcher,
      deadlineAt,
    });
    state.formalAliasReadable = formalAlias.readable;
    state.formalAliasProjectMatches = formalAlias.projectMatches;
    state.formalAliasProductionReady = formalAlias.productionReady;
    if (!formalAlias.projectMatches) {
      fail("VERCEL_GIT_RELINK_FORMAL_ALIAS_PROJECT_MISMATCH", "formal-alias", state);
    }
    if (!formalAlias.productionReady) {
      fail(
        "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_PRODUCTION_READY",
        "formal-alias",
        state,
      );
    }

    if (mode === "restore-source") {
      state.finalLinkState = before.state;
      if (before.state !== "unlinked") {
        fail(
          "VERCEL_GIT_RELINK_RESTORE_SOURCE_STATE_INVALID",
          "restore-source",
          state,
        );
      }
      const restoreResult = await connectSourceAndVerify({
        state,
        configuration,
        fetcher,
        deadlineAt,
        connectRepository,
        postconditionAttempts,
        retryDelay,
        compensation: false,
      });
      if (!restoreResult.restored) {
        fail(
          "VERCEL_GIT_RELINK_SOURCE_RESTORE_FAILED",
          "restore-source",
          state,
        );
      }
      return successResult(state, "SOURCE_RESTORED");
    }

    if (before.state === "expected-target" && before.productionBranchIsMain) {
      state.finalLinkState = "expected-target";
      return successResult(state, "ALREADY_LINKED");
    }
    if (before.state === "expected-source-id-unavailable") {
      fail(
        "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_ID_UNAVAILABLE",
        "project-before",
        state,
      );
    }
    if (before.state !== "expected-source" || !before.productionBranchIsMain) {
      fail("VERCEL_GIT_RELINK_SOURCE_NOT_EXPECTED", "project-before", state);
    }

    if (mode === "dry-run") {
      state.finalLinkState = before.state;
      return successResult(state, "DRY_RUN_READY");
    }

    if (!projectMutationIdentityVerified(state)) {
      fail("VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE", "connect", state);
    }

    state.gitLinkMutationAttemptCount = 1;
    let commandResult;
    try {
      commandResult = await connectRepository(configuration, "target");
    } catch {
      commandResult = { ok: false, errorCode: "VERCEL_GIT_RELINK_COMMAND_FAILED" };
    }
    if (commandResult?.ok !== true) {
      const commandCode = safeCommandFailureCode(commandResult);
      try {
        const afterFailure = await readProject({
          configuration,
          fetcher,
          deadlineAt,
          stage: "project-after",
        });
        recordPostTargetState(state, afterFailure);
        if (afterFailure.state === "unlinked") {
          const compensation = await connectSourceAndVerify({
            state,
            configuration,
            fetcher,
            deadlineAt,
            connectRepository,
            postconditionAttempts,
            retryDelay,
            compensation: true,
          });
          if (compensation.restored) {
            fail(
              "VERCEL_GIT_RELINK_TARGET_CONNECT_FAILED_COMPENSATED",
              "compensate-source",
              state,
            );
          }
          fail(
            "VERCEL_GIT_RELINK_COMPENSATION_FAILED",
            "compensate-source",
            state,
          );
        }
      } catch {
        if (state.sourceRestoreMutationAttemptCount === 1) {
          fail(
            state.sourceRestoreMutationVerifiedCount === 1
              ? "VERCEL_GIT_RELINK_TARGET_CONNECT_FAILED_COMPENSATED"
              : "VERCEL_GIT_RELINK_COMPENSATION_FAILED",
            "compensate-source",
            state,
          );
        }
        state.postCommandFailureState = "unknown";
        state.postCommandFailureCheckCompleted = false;
        state.finalLinkState = "unchecked";
      }
      fail(commandCode, "connect", state);
    }

    const after = await readBoundedProjectPostcondition({
      configuration,
      fetcher,
      deadlineAt,
      postconditionAttempts,
      retryDelay,
      expectedState: "expected-target",
    });
    recordObservedProject(state, after);
    if (after?.state !== "expected-target" || !after.productionBranchIsMain) {
      if (after?.state === "unlinked") {
        const compensation = await connectSourceAndVerify({
          state,
          configuration,
          fetcher,
          deadlineAt,
          connectRepository,
          postconditionAttempts,
          retryDelay,
          compensation: true,
        });
        if (compensation.restored) {
          fail(
            "VERCEL_GIT_RELINK_TARGET_POSTCONDITION_FAILED_COMPENSATED",
            "compensate-source",
            state,
          );
        }
        fail(
          "VERCEL_GIT_RELINK_COMPENSATION_FAILED",
          "compensate-source",
          state,
        );
      }
      fail("VERCEL_GIT_RELINK_POSTCONDITION_FAILED", "project-after", state);
    }

    state.gitLinkMutationVerifiedCount = 1;
    return successResult(state, "RELINKED");
  } catch (error) {
    enrichFailure(error, state);
  }
}

export function safeVercelGitRelinkFailure(error) {
  const code = SAFE_ERROR_CODE_SET.has(error?.code)
    ? error.code
    : "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE";
  const stage = SAFE_STAGES.has(error?.stage) ? error.stage : "configuration";
  return Object.freeze({
    schemaVersion: "novel-vercel-git-relink-result-v1",
    status: "FAIL",
    errorCode: code,
    stage,
    targetRepository: VERCEL_GIT_RELINK_TARGET_REPOSITORY,
    ...sanitizeState(error?.safeState),
    projectAndTeamPreserved: false,
    rawChildOutputIncluded: false,
    secretValuesIncluded: false,
  });
}

async function main() {
  const argument = process.argv[2];
  if (
    !["--apply", "--dry-run", "--restore-source"].includes(argument)
    || process.argv.length !== 3
  ) {
    configurationError();
  }
  const result = await repointVercelGitRepository({
    mode: argument === "--apply"
      ? "apply"
      : argument === "--restore-source"
        ? "restore-source"
        : "dry-run",
    configuration: vercelGitRelinkConfigurationFromEnvironment(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(safeVercelGitRelinkFailure(error))}\n`);
    process.exitCode = 1;
  });
}
