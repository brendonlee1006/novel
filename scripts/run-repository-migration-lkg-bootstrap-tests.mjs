import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const mode = process.argv[2] ?? "all";
assert.equal(mode, "all", "repository migration LKG bootstrap tests only support all");

const lkg = await import("./production-last-known-good.mjs");
const requiredExports = [
  "REPOSITORY_MIGRATION_SOURCE",
  "REPOSITORY_MIGRATION_TARGET",
  "createLastKnownGoodArtifactProof",
  "createLastKnownGoodProductionIdentity",
  "createReadOnlyRollbackSelectionProof",
  "createRepositoryMigrationSeedIdentity",
  "validateRepositoryMigrationSeedIdentity",
  "isRepositoryMigrationSeedEligible",
  "discoverRepositoryMigrationSeedArtifact",
  "downloadRepositoryMigrationSeedArtifact",
  "verifyPinnedRepositoryMigrationSource",
  "assertRepositoryMigrationSeedNotPublished",
];
for (const name of requiredExports) {
  assert.notEqual(lkg[name], undefined, `required repository migration export missing: ${name}`);
}

const {
  REPOSITORY_MIGRATION_SOURCE: sourcePin,
  REPOSITORY_MIGRATION_TARGET: targetPin,
  createLastKnownGoodArtifactProof,
  createLastKnownGoodProductionIdentity,
  createReadOnlyRollbackSelectionProof,
  createRepositoryMigrationSeedIdentity,
  validateRepositoryMigrationSeedIdentity,
  isRepositoryMigrationSeedEligible,
  discoverRepositoryMigrationSeedArtifact,
  downloadRepositoryMigrationSeedArtifact,
  verifyPinnedRepositoryMigrationSource,
  assertRepositoryMigrationSeedNotPublished,
} = lkg;

const SOURCE_ARCHIVE_BASE64 = "UEsDBBQACAAIAFhzI10AAAAAAAAAAAAAAAAfAAAAbGFzdC1rbm93bi1nb29kLXByb2R1Y3Rpb24uanNvbp3QzU4DIRQF4H2fopm1NDAwDHTX2ESNG+N/ujEMXCp2BhDoaGN8d9NqE926vvlOzj0fk+m0yvoZBnUPKbvgq/m06lUuaOPDm0frEAyKKZitLi545Az44soOjaQ62eOY3KDSbgmxD7sBfLkw+wgT+6elpS9nV3eX9vH14T0uLBXnK59Z5N3N5hsPLqWQ/mdVjKdhGFzZE6hxpxSmnGsL2BommaYCC6UxM0aBpYQxQn86J+hBZbhV6731YYQeKYdizTqkgx8hZXX41rqUC8pla1xASfNZ8yfgGkZ33OzXdYTkrAOzOFSrcc0RlgjTW8LmNZ8zOSO0XR3nCyN45TUs3RryQRBhMYhWdAII0bqBWksrucISWCOkVppSVhOJ20a0knPNG8YaAlQy2pnGVJPPyRdQSwcIKcWWSzABAADZAQAAUEsBAi0DFAAIAAgAWHMjXSnFlkswAQAA2QEAAB8AAAAAAAAAAAAgAKSBAAAAAGxhc3Qta25vd24tZ29vZC1wcm9kdWN0aW9uLmpzb25QSwUGAAAAAAEAAQBNAAAAfQEAAAAA";
const SOURCE_ARCHIVE = Buffer.from(SOURCE_ARCHIVE_BASE64, "base64");
const TEAM_ID = "team_repository_migration_fixture";
const PROJECT_ID = "prj_repository_migration_fixture";
const BOOTSTRAP_COMMIT = "9fccf8792bcfa60b59f14873f9e09e33a16f983e";
const CONSUMER_COMMIT = "f".repeat(40);
const BOOTSTRAP_RUN_ID = "33790000001";
const CONSUMER_RUN_ID = "33790000002";
const DOWNLOADED_AT = "2026-09-05T00:00:00.000Z";
const SELECTED_AT = "2026-09-05T00:01:00.000Z";
const SEEDED_AT = "2026-09-05T00:02:00.000Z";
const VALIDATION_NOW = "2026-09-05T00:03:00.000Z";
const SEED_EXPIRES_AT = "2026-09-06T00:02:00.000Z";

const clone = (value) => structuredClone(value);
const tests = [];

function test(name, operation) {
  tests.push({ name, operation });
}

function expectThrows(operation, label, codePattern = null) {
  assert.throws(operation, (error) => {
    const code = String(error?.code || error?.message || "");
    assert.ok(code, `${label}: rejection must have a code`);
    if (codePattern) assert.match(code, codePattern, label);
    return true;
  }, label);
}

async function expectRejects(operation, label, codePattern = null) {
  await assert.rejects(operation, (error) => {
    const code = String(error?.code || error?.message || "");
    assert.ok(code, `${label}: rejection must have a code`);
    if (codePattern) assert.match(code, codePattern, label);
    return true;
  }, label);
}

function sourceRepositoryMetadata() {
  return {
    repository: sourcePin.repository,
    repositoryId: sourcePin.repositoryId,
    nodeId: sourcePin.nodeId,
    defaultBranch: sourcePin.defaultBranch,
    visibility: sourcePin.visibility,
  };
}

function sourceArtifactMetadata() {
  return {
    artifactId: sourcePin.artifactId,
    artifactName: sourcePin.artifactName,
    artifactDigest: sourcePin.artifactDigest,
    runId: sourcePin.runId,
    headSha: sourcePin.headSha,
    productCommit: sourcePin.productCommit,
    controlCommit: sourcePin.controlCommit,
    workflowEvent: sourcePin.workflowEvent,
    workflowBranch: sourcePin.workflowBranch,
    runAttempt: sourcePin.runAttempt,
    workflowPath: sourcePin.workflowPath,
    createdAt: sourcePin.createdAt,
    expiresAt: sourcePin.expiresAt,
    sizeInBytes: sourcePin.artifactSizeInBytes,
  };
}

function sourceIdentity() {
  return createLastKnownGoodProductionIdentity({
    primaryDeploymentId: sourcePin.primaryDeploymentId,
    mirrorDeploymentId: sourcePin.mirrorDeploymentId,
    appCommit: sourcePin.productCommit,
    releaseTag: sourcePin.releaseTag,
    releaseRevision: sourcePin.releaseRevision,
    verifiedAt: sourcePin.identityVerifiedAt,
  });
}

function sourceArtifactProof(identity = sourceIdentity()) {
  return createLastKnownGoodArtifactProof({
    repository: sourcePin.repository,
    ...sourceArtifactMetadata(),
    downloadedAt: DOWNLOADED_AT,
    identity,
  });
}

function vercelSelectionProof(proof = sourceArtifactProof()) {
  return createReadOnlyRollbackSelectionProof({
    selectedAt: SELECTED_AT,
    source: "last-known-good",
    primaryDeploymentId: sourcePin.primaryDeploymentId,
    primaryAppCommit: sourcePin.productCommit,
    mirrorDeploymentId: sourcePin.mirrorDeploymentId,
    mirrorAppCommit: sourcePin.productCommit,
    lastKnownGoodAvailable: true,
    lastKnownGoodArtifactProofDigest: proof.proofDigest,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
  });
}

function target() {
  return {
    repository: targetPin.repository,
    repositoryId: targetPin.repositoryId,
    bootstrapControlCommit: BOOTSTRAP_COMMIT,
    bootstrapRunId: BOOTSTRAP_RUN_ID,
    bootstrapRunAttempt: "1",
    workflowPath: ".github/workflows/deploy.yml",
    workflowRef: `${targetPin.repository}/.github/workflows/deploy.yml@refs/heads/main`,
    eventName: "workflow_dispatch",
    eventRef: "refs/heads/main",
    operation: "bootstrap-lkg-repository-migration",
    consumerRunId: CONSUMER_RUN_ID,
    consumerCommit: CONSUMER_COMMIT,
  };
}

function seedInput() {
  const identity = sourceIdentity();
  const proof = sourceArtifactProof(identity);
  return {
    sourceRepositoryMetadata: sourceRepositoryMetadata(),
    sourceArtifactMetadata: sourceArtifactMetadata(),
    sourceIdentity: identity,
    sourceArtifactProof: proof,
    target: target(),
    vercelSelectionProof: vercelSelectionProof(proof),
    seededAt: SEEDED_AT,
  };
}

function createSeed() {
  return createRepositoryMigrationSeedIdentity(seedInput());
}

function eligibilityContext(overrides = {}) {
  return {
    repository: targetPin.repository,
    repositoryId: targetPin.repositoryId,
    runId: CONSUMER_RUN_ID,
    runAttempt: "1",
    headSha: CONSUMER_COMMIT,
    eventName: "push",
    eventRef: "refs/heads/main",
    workflowPath: ".github/workflows/deploy.yml",
    workflowRef: `${targetPin.repository}/.github/workflows/deploy.yml@refs/heads/main`,
    canonicalLastKnownGoodAvailable: false,
    now: Date.parse(VALIDATION_NOW),
    ...overrides,
  };
}

test("pinned source and target identities remain exact", () => {
  assert.deepEqual(sourceRepositoryMetadata(), {
    repository: "bobobo-org/novel",
    repositoryId: 1_292_526_682,
    nodeId: "R_kgDOTQpkWg",
    defaultBranch: "main",
    visibility: "public",
  });
  assert.deepEqual(sourceArtifactMetadata(), {
    artifactId: 9_897_879_443,
    artifactName: "production-last-known-good-e20baa0366cfe0fd494c3808ac04ddaef3144131",
    artifactDigest: "sha256:32df7d343c5ef11e027df5a064d4f70f4ac9e9249d3996787c37860de391e14d",
    runId: 33_763_928_992,
    headSha: "e20baa0366cfe0fd494c3808ac04ddaef3144131",
    productCommit: "e20baa0366cfe0fd494c3808ac04ddaef3144131",
    controlCommit: "e20baa0366cfe0fd494c3808ac04ddaef3144131",
    workflowEvent: "push",
    workflowBranch: "main",
    runAttempt: 1,
    workflowPath: ".github/workflows/deploy.yml",
    createdAt: "2026-09-03T14:26:49.000Z",
    expiresAt: "2026-12-02T13:56:14.000Z",
    sizeInBytes: 480,
  });
  assert.equal(sourceIdentity().provenanceDigest, sourcePin.identityProvenanceDigest);
  assert.equal(targetPin.repository, "brendonlee1006/novel");
  assert.equal(targetPin.repositoryId, 1_357_493_987);
});

test("valid pinned source creates a target-owned migration seed", () => {
  const seed = createSeed();
  const validated = validateRepositoryMigrationSeedIdentity(seed, {
    expectedVercelTeamId: TEAM_ID,
    expectedVercelProjectId: PROJECT_ID,
    now: VALIDATION_NOW,
  });
  assert.deepEqual(validated, seed);
  assert.equal(seed.publicationMode, "repository-migration-seed");
  assert.equal(seed.sourceRepository.repository, sourcePin.repository);
  assert.equal(seed.sourceArtifact.artifactId, sourcePin.artifactId);
  assert.equal(seed.target.repository, targetPin.repository);
  assert.equal(seed.target.consumerRunId, CONSUMER_RUN_ID);
  assert.equal(seed.target.consumerCommit, CONSUMER_COMMIT);
  assert.equal(seed.expiresAt, SEED_EXPIRES_AT);
  assert.equal(Date.parse(seed.expiresAt) - Date.parse(seed.seededAt), 24 * 60 * 60 * 1_000);
  assert.match(seed.provenanceDigest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(seed), /source-token|target-token|fixture-secret/iu);
});

const sourceRepositoryMutations = [
  ["repository name", "repository", "attacker/novel"],
  ["repository id", "repositoryId", sourcePin.repositoryId + 1],
  ["repository node id", "nodeId", "R_attacker"],
  ["default branch", "defaultBranch", "develop"],
  ["visibility", "visibility", "private"],
];
for (const [name, field, replacement] of sourceRepositoryMutations) {
  test(`source ${name} tamper is rejected`, () => {
    const input = seedInput();
    input.sourceRepositoryMetadata[field] = replacement;
    expectThrows(
      () => createRepositoryMigrationSeedIdentity(input),
      name,
      /^REPOSITORY_MIGRATION_/u,
    );
  });
}

const sourceArtifactMutations = [
  ["artifact id", "artifactId", sourcePin.artifactId + 1],
  ["artifact name", "artifactName", `production-last-known-good-${"a".repeat(40)}`],
  ["artifact digest", "artifactDigest", `sha256:${"a".repeat(64)}`],
  ["workflow run", "runId", sourcePin.runId + 1],
  ["head sha", "headSha", "a".repeat(40)],
  ["product commit", "productCommit", "a".repeat(40)],
  ["control commit", "controlCommit", "a".repeat(40)],
  ["workflow event", "workflowEvent", "workflow_dispatch"],
  ["workflow branch", "workflowBranch", "develop"],
  ["run attempt", "runAttempt", sourcePin.runAttempt + 1],
  ["workflow path", "workflowPath", ".github/workflows/other.yml"],
  ["creation time", "createdAt", "2026-09-03T14:26:50.000Z"],
  ["expiry", "expiresAt", "2026-12-02T13:56:15.000Z"],
  ["archive size", "sizeInBytes", sourcePin.artifactSizeInBytes + 1],
];
for (const [name, field, replacement] of sourceArtifactMutations) {
  test(`source ${name} tamper is rejected`, () => {
    const input = seedInput();
    input.sourceArtifactMetadata[field] = replacement;
    expectThrows(
      () => createRepositoryMigrationSeedIdentity(input),
      name,
      /^REPOSITORY_MIGRATION_/u,
    );
  });
}

test("source proof digest tamper is rejected", () => {
  const input = seedInput();
  input.sourceArtifactProof.proofDigest = "a".repeat(64);
  expectThrows(() => createRepositoryMigrationSeedIdentity(input), "source proof digest");
});

test("source identity provenance tamper is rejected", () => {
  const input = seedInput();
  input.sourceIdentity.provenanceDigest = "a".repeat(64);
  expectThrows(() => createRepositoryMigrationSeedIdentity(input), "source identity provenance");
});

test("Vercel selection proof tamper and wrong ownership are rejected", () => {
  const input = seedInput();
  input.vercelSelectionProof.proofDigest = "a".repeat(64);
  expectThrows(() => createRepositoryMigrationSeedIdentity(input), "selection proof digest");
  const seed = createSeed();
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(seed, {
      expectedVercelTeamId: "team_wrong",
      expectedVercelProjectId: PROJECT_ID,
      now: VALIDATION_NOW,
    }),
    "Vercel team ownership",
  );
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(seed, {
      expectedVercelTeamId: TEAM_ID,
      expectedVercelProjectId: "prj_wrong",
      now: VALIDATION_NOW,
    }),
    "Vercel project ownership",
  );
});

const fixedTargetMutations = [
  ["target repository", "repository", "attacker/novel"],
  ["target repository id", "repositoryId", targetPin.repositoryId + 1],
  ["target workflow path", "workflowPath", ".github/workflows/other.yml"],
  ["target workflow ref", "workflowRef", `${targetPin.repository}/.github/workflows/deploy.yml@refs/heads/develop`],
  ["target event", "eventName", "push"],
  ["target ref", "eventRef", "refs/heads/develop"],
  ["target operation", "operation", "restore-known-stable"],
];
for (const [name, field, replacement] of fixedTargetMutations) {
  test(`${name} tamper is rejected while creating the seed`, () => {
    const input = seedInput();
    input.target[field] = replacement;
    expectThrows(
      () => createRepositoryMigrationSeedIdentity(input),
      name,
      /^REPOSITORY_MIGRATION_/u,
    );
  });
}

test("invalid or self-referential target consumer coordinates are rejected", () => {
  for (const [field, replacement] of [
    ["consumerRunId", "0"],
    ["consumerCommit", "not-a-commit"],
    ["bootstrapRunId", CONSUMER_RUN_ID],
    ["bootstrapRunAttempt", "0"],
    ["bootstrapControlCommit", "not-a-commit"],
  ]) {
    const input = seedInput();
    input.target[field] = replacement;
    expectThrows(
      () => createRepositoryMigrationSeedIdentity(input),
      `invalid target ${field}`,
      /^REPOSITORY_MIGRATION_/u,
    );
  }
});

test("seed expiry and time ordering fail closed", () => {
  const nearExpiry = seedInput();
  nearExpiry.seededAt = "2026-12-02T00:00:00.000Z";
  expectThrows(
    () => createRepositoryMigrationSeedIdentity(nearExpiry),
    "less than one day remains before source expiry",
    /^REPOSITORY_MIGRATION_/u,
  );
  const proofFromFuture = seedInput();
  proofFromFuture.seededAt = "2026-09-04T23:59:59.000Z";
  expectThrows(
    () => createRepositoryMigrationSeedIdentity(proofFromFuture),
    "source proof from future",
    /^REPOSITORY_MIGRATION_/u,
  );
  const selectionFromFuture = seedInput();
  selectionFromFuture.seededAt = "2026-09-05T00:00:30.000Z";
  expectThrows(
    () => createRepositoryMigrationSeedIdentity(selectionFromFuture),
    "selection proof from future",
    /^REPOSITORY_MIGRATION_/u,
  );
});

test("seed validity is exactly 24 hours and both time boundaries fail closed", () => {
  const seed = createSeed();
  assert.deepEqual(
    validateRepositoryMigrationSeedIdentity(seed, { now: Date.parse(seed.seededAt) }),
    seed,
    "the inclusive seededAt boundary must be valid",
  );
  assert.deepEqual(
    validateRepositoryMigrationSeedIdentity(seed, { now: Date.parse(seed.expiresAt) - 1 }),
    seed,
    "the final millisecond before expiry must be valid",
  );
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(seed, { now: Date.parse(seed.seededAt) - 1 }),
    "a seed is not valid before seededAt",
    /^REPOSITORY_MIGRATION_SEED_NOT_YET_VALID$/u,
  );
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(seed, { now: Date.parse(seed.expiresAt) }),
    "the exact expiresAt boundary is expired",
    /^REPOSITORY_MIGRATION_SEED_EXPIRED$/u,
  );
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(seed, { now: Number.NaN }),
    "an unknown current time fails closed",
    /^REPOSITORY_MIGRATION_CURRENT_TIME_INVALID$/u,
  );
});

test("expiresAt is digest-bound and cannot extend seed lifetime", () => {
  const tampered = clone(createSeed());
  tampered.expiresAt = "2026-09-06T00:02:00.001Z";
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(tampered, { now: VALIDATION_NOW }),
    "expiresAt tamper",
    /^REPOSITORY_MIGRATION_SEED_DIGEST_INVALID$/u,
  );
});

test("seed shape, nested tamper, and provenance digest tamper are rejected", () => {
  const extra = { ...createSeed(), unexpected: true };
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(extra),
    "unexpected seed key",
    /^REPOSITORY_MIGRATION_/u,
  );
  const nested = clone(createSeed());
  nested.target.consumerCommit = "a".repeat(40);
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(nested, { now: VALIDATION_NOW }),
    "nested target tamper",
  );
  const digestTamper = clone(createSeed());
  digestTamper.provenanceDigest = "a".repeat(64);
  expectThrows(
    () => validateRepositoryMigrationSeedIdentity(digestTamper, { now: VALIDATION_NOW }),
    "seed provenance digest tamper",
    /^REPOSITORY_MIGRATION_/u,
  );
});

test("exact consumer run is eligible and rerun attempts remain eligible", () => {
  const seed = createSeed();
  assert.equal(isRepositoryMigrationSeedEligible(seed, eligibilityContext()), true);
  assert.equal(
    isRepositoryMigrationSeedEligible(seed, eligibilityContext({ runAttempt: "2" })),
    true,
    "a rerun keeps the same GitHub run id and must remain eligible",
  );
  assert.equal(
    isRepositoryMigrationSeedEligible(seed, eligibilityContext({ runAttempt: "999" })),
    true,
    "run attempt must not be confused with run id",
  );
});

test("eligibility rejects not-yet-valid and expired seeds even if artifact retention lingers", () => {
  const seed = createSeed();
  assert.equal(
    isRepositoryMigrationSeedEligible(seed, eligibilityContext({
      now: Date.parse(seed.seededAt) - 1,
    })),
    false,
  );
  assert.equal(
    isRepositoryMigrationSeedEligible(seed, eligibilityContext({
      now: Date.parse(seed.expiresAt),
    })),
    false,
  );
});

const consumerContextMutations = [
  ["repository", { repository: "attacker/novel" }],
  ["repository id", { repositoryId: targetPin.repositoryId + 1 }],
  ["consumer run", { runId: String(Number(CONSUMER_RUN_ID) + 1) }],
  ["consumer sha", { headSha: "a".repeat(40) }],
  ["event", { eventName: "workflow_dispatch" }],
  ["ref", { eventRef: "refs/heads/develop" }],
  ["workflow path", { workflowPath: ".github/workflows/other.yml" }],
  ["workflow ref", { workflowRef: `${targetPin.repository}/.github/workflows/deploy.yml@refs/heads/develop` }],
];
for (const [name, overrides] of consumerContextMutations) {
  test(`${name} mismatch makes the migration seed ineligible`, () => {
    assert.equal(
      isRepositoryMigrationSeedEligible(createSeed(), eligibilityContext(overrides)),
      false,
    );
  });
}

test("canonical target-repository LKG takes precedence and permanently stops seed replay", () => {
  const seed = createSeed();
  assert.equal(
    isRepositoryMigrationSeedEligible(seed, eligibilityContext({
      canonicalLastKnownGoodAvailable: true,
    })),
    false,
  );
  assert.equal(
    isRepositoryMigrationSeedEligible(seed, eligibilityContext({
      canonicalLastKnownGoodAvailable: true,
      runAttempt: "2",
    })),
    false,
    "rerunning the original consumer must not revive a seed after canonical publication",
  );
});

test("tampered migration seed is never eligible", () => {
  const tampered = clone(createSeed());
  tampered.sourceArtifact.runId += 1;
  assert.equal(isRepositoryMigrationSeedEligible(tampered, eligibilityContext()), false);
});

function githubApiFixture({ sourceRepositoryId = sourcePin.repositoryId } = {}) {
  const consumerRun = {
    id: Number(CONSUMER_RUN_ID),
    repository: { id: targetPin.repositoryId, full_name: targetPin.repository },
    status: "completed",
    conclusion: "failure",
    event: "push",
    head_branch: "main",
    head_sha: CONSUMER_COMMIT,
    run_attempt: 1,
    path: ".github/workflows/deploy.yml",
  };
  return async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    const authorization = String(options.headers?.Authorization || options.headers?.authorization || "");
    if (url.hostname === "api.github.com") {
      if (url.pathname === `/repos/${sourcePin.repository}`) {
        assert.equal(authorization, "Bearer source-token");
        return Response.json({
          id: sourceRepositoryId,
          node_id: sourcePin.nodeId,
          full_name: sourcePin.repository,
          default_branch: sourcePin.defaultBranch,
          visibility: sourcePin.visibility,
          private: false,
        });
      }
      if (url.pathname === `/repos/${sourcePin.repository}/actions/artifacts/${sourcePin.artifactId}`) {
        assert.equal(authorization, "Bearer source-token");
        return Response.json({
          id: sourcePin.artifactId,
          name: sourcePin.artifactName,
          digest: sourcePin.artifactDigest,
          size_in_bytes: sourcePin.artifactSizeInBytes,
          expired: false,
          created_at: sourcePin.createdAt,
          expires_at: sourcePin.expiresAt,
          workflow_run: {
            id: sourcePin.runId,
            head_branch: sourcePin.workflowBranch,
            head_sha: sourcePin.headSha,
          },
        });
      }
      if (url.pathname === `/repos/${sourcePin.repository}/actions/runs/${sourcePin.runId}`) {
        assert.equal(authorization, "Bearer source-token");
        return Response.json({
          id: sourcePin.runId,
          repository: { id: sourcePin.repositoryId, full_name: sourcePin.repository },
          status: "completed",
          conclusion: "success",
          event: sourcePin.workflowEvent,
          head_branch: sourcePin.workflowBranch,
          head_sha: sourcePin.headSha,
          run_attempt: sourcePin.runAttempt,
          path: sourcePin.workflowPath,
        });
      }
      if (url.pathname === `/repos/${sourcePin.repository}/actions/artifacts/${sourcePin.artifactId}/zip`) {
        assert.equal(authorization, "Bearer source-token");
        return new Response(SOURCE_ARCHIVE, {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      }
      if (url.pathname === `/repos/${targetPin.repository}`) {
        assert.equal(authorization, "Bearer target-token");
        return Response.json({
          id: targetPin.repositoryId,
          node_id: targetPin.nodeId,
          full_name: targetPin.repository,
          default_branch: targetPin.defaultBranch,
          visibility: "private",
          private: true,
        });
      }
      if (url.pathname === `/repos/${targetPin.repository}/actions/runs/${CONSUMER_RUN_ID}`) {
        assert.equal(authorization, "Bearer target-token");
        return Response.json(consumerRun);
      }
      if (url.pathname === `/repos/${targetPin.repository}/compare/${sourcePin.productCommit}...${CONSUMER_COMMIT}`) {
        assert.equal(authorization, "Bearer target-token");
        return Response.json({
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          base_commit: { sha: sourcePin.productCommit },
          merge_base_commit: { sha: sourcePin.productCommit },
        });
      }
    }
    throw new Error(`UNEXPECTED_FIXTURE_REQUEST:${url.href}`);
  };
}

test("pinned verifier rejects missing scoped tokens before any request", async () => {
  let requestCount = 0;
  await expectRejects(
    () => verifyPinnedRepositoryMigrationSource({
      sourceToken: "",
      targetToken: "target-token",
      consumerRunId: CONSUMER_RUN_ID,
      consumerCommit: CONSUMER_COMMIT,
      fetcher: async () => {
        requestCount += 1;
        throw new Error("NETWORK_MUST_NOT_RUN");
      },
      now: Date.parse(SEEDED_AT),
    }),
    "missing source token",
    /^REPOSITORY_MIGRATION_/u,
  );
  assert.equal(requestCount, 0);
});

test("pinned verifier rejects source repository id substitution", async () => {
  await expectRejects(
    () => verifyPinnedRepositoryMigrationSource({
      sourceToken: "source-token",
      targetToken: "target-token",
      consumerRunId: CONSUMER_RUN_ID,
      consumerCommit: CONSUMER_COMMIT,
      fetcher: githubApiFixture({ sourceRepositoryId: sourcePin.repositoryId + 1 }),
      now: Date.parse(SEEDED_AT),
    }),
    "source repository id substitution",
    /^REPOSITORY_MIGRATION_/u,
  );
});

test("pinned verifier accepts only the exact source tuple and target consumer lineage", async () => {
  const verified = await verifyPinnedRepositoryMigrationSource({
    sourceToken: "source-token",
    targetToken: "target-token",
    consumerRunId: CONSUMER_RUN_ID,
    consumerCommit: CONSUMER_COMMIT,
    fetcher: githubApiFixture(),
    now: Date.parse(SEEDED_AT),
  });
  assert.equal(verified.sourceRepositoryMetadata.repository, sourcePin.repository);
  assert.equal(verified.sourceRepositoryMetadata.repositoryId, sourcePin.repositoryId);
  assert.equal(verified.sourceArtifactMetadata.artifactDigest, sourcePin.artifactDigest);
  assert.equal(verified.sourceIdentity.provenanceDigest, sourcePin.identityProvenanceDigest);
  assert.equal(verified.sourceArtifactProof.repository, sourcePin.repository);
  assert.equal(verified.consumerRunAttempt, 1);
  assert.doesNotMatch(JSON.stringify(verified), /source-token|target-token/u);
});

function migrationDiscoveryContext(runAttempt = "2") {
  return {
    repository: targetPin.repository,
    repositoryId: targetPin.repositoryId,
    runId: CONSUMER_RUN_ID,
    runAttempt,
    headSha: CONSUMER_COMMIT,
    eventName: "push",
    eventRef: "refs/heads/main",
    workflowPath: ".github/workflows/deploy.yml",
    workflowRef: `${targetPin.repository}/.github/workflows/deploy.yml@refs/heads/main`,
  };
}

function migrationSeedName(controlCommit = BOOTSTRAP_COMMIT, consumerRunId = CONSUMER_RUN_ID) {
  return `production-last-known-good-migration-control-${controlCommit}`
    + `-consumer-${consumerRunId}-product-${sourcePin.productCommit}`;
}

function publicationPreflightFetcher(artifacts) {
  return async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    assert.equal(url.pathname, `/repos/${targetPin.repository}/actions/artifacts`);
    assert.equal(options.method, "GET", "publication preflight must be GET-only");
    assert.equal(String(options.headers?.Authorization), "Bearer target-token");
    return Response.json({ total_count: artifacts.length, artifacts });
  };
}

test("publication preflight is GET-only and returns a zero-mutation exact seed name", async () => {
  const result = await assertRepositoryMigrationSeedNotPublished({
    repository: targetPin.repository,
    repositoryId: targetPin.repositoryId,
    controlCommit: BOOTSTRAP_COMMIT,
    consumerRunId: CONSUMER_RUN_ID,
    token: "target-token",
    fetcher: publicationPreflightFetcher([{
      id: 8,
      name: migrationSeedName("a".repeat(40), String(Number(CONSUMER_RUN_ID) + 1)),
    }]),
  });
  assert.equal(result.seedName, migrationSeedName());
  assert.equal(result.readOnly, true);
  assert.equal(result.mutationCount, 0);
  assert.equal(result.inspectedCount, 1);
});

for (const [label, artifactName] of [
  ["exact seed name", migrationSeedName()],
  ["same consumer under another control commit", migrationSeedName("a".repeat(40))],
]) {
  test(`publication preflight rejects ${label} without deleting or overwriting it`, async () => {
    await expectRejects(
      () => assertRepositoryMigrationSeedNotPublished({
        repository: targetPin.repository,
        repositoryId: targetPin.repositoryId,
        controlCommit: BOOTSTRAP_COMMIT,
        consumerRunId: CONSUMER_RUN_ID,
        token: "target-token",
        fetcher: publicationPreflightFetcher([{
          id: 9,
          name: artifactName,
          expired: true,
        }]),
      }),
      label,
      /^REPOSITORY_MIGRATION_SEED_ALREADY_PUBLISHED$/u,
    );
  });
}

test("publication preflight fails closed when the artifact inventory cannot be completed", async () => {
  let requestCount = 0;
  await expectRejects(
    () => assertRepositoryMigrationSeedNotPublished({
      repository: targetPin.repository,
      repositoryId: targetPin.repositoryId,
      controlCommit: BOOTSTRAP_COMMIT,
      consumerRunId: CONSUMER_RUN_ID,
      token: "target-token",
      fetcher: async (_rawUrl, options = {}) => {
        requestCount += 1;
        assert.equal(options.method, "GET");
        return Response.json({
          total_count: 1_001,
          artifacts: Array.from({ length: 100 }, (_, index) => ({
            id: requestCount * 100 + index,
            name: `unrelated-${requestCount}-${index}`,
          })),
        });
      },
    }),
    "incomplete inventory",
    /^REPOSITORY_MIGRATION_SEED_PREFLIGHT_INCOMPLETE$/u,
  );
  assert.equal(requestCount, 10);
});

function migrationDiscoveryFetcher(priorConclusion) {
  const artifactName = `production-last-known-good-migration-control-${BOOTSTRAP_COMMIT}`
    + `-consumer-${CONSUMER_RUN_ID}-product-${sourcePin.productCommit}`;
  const archive = createStoredZip("last-known-good-production.json", JSON.stringify(createSeed()));
  const artifactDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  return async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith(`/actions/runs/${CONSUMER_RUN_ID}/attempts/1`)) {
      return Response.json({
        status: "completed",
        conclusion: priorConclusion,
        event: "push",
        head_branch: "main",
        head_sha: CONSUMER_COMMIT,
        path: ".github/workflows/deploy.yml",
      });
    }
    if (url.pathname.endsWith("/actions/artifacts")) {
      return Response.json({
        total_count: 1,
        artifacts: [{
          id: 90_001,
          name: artifactName,
          digest: artifactDigest,
          expired: false,
          created_at: "2026-09-05T00:03:00.000Z",
          workflow_run: { id: Number(BOOTSTRAP_RUN_ID), head_branch: "main", head_sha: BOOTSTRAP_COMMIT },
        }],
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${BOOTSTRAP_RUN_ID}`)) {
      return Response.json({
        id: Number(BOOTSTRAP_RUN_ID),
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: BOOTSTRAP_COMMIT,
        run_attempt: 1,
        path: ".github/workflows/deploy.yml",
        repository: { id: targetPin.repositoryId },
      });
    }
    if (url.pathname.endsWith("/actions/artifacts/90001/zip")) {
      return new Response(archive, { status: 200 });
    }
    throw new Error(`UNEXPECTED_DISCOVERY_REQUEST:${url.href}`);
  };
}

function createStoredZip(name, content) {
  const filename = Buffer.from(name);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

test("a failed first attempt may consume the seed on the exact same run", async () => {
  const artifact = await discoverRepositoryMigrationSeedArtifact({
    repository: targetPin.repository,
    repositoryId: targetPin.repositoryId,
    token: "target-token",
    currentContext: migrationDiscoveryContext("2"),
    fetcher: migrationDiscoveryFetcher("failure"),
    now: Date.parse(VALIDATION_NOW),
  });
  assert.equal(artifact.publicationMode, "repository-migration-seed");
  assert.equal(artifact.productCommit, sourcePin.productCommit);
});

test("discovery rejects a retained migration artifact at the exact seed expiry boundary", async () => {
  await expectRejects(
    () => discoverRepositoryMigrationSeedArtifact({
      repository: targetPin.repository,
      repositoryId: targetPin.repositoryId,
      token: "target-token",
      currentContext: migrationDiscoveryContext("2"),
      fetcher: migrationDiscoveryFetcher("failure"),
      now: Date.parse(SEED_EXPIRES_AT),
    }),
    "retained artifact after seed expiry",
    /^REPOSITORY_MIGRATION_SEED_EXPIRED$/u,
  );
});

test("a prior successful attempt permanently fuses the seed for the same run id", async () => {
  await expectRejects(
    () => discoverRepositoryMigrationSeedArtifact({
      repository: targetPin.repository,
      repositoryId: targetPin.repositoryId,
      token: "target-token",
      currentContext: migrationDiscoveryContext("2"),
      fetcher: migrationDiscoveryFetcher("success"),
      now: Date.parse(VALIDATION_NOW),
    }),
    "successful prior attempt must consume seed",
    /^REPOSITORY_MIGRATION_SEED_ALREADY_CONSUMED$/u,
  );
});

test("destination seed download verifies its archive, wrapper, consumer, and Vercel ownership", async () => {
  const seed = createSeed();
  const archive = createStoredZip("last-known-good-production.json", JSON.stringify(seed));
  const artifact = {
    artifactId: 90_001,
    artifactName: `production-last-known-good-migration-control-${BOOTSTRAP_COMMIT}`
      + `-consumer-${CONSUMER_RUN_ID}-product-${sourcePin.productCommit}`,
    artifactDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    runId: Number(BOOTSTRAP_RUN_ID),
    headSha: BOOTSTRAP_COMMIT,
    productCommit: sourcePin.productCommit,
    controlCommit: BOOTSTRAP_COMMIT,
    workflowEvent: "workflow_dispatch",
    workflowBranch: "main",
    runAttempt: 1,
    workflowPath: ".github/workflows/deploy.yml",
    createdAt: "2026-09-05T00:03:00.000Z",
    publicationMode: "repository-migration-seed",
  };
  const result = await downloadRepositoryMigrationSeedArtifact({
    repository: targetPin.repository,
    token: "target-token",
    artifact,
    currentContext: eligibilityContext({ runAttempt: "2" }),
    expectedVercelTeamId: TEAM_ID,
    expectedVercelProjectId: PROJECT_ID,
    fetcher: async () => new Response(archive),
    now: Date.parse(VALIDATION_NOW),
  });
  assert.equal(result.identity.provenanceDigest, sourcePin.identityProvenanceDigest);
  assert.equal(result.proof.publicationMode, "repository-migration-seed");
  assert.equal(result.proof.consumerRunId, CONSUMER_RUN_ID);
  assert.equal(result.proof.seedProvenanceDigest, seed.provenanceDigest);
  await expectRejects(
    () => downloadRepositoryMigrationSeedArtifact({
      repository: targetPin.repository,
      token: "target-token",
      artifact: { ...artifact, artifactDigest: `sha256:${"0".repeat(64)}` },
      currentContext: eligibilityContext({ runAttempt: "2" }),
      expectedVercelTeamId: TEAM_ID,
      expectedVercelProjectId: PROJECT_ID,
      fetcher: async () => new Response(archive),
      now: Date.parse(VALIDATION_NOW),
    }),
    "destination archive digest mismatch",
    /^REPOSITORY_MIGRATION_ARCHIVE_DIGEST_MISMATCH$/u,
  );
  await expectRejects(
    () => downloadRepositoryMigrationSeedArtifact({
      repository: targetPin.repository,
      token: "target-token",
      artifact,
      currentContext: eligibilityContext({ runAttempt: "2" }),
      expectedVercelTeamId: TEAM_ID,
      expectedVercelProjectId: PROJECT_ID,
      fetcher: async () => new Response(archive),
      now: Date.parse(SEED_EXPIRES_AT),
    }),
    "download at exact seed expiry",
    /^REPOSITORY_MIGRATION_SEED_EXPIRED$/u,
  );
  await expectRejects(
    () => downloadRepositoryMigrationSeedArtifact({
      repository: targetPin.repository,
      token: "target-token",
      artifact: { ...artifact, createdAt: SEED_EXPIRES_AT },
      currentContext: eligibilityContext({ runAttempt: "2" }),
      expectedVercelTeamId: TEAM_ID,
      expectedVercelProjectId: PROJECT_ID,
      fetcher: async () => new Response(archive),
      now: Date.parse(SEED_EXPIRES_AT) - 1,
    }),
    "artifact publication delayed until the seed expiry boundary",
    /^REPOSITORY_MIGRATION_ARTIFACT_PROOF_INVALID$/u,
  );
});

let passed = 0;
const failures = [];
for (const { name, operation } of tests) {
  try {
    await operation();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stderr.write(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

const summary = {
  schemaVersion: "repository-migration-lkg-bootstrap-tests-v1",
  status: failures.length === 0 ? "PASS" : "FAIL",
  total: tests.length,
  passed,
  failed: failures.length,
  sourceRepository: sourcePin.repository,
  sourceArtifactId: sourcePin.artifactId,
  targetRepository: targetPin.repository,
  externalMutationCount: 0,
  rawTokensIncluded: false,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (failures.length > 0) process.exitCode = 1;
