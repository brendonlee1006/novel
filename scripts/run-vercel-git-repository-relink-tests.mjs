import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  repointVercelGitRepository,
  safeVercelGitRelinkFailure,
  vercelGitRelinkConfigurationFromEnvironment,
  vercelGitRelinkChildEnvironment,
  VERCEL_GIT_RELINK_SAFE_ERROR_CODES,
  VERCEL_GIT_RELINK_TARGET_REPOSITORY,
  VERCEL_GIT_RELINK_TARGET_URL,
} from "./repoint-vercel-git-repository.mjs";

const configuration = Object.freeze({
  token: "fake_vercel_token_DO_NOT_LOG",
  teamId: "team_12345678",
  projectId: "prj_12345678",
  scope: "team-fixture",
});
const fakePrivateKey = [
  "-----BEGIN",
  "PRIVATE KEY-----FAKE-MATERIAL-----END PRIVATE KEY-----",
].join(" ");
const fakeSupabaseKey = "sb_secret_FAKE_SUPABASE_KEY_MUST_NOT_APPEAR";
const fakeAuthorization = `Bearer ${configuration.token}`;
let assertionCount = 0;

function check(value, message) {
  assert.ok(value, message);
  assertionCount += 1;
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertionCount += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertionCount += 1;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: async () => undefined },
    json: async () => body,
  };
}

function targetRepository(overrides = {}) {
  return {
    id: 1357493987,
    node_id: "R_kgDOUOm24w",
    full_name: "brendonlee1006/novel",
    owner: { login: "brendonlee1006" },
    name: "novel",
    default_branch: "main",
    archived: false,
    disabled: false,
    ...overrides,
  };
}

function sourceRepository(overrides = {}) {
  return {
    id: 1292526682,
    node_id: "R_kgDOTQpkWg",
    full_name: "bobobo-org/novel",
    owner: { login: "bobobo-org" },
    name: "novel",
    default_branch: "main",
    archived: false,
    disabled: false,
    ...overrides,
  };
}

function team() {
  return { id: configuration.teamId, slug: configuration.scope };
}

function gitNamespaces() {
  return [
    {
      provider: "github",
      slug: "bobobo-org",
      id: "ns_source_12345678",
      installationId: "987654320",
      requireReauth: false,
    },
    {
      provider: "github",
      slug: "brendonlee1006",
      id: "ns_target_12345678",
      installationId: "987654321",
      requireReauth: false,
    },
  ];
}

function visibleRepository(owner, id) {
  return {
    repositories: [{
      id,
      full_name: `${owner}/novel`,
      owner: { login: owner },
      name: "novel",
    }],
  };
}

function sourceProject() {
  return {
    id: configuration.projectId,
    accountId: configuration.teamId,
    link: {
      type: "github",
      org: "bobobo-org",
      repo: "novel",
      repoId: 1292526682,
      productionBranch: "main",
    },
  };
}

function targetProject() {
  return {
    id: configuration.projectId,
    accountId: configuration.teamId,
    link: {
      type: "github",
      org: "brendonlee1006",
      repo: "novel",
      repoId: 1357493987,
      productionBranch: "main",
    },
  };
}

function unlinkedProject() {
  return { id: configuration.projectId, accountId: configuration.teamId, link: null };
}

function unexpectedProject() {
  return {
    id: configuration.projectId,
    accountId: configuration.teamId,
    link: {
      type: "github",
      org: "someone-else",
      repo: "other",
      repoId: 999999,
      productionBranch: "main",
    },
  };
}

function formalAlias(overrides = {}) {
  return {
    projectId: configuration.projectId,
    target: "production",
    readyState: "READY",
    ...overrides,
  };
}

function routeFetcher(projectBodies, {
  targetRepositoryBody = targetRepository(),
  sourceRepositoryBody = sourceRepository(),
  teamBody = team(),
  namespacesBody = gitNamespaces(),
  sourceVisibleBody = visibleRepository("bobobo-org", 1292526682),
  targetVisibleBody = visibleRepository("brendonlee1006", 1357493987),
  aliasBody = formalAlias(),
  aliasStatus = 200,
} = {}) {
  const requests = [];
  let projectIndex = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({
      method: init.method ?? "GET",
      origin: url.origin,
      pathname: url.pathname,
      query: url.searchParams.get("query"),
    });
    if (url.origin === "https://api.github.com") {
      if (url.pathname === "/repos/brendonlee1006/novel") return jsonResponse(targetRepositoryBody);
      if (url.pathname === "/repos/bobobo-org/novel") return jsonResponse(sourceRepositoryBody);
    }
    if (url.pathname.startsWith("/v2/teams/")) return jsonResponse(teamBody);
    if (url.pathname === "/v13/deployments/novel-orcin.vercel.app") {
      return jsonResponse(aliasBody, aliasStatus);
    }
    if (url.pathname === "/v1/integrations/git-namespaces") return jsonResponse(namespacesBody);
    if (url.pathname === "/v1/integrations/search-repo") {
      const namespaceId = url.searchParams.get("namespaceId");
      if (namespaceId === "ns_source_12345678") return jsonResponse(sourceVisibleBody);
      if (namespaceId === "ns_target_12345678") return jsonResponse(targetVisibleBody);
      throw new Error("unexpected repository namespace");
    }
    if (url.pathname.startsWith("/v9/projects/")) {
      const body = projectBodies[Math.min(projectIndex, projectBodies.length - 1)];
      projectIndex += 1;
      return jsonResponse(body);
    }
    throw new Error(`unexpected test route ${url.origin}${url.pathname}`);
  };
  return { fetcher, requests, projectReadCount: () => projectIndex };
}

async function captureFailure(operation) {
  try {
    await operation();
  } catch (error) {
    return safeVercelGitRelinkFailure(error);
  }
  assert.fail("expected operation to fail");
}

function assertNoSensitiveData(receipt, label) {
  const serialized = JSON.stringify(receipt);
  for (const sensitive of [
    configuration.token,
    fakeAuthorization,
    fakePrivateKey,
    fakeSupabaseKey,
    "server said",
  ]) {
    check(!serialized.includes(sensitive), `${label} excludes sensitive child/API output`);
  }
}

function assertZeroUnrelatedMutations(receipt, label) {
  equal(receipt.environmentMutationCount, 0, `${label} does not mutate environment variables`);
  equal(receipt.deploymentMutationCount, 0, `${label} does not mutate deployments`);
  equal(receipt.aliasMutationCount, 0, `${label} does not mutate aliases`);
  equal(receipt.supabaseMutationCount, 0, `${label} does not mutate Supabase`);
}

{
  const childEnvironment = vercelGitRelinkChildEnvironment(configuration, {
    Path: "C:\\safe-node-path",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\safe-temp",
    SUPABASE_SERVICE_ROLE_KEY: fakeSupabaseKey,
    PRIVATE_ATTESTATION_KEY: fakePrivateKey,
    GITHUB_TOKEN: "fake_github_token_must_not_be_forwarded",
    SOURCE_LKG_READ_TOKEN: "fake_source_token_must_not_be_forwarded",
  });
  equal(childEnvironment.PATH, "C:\\safe-node-path", "child receives allowlisted PATH");
  equal(childEnvironment.SYSTEMROOT, "C:\\Windows", "child receives allowlisted SYSTEMROOT");
  equal(childEnvironment.VERCEL_TOKEN, configuration.token, "child receives the required Vercel token");
  for (const name of [
    "SUPABASE_SERVICE_ROLE_KEY",
    "PRIVATE_ATTESTATION_KEY",
    "GITHUB_TOKEN",
    "SOURCE_LKG_READ_TOKEN",
  ]) {
    check(!Object.hasOwn(childEnvironment, name), `${name} is not forwarded to the child`);
  }
  const serialized = JSON.stringify(childEnvironment);
  check(!serialized.includes(fakeSupabaseKey), "fake Supabase key never enters child environment");
  check(!serialized.includes(fakePrivateKey), "fake private key never enters child environment");
}

{
  const routed = routeFetcher([sourceProject(), targetProject()]);
  const destinations = [];
  const result = await repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async (received, destination) => {
      equal(received, configuration, "connect receives validated configuration");
      destinations.push(destination);
      return { ok: true, stdout: configuration.token, stderr: fakePrivateKey };
    },
    retryDelay: async () => undefined,
  });
  equal(result.status, "PASS", "successful relink passes");
  equal(result.outcome, "RELINKED", "successful relink reports RELINKED");
  equal(result.targetRepository, VERCEL_GIT_RELINK_TARGET_REPOSITORY, "target repository is fixed");
  equal(result.initialLinkState, "expected-source", "source linkage is recognized");
  equal(result.finalLinkState, "expected-target", "target linkage is verified");
  equal(result.targetRepositoryReadable, true, "target GitHub repository is readable");
  equal(result.sourceRepositoryReadable, true, "source GitHub repository is readable");
  equal(result.vercelGitNamespaceReadable, true, "Vercel Git namespaces are readable");
  equal(result.vercelSourceRepositoryVisible, true, "source repository is visible to Vercel");
  equal(result.vercelTargetRepositoryVisible, true, "target repository is visible to Vercel");
  equal(result.formalAliasReadable, true, "formal alias is readable");
  equal(result.formalAliasProjectMatches, true, "formal alias is bound to the pinned project");
  equal(result.formalAliasProductionReady, true, "formal alias is READY production");
  equal(result.gitLinkMutationAttemptCount, 1, "one target mutation is attempted");
  equal(result.gitLinkMutationVerifiedCount, 1, "one target mutation is verified");
  equal(result.sourceRestoreMutationAttemptCount, 0, "successful relink needs no source restore");
  equal(result.compensationState, "not-required", "successful relink needs no compensation");
  deepEqual(destinations, ["target"], "apply connects only the pinned target");
  check(routed.requests.every(({ method }) => method === "GET"), "all HTTP pre/postflight calls are GET");
  equal(routed.requests.filter(({ pathname }) => pathname === "/v1/integrations/search-repo").length, 2, "Vercel visibility is checked for source and target");
  equal(routed.requests.filter(({ pathname }) => pathname === "/v13/deployments/novel-orcin.vercel.app").length, 1, "formal alias is checked once before mutation");
  assertZeroUnrelatedMutations(result, "successful relink");
  assertNoSensitiveData(result, "successful relink receipt");
}

{
  const routed = routeFetcher([sourceProject()]);
  let connectCount = 0;
  const result = await repointVercelGitRepository({
    mode: "dry-run",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  });
  equal(result.outcome, "DRY_RUN_READY", "dry run reports readiness");
  equal(connectCount, 0, "dry run never connects a repository");
  equal(result.gitLinkMutationAttemptCount, 0, "dry run records zero target mutations");
  assertZeroUnrelatedMutations(result, "dry run");
}

{
  const routed = routeFetcher([targetProject()]);
  let connectCount = 0;
  const result = await repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  });
  equal(result.outcome, "ALREADY_LINKED", "already-linked project is idempotent");
  equal(connectCount, 0, "already-linked project is not mutated");
}

for (const test of [
  {
    options: { aliasBody: formalAlias({ projectId: "prj_wrong_project" }) },
    code: "VERCEL_GIT_RELINK_FORMAL_ALIAS_PROJECT_MISMATCH",
    projectMatches: false,
    productionReady: true,
    label: "wrong-project formal alias",
  },
  {
    options: { aliasBody: formalAlias({ target: "preview" }) },
    code: "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_PRODUCTION_READY",
    projectMatches: true,
    productionReady: false,
    label: "non-production formal alias",
  },
  {
    options: { aliasBody: formalAlias({ readyState: "ERROR" }) },
    code: "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_PRODUCTION_READY",
    projectMatches: true,
    productionReady: false,
    label: "non-ready formal alias",
  },
  {
    options: { aliasBody: formalAlias({ target: "PRODUCTION" }) },
    code: "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_PRODUCTION_READY",
    projectMatches: true,
    productionReady: false,
    label: "case-drifted alias target",
  },
  {
    options: { aliasBody: formalAlias({ readyState: "ready" }) },
    code: "VERCEL_GIT_RELINK_FORMAL_ALIAS_NOT_PRODUCTION_READY",
    projectMatches: true,
    productionReady: false,
    label: "case-drifted alias state",
  },
]) {
  const routed = routeFetcher([sourceProject()], test.options);
  let connectCount = 0;
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  }));
  equal(failure.errorCode, test.code, `${test.label} fails closed`);
  equal(failure.formalAliasReadable, true, `${test.label} was read safely`);
  equal(failure.formalAliasProjectMatches, test.projectMatches, `${test.label} reports project match safely`);
  equal(failure.formalAliasProductionReady, test.productionReady, `${test.label} never claims readiness`);
  equal(connectCount, 0, `${test.label} prevents mutation`);
}

for (const test of [
  {
    options: { targetRepositoryBody: targetRepository({ id: 999 }) },
    code: "VERCEL_GIT_RELINK_TARGET_REPOSITORY_IDENTITY_MISMATCH",
    label: "target GitHub identity mismatch",
  },
  {
    options: { sourceRepositoryBody: sourceRepository({ node_id: "wrong" }) },
    code: "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_IDENTITY_MISMATCH",
    label: "source GitHub identity mismatch",
  },
  {
    options: { targetVisibleBody: { repositories: [] } },
    code: "VERCEL_GIT_RELINK_TARGET_REPOSITORY_NOT_VISIBLE_TO_VERCEL",
    label: "target invisible to Vercel",
  },
  {
    options: { sourceVisibleBody: { repositories: [] } },
    code: "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_NOT_VISIBLE_TO_VERCEL",
    label: "source invisible to Vercel",
  },
]) {
  const routed = routeFetcher([sourceProject()], test.options);
  let connectCount = 0;
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  }));
  equal(failure.errorCode, test.code, `${test.label} has an exact safe error`);
  equal(connectCount, 0, `${test.label} prevents mutation`);
  assertNoSensitiveData(failure, `${test.label} receipt`);
}

{
  const sourceWithoutId = sourceProject();
  delete sourceWithoutId.link.repoId;
  const routed = routeFetcher([sourceWithoutId]);
  let connectCount = 0;
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_SOURCE_REPOSITORY_ID_UNAVAILABLE", "missing source repoId fails closed");
  equal(failure.initialLinkState, "expected-source-id-unavailable", "missing source repoId has a safe state");
  equal(connectCount, 0, "missing source repoId prevents mutation");
}

{
  const routed = routeFetcher([unexpectedProject()]);
  let connectCount = 0;
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_SOURCE_NOT_EXPECTED", "unexpected initial linkage fails closed");
  equal(failure.initialLinkState, "unexpected", "unexpected source name is never emitted");
  equal(connectCount, 0, "unexpected initial linkage prevents mutation");
}

{
  const routed = routeFetcher([sourceProject(), unlinkedProject(), sourceProject()]);
  const destinations = [];
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async (_received, destination) => {
      destinations.push(destination);
      if (destination === "target") {
        return {
          ok: false,
          errorCode: "NOT_WHITELISTED",
          stdout: fakeAuthorization,
          stderr: `${fakePrivateKey}${fakeSupabaseKey}`,
          message: `server said ${configuration.token}`,
        };
      }
      return { ok: true, stdout: fakeAuthorization };
    },
    postconditionAttempts: 1,
    retryDelay: async () => undefined,
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_TARGET_CONNECT_FAILED_COMPENSATED", "disconnect then target failure is compensated");
  equal(failure.postCommandFailureCheckCompleted, true, "target command failure gets a read-only postflight");
  equal(failure.postCommandFailureState, "known-unlinked", "postflight identifies the disconnected state");
  equal(failure.finalLinkState, "expected-source", "compensation restores source linkage");
  equal(failure.gitLinkMutationAttemptCount, 1, "target attempt is recorded once");
  equal(failure.gitLinkMutationVerifiedCount, 0, "target attempt is not claimed verified");
  equal(failure.sourceRestoreMutationAttemptCount, 1, "compensation is attempted once");
  equal(failure.sourceRestoreMutationVerifiedCount, 1, "compensation is verified once");
  equal(failure.compensationState, "restored-source", "compensation state is explicit");
  deepEqual(destinations, ["target", "source"], "compensation uses only pinned target then source");
  assertZeroUnrelatedMutations(failure, "compensated target failure");
  assertNoSensitiveData(failure, "compensated target failure receipt");
}

{
  const routed = routeFetcher([sourceProject(), unlinkedProject(), unlinkedProject()]);
  const destinations = [];
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async (_received, destination) => {
      destinations.push(destination);
      return {
        ok: false,
        errorCode: "VERCEL_GIT_RELINK_COMMAND_FAILED",
        stdout: fakeAuthorization,
        stderr: `${fakePrivateKey}${fakeSupabaseKey}`,
      };
    },
    postconditionAttempts: 1,
    retryDelay: async () => undefined,
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_COMPENSATION_FAILED", "failed source compensation has a distinct safe error");
  equal(failure.finalLinkState, "unlinked", "failed compensation reports observed unlinked state");
  equal(failure.sourceRestoreMutationAttemptCount, 1, "failed compensation is attempted once");
  equal(failure.sourceRestoreMutationVerifiedCount, 0, "failed compensation is never claimed verified");
  equal(failure.compensationState, "failed", "failed compensation is explicit");
  deepEqual(destinations, ["target", "source"], "failed compensation uses only pinned destinations");
  assertNoSensitiveData(failure, "failed compensation receipt");
}

{
  const routed = routeFetcher([sourceProject(), unlinkedProject(), sourceProject()]);
  const destinations = [];
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async (_received, destination) => {
      destinations.push(destination);
      return { ok: true, stdout: configuration.token, stderr: fakePrivateKey };
    },
    postconditionAttempts: 1,
    retryDelay: async () => undefined,
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_TARGET_POSTCONDITION_FAILED_COMPENSATED", "exit zero but unlinked postflight is compensated");
  equal(failure.finalLinkState, "expected-source", "postcondition compensation restores source");
  equal(failure.compensationState, "restored-source", "postcondition compensation is explicit");
  equal(failure.sourceRestoreMutationAttemptCount, 1, "postcondition compensation attempts source once");
  equal(failure.sourceRestoreMutationVerifiedCount, 1, "postcondition compensation verifies source once");
  deepEqual(destinations, ["target", "source"], "postcondition compensation uses pinned destinations");
  assertNoSensitiveData(failure, "postcondition compensation receipt");
}

{
  const routed = routeFetcher([sourceProject(), targetProject()]);
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => ({
      ok: false,
      errorCode: "VERCEL_GIT_RELINK_COMMAND_FAILED",
      stdout: fakeAuthorization,
      stderr: `${fakePrivateKey}${fakeSupabaseKey}`,
    }),
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_COMMAND_FAILED", "nonzero command remains failure even when target linked");
  equal(failure.postCommandFailureState, "known-new", "postflight safely reports known target");
  equal(failure.finalLinkState, "expected-target", "target identity is verified after nonzero exit");
  equal(failure.gitLinkMutationVerifiedCount, 1, "known target is recorded as verified");
  equal(failure.sourceRestoreMutationAttemptCount, 0, "verified target is never rolled back");
  assertNoSensitiveData(failure, "known target command failure receipt");
}

{
  const routed = routeFetcher([sourceProject(), sourceProject()]);
  const destinations = [];
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async (_received, destination) => {
      destinations.push(destination);
      return { ok: true };
    },
    postconditionAttempts: 1,
    retryDelay: async () => undefined,
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_POSTCONDITION_FAILED", "known source postcondition fails without redundant compensation");
  equal(failure.finalLinkState, "expected-source", "known source state remains explicit");
  equal(failure.sourceRestoreMutationAttemptCount, 0, "known source needs no compensating mutation");
  deepEqual(destinations, ["target"], "known source postcondition does not reconnect source");
}

{
  let projectReadCount = 0;
  const routed = routeFetcher([sourceProject()]);
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.startsWith("/v9/projects/")) {
      projectReadCount += 1;
      if (projectReadCount > 1) {
        return jsonResponse({ detail: configuration.token, authorization: fakeAuthorization }, 503);
      }
    }
    return routed.fetcher(input, init);
  };
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "apply",
    configuration,
    fetcher,
    connectRepository: async () => ({
      ok: false,
      stdout: fakeAuthorization,
      stderr: `${fakePrivateKey}${fakeSupabaseKey}`,
    }),
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_COMMAND_FAILED", "command failure remains safely classified when postflight is unavailable");
  equal(failure.postCommandFailureCheckCompleted, false, "unavailable postflight is not claimed complete");
  equal(failure.postCommandFailureState, "unknown", "unavailable postflight reports unknown state");
  equal(failure.finalLinkState, "unchecked", "unavailable postflight does not guess linkage");
  equal(failure.sourceRestoreMutationAttemptCount, 0, "unknown state is never mutated by guesswork");
  assertNoSensitiveData(failure, "unavailable postflight receipt");
}

{
  const routed = routeFetcher([unlinkedProject(), sourceProject()]);
  const destinations = [];
  const result = await repointVercelGitRepository({
    mode: "restore-source",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async (_received, destination) => {
      destinations.push(destination);
      return { ok: true, stdout: configuration.token, stderr: fakePrivateKey };
    },
    postconditionAttempts: 1,
    retryDelay: async () => undefined,
  });
  equal(result.status, "PASS", "explicit source restore succeeds from unlinked state");
  equal(result.outcome, "SOURCE_RESTORED", "explicit restore has a distinct outcome");
  equal(result.initialLinkState, "unlinked", "explicit restore requires observed unlinked state");
  equal(result.finalLinkState, "expected-source", "explicit restore verifies pinned source");
  equal(result.vercelSourceRepositoryVisible, true, "explicit restore preflights source visibility");
  equal(result.vercelTargetRepositoryVisible, true, "explicit restore preflights target visibility too");
  equal(result.gitLinkMutationAttemptCount, 0, "explicit restore never attempts target linkage");
  equal(result.sourceRestoreMutationAttemptCount, 1, "explicit restore attempts source once");
  equal(result.sourceRestoreMutationVerifiedCount, 1, "explicit restore verifies source once");
  deepEqual(destinations, ["source"], "explicit restore can only connect pinned source");
  assertZeroUnrelatedMutations(result, "explicit source restore");
  assertNoSensitiveData(result, "explicit source restore receipt");
}

for (const initialProject of [targetProject(), sourceProject(), unexpectedProject()]) {
  const routed = routeFetcher([initialProject]);
  let connectCount = 0;
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "restore-source",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => { connectCount += 1; return { ok: true }; },
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_RESTORE_SOURCE_STATE_INVALID", "restore-source rejects target/source/unexpected states");
  equal(connectCount, 0, "invalid restore state does not mutate linkage");
  equal(failure.sourceRestoreMutationAttemptCount, 0, "invalid restore state records zero restore attempts");
}

{
  const routed = routeFetcher([unlinkedProject(), unlinkedProject()]);
  const failure = await captureFailure(() => repointVercelGitRepository({
    mode: "restore-source",
    configuration,
    fetcher: routed.fetcher,
    connectRepository: async () => ({
      ok: false,
      errorCode: "NOT_WHITELISTED",
      stdout: fakeAuthorization,
      stderr: `${fakePrivateKey}${fakeSupabaseKey}`,
      message: `server said ${configuration.token}`,
    }),
    postconditionAttempts: 1,
    retryDelay: async () => undefined,
  }));
  equal(failure.errorCode, "VERCEL_GIT_RELINK_SOURCE_RESTORE_FAILED", "failed explicit restore has a safe error");
  equal(failure.sourceRestoreMutationAttemptCount, 1, "failed explicit restore is attempted once");
  equal(failure.sourceRestoreMutationVerifiedCount, 0, "failed explicit restore is never claimed verified");
  equal(failure.finalLinkState, "unlinked", "failed explicit restore reports observed unlinked state");
  assertNoSensitiveData(failure, "failed explicit restore receipt");
}

{
  const parsed = vercelGitRelinkConfigurationFromEnvironment({
    VERCEL_TOKEN: configuration.token,
    VERCEL_ORG_ID: configuration.teamId,
    VERCEL_PROJECT_ID: configuration.projectId,
    VERCEL_SCOPE: configuration.scope,
  });
  equal(parsed.projectId, configuration.projectId, "valid environment configuration parses");
  const failure = await captureFailure(async () => {
    vercelGitRelinkConfigurationFromEnvironment({
      VERCEL_TOKEN: "",
      VERCEL_ORG_ID: configuration.teamId,
      VERCEL_PROJECT_ID: configuration.projectId,
      VERCEL_SCOPE: configuration.scope,
    });
  });
  equal(failure.errorCode, "VERCEL_GIT_RELINK_CONFIGURATION_INVALID", "missing token is a safe configuration failure");
  assertNoSensitiveData(failure, "configuration failure receipt");
}

{
  const source = await readFile(new URL("./repoint-vercel-git-repository.mjs", import.meta.url), "utf8");
  check(source.includes("node_modules"), "real command resolves repository-local Vercel CLI");
  check(source.includes("VERCEL_CLI_ENTRY_PATH"), "real command uses absolute Vercel CLI entry point");
  check(source.includes('"git",\n      "connect"'), "real command is limited to Vercel git connect");
  check(source.includes("VERCEL_GIT_RELINK_SOURCE_URL"), "recovery pins source URL");
  check(source.includes('destination === "target"'), "destination uses a closed target branch");
  check(source.includes('destination === "source"'), "destination uses a closed source branch");
  check(source.includes('stdio: "ignore"'), "real command discards all child output");
  check(source.includes("env: vercelGitRelinkChildEnvironment(configuration)"), "spawn uses tested env allowlist");
  check(!source.includes("...process.env"), "spawn never forwards complete job environment");
  check(!source.includes('"--token",\n      configuration.token'), "token is absent from child arguments");
  check(!source.includes('"env",\n      "add"'), "script contains no Vercel env add");
  check(!source.includes('"env",\n      "rm"'), "script contains no Vercel env remove");
  check(!source.includes("api.supabase.com"), "script contains no Supabase API");
  check(!source.includes("vercel deploy"), "script contains no deploy command");
  check(!source.includes("vercel alias"), "script contains no alias command");
  check(source.includes('"--restore-source"'), "CLI exposes explicit source recovery");
  equal(VERCEL_GIT_RELINK_TARGET_URL, "https://github.com/brendonlee1006/novel.git", "target URL is not dynamic");
  for (const code of [
    "VERCEL_GIT_RELINK_TARGET_CONNECT_FAILED_COMPENSATED",
    "VERCEL_GIT_RELINK_TARGET_POSTCONDITION_FAILED_COMPENSATED",
    "VERCEL_GIT_RELINK_COMPENSATION_FAILED",
    "VERCEL_GIT_RELINK_RESTORE_SOURCE_STATE_INVALID",
    "VERCEL_GIT_RELINK_SOURCE_RESTORE_FAILED",
    "VERCEL_GIT_RELINK_UNKNOWN_SAFE_FAILURE",
  ]) {
    check(VERCEL_GIT_RELINK_SAFE_ERROR_CODES.includes(code), `${code} is allowlisted`);
  }
}

{
  const workflow = await readFile(
    new URL("../.github/workflows/repoint-vercel-repository.yml", import.meta.url),
    "utf8",
  );
  check(/^name: Repoint formal Vercel Git repository$/mu.test(workflow), "workflow identity is fixed");
  check(/^  workflow_dispatch:$/mu.test(workflow), "workflow is manual-only");
  check(!/^  (?:push|pull_request):/mu.test(workflow), "workflow cannot run from push/PR");
  check(/github\.repository == 'brendonlee1006\/novel'/u.test(workflow), "workflow pins target repository");
  check(/github\.repository_id == '1357493987'/u.test(workflow), "workflow pins target repository id");
  check(/github\.ref == 'refs\/heads\/main'/u.test(workflow), "workflow pins main");
  check(/github\.sha == inputs\.control_commit/u.test(workflow), "dispatch binds exact commit");
  check(/github\.workflow_sha == github\.sha/u.test(workflow), "workflow source equals checkout");
  check(/inputs\.operation == 'repoint-to-personal-repository'/u.test(workflow), "normal relink requires the explicit operation");
  check(/inputs\.operation == 'restore-source-linkage'/u.test(workflow), "source recovery requires the explicit operation");
  check(/environment:\s*production-migration/u.test(workflow), "workflow uses protected migration environment");
  check(/permissions:\s*\r?\n  contents: read/u.test(workflow), "workflow token is read-only");
  check(/persist-credentials:\s*false/u.test(workflow), "checkout credentials are not persisted");
  check(/deploymentEnabled !== false/u.test(workflow), "native Git deployment stays disabled");
  check(/pnpm@10\.34\.5/u.test(workflow), "package manager is pinned");
  check(/pnpm install --frozen-lockfile --ignore-scripts/u.test(workflow), "install is locked and skips lifecycle scripts");
  check(/repoint-vercel-git-repository\.mjs --dry-run/u.test(workflow), "read-only preflight precedes mutation");
  check(/repoint-vercel-git-repository\.mjs --apply/u.test(workflow), "bounded relink is explicit");
  equal((workflow.match(/repoint-vercel-git-repository\.mjs --apply/gu) ?? []).length, 1, "workflow has one target mutation step");
  check(/if: inputs\.operation == 'repoint-to-personal-repository'[\s\S]*?repoint-vercel-git-repository\.mjs --dry-run/u.test(workflow), "normal operation gates the read-only preflight");
  check(/if: inputs\.operation == 'repoint-to-personal-repository'[\s\S]*?repoint-vercel-git-repository\.mjs --apply/u.test(workflow), "normal operation gates the target mutation");
  check(/if: inputs\.operation == 'restore-source-linkage'[\s\S]*?repoint-vercel-git-repository\.mjs --restore-source/u.test(workflow), "source restore is separately selected and reviewed");
  equal((workflow.match(/repoint-vercel-git-repository\.mjs --restore-source/gu) ?? []).length, 1, "workflow has one explicit source recovery step");
  check(!/vercel\s+(?:env|deploy|alias)|supabase\s+(?:db|migration|functions)|prisma\s+migrate/iu.test(workflow), "workflow cannot mutate env/deploy/alias/Supabase");
  check(!/upload-artifact|artifact\/upload/iu.test(workflow), "workflow never persists command output");
  check(!/SOURCE_LKG_READ_TOKEN|SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|PRIVATE.*KEY/iu.test(workflow), "workflow contains no unrelated secrets");
}

process.stdout.write(`VERCEL_GIT_RELINK_TESTS_PASSED ${assertionCount}/${assertionCount}\n`);
