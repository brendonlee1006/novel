import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  assertDeadline,
  boundedFetch,
  boundedOperation,
} from "./bounded-fetch.mjs";
import {
  RC6_2_RECOVERY_OPERATION,
  validateProductionRecoveryControlProof,
} from "./verify-production-recovery-control.mjs";

const LKG_SCHEMA_V1 = "last-known-good-production-identity-v1";
const LKG_SCHEMA_V2 = "last-known-good-production-identity-v2";
const LKG_ARTIFACT_PROOF_SCHEMA = "github-actions-lkg-artifact-proof-v2";
const REPOSITORY_MIGRATION_SEED_SCHEMA = "repository-migration-lkg-seed-v3";
const REPOSITORY_MIGRATION_ARTIFACT_PROOF_SCHEMA = "github-actions-repository-migration-lkg-proof-v3";
const READ_ONLY_SELECTION_PROOF_SCHEMA = "p24b-rc6.2-readonly-rollback-selection-proof-v3";
const ARTIFACT_DIGEST = /^sha256:([a-f0-9]{64})$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;
const LEGACY_LKG_ARTIFACT = /^production-last-known-good-([a-f0-9]{40})$/u;
const CONTROLLED_LKG_ARTIFACT = /^production-last-known-good-control-([a-f0-9]{40})-product-([a-f0-9]{40})$/u;
const REPOSITORY_MIGRATION_LKG_ARTIFACT = /^production-last-known-good-migration-control-([a-f0-9]{40})-consumer-([1-9][0-9]{0,19})-product-([a-f0-9]{40})$/u;
const REPOSITORY_MIGRATION_OPERATION = "bootstrap-lkg-repository-migration";
const REPOSITORY_MIGRATION_WORKFLOW_PATH = ".github/workflows/deploy.yml";
const REPOSITORY_MIGRATION_MINIMUM_SOURCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const REPOSITORY_MIGRATION_SEED_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export const REPOSITORY_MIGRATION_SOURCE = Object.freeze({
  repository: "bobobo-org/novel",
  repositoryId: 1_292_526_682,
  nodeId: "R_kgDOTQpkWg",
  defaultBranch: "main",
  visibility: "public",
  artifactId: 9_897_879_443,
  artifactName: "production-last-known-good-e20baa0366cfe0fd494c3808ac04ddaef3144131",
  artifactDigest: "sha256:32df7d343c5ef11e027df5a064d4f70f4ac9e9249d3996787c37860de391e14d",
  artifactSizeInBytes: 480,
  runId: 33_763_928_992,
  headSha: "e20baa0366cfe0fd494c3808ac04ddaef3144131",
  productCommit: "e20baa0366cfe0fd494c3808ac04ddaef3144131",
  controlCommit: "e20baa0366cfe0fd494c3808ac04ddaef3144131",
  workflowEvent: "push",
  workflowBranch: "main",
  runAttempt: 1,
  workflowPath: REPOSITORY_MIGRATION_WORKFLOW_PATH,
  createdAt: "2026-09-03T14:26:49.000Z",
  expiresAt: "2026-12-02T13:56:14.000Z",
  primaryDeploymentId: "dpl_Df3jGPUKfXqWxpAf38HZns4p6bSk",
  mirrorDeploymentId: "dpl_Df3jGPUKfXqWxpAf38HZns4p6bSk",
  releaseTag: "novel-ai-p24b-conversation-first-studio-rc6.5",
  releaseRevision: "rc6.5",
  identityVerifiedAt: "2026-09-03T14:26:49.137Z",
  identityProvenanceDigest: "18f0e878b8e11cc5e2c9f96a09e4589cac33421907587966c654451e3943bd5d",
});

export const REPOSITORY_MIGRATION_TARGET = Object.freeze({
  repository: "brendonlee1006/novel",
  repositoryId: 1_357_493_987,
  nodeId: "R_kgDOUOm24w",
  defaultBranch: "main",
});

const REPOSITORY_MIGRATION_SEED_KEYS = Object.freeze([
  "schemaVersion",
  "publicationMode",
  "seededAt",
  "expiresAt",
  "sourceRepository",
  "sourceArtifact",
  "sourceIdentity",
  "sourceArtifactProof",
  "target",
  "vercelSelectionProof",
  "provenanceDigest",
]);
const REPOSITORY_MIGRATION_SOURCE_REPOSITORY_KEYS = Object.freeze([
  "repository", "repositoryId", "nodeId", "defaultBranch", "visibility",
]);
const REPOSITORY_MIGRATION_SOURCE_ARTIFACT_KEYS = Object.freeze([
  "artifactId", "artifactName", "artifactDigest", "runId", "headSha", "productCommit",
  "controlCommit", "workflowEvent", "workflowBranch", "runAttempt", "workflowPath",
  "createdAt", "expiresAt", "sizeInBytes",
]);
const REPOSITORY_MIGRATION_TARGET_KEYS = Object.freeze([
  "repository", "repositoryId", "bootstrapControlCommit", "bootstrapRunId",
  "bootstrapRunAttempt", "workflowPath", "workflowRef", "eventName", "eventRef",
  "operation", "consumerRunId", "consumerCommit",
]);
const REPOSITORY_MIGRATION_ARTIFACT_PROOF_KEYS = Object.freeze([
  "schemaVersion", "repository", "artifactId", "artifactName", "artifactDigest",
  "archiveSha256", "runId", "headSha", "productCommit", "controlCommit",
  "publicationMode", "workflowEvent", "workflowBranch", "runAttempt", "workflowPath",
  "createdAt", "seed", "seedProvenanceDigest", "identityProvenanceDigest",
  "sourceArtifactProofDigest", "consumerRunId", "consumerCommit", "readOnlyDiscovery",
  "artifactControlPlaneVerified", "workflowRunControlPlaneVerified", "proofDigest",
]);
const READ_ONLY_SELECTION_PROOF_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "selectedAt",
  "source",
  "primaryDeploymentId",
  "primaryAppCommit",
  "mirrorDeploymentId",
  "mirrorAppCommit",
  "lastKnownGoodAvailable",
  "lastKnownGoodArtifactProofDigest",
  "lastKnownGoodControlPlaneVerified",
  "readOnlySelection",
  "vercelTeamIdSha256",
  "vercelProjectIdSha256",
  "auditProvenance",
  "proofDigest",
]);
const AUDIT_PROVENANCE_KEYS = Object.freeze([
  "mode",
  "productCommit",
  "controlCommit",
  "controlProofDigest",
  "repository",
  "eventName",
  "eventRef",
  "eventCommit",
  "workflow",
  "workflowRef",
  "workflowSha",
  "runId",
  "runAttempt",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function fingerprint(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512 || /[\0\r\n]/u.test(normalized)) {
    throw Object.assign(new Error(code), { code });
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function proofError(code) {
  return Object.assign(new Error(code), { code });
}

function repositoryMigrationCurrentTimeMs(now) {
  const value = now instanceof Date
    ? now.getTime()
    : typeof now === "number"
      ? now
      : Date.parse(String(now || ""));
  if (!Number.isFinite(value)) {
    throw proofError("REPOSITORY_MIGRATION_CURRENT_TIME_INVALID");
  }
  return value;
}

function isSafeZipPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return Boolean(normalized)
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:\//u.test(normalized)
    && !normalized.split("/").includes("..");
}

export function extractLastKnownGoodIdentityFromZip(zipBytes) {
  const zip = Buffer.from(zipBytes);
  const minimumEocd = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= minimumEocd; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("LAST_KNOWN_GOOD_ZIP_EOCD_MISSING");
  const entries = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (entries !== 1 || centralOffset + centralSize > eocd) {
    throw new Error("LAST_KNOWN_GOOD_ZIP_TOPOLOGY_INVALID");
  }
  if (zip.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error("LAST_KNOWN_GOOD_ZIP_CENTRAL_DIRECTORY_INVALID");
  }
  const flags = zip.readUInt16LE(centralOffset + 8);
  const method = zip.readUInt16LE(centralOffset + 10);
  const compressedSize = zip.readUInt32LE(centralOffset + 20);
  const uncompressedSize = zip.readUInt32LE(centralOffset + 24);
  const nameLength = zip.readUInt16LE(centralOffset + 28);
  const extraLength = zip.readUInt16LE(centralOffset + 30);
  const commentLength = zip.readUInt16LE(centralOffset + 32);
  const localOffset = zip.readUInt32LE(centralOffset + 42);
  const entryName = zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
  const centralEnd = centralOffset + 46 + nameLength + extraLength + commentLength;
  if (centralEnd !== centralOffset + centralSize
    || flags & 0x1
    || ![0, 8].includes(method)
    || compressedSize === 0xffffffff
    || uncompressedSize === 0xffffffff
    || !isSafeZipPath(entryName)
    || entryName !== "last-known-good-production.json"
    || zip.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("LAST_KNOWN_GOOD_ZIP_ENTRY_INVALID");
  }
  const localNameLength = zip.readUInt16LE(localOffset + 26);
  const localExtraLength = zip.readUInt16LE(localOffset + 28);
  const localFlags = zip.readUInt16LE(localOffset + 6);
  const localMethod = zip.readUInt16LE(localOffset + 8);
  const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
  if (localFlags !== flags || localMethod !== method || localName !== entryName || !isSafeZipPath(localName)) {
    throw new Error("LAST_KNOWN_GOOD_ZIP_LOCAL_HEADER_MISMATCH");
  }
  const contentStart = localOffset + 30 + localNameLength + localExtraLength;
  const contentEnd = contentStart + compressedSize;
  if (contentEnd > zip.length) throw new Error("LAST_KNOWN_GOOD_ZIP_TRUNCATED");
  const compressed = zip.subarray(contentStart, contentEnd);
  let content;
  try {
    content = method === 8 ? inflateRawSync(compressed) : compressed;
  } catch {
    throw new Error("LAST_KNOWN_GOOD_ZIP_INFLATE_FAILED");
  }
  if (content.length !== uncompressedSize || content.length > 1_000_000) {
    throw new Error("LAST_KNOWN_GOOD_ZIP_SIZE_INVALID");
  }
  return content.toString("utf8");
}

export function createLastKnownGoodArtifactProof({
  repository,
  artifactId,
  artifactName,
  artifactDigest,
  runId,
  headSha,
  productCommit,
  controlCommit = headSha,
  workflowEvent,
  workflowBranch,
  runAttempt,
  workflowPath,
  createdAt,
  downloadedAt = new Date().toISOString(),
  identity,
}) {
  if (!repository
    || !Number.isSafeInteger(Number(artifactId))
    || Number(artifactId) <= 0
    || (!LEGACY_LKG_ARTIFACT.test(String(artifactName || ""))
      && !CONTROLLED_LKG_ARTIFACT.test(String(artifactName || "")))
    || !ARTIFACT_DIGEST.test(String(artifactDigest || ""))
    || !Number.isSafeInteger(Number(runId))
    || !isCommit(headSha)
    || !isCommit(productCommit)
    || !isCommit(controlCommit)
    || controlCommit !== headSha
    || !["push", "workflow_dispatch"].includes(workflowEvent)
    || workflowBranch !== "main"
    || !Number.isSafeInteger(Number(runAttempt))
    || Number(runAttempt) <= 0
    || workflowPath !== ".github/workflows/deploy.yml"
    || !Number.isFinite(Date.parse(createdAt))
    || !Number.isFinite(Date.parse(downloadedAt))) {
    throw new Error("LAST_KNOWN_GOOD_ARTIFACT_PROOF_INVALID");
  }
  const normalizedIdentity = validateLastKnownGoodProductionIdentity(identity);
  const legacyMatch = LEGACY_LKG_ARTIFACT.exec(String(artifactName));
  const controlledMatch = CONTROLLED_LKG_ARTIFACT.exec(String(artifactName));
  const recoveryControlProof = normalizedIdentity.recoveryControlProof ?? null;
  const publicationMode = legacyMatch ? "same-sha" : "immutable-product-control";
  if (normalizedIdentity.appCommit !== productCommit
    || !String(artifactName).endsWith(normalizedIdentity.appCommit)
    || (legacyMatch && (legacyMatch[1] !== productCommit
      || controlCommit !== productCommit
      || workflowEvent !== "push"
      || normalizedIdentity.schemaVersion !== LKG_SCHEMA_V1
      || recoveryControlProof !== null))
    || (controlledMatch && (controlledMatch[1] !== controlCommit
      || controlledMatch[2] !== productCommit
      || controlCommit === productCommit
      || workflowEvent !== "workflow_dispatch"
      || normalizedIdentity.schemaVersion !== LKG_SCHEMA_V2
      || !recoveryControlProof
      || recoveryControlProof.repository !== repository
      || recoveryControlProof.productCommit !== productCommit
      || recoveryControlProof.controlCommit !== controlCommit
      || recoveryControlProof.workflowSha !== controlCommit
      || recoveryControlProof.eventName !== workflowEvent
      || recoveryControlProof.eventRef !== "refs/heads/main"
      || recoveryControlProof.workflowRef !== `${repository}/${workflowPath}@refs/heads/main`
      || recoveryControlProof.runId !== String(runId)
      || recoveryControlProof.runAttempt !== String(runAttempt)
      || recoveryControlProof.operation !== RC6_2_RECOVERY_OPERATION))) {
    throw new Error("LAST_KNOWN_GOOD_ARTIFACT_IDENTITY_MISMATCH");
  }
  const core = {
    schemaVersion: LKG_ARTIFACT_PROOF_SCHEMA,
    repository,
    artifactId: Number(artifactId),
    artifactName,
    artifactDigest,
    archiveSha256: ARTIFACT_DIGEST.exec(artifactDigest)[1],
    runId: Number(runId),
    headSha,
    productCommit,
    controlCommit,
    publicationMode,
    workflowEvent,
    workflowBranch,
    runAttempt: Number(runAttempt),
    workflowPath,
    createdAt: new Date(createdAt).toISOString(),
    downloadedAt: new Date(downloadedAt).toISOString(),
    identityProvenanceDigest: normalizedIdentity.provenanceDigest,
    recoveryControlProofDigest: recoveryControlProof?.proofDigest ?? null,
    readOnlyDiscovery: true,
    artifactControlPlaneVerified: true,
    workflowRunControlPlaneVerified: true,
  };
  return { ...core, proofDigest: digest(core) };
}

export function validateLastKnownGoodArtifactProof(value, identity) {
  if (value?.schemaVersion === REPOSITORY_MIGRATION_ARTIFACT_PROOF_SCHEMA) {
    return validateRepositoryMigrationArtifactProof(value, identity);
  }
  const normalized = createLastKnownGoodArtifactProof({ ...value, identity });
  if (value?.schemaVersion !== LKG_ARTIFACT_PROOF_SCHEMA
    || value?.proofDigest !== normalized.proofDigest
    || value?.archiveSha256 !== normalized.archiveSha256) {
    throw Object.assign(new Error("LAST_KNOWN_GOOD_ARTIFACT_PROOF_DIGEST_INVALID"), {
      code: "LAST_KNOWN_GOOD_ARTIFACT_PROOF_DIGEST_INVALID",
    });
  }
  return normalized;
}

function normalizedIsoTimestamp(value, code) {
  const timestamp = new Date(String(value || ""));
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw proofError(code);
  }
  return timestamp.toISOString();
}

function normalizeRepositoryMigrationSourceRepository(value) {
  if (!hasExactKeys(value, REPOSITORY_MIGRATION_SOURCE_REPOSITORY_KEYS)) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_REPOSITORY_SHAPE_INVALID");
  }
  const normalized = {
    repository: String(value.repository || ""),
    repositoryId: Number(value.repositoryId),
    nodeId: String(value.nodeId || ""),
    defaultBranch: String(value.defaultBranch || ""),
    visibility: String(value.visibility || ""),
  };
  if (normalized.repository !== REPOSITORY_MIGRATION_SOURCE.repository
    || normalized.repositoryId !== REPOSITORY_MIGRATION_SOURCE.repositoryId
    || normalized.nodeId !== REPOSITORY_MIGRATION_SOURCE.nodeId
    || normalized.defaultBranch !== REPOSITORY_MIGRATION_SOURCE.defaultBranch
    || normalized.visibility !== REPOSITORY_MIGRATION_SOURCE.visibility) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_REPOSITORY_MISMATCH");
  }
  return normalized;
}

function normalizeRepositoryMigrationSourceArtifact(value) {
  if (!hasExactKeys(value, REPOSITORY_MIGRATION_SOURCE_ARTIFACT_KEYS)) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_ARTIFACT_SHAPE_INVALID");
  }
  const normalized = {
    artifactId: Number(value.artifactId),
    artifactName: String(value.artifactName || ""),
    artifactDigest: String(value.artifactDigest || ""),
    runId: Number(value.runId),
    headSha: String(value.headSha || ""),
    productCommit: String(value.productCommit || ""),
    controlCommit: String(value.controlCommit || ""),
    workflowEvent: String(value.workflowEvent || ""),
    workflowBranch: String(value.workflowBranch || ""),
    runAttempt: Number(value.runAttempt),
    workflowPath: String(value.workflowPath || ""),
    createdAt: normalizedIsoTimestamp(
      value.createdAt,
      "REPOSITORY_MIGRATION_SOURCE_ARTIFACT_CREATED_AT_INVALID",
    ),
    expiresAt: normalizedIsoTimestamp(
      value.expiresAt,
      "REPOSITORY_MIGRATION_SOURCE_ARTIFACT_EXPIRES_AT_INVALID",
    ),
    sizeInBytes: Number(value.sizeInBytes),
  };
  const expected = REPOSITORY_MIGRATION_SOURCE;
  if (normalized.artifactId !== expected.artifactId
    || normalized.artifactName !== expected.artifactName
    || normalized.artifactDigest !== expected.artifactDigest
    || normalized.runId !== expected.runId
    || normalized.headSha !== expected.headSha
    || normalized.productCommit !== expected.productCommit
    || normalized.controlCommit !== expected.controlCommit
    || normalized.workflowEvent !== expected.workflowEvent
    || normalized.workflowBranch !== expected.workflowBranch
    || normalized.runAttempt !== expected.runAttempt
    || normalized.workflowPath !== expected.workflowPath
    || normalized.createdAt !== expected.createdAt
    || normalized.expiresAt !== expected.expiresAt
    || normalized.sizeInBytes !== expected.artifactSizeInBytes) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_ARTIFACT_MISMATCH");
  }
  return normalized;
}

function normalizeRepositoryMigrationTarget(value) {
  if (!hasExactKeys(value, REPOSITORY_MIGRATION_TARGET_KEYS)) {
    throw proofError("REPOSITORY_MIGRATION_TARGET_SHAPE_INVALID");
  }
  const normalized = {
    repository: String(value.repository || ""),
    repositoryId: Number(value.repositoryId),
    bootstrapControlCommit: String(value.bootstrapControlCommit || ""),
    bootstrapRunId: String(value.bootstrapRunId || ""),
    bootstrapRunAttempt: String(value.bootstrapRunAttempt || ""),
    workflowPath: String(value.workflowPath || ""),
    workflowRef: String(value.workflowRef || ""),
    eventName: String(value.eventName || ""),
    eventRef: String(value.eventRef || ""),
    operation: String(value.operation || ""),
    consumerRunId: String(value.consumerRunId || ""),
    consumerCommit: String(value.consumerCommit || ""),
  };
  if (normalized.repository !== REPOSITORY_MIGRATION_TARGET.repository
    || normalized.repositoryId !== REPOSITORY_MIGRATION_TARGET.repositoryId
    || !isCommit(normalized.bootstrapControlCommit)
    || !/^[1-9][0-9]{0,19}$/u.test(normalized.bootstrapRunId)
    || !/^[1-9][0-9]{0,9}$/u.test(normalized.bootstrapRunAttempt)
    || normalized.workflowPath !== REPOSITORY_MIGRATION_WORKFLOW_PATH
    || normalized.workflowRef !== `${normalized.repository}/${normalized.workflowPath}@refs/heads/main`
    || normalized.eventName !== "workflow_dispatch"
    || normalized.eventRef !== "refs/heads/main"
    || normalized.operation !== REPOSITORY_MIGRATION_OPERATION
    || !/^[1-9][0-9]{0,19}$/u.test(normalized.consumerRunId)
    || !isCommit(normalized.consumerCommit)
    || normalized.bootstrapRunId === normalized.consumerRunId) {
    throw proofError("REPOSITORY_MIGRATION_TARGET_INVALID");
  }
  return normalized;
}

function assertPinnedRepositoryMigrationIdentity(value) {
  const normalized = validateLastKnownGoodProductionIdentity(value);
  const expected = REPOSITORY_MIGRATION_SOURCE;
  if (normalized.schemaVersion !== LKG_SCHEMA_V1
    || normalized.primaryDeploymentId !== expected.primaryDeploymentId
    || normalized.mirrorDeploymentId !== expected.mirrorDeploymentId
    || normalized.appCommit !== expected.productCommit
    || normalized.releaseTag !== expected.releaseTag
    || normalized.releaseRevision !== expected.releaseRevision
    || normalized.verifiedAt !== expected.identityVerifiedAt
    || normalized.provenanceDigest !== expected.identityProvenanceDigest) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_IDENTITY_MISMATCH");
  }
  return normalized;
}

export function createRepositoryMigrationSeedIdentity({
  sourceRepositoryMetadata,
  sourceArtifactMetadata,
  sourceIdentity,
  sourceArtifactProof,
  target,
  vercelSelectionProof,
  seededAt = new Date().toISOString(),
}) {
  const normalizedSeededAt = normalizedIsoTimestamp(
    seededAt,
    "REPOSITORY_MIGRATION_SEEDED_AT_INVALID",
  );
  const seededAtMs = Date.parse(normalizedSeededAt);
  const expiresAt = new Date(
    seededAtMs + REPOSITORY_MIGRATION_SEED_LIFETIME_MS,
  ).toISOString();
  const normalizedSourceRepository = normalizeRepositoryMigrationSourceRepository(
    sourceRepositoryMetadata,
  );
  const normalizedSourceArtifact = normalizeRepositoryMigrationSourceArtifact(
    sourceArtifactMetadata,
  );
  const normalizedSourceIdentity = assertPinnedRepositoryMigrationIdentity(sourceIdentity);
  const normalizedSourceProof = validateLastKnownGoodArtifactProof(
    sourceArtifactProof,
    normalizedSourceIdentity,
  );
  const normalizedTarget = normalizeRepositoryMigrationTarget(target);
  const normalizedSelectionProof = validateReadOnlyRollbackSelectionProof(vercelSelectionProof);
  if (normalizedSourceProof.repository !== normalizedSourceRepository.repository
    || normalizedSourceProof.artifactId !== normalizedSourceArtifact.artifactId
    || normalizedSourceProof.artifactName !== normalizedSourceArtifact.artifactName
    || normalizedSourceProof.artifactDigest !== normalizedSourceArtifact.artifactDigest
    || normalizedSourceProof.runId !== normalizedSourceArtifact.runId
    || normalizedSourceProof.headSha !== normalizedSourceArtifact.headSha
    || normalizedSourceProof.productCommit !== normalizedSourceArtifact.productCommit
    || normalizedSourceProof.controlCommit !== normalizedSourceArtifact.controlCommit
    || normalizedSourceProof.workflowEvent !== normalizedSourceArtifact.workflowEvent
    || normalizedSourceProof.workflowBranch !== normalizedSourceArtifact.workflowBranch
    || normalizedSourceProof.runAttempt !== normalizedSourceArtifact.runAttempt
    || normalizedSourceProof.workflowPath !== normalizedSourceArtifact.workflowPath
    || normalizedSourceProof.createdAt !== normalizedSourceArtifact.createdAt
    || normalizedSourceProof.identityProvenanceDigest !== normalizedSourceIdentity.provenanceDigest
    || Date.parse(normalizedSourceProof.downloadedAt) > seededAtMs
    || Date.parse(normalizedSourceArtifact.expiresAt)
      < seededAtMs + REPOSITORY_MIGRATION_MINIMUM_SOURCE_LIFETIME_MS) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_PROOF_MISMATCH");
  }
  if (normalizedSelectionProof.source !== "last-known-good"
    || normalizedSelectionProof.primaryDeploymentId !== normalizedSourceIdentity.primaryDeploymentId
    || normalizedSelectionProof.mirrorDeploymentId !== normalizedSourceIdentity.mirrorDeploymentId
    || normalizedSelectionProof.primaryAppCommit !== normalizedSourceIdentity.appCommit
    || normalizedSelectionProof.mirrorAppCommit !== normalizedSourceIdentity.appCommit
    || normalizedSelectionProof.lastKnownGoodAvailable !== true
    || normalizedSelectionProof.lastKnownGoodArtifactProofDigest !== normalizedSourceProof.proofDigest
    || normalizedSelectionProof.lastKnownGoodControlPlaneVerified !== true
    || Date.parse(normalizedSelectionProof.selectedAt) > seededAtMs) {
    throw proofError("REPOSITORY_MIGRATION_VERCEL_SELECTION_MISMATCH");
  }
  const core = {
    schemaVersion: REPOSITORY_MIGRATION_SEED_SCHEMA,
    publicationMode: "repository-migration-seed",
    seededAt: normalizedSeededAt,
    expiresAt,
    sourceRepository: normalizedSourceRepository,
    sourceArtifact: normalizedSourceArtifact,
    sourceIdentity: normalizedSourceIdentity,
    sourceArtifactProof: normalizedSourceProof,
    target: normalizedTarget,
    vercelSelectionProof: normalizedSelectionProof,
  };
  return { ...core, provenanceDigest: digest(core) };
}

export function validateRepositoryMigrationSeedIdentity(
  value,
  {
    expectedVercelTeamId,
    expectedVercelProjectId,
    now = Date.now(),
  } = {},
) {
  if (!hasExactKeys(value, REPOSITORY_MIGRATION_SEED_KEYS)) {
    throw proofError("REPOSITORY_MIGRATION_SEED_SHAPE_INVALID");
  }
  const normalizedSelectionProof = validateReadOnlyRollbackSelectionProof(
    value.vercelSelectionProof,
    { expectedTeamId: expectedVercelTeamId, expectedProjectId: expectedVercelProjectId },
  );
  const normalized = createRepositoryMigrationSeedIdentity({
    sourceRepositoryMetadata: value.sourceRepository,
    sourceArtifactMetadata: value.sourceArtifact,
    sourceIdentity: value.sourceIdentity,
    sourceArtifactProof: value.sourceArtifactProof,
    target: value.target,
    vercelSelectionProof: normalizedSelectionProof,
    seededAt: value.seededAt,
  });
  if (value.schemaVersion !== REPOSITORY_MIGRATION_SEED_SCHEMA
    || value.publicationMode !== "repository-migration-seed"
    || value.expiresAt !== normalized.expiresAt
    || !SHA256_DIGEST.test(String(value.provenanceDigest || ""))
    || value.provenanceDigest !== normalized.provenanceDigest) {
    throw proofError("REPOSITORY_MIGRATION_SEED_DIGEST_INVALID");
  }
  const currentTimeMs = repositoryMigrationCurrentTimeMs(now);
  if (currentTimeMs < Date.parse(normalized.seededAt)) {
    throw proofError("REPOSITORY_MIGRATION_SEED_NOT_YET_VALID");
  }
  if (currentTimeMs >= Date.parse(normalized.expiresAt)) {
    throw proofError("REPOSITORY_MIGRATION_SEED_EXPIRED");
  }
  return normalized;
}

export function isRepositoryMigrationSeedEligible(seed, {
  repository,
  repositoryId,
  runId,
  headSha,
  eventName,
  eventRef,
  workflowPath,
  workflowRef,
  canonicalLastKnownGoodAvailable = false,
  now = Date.now(),
}) {
  try {
    const normalized = validateRepositoryMigrationSeedIdentity(seed, { now });
    const target = normalized.target;
    return canonicalLastKnownGoodAvailable === false
      && repository === target.repository
      && Number(repositoryId) === target.repositoryId
      && String(runId) === target.consumerRunId
      && headSha === target.consumerCommit
      && eventName === "push"
      && eventRef === "refs/heads/main"
      && workflowPath === target.workflowPath
      && workflowRef === `${target.repository}/${target.workflowPath}@refs/heads/main`;
  } catch {
    return false;
  }
}

export function createRepositoryMigrationArtifactProof({
  repository,
  artifactId,
  artifactName,
  artifactDigest,
  runId,
  headSha,
  productCommit,
  controlCommit = headSha,
  workflowEvent,
  workflowBranch,
  runAttempt,
  workflowPath,
  createdAt,
  seed,
  identity,
  now = Date.now(),
}) {
  const normalizedSeed = validateRepositoryMigrationSeedIdentity(seed, { now });
  const normalizedIdentity = assertPinnedRepositoryMigrationIdentity(identity);
  const match = REPOSITORY_MIGRATION_LKG_ARTIFACT.exec(String(artifactName || ""));
  const normalizedCreatedAt = normalizedIsoTimestamp(
    createdAt,
    "REPOSITORY_MIGRATION_ARTIFACT_CREATED_AT_INVALID",
  );
  if (repository !== normalizedSeed.target.repository
    || !Number.isSafeInteger(Number(artifactId))
    || Number(artifactId) <= 0
    || !match
    || !ARTIFACT_DIGEST.test(String(artifactDigest || ""))
    || String(runId) !== normalizedSeed.target.bootstrapRunId
    || headSha !== normalizedSeed.target.bootstrapControlCommit
    || productCommit !== normalizedSeed.sourceIdentity.appCommit
    || controlCommit !== headSha
    || workflowEvent !== "workflow_dispatch"
    || workflowBranch !== "main"
    || String(runAttempt) !== normalizedSeed.target.bootstrapRunAttempt
    || workflowPath !== normalizedSeed.target.workflowPath
    || match[1] !== normalizedSeed.target.bootstrapControlCommit
    || match[2] !== normalizedSeed.target.consumerRunId
    || match[3] !== normalizedSeed.sourceIdentity.appCommit
    || normalizedCreatedAt < normalizedSeed.seededAt
    || normalizedCreatedAt >= normalizedSeed.expiresAt
    || Date.parse(normalizedCreatedAt) > repositoryMigrationCurrentTimeMs(now)
    || normalizedIdentity.provenanceDigest !== normalizedSeed.sourceIdentity.provenanceDigest) {
    throw proofError("REPOSITORY_MIGRATION_ARTIFACT_PROOF_INVALID");
  }
  const core = {
    schemaVersion: REPOSITORY_MIGRATION_ARTIFACT_PROOF_SCHEMA,
    repository,
    artifactId: Number(artifactId),
    artifactName,
    artifactDigest,
    archiveSha256: ARTIFACT_DIGEST.exec(artifactDigest)[1],
    runId: Number(runId),
    headSha,
    productCommit,
    controlCommit,
    publicationMode: "repository-migration-seed",
    workflowEvent,
    workflowBranch,
    runAttempt: Number(runAttempt),
    workflowPath,
    createdAt: normalizedCreatedAt,
    seed: normalizedSeed,
    seedProvenanceDigest: normalizedSeed.provenanceDigest,
    identityProvenanceDigest: normalizedIdentity.provenanceDigest,
    sourceArtifactProofDigest: normalizedSeed.sourceArtifactProof.proofDigest,
    consumerRunId: normalizedSeed.target.consumerRunId,
    consumerCommit: normalizedSeed.target.consumerCommit,
    readOnlyDiscovery: true,
    artifactControlPlaneVerified: true,
    workflowRunControlPlaneVerified: true,
  };
  return { ...core, proofDigest: digest(core) };
}

export function validateRepositoryMigrationArtifactProof(value, identity, { now = Date.now() } = {}) {
  if (!hasExactKeys(value, REPOSITORY_MIGRATION_ARTIFACT_PROOF_KEYS)) {
    throw proofError("REPOSITORY_MIGRATION_ARTIFACT_PROOF_SHAPE_INVALID");
  }
  const normalized = createRepositoryMigrationArtifactProof({ ...value, identity, now });
  if (!SHA256_DIGEST.test(String(value.proofDigest || ""))
    || value.proofDigest !== normalized.proofDigest
    || value.archiveSha256 !== normalized.archiveSha256
    || value.seedProvenanceDigest !== normalized.seedProvenanceDigest
    || value.sourceArtifactProofDigest !== normalized.sourceArtifactProofDigest) {
    throw proofError("REPOSITORY_MIGRATION_ARTIFACT_PROOF_DIGEST_INVALID");
  }
  return normalized;
}

function isDeploymentId(value) {
  return /^dpl_[A-Za-z0-9]+$/u.test(String(value || ""));
}

function isCommit(value) {
  return /^[a-f0-9]{40}$/u.test(String(value || ""));
}

function normalizeAuditProvenance(value, { required = false } = {}) {
  if (value == null) {
    if (required) throw proofError("READ_ONLY_SELECTION_AUDIT_PROVENANCE_REQUIRED");
    return null;
  }
  if (!hasExactKeys(value, AUDIT_PROVENANCE_KEYS)) {
    throw proofError("READ_ONLY_SELECTION_AUDIT_PROVENANCE_SHAPE_INVALID");
  }
  const normalized = Object.fromEntries(AUDIT_PROVENANCE_KEYS.map((key) => [
    key,
    typeof value[key] === "string" ? value[key].trim() : "",
  ]));
  normalized.productCommit = normalized.productCommit.toLowerCase();
  normalized.controlCommit = normalized.controlCommit.toLowerCase();
  normalized.eventCommit = normalized.eventCommit.toLowerCase();
  normalized.workflowSha = normalized.workflowSha.toLowerCase();
  const workflowPrefix = `${normalized.repository}/.github/workflows/`;
  const workflowSuffix = `@${normalized.eventRef}`;
  const workflowPath = normalized.workflowRef.startsWith(workflowPrefix)
    && normalized.workflowRef.endsWith(workflowSuffix)
    ? normalized.workflowRef.slice(workflowPrefix.length, -workflowSuffix.length)
    : "";
  if (
    !isCommit(normalized.productCommit)
    || !["same-sha", "immutable-product-control"].includes(normalized.mode)
    || !isCommit(normalized.controlCommit)
    || (normalized.mode === "same-sha" && normalized.controlProofDigest !== "")
    || (normalized.mode === "immutable-product-control"
      && !SHA256_DIGEST.test(normalized.controlProofDigest))
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized.repository)
    || !["push", "workflow_dispatch"].includes(normalized.eventName)
    || !/^refs\/(?:heads|tags)\/[^\0\r\n]{1,480}$/u.test(normalized.eventRef)
    || !isCommit(normalized.eventCommit)
    || !normalized.workflow
    || normalized.workflow.length > 256
    || /[\0\r\n]/u.test(normalized.workflow)
    || !/^[A-Za-z0-9_.\/-]+\.ya?ml$/u.test(workflowPath)
    || workflowPath.split("/").includes("..")
    || normalized.workflowRef.length > 768
    || /[\0\r\n]/u.test(normalized.workflowRef)
    || !isCommit(normalized.workflowSha)
    || !/^[1-9][0-9]{0,19}$/u.test(normalized.runId)
    || !/^[1-9][0-9]{0,9}$/u.test(normalized.runAttempt)
    || normalized.controlCommit !== normalized.eventCommit
    || normalized.controlCommit !== normalized.workflowSha
    || (normalized.mode === "same-sha" && normalized.productCommit !== normalized.controlCommit)
    || (normalized.mode === "immutable-product-control" && (
      normalized.productCommit === normalized.controlCommit
      || normalized.eventName !== "workflow_dispatch"
      || normalized.eventRef !== "refs/heads/main"
    ))
  ) {
    throw proofError("READ_ONLY_SELECTION_AUDIT_PROVENANCE_INVALID");
  }
  return normalized;
}

function normalizeReadOnlySelectionProofCore(value, { requireAuditProvenance = false } = {}) {
  const lastKnownGoodAvailable = value.lastKnownGoodAvailable === true;
  const lastKnownGoodArtifactProofDigest = value.lastKnownGoodArtifactProofDigest ?? null;
  const selectedAt = new Date(value.selectedAt);
  if (
    value.schemaVersion !== READ_ONLY_SELECTION_PROOF_SCHEMA
    || value.status !== "PASS"
    || typeof value.selectedAt !== "string"
    || !Number.isFinite(selectedAt.getTime())
    || selectedAt.toISOString() !== value.selectedAt
    || !["current-transaction-capture", "last-known-good", "emergency-static"].includes(value.source)
    || !isDeploymentId(value.primaryDeploymentId)
    || !isCommit(value.primaryAppCommit)
    || !isDeploymentId(value.mirrorDeploymentId)
    || !isCommit(value.mirrorAppCommit)
    || typeof value.lastKnownGoodAvailable !== "boolean"
    || (lastKnownGoodAvailable && !SHA256_DIGEST.test(String(lastKnownGoodArtifactProofDigest || "")))
    || (!lastKnownGoodAvailable && lastKnownGoodArtifactProofDigest !== null)
    || value.lastKnownGoodControlPlaneVerified !== lastKnownGoodAvailable
    || value.readOnlySelection !== true
    || !SHA256_DIGEST.test(String(value.vercelTeamIdSha256 || ""))
    || !SHA256_DIGEST.test(String(value.vercelProjectIdSha256 || ""))
    || (value.source === "last-known-good" && !lastKnownGoodAvailable)
  ) {
    throw proofError("READ_ONLY_SELECTION_PROOF_INVALID");
  }
  return {
    schemaVersion: READ_ONLY_SELECTION_PROOF_SCHEMA,
    status: "PASS",
    selectedAt: selectedAt.toISOString(),
    source: value.source,
    primaryDeploymentId: value.primaryDeploymentId,
    primaryAppCommit: value.primaryAppCommit,
    mirrorDeploymentId: value.mirrorDeploymentId,
    mirrorAppCommit: value.mirrorAppCommit,
    lastKnownGoodAvailable,
    lastKnownGoodArtifactProofDigest,
    lastKnownGoodControlPlaneVerified: lastKnownGoodAvailable,
    readOnlySelection: true,
    vercelTeamIdSha256: value.vercelTeamIdSha256,
    vercelProjectIdSha256: value.vercelProjectIdSha256,
    auditProvenance: normalizeAuditProvenance(value.auditProvenance, {
      required: requireAuditProvenance,
    }),
  };
}

export function createReadOnlyRollbackSelectionProof({
  selectedAt = new Date().toISOString(),
  source,
  primaryDeploymentId,
  primaryAppCommit,
  mirrorDeploymentId,
  mirrorAppCommit,
  lastKnownGoodAvailable,
  lastKnownGoodArtifactProofDigest = null,
  teamId,
  projectId,
  auditProvenance = null,
  requireAuditProvenance = false,
}) {
  const core = normalizeReadOnlySelectionProofCore({
    schemaVersion: READ_ONLY_SELECTION_PROOF_SCHEMA,
    status: "PASS",
    selectedAt,
    source,
    primaryDeploymentId,
    primaryAppCommit,
    mirrorDeploymentId,
    mirrorAppCommit,
    lastKnownGoodAvailable,
    lastKnownGoodArtifactProofDigest,
    lastKnownGoodControlPlaneVerified: lastKnownGoodAvailable === true,
    readOnlySelection: true,
    vercelTeamIdSha256: fingerprint(teamId, "READ_ONLY_SELECTION_TEAM_ID_INVALID"),
    vercelProjectIdSha256: fingerprint(projectId, "READ_ONLY_SELECTION_PROJECT_ID_INVALID"),
    auditProvenance,
  }, { requireAuditProvenance });
  return { ...core, proofDigest: digest(core) };
}

export function validateReadOnlyRollbackSelectionProof(
  value,
  {
    requireAuditProvenance = false,
    expectedTeamId,
    expectedProjectId,
  } = {},
) {
  if (!hasExactKeys(value, READ_ONLY_SELECTION_PROOF_KEYS)) {
    throw proofError("READ_ONLY_SELECTION_PROOF_SHAPE_INVALID");
  }
  const core = normalizeReadOnlySelectionProofCore(value, { requireAuditProvenance });
  const ownershipExpectationProvided = expectedTeamId !== undefined
    || expectedProjectId !== undefined;
  if (ownershipExpectationProvided && (
    expectedTeamId === undefined
    || expectedProjectId === undefined
    || core.vercelTeamIdSha256 !== fingerprint(
      expectedTeamId,
      "READ_ONLY_SELECTION_EXPECTED_TEAM_ID_INVALID",
    )
    || core.vercelProjectIdSha256 !== fingerprint(
      expectedProjectId,
      "READ_ONLY_SELECTION_EXPECTED_PROJECT_ID_INVALID",
    )
  )) {
    throw proofError("READ_ONLY_SELECTION_PROOF_OWNERSHIP_MISMATCH");
  }
  const normalized = { ...core, proofDigest: digest(core) };
  if (!SHA256_DIGEST.test(String(value.proofDigest || ""))
    || value.proofDigest !== normalized.proofDigest) {
    throw proofError("READ_ONLY_SELECTION_PROOF_DIGEST_INVALID");
  }
  return normalized;
}

export function createLastKnownGoodProductionIdentity({
  primaryDeploymentId,
  mirrorDeploymentId,
  appCommit,
  releaseTag,
  releaseRevision,
  verifiedAt = new Date().toISOString(),
  recoveryControlProof = null,
}) {
  if (
    !isDeploymentId(primaryDeploymentId)
    || !isDeploymentId(mirrorDeploymentId)
    || !isCommit(appCommit)
    || !releaseTag
    || !releaseRevision
    || !Number.isFinite(Date.parse(verifiedAt))
  ) {
    throw new Error("LAST_KNOWN_GOOD_IDENTITY_INVALID");
  }
  const normalizedControlProof = recoveryControlProof == null
    ? null
    : validateProductionRecoveryControlProof(recoveryControlProof);
  if (normalizedControlProof && normalizedControlProof.productCommit !== appCommit) {
    throw new Error("LAST_KNOWN_GOOD_RECOVERY_CONTROL_PRODUCT_MISMATCH");
  }
  const provenanceCore = {
    schemaVersion: normalizedControlProof ? LKG_SCHEMA_V2 : LKG_SCHEMA_V1,
    primaryDeploymentId,
    mirrorDeploymentId,
    appCommit,
    releaseTag,
    releaseRevision,
    verifiedAt,
    ...(normalizedControlProof ? { recoveryControlProof: normalizedControlProof } : {}),
  };
  return {
    ...provenanceCore,
    provenanceDigest: digest(provenanceCore),
  };
}

export function validateLastKnownGoodProductionIdentity(value) {
  const recoveryControlProof = value?.schemaVersion === LKG_SCHEMA_V2
    ? value?.recoveryControlProof
    : null;
  const normalized = createLastKnownGoodProductionIdentity({
    primaryDeploymentId: value?.primaryDeploymentId,
    mirrorDeploymentId: value?.mirrorDeploymentId,
    appCommit: value?.appCommit,
    releaseTag: value?.releaseTag,
    releaseRevision: value?.releaseRevision,
    verifiedAt: value?.verifiedAt,
    recoveryControlProof,
  });
  const expectedKeys = recoveryControlProof
    ? [
      "schemaVersion",
      "primaryDeploymentId",
      "mirrorDeploymentId",
      "appCommit",
      "releaseTag",
      "releaseRevision",
      "verifiedAt",
      "recoveryControlProof",
      "provenanceDigest",
    ]
    : [
      "schemaVersion",
      "primaryDeploymentId",
      "mirrorDeploymentId",
      "appCommit",
      "releaseTag",
      "releaseRevision",
      "verifiedAt",
      "provenanceDigest",
    ];
  if (!hasExactKeys(value, expectedKeys)
    || ![LKG_SCHEMA_V1, LKG_SCHEMA_V2].includes(value?.schemaVersion)
    || value.schemaVersion !== normalized.schemaVersion
    || value?.provenanceDigest !== normalized.provenanceDigest) {
    throw Object.assign(new Error("LAST_KNOWN_GOOD_DIGEST_INVALID"), {
      code: "LAST_KNOWN_GOOD_DIGEST_INVALID",
    });
  }
  if (!Number.isFinite(Date.parse(value.verifiedAt))) {
    throw Object.assign(new Error("LAST_KNOWN_GOOD_TIMESTAMP_INVALID"), {
      code: "LAST_KNOWN_GOOD_TIMESTAMP_INVALID",
    });
  }
  return normalized;
}

export function assertExpectedLastKnownGoodIdentity(identity, expected = {}) {
  const normalized = validateLastKnownGoodProductionIdentity(identity);
  const comparisons = {
    appCommit: expected.appCommit,
    primaryDeploymentId: expected.primaryDeploymentId,
    mirrorDeploymentId: expected.mirrorDeploymentId,
    releaseTag: expected.releaseTag,
    releaseRevision: expected.releaseRevision,
  };
  for (const [field, expectedValue] of Object.entries(comparisons)) {
    if (expectedValue && normalized[field] !== expectedValue) {
      throw Object.assign(new Error(`LAST_KNOWN_GOOD_EXPECTED_IDENTITY_MISMATCH:${field}`), {
        code: "LAST_KN_GOOD_EXPECTED_IDENTITY_MISMATCH",
      });
    }
  }
  return normalized;
}

export function parseLastKnownGoodCandidate(source) {
  try {
    const parsed = JSON.parse(String(source || ""));
    return {
      candidate: validateLastKnownGoodProductionIdentity(parsed),
      rejectionCode: null,
    };
  } catch (error) {
    return {
      candidate: null,
      rejectionCode: String(error?.code || error?.message || "LAST_KNOWN_GOOD_INVALID"),
    };
  }
}

function normalizeCandidate(source, value) {
  if (!value) return null;
  const candidate = {
    source,
    primary: {
      deploymentId: value.primaryDeploymentId,
      appCommit: value.primaryAppCommit || value.appCommit,
      releaseTag: value.releaseTag || null,
      releaseRevision: value.releaseRevision || null,
    },
    mirror: {
      deploymentId: value.mirrorDeploymentId,
      appCommit: value.mirrorAppCommit || value.appCommit,
      releaseTag: value.releaseTag || null,
      releaseRevision: value.releaseRevision || null,
    },
  };
  if (
    !isDeploymentId(candidate.primary.deploymentId)
    || !isDeploymentId(candidate.mirror.deploymentId)
    || !isCommit(candidate.primary.appCommit)
    || !isCommit(candidate.mirror.appCommit)
  ) return null;
  return candidate;
}

export function validateDeploymentControlPlaneTarget({
  deployment,
  expectedDeploymentId,
  expectedCommit,
  expectedProjectId,
  expectedTeamId,
}) {
  const deploymentId = deployment?.id ?? deployment?.uid ?? null;
  const appCommit = deployment?.meta?.githubCommitSha ?? null;
  const projectId = deployment?.projectId ?? deployment?.project?.id ?? null;
  const teamId = deployment?.teamId
    ?? deployment?.ownerId
    ?? deployment?.project?.accountId
    ?? null;
  const readyState = deployment?.readyState ?? deployment?.state ?? null;
  const target = deployment?.target ?? null;
  const deploymentUrl = deployment?.url ?? null;
  if (
    deploymentId !== expectedDeploymentId
    || appCommit !== expectedCommit
    || projectId !== expectedProjectId
    || teamId !== expectedTeamId
    || readyState !== "READY"
    || target !== "production"
    || !deploymentUrl
  ) {
    throw Object.assign(new Error("ROLLBACK_TARGET_CONTROL_PLANE_INVALID"), {
      code: "ROLLBACK_TARGET_CONTROL_PLANE_INVALID",
    });
  }
  return { deploymentId, appCommit, projectId, teamId, deploymentUrl };
}

async function verifyOneDeployment({
  identity,
  token,
  teamId,
  projectId,
  fetcher,
  fetchTimeoutMs,
  deadlineAt,
}) {
  const controlUrl = new URL(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(identity.deploymentId)}`,
  );
  controlUrl.searchParams.set("teamId", teamId);
  const response = await boundedFetch(fetcher, controlUrl, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    cache: "no-store",
  }, {
    timeoutMs: fetchTimeoutMs,
    deadlineAt,
    timeoutCode: "ROLLBACK_TARGET_CONTROL_PLANE_TIMEOUT",
  });
  const deployment = await boundedOperation(() => response.json(), {
    timeoutMs: fetchTimeoutMs,
    deadlineAt,
    timeoutCode: "ROLLBACK_TARGET_CONTROL_PLANE_BODY_TIMEOUT",
    onTimeout: () => response.body?.cancel().catch(() => undefined),
  }).catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error("ROLLBACK_TARGET_DEPLOYMENT_NOT_FOUND"), {
      code: "ROLLBACK_TARGET_DEPLOYMENT_NOT_FOUND",
    });
  }
  const verified = validateDeploymentControlPlaneTarget({
    deployment,
    expectedDeploymentId: identity.deploymentId,
    expectedCommit: identity.appCommit,
    expectedProjectId: projectId,
    expectedTeamId: teamId,
  });
  const identityResponse = await boundedFetch(
    fetcher,
    `https://${verified.deploymentUrl}/api/release/identity?rollback-target=${Date.now()}`,
    { cache: "no-store" },
    {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "ROLLBACK_TARGET_RUNTIME_TIMEOUT",
    },
  );
  const runtimeIdentity = await boundedOperation(() => identityResponse.json(), {
    timeoutMs: fetchTimeoutMs,
    deadlineAt,
    timeoutCode: "ROLLBACK_TARGET_RUNTIME_BODY_TIMEOUT",
    onTimeout: () => identityResponse.body?.cancel().catch(() => undefined),
  }).catch(() => null);
  if (
    !identityResponse.ok
    || runtimeIdentity?.deploymentId !== identity.deploymentId
    || runtimeIdentity?.appCommit !== identity.appCommit
    || runtimeIdentity?.provenanceStatus !== "verified"
    || runtimeIdentity?.environment !== "production"
    || (identity.releaseTag && runtimeIdentity?.releaseTag !== identity.releaseTag)
    || (identity.releaseRevision && runtimeIdentity?.releaseRevision !== identity.releaseRevision)
  ) {
    throw Object.assign(new Error("ROLLBACK_TARGET_RUNTIME_IDENTITY_INVALID"), {
      code: "ROLLBACK_TARGET_RUNTIME_IDENTITY_INVALID",
    });
  }
  return { ...identity, provenanceStatus: "verified", environment: "production" };
}

export async function verifyRollbackCandidate({
  candidate,
  token,
  teamId,
  projectId,
  fetcher = fetch,
  fetchTimeoutMs = 5_000,
  deadlineAt = Date.now() + 15_000,
}) {
  if (!candidate) throw new Error("ROLLBACK_CANDIDATE_MISSING");
  const [primary, mirror] = await Promise.all([
    verifyOneDeployment({
      identity: candidate.primary,
      token,
      teamId,
      projectId,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
    }),
    verifyOneDeployment({
      identity: candidate.mirror,
      token,
      teamId,
      projectId,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
    }),
  ]);
  return { source: candidate.source, primary, mirror };
}

export async function selectVerifiedRollbackTarget({
  current,
  lastKnownGood,
  emergency,
  token,
  teamId,
  projectId,
  fetcher = fetch,
  fetchTimeoutMs = 5_000,
  candidateTimeoutMs = 15_000,
  deadlineAt = Date.now() + 60_000,
  failClosedSources = [],
}) {
  const requiredSources = new Set(failClosedSources);
  const candidates = [
    normalizeCandidate("current-transaction-capture", current),
    normalizeCandidate("last-known-good", lastKnownGood),
    normalizeCandidate("emergency-static", emergency),
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    assertDeadline(deadlineAt, "ROLLBACK_TARGET_SELECTION_DEADLINE_EXCEEDED");
    const candidateDeadlineAt = Math.min(deadlineAt, Date.now() + candidateTimeoutMs);
    try {
      return await verifyRollbackCandidate({
        candidate,
        token,
        teamId,
        projectId,
        fetcher,
        fetchTimeoutMs,
        deadlineAt: candidateDeadlineAt,
      });
    } catch (error) {
      failures.push({ source: candidate.source, code: error?.code || error?.message });
      if (requiredSources.has(candidate.source)) {
        throw Object.assign(new Error("REQUIRED_ROLLBACK_TARGET_VERIFICATION_FAILED"), {
          code: "REQUIRED_ROLLBACK_TARGET_VERIFICATION_FAILED",
          failures,
        });
      }
    }
  }
  throw Object.assign(new Error("NO_VERIFIED_ROLLBACK_TARGET"), {
    code: "NO_VERIFIED_ROLLBACK_TARGET",
    failures,
  });
}

async function githubJson({
  repository,
  path,
  token,
  fetcher,
  fetchTimeoutMs,
  deadlineAt,
  errorCode,
}) {
  const response = await boundedFetch(
    fetcher,
    `https://api.github.com/repos/${repository}${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
    { timeoutMs: fetchTimeoutMs, deadlineAt, timeoutCode: `${errorCode}_TIMEOUT` },
  );
  const body = await boundedOperation(() => response.json(), {
    timeoutMs: fetchTimeoutMs,
    deadlineAt,
    timeoutCode: `${errorCode}_BODY_TIMEOUT`,
    onTimeout: () => response.body?.cancel().catch(() => undefined),
  }).catch(() => null);
  if (!response.ok || !body || typeof body !== "object") {
    throw proofError(errorCode);
  }
  return body;
}

export async function assertRepositoryMigrationSeedNotPublished({
  repository,
  repositoryId,
  controlCommit,
  consumerRunId,
  token,
  fetcher = fetch,
  fetchTimeoutMs = 5_000,
  deadlineAt = Date.now() + 30_000,
}) {
  const seedName = `production-last-known-good-migration-control-${controlCommit}`
    + `-consumer-${consumerRunId}-product-${REPOSITORY_MIGRATION_SOURCE.productCommit}`;
  if (repository !== REPOSITORY_MIGRATION_TARGET.repository
    || Number(repositoryId) !== REPOSITORY_MIGRATION_TARGET.repositoryId
    || !isCommit(controlCommit)
    || !/^[1-9][0-9]{0,19}$/u.test(String(consumerRunId || ""))
    || !token
    || !REPOSITORY_MIGRATION_LKG_ARTIFACT.test(seedName)) {
    throw proofError("REPOSITORY_MIGRATION_SEED_PREFLIGHT_INVALID");
  }
  let inspectedCount = 0;
  const maximumPages = 10;
  for (let page = 1; page <= maximumPages; page += 1) {
    assertDeadline(deadlineAt, "REPOSITORY_MIGRATION_SEED_PREFLIGHT_DEADLINE_EXCEEDED");
    const url = new URL(`https://api.github.com/repos/${repository}/actions/artifacts`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await boundedFetch(fetcher, url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }, {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "REPOSITORY_MIGRATION_SEED_PREFLIGHT_TIMEOUT",
    });
    const body = await boundedOperation(() => response.json(), {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "REPOSITORY_MIGRATION_SEED_PREFLIGHT_BODY_TIMEOUT",
      onTimeout: () => response.body?.cancel().catch(() => undefined),
    }).catch(() => null);
    if (!response.ok || !Array.isArray(body?.artifacts)) {
      throw proofError("REPOSITORY_MIGRATION_SEED_PREFLIGHT_LOOKUP_FAILED");
    }
    for (const artifact of body.artifacts) {
      inspectedCount += 1;
      const artifactName = String(artifact?.name || "");
      const match = REPOSITORY_MIGRATION_LKG_ARTIFACT.exec(artifactName);
      if (artifactName === seedName || match?.[2] === String(consumerRunId)) {
        throw proofError("REPOSITORY_MIGRATION_SEED_ALREADY_PUBLISHED");
      }
    }
    const totalCount = Number(body.total_count);
    if (body.artifacts.length < 100
      || (Number.isFinite(totalCount) && inspectedCount >= totalCount)) {
      return Object.freeze({
        seedName,
        inspectedCount,
        readOnly: true,
        mutationCount: 0,
      });
    }
    if (page === maximumPages) {
      throw proofError("REPOSITORY_MIGRATION_SEED_PREFLIGHT_INCOMPLETE");
    }
  }
  throw proofError("REPOSITORY_MIGRATION_SEED_PREFLIGHT_INCOMPLETE");
}

export async function verifyPinnedRepositoryMigrationSource({
  sourceToken,
  targetToken,
  consumerRunId,
  consumerCommit,
  identityPath,
  proofPath,
  fetcher = fetch,
  fetchTimeoutMs = 10_000,
  deadlineAt = Date.now() + 60_000,
  now = Date.now(),
}) {
  if (!sourceToken || !targetToken
    || !/^[1-9][0-9]{0,19}$/u.test(String(consumerRunId || ""))
    || !isCommit(consumerCommit)) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_REQUEST_INVALID");
  }
  const source = REPOSITORY_MIGRATION_SOURCE;
  const target = REPOSITORY_MIGRATION_TARGET;
  const [sourceRepository, sourceArtifact, sourceRun, targetRepository, consumerRun] = await Promise.all([
    githubJson({
      repository: source.repository,
      path: "",
      token: sourceToken,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_SOURCE_REPOSITORY_LOOKUP_FAILED",
    }),
    githubJson({
      repository: source.repository,
      path: `/actions/artifacts/${source.artifactId}`,
      token: sourceToken,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_SOURCE_ARTIFACT_LOOKUP_FAILED",
    }),
    githubJson({
      repository: source.repository,
      path: `/actions/runs/${source.runId}`,
      token: sourceToken,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_SOURCE_RUN_LOOKUP_FAILED",
    }),
    githubJson({
      repository: target.repository,
      path: "",
      token: targetToken,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_TARGET_REPOSITORY_LOOKUP_FAILED",
    }),
    githubJson({
      repository: target.repository,
      path: `/actions/runs/${consumerRunId}`,
      token: targetToken,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_CONSUMER_RUN_LOOKUP_FAILED",
    }),
  ]);
  const sourceRepositoryMetadata = normalizeRepositoryMigrationSourceRepository({
    repository: sourceRepository.full_name,
    repositoryId: sourceRepository.id,
    nodeId: sourceRepository.node_id,
    defaultBranch: sourceRepository.default_branch,
    visibility: sourceRepository.visibility,
  });
  if (sourceRepository.private !== false) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_REPOSITORY_MISMATCH");
  }
  if (Number(targetRepository.id) !== target.repositoryId
    || targetRepository.node_id !== target.nodeId
    || targetRepository.full_name !== target.repository
    || targetRepository.default_branch !== target.defaultBranch) {
    throw proofError("REPOSITORY_MIGRATION_TARGET_REPOSITORY_MISMATCH");
  }
  const sourceArtifactMetadata = normalizeRepositoryMigrationSourceArtifact({
    artifactId: sourceArtifact.id,
    artifactName: sourceArtifact.name,
    artifactDigest: sourceArtifact.digest,
    runId: sourceArtifact.workflow_run?.id,
    headSha: sourceArtifact.workflow_run?.head_sha,
    productCommit: source.productCommit,
    controlCommit: sourceArtifact.workflow_run?.head_sha,
    workflowEvent: sourceRun.event,
    workflowBranch: sourceRun.head_branch,
    runAttempt: sourceRun.run_attempt,
    workflowPath: sourceRun.path,
    createdAt: new Date(sourceArtifact.created_at).toISOString(),
    expiresAt: new Date(sourceArtifact.expires_at).toISOString(),
    sizeInBytes: sourceArtifact.size_in_bytes,
  });
  if (sourceArtifact.expired !== false
    || sourceRun.id !== source.runId
    || sourceRun.status !== "completed"
    || sourceRun.conclusion !== "success"
    || sourceRun.head_sha !== source.headSha
    || Number(sourceRun.repository?.id) !== source.repositoryId
    || Date.parse(sourceArtifactMetadata.expiresAt)
      < Number(now) + REPOSITORY_MIGRATION_MINIMUM_SOURCE_LIFETIME_MS) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_CONTROL_PLANE_MISMATCH");
  }
  if (String(consumerRun.id) !== String(consumerRunId)
    || consumerRun.event !== "push"
    || consumerRun.head_branch !== "main"
    || consumerRun.head_sha !== consumerCommit
    || consumerRun.path !== REPOSITORY_MIGRATION_WORKFLOW_PATH
    || consumerRun.status !== "completed"
    || !["failure", "cancelled"].includes(consumerRun.conclusion)
    || Number(consumerRun.repository?.id) !== target.repositoryId
    || !Number.isSafeInteger(Number(consumerRun.run_attempt))
    || Number(consumerRun.run_attempt) <= 0) {
    throw proofError("REPOSITORY_MIGRATION_CONSUMER_RUN_MISMATCH");
  }
  const comparison = await githubJson({
    repository: target.repository,
    path: `/compare/${source.productCommit}...${consumerCommit}`,
    token: targetToken,
    fetcher,
    fetchTimeoutMs,
    deadlineAt,
    errorCode: "REPOSITORY_MIGRATION_ANCESTRY_LOOKUP_FAILED",
  });
  if (!["ahead", "identical"].includes(comparison.status)
    || comparison.merge_base_commit?.sha !== source.productCommit) {
    throw proofError("REPOSITORY_MIGRATION_SOURCE_NOT_ANCESTOR");
  }
  const downloaded = await downloadLastKnownGoodArtifact({
    repository: source.repository,
    token: sourceToken,
    artifact: {
      ...sourceArtifactMetadata,
      downloadedAt: new Date(Number(now)).toISOString(),
    },
    identityPath,
    proofPath,
    fetcher,
    fetchTimeoutMs,
    deadlineAt,
    expectedIdentity: {
      appCommit: source.productCommit,
      primaryDeploymentId: source.primaryDeploymentId,
      mirrorDeploymentId: source.mirrorDeploymentId,
      releaseTag: source.releaseTag,
      releaseRevision: source.releaseRevision,
    },
  });
  assertPinnedRepositoryMigrationIdentity(downloaded.identity);
  return {
    sourceRepositoryMetadata,
    sourceArtifactMetadata,
    sourceIdentity: downloaded.identity,
    sourceArtifactProof: downloaded.proof,
    consumerRunAttempt: Number(consumerRun.run_attempt),
  };
}

export async function discoverLatestLastKnownGoodArtifact({
  repository,
  token,
  excludeRunId = null,
  fetcher = fetch,
  fetchTimeoutMs = 5_000,
  deadlineAt = Date.now() + 30_000,
}) {
  const artifacts = [];
  const maximumPages = 10;
  for (let page = 1; page <= maximumPages; page += 1) {
    assertDeadline(deadlineAt, "LAST_KNOWN_GOOD_DISCOVERY_DEADLINE_EXCEEDED");
    const url = new URL(`https://api.github.com/repos/${repository}/actions/artifacts`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await boundedFetch(fetcher, url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }, {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "LAST_KNOWN_GOOD_ARTIFACT_LIST_TIMEOUT",
    });
    const body = await boundedOperation(() => response.json(), {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "LAST_KNOWN_GOOD_ARTIFACT_LIST_BODY_TIMEOUT",
      onTimeout: () => response.body?.cancel().catch(() => undefined),
    }).catch(() => null);
    if (!response.ok || !Array.isArray(body?.artifacts)) {
      throw Object.assign(new Error("LAST_KNOWN_GOOD_ARTIFACT_LOOKUP_FAILED"), {
        code: "LAST_KNOWN_GOOD_ARTIFACT_LOOKUP_FAILED",
      });
    }
    artifacts.push(...body.artifacts);
    const totalCount = Number(body.total_count);
    if (
      body.artifacts.length < 100
      || (Number.isFinite(totalCount) && artifacts.length >= totalCount)
    ) break;
  }
  const candidates = artifacts
    .filter((entry) =>
      entry?.expired === false
      && (LEGACY_LKG_ARTIFACT.test(String(entry?.name || ""))
        || CONTROLLED_LKG_ARTIFACT.test(String(entry?.name || "")))
      && ARTIFACT_DIGEST.test(String(entry?.digest || ""))
      && entry?.workflow_run?.head_branch === "main"
      && Number(entry?.workflow_run?.id) !== Number(excludeRunId))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  for (const artifact of candidates) {
    assertDeadline(deadlineAt, "LAST_KNOWN_GOOD_DISCOVERY_DEADLINE_EXCEEDED");
    const runResponse = await boundedFetch(
      fetcher,
      `https://api.github.com/repos/${repository}/actions/runs/${artifact.workflow_run.id}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      },
      {
        timeoutMs: fetchTimeoutMs,
        deadlineAt,
        timeoutCode: "LAST_KNOWN_GOOD_RUN_LOOKUP_TIMEOUT",
      },
    );
    const run = await boundedOperation(() => runResponse.json(), {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "LAST_KNOWN_GOOD_RUN_BODY_TIMEOUT",
      onTimeout: () => runResponse.body?.cancel().catch(() => undefined),
    }).catch(() => null);
    const legacyMatch = LEGACY_LKG_ARTIFACT.exec(String(artifact.name || ""));
    const controlledMatch = CONTROLLED_LKG_ARTIFACT.exec(String(artifact.name || ""));
    const controlCommit = String(artifact.workflow_run.head_sha || "");
    const productCommit = legacyMatch?.[1] || controlledMatch?.[2] || "";
    const validPublication = Boolean(
      (legacyMatch
        && run?.event === "push"
        && controlCommit === productCommit)
      || (controlledMatch
        && run?.event === "workflow_dispatch"
        && controlledMatch[1] === controlCommit
        && controlCommit !== productCommit),
    );
    if (
      runResponse.ok
      && run?.conclusion === "success"
      && validPublication
      && run?.head_branch === "main"
      && run?.head_sha === artifact.workflow_run.head_sha
      && run?.path === ".github/workflows/deploy.yml"
      && Number.isSafeInteger(Number(run?.run_attempt))
      && Number(run.run_attempt) > 0
    ) {
      return {
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactDigest: artifact.digest,
        runId: artifact.workflow_run.id,
        headSha: controlCommit,
        productCommit,
        controlCommit,
        workflowEvent: run.event,
        workflowBranch: run.head_branch,
        runAttempt: Number(run.run_attempt),
        workflowPath: run.path,
        createdAt: artifact.created_at,
        publicationMode: legacyMatch ? "same-sha" : "immutable-product-control",
      };
    }
  }
  return null;
}

export async function safeDiscoverLatestLastKnownGoodArtifact(options) {
  try {
    return {
      artifact: await discoverLatestLastKnownGoodArtifact(options),
      rejectionCode: null,
    };
  } catch (error) {
    return {
      artifact: null,
      rejectionCode: String(error?.code || error?.message || "LAST_KNOWN_GOOD_DISCOVERY_FAILED"),
    };
  }
}

export async function discoverRepositoryMigrationSeedArtifact({
  repository,
  repositoryId,
  token,
  currentContext,
  fetcher = fetch,
  fetchTimeoutMs = 5_000,
  deadlineAt = Date.now() + 30_000,
  now = Date.now(),
}) {
  repositoryMigrationCurrentTimeMs(now);
  if (repository !== REPOSITORY_MIGRATION_TARGET.repository
    || Number(repositoryId) !== REPOSITORY_MIGRATION_TARGET.repositoryId
    || currentContext?.repository !== repository
    || Number(currentContext?.repositoryId) !== Number(repositoryId)
    || !/^[1-9][0-9]{0,19}$/u.test(String(currentContext?.runId || ""))
    || !Number.isSafeInteger(Number(currentContext?.runAttempt))
    || Number(currentContext.runAttempt) < 2
    || Number(currentContext.runAttempt) > 20
    || !isCommit(currentContext?.headSha)
    || currentContext?.eventName !== "push"
    || currentContext?.eventRef !== "refs/heads/main"
    || currentContext?.workflowPath !== REPOSITORY_MIGRATION_WORKFLOW_PATH
    || currentContext?.workflowRef
      !== `${repository}/${REPOSITORY_MIGRATION_WORKFLOW_PATH}@refs/heads/main`) {
    throw proofError("REPOSITORY_MIGRATION_DISCOVERY_CONTEXT_INVALID");
  }
  for (let attempt = 1; attempt < Number(currentContext.runAttempt); attempt += 1) {
    const priorAttempt = await githubJson({
      repository,
      path: `/actions/runs/${currentContext.runId}/attempts/${attempt}`,
      token,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_CONSUMER_ATTEMPT_LOOKUP_FAILED",
    });
    if (priorAttempt.status === "completed"
      && priorAttempt.conclusion === "success"
      && priorAttempt.event === "push"
      && priorAttempt.head_branch === "main"
      && priorAttempt.head_sha === currentContext.headSha
      && priorAttempt.path === REPOSITORY_MIGRATION_WORKFLOW_PATH) {
      throw proofError("REPOSITORY_MIGRATION_SEED_ALREADY_CONSUMED");
    }
  }
  const artifacts = [];
  for (let page = 1; page <= 10; page += 1) {
    assertDeadline(deadlineAt, "REPOSITORY_MIGRATION_DISCOVERY_DEADLINE_EXCEEDED");
    const url = new URL(`https://api.github.com/repos/${repository}/actions/artifacts`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await boundedFetch(fetcher, url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }, {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "REPOSITORY_MIGRATION_ARTIFACT_LIST_TIMEOUT",
    });
    const body = await boundedOperation(() => response.json(), {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "REPOSITORY_MIGRATION_ARTIFACT_LIST_BODY_TIMEOUT",
      onTimeout: () => response.body?.cancel().catch(() => undefined),
    }).catch(() => null);
    if (!response.ok || !Array.isArray(body?.artifacts)) {
      throw proofError("REPOSITORY_MIGRATION_ARTIFACT_LOOKUP_FAILED");
    }
    artifacts.push(...body.artifacts);
    if (body.artifacts.length < 100
      || (Number.isFinite(Number(body.total_count)) && artifacts.length >= Number(body.total_count))) {
      break;
    }
  }
  const candidates = artifacts.filter((artifact) => {
    const match = REPOSITORY_MIGRATION_LKG_ARTIFACT.exec(String(artifact?.name || ""));
    return artifact?.expired === false
      && match
      && match[2] === String(currentContext.runId)
      && match[3] === REPOSITORY_MIGRATION_SOURCE.productCommit
      && ARTIFACT_DIGEST.test(String(artifact?.digest || ""))
      && artifact?.workflow_run?.head_branch === "main"
      && String(artifact?.workflow_run?.id) !== String(currentContext.runId);
  });
  const verified = [];
  for (const artifact of candidates) {
    const match = REPOSITORY_MIGRATION_LKG_ARTIFACT.exec(artifact.name);
    const run = await githubJson({
      repository,
      path: `/actions/runs/${artifact.workflow_run.id}`,
      token,
      fetcher,
      fetchTimeoutMs,
      deadlineAt,
      errorCode: "REPOSITORY_MIGRATION_ARTIFACT_RUN_LOOKUP_FAILED",
    });
    if (run.status === "completed"
      && run.conclusion === "success"
      && run.event === "workflow_dispatch"
      && run.head_branch === "main"
      && run.head_sha === artifact.workflow_run.head_sha
      && run.head_sha === match[1]
      && run.path === REPOSITORY_MIGRATION_WORKFLOW_PATH
      && Number(run.repository?.id) === REPOSITORY_MIGRATION_TARGET.repositoryId
      && Number.isSafeInteger(Number(run.run_attempt))
      && Number(run.run_attempt) > 0) {
      verified.push({
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactDigest: artifact.digest,
        runId: Number(run.id),
        headSha: run.head_sha,
        productCommit: match[3],
        controlCommit: run.head_sha,
        workflowEvent: run.event,
        workflowBranch: run.head_branch,
        runAttempt: Number(run.run_attempt),
        workflowPath: run.path,
        createdAt: new Date(artifact.created_at).toISOString(),
        publicationMode: "repository-migration-seed",
      });
    }
  }
  if (verified.length > 1) {
    throw proofError("REPOSITORY_MIGRATION_SEED_AMBIGUOUS");
  }
  const artifact = verified[0] || null;
  if (!artifact) return null;
  await downloadRepositoryMigrationSeedArtifact({
    repository,
    token,
    artifact,
    currentContext: {
      ...currentContext,
      canonicalLastKnownGoodAvailable: false,
    },
    fetcher,
    fetchTimeoutMs,
    deadlineAt,
    now,
  });
  return artifact;
}

export async function safeDiscoverRepositoryMigrationSeedArtifact(options) {
  try {
    return {
      artifact: await discoverRepositoryMigrationSeedArtifact(options),
      rejectionCode: null,
    };
  } catch (error) {
    return {
      artifact: null,
      rejectionCode: String(error?.code || error?.message || "REPOSITORY_MIGRATION_DISCOVERY_FAILED"),
    };
  }
}

export async function downloadLastKnownGoodArtifact({
  repository,
  token,
  artifact,
  identityPath,
  proofPath,
  fetcher = fetch,
  fetchTimeoutMs = 10_000,
  deadlineAt = Date.now() + 30_000,
  expectedIdentity = {},
}) {
  if (!artifact?.artifactId || !ARTIFACT_DIGEST.test(String(artifact?.artifactDigest || ""))) {
    throw new Error("LAST_KNOWN_GOOD_DOWNLOAD_METADATA_INVALID");
  }
  const response = await boundedFetch(
    fetcher,
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.artifactId}/zip`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      redirect: "follow",
    },
    {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "LAST_KNOWN_GOOD_ARTIFACT_DOWNLOAD_TIMEOUT",
    },
  );
  if (!response.ok) {
    throw Object.assign(new Error("LAST_KNOWN_GOOD_ARTIFACT_DOWNLOAD_FAILED"), {
      code: "LAST_KNOWN_GOOD_ARTIFACT_DOWNLOAD_FAILED",
    });
  }
  const archive = Buffer.from(await boundedOperation(() => response.arrayBuffer(), {
    timeoutMs: fetchTimeoutMs,
    deadlineAt,
    timeoutCode: "LAST_KNOWN_GOOD_ARTIFACT_BODY_TIMEOUT",
    onTimeout: () => response.body?.cancel().catch(() => undefined),
  }));
  const actualDigest = createHash("sha256").update(archive).digest("hex");
  const expectedDigest = ARTIFACT_DIGEST.exec(artifact.artifactDigest)[1];
  if (actualDigest !== expectedDigest) {
    throw Object.assign(new Error("LAST_KNOWN_GOOD_ARCHIVE_DIGEST_MISMATCH"), {
      code: "LAST_KNOWN_GOOD_ARCHIVE_DIGEST_MISMATCH",
    });
  }
  const identity = assertExpectedLastKnownGoodIdentity(JSON.parse(
    extractLastKnownGoodIdentityFromZip(archive),
  ), expectedIdentity);
  const proof = createLastKnownGoodArtifactProof({
    repository,
    ...artifact,
    identity,
  });
  if (identityPath) await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  return { identity, proof };
}

export async function downloadRepositoryMigrationSeedArtifact({
  repository,
  token,
  artifact,
  currentContext,
  identityPath,
  proofPath,
  expectedVercelTeamId,
  expectedVercelProjectId,
  fetcher = fetch,
  fetchTimeoutMs = 10_000,
  deadlineAt = Date.now() + 30_000,
  now = Date.now(),
}) {
  repositoryMigrationCurrentTimeMs(now);
  if (repository !== REPOSITORY_MIGRATION_TARGET.repository
    || !artifact?.artifactId
    || artifact.publicationMode !== "repository-migration-seed"
    || !REPOSITORY_MIGRATION_LKG_ARTIFACT.test(String(artifact.artifactName || ""))
    || !ARTIFACT_DIGEST.test(String(artifact.artifactDigest || ""))) {
    throw proofError("REPOSITORY_MIGRATION_DOWNLOAD_METADATA_INVALID");
  }
  const response = await boundedFetch(
    fetcher,
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.artifactId}/zip`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      redirect: "follow",
    },
    {
      timeoutMs: fetchTimeoutMs,
      deadlineAt,
      timeoutCode: "REPOSITORY_MIGRATION_ARTIFACT_DOWNLOAD_TIMEOUT",
    },
  );
  if (!response.ok) {
    throw proofError("REPOSITORY_MIGRATION_ARTIFACT_DOWNLOAD_FAILED");
  }
  const archive = Buffer.from(await boundedOperation(() => response.arrayBuffer(), {
    timeoutMs: fetchTimeoutMs,
    deadlineAt,
    timeoutCode: "REPOSITORY_MIGRATION_ARTIFACT_BODY_TIMEOUT",
    onTimeout: () => response.body?.cancel().catch(() => undefined),
  }));
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  if (archiveSha256 !== ARTIFACT_DIGEST.exec(artifact.artifactDigest)[1]) {
    throw proofError("REPOSITORY_MIGRATION_ARCHIVE_DIGEST_MISMATCH");
  }
  const seed = validateRepositoryMigrationSeedIdentity(
    JSON.parse(extractLastKnownGoodIdentityFromZip(archive)),
    { expectedVercelTeamId, expectedVercelProjectId, now },
  );
  if (!isRepositoryMigrationSeedEligible(seed, {
    ...currentContext,
    canonicalLastKnownGoodAvailable: currentContext?.canonicalLastKnownGoodAvailable === true,
    now,
  })) {
    throw proofError("REPOSITORY_MIGRATION_SEED_NOT_ELIGIBLE");
  }
  const identity = assertPinnedRepositoryMigrationIdentity(seed.sourceIdentity);
  const proof = createRepositoryMigrationArtifactProof({
    repository,
    ...artifact,
    seed,
    identity,
    now,
  });
  if (identityPath) await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  return { identity, proof, seed };
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`MISSING_ENVIRONMENT:${name}`);
  return value;
}

function strictBooleanEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw proofError(`INVALID_BOOLEAN_ENVIRONMENT:${name}`);
}

function auditSelectionProvenanceFromEnvironment(required) {
  const controlCommit = String(process.env.AUDIT_COMMIT || "").trim();
  const productCommit = String(process.env.AUDIT_PRODUCT_COMMIT || controlCommit).trim();
  if (!controlCommit && !required) return null;
  const mode = productCommit === controlCommit ? "same-sha" : "immutable-product-control";
  return {
    mode,
    productCommit,
    controlCommit,
    controlProofDigest: mode === "immutable-product-control"
      ? String(process.env.AUDIT_CONTROL_PROOF_DIGEST || "").trim()
      : "",
    repository: String(process.env.GITHUB_REPOSITORY || ""),
    eventName: String(process.env.GITHUB_EVENT_NAME || ""),
    eventRef: String(process.env.GITHUB_REF || ""),
    eventCommit: String(process.env.GITHUB_SHA || ""),
    workflow: String(process.env.GITHUB_WORKFLOW || ""),
    workflowRef: String(process.env.GITHUB_WORKFLOW_REF || ""),
    workflowSha: String(process.env.GITHUB_WORKFLOW_SHA || ""),
    runId: String(process.env.GITHUB_RUN_ID || ""),
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT || ""),
  };
}

function optionalIdentity(prefix) {
  const primaryDeploymentId = process.env[`${prefix}_PRIMARY_DEPLOYMENT`] || "";
  const primaryAppCommit = process.env[`${prefix}_PRIMARY_COMMIT`] || "";
  const mirrorDeploymentId = process.env[`${prefix}_MIRROR_DEPLOYMENT`] || "";
  const mirrorAppCommit = process.env[`${prefix}_MIRROR_COMMIT`] || "";
  return { primaryDeploymentId, primaryAppCommit, mirrorDeploymentId, mirrorAppCommit };
}

function appendOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8",
  );
}

function repositoryMigrationContextFromEnvironment() {
  return {
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    repositoryId: Number(requiredEnvironment("GITHUB_REPOSITORY_ID")),
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
    headSha: requiredEnvironment("GITHUB_SHA"),
    eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
    eventRef: requiredEnvironment("GITHUB_REF"),
    workflowPath: REPOSITORY_MIGRATION_WORKFLOW_PATH,
    workflowRef: requiredEnvironment("GITHUB_WORKFLOW_REF"),
  };
}

async function discoverCli() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("GITHUB_TOKEN");
  const result = await safeDiscoverLatestLastKnownGoodArtifact({
    repository,
    token,
    excludeRunId: process.env.GITHUB_RUN_ID || null,
  });
  let artifact = result.artifact;
  let rejectionCode = result.rejectionCode;
  if (!artifact
    && !rejectionCode
    && strictBooleanEnvironment("ALLOW_REPOSITORY_MIGRATION_SEED")) {
    const migrationResult = await safeDiscoverRepositoryMigrationSeedArtifact({
      repository,
      repositoryId: requiredEnvironment("GITHUB_REPOSITORY_ID"),
      token,
      currentContext: repositoryMigrationContextFromEnvironment(),
    });
    artifact = migrationResult.artifact;
    rejectionCode = migrationResult.rejectionCode;
  }
  const publicationMode = artifact?.publicationMode
    || (LEGACY_LKG_ARTIFACT.test(String(artifact?.artifactName || ""))
      ? "same-sha"
      : CONTROLLED_LKG_ARTIFACT.test(String(artifact?.artifactName || ""))
        ? "immutable-product-control"
        : "");
  const seedEligible = publicationMode === "repository-migration-seed";
  appendOutputs({
    available: String(Boolean(artifact)),
    artifact_name: artifact?.artifactName || "",
    artifact_id: artifact?.artifactId || "",
    artifact_digest: artifact?.artifactDigest || "",
    run_id: artifact?.runId || "",
    head_sha: artifact?.headSha || "",
    product_commit: artifact?.productCommit || "",
    control_commit: artifact?.controlCommit || "",
    workflow_event: artifact?.workflowEvent || "",
    workflow_branch: artifact?.workflowBranch || "",
    run_attempt: artifact?.runAttempt || "",
    workflow_path: artifact?.workflowPath || "",
    created_at: artifact?.createdAt || "",
    publication_mode: publicationMode,
    seed_eligible: String(seedEligible),
    rejection_code: rejectionCode || "",
  });
  console.log(JSON.stringify({
    status: "PASS",
    available: Boolean(artifact),
    publicationMode: publicationMode || null,
    seedEligible,
    candidateRejected: Boolean(rejectionCode),
    rejectionCode,
  }));
}

async function downloadCli() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("GITHUB_TOKEN");
  const artifactName = requiredEnvironment("LAST_KNOWN_GOOD_ARTIFACT_NAME");
  const inferredMode = REPOSITORY_MIGRATION_LKG_ARTIFACT.test(artifactName)
    ? "repository-migration-seed"
    : LEGACY_LKG_ARTIFACT.test(artifactName)
      ? "same-sha"
      : CONTROLLED_LKG_ARTIFACT.test(artifactName)
        ? "immutable-product-control"
        : "";
  const publicationMode = String(process.env.LAST_KNOWN_GOOD_PUBLICATION_MODE || inferredMode);
  if (publicationMode !== inferredMode) {
    throw proofError("LAST_KNOWN_GOOD_PUBLICATION_MODE_MISMATCH");
  }
  const artifact = {
    artifactId: Number(requiredEnvironment("LAST_KNOWN_GOOD_ARTIFACT_ID")),
    artifactName,
    artifactDigest: requiredEnvironment("LAST_KN_GOOD_ARTIFACT_DIGEST"),
    runId: Number(requiredEnvironment("LAST_KNOWN_GOOD_RUN_ID")),
    headSha: requiredEnvironment("LAST_KNOWN_GOOD_HEAD_SHA"),
    productCommit: requiredEnvironment("LAST_KNOWN_GOOD_PRODUCT_COMMIT"),
    controlCommit: requiredEnvironment("LAST_KNOWN_GOOD_CONTROL_COMMIT"),
    workflowEvent: requiredEnvironment("LAST_KNOWN_GOOD_WORKFLOW_EVENT"),
    workflowBranch: requiredEnvironment("LAST_KNOWN_GOOD_WORKFLOW_BRANCH"),
    runAttempt: Number(requiredEnvironment("LAST_KNOWN_GOOD_RUN_ATTEMPT")),
    workflowPath: requiredEnvironment("LAST_KNOWN_GOOD_WORKFLOW_PATH"),
    createdAt: requiredEnvironment("LAST_KNOWN_GOOD_CREATED_AT"),
    publicationMode,
  };
  const common = {
    repository,
    token,
    artifact,
    identityPath: requiredEnvironment("LAST_KNOWN_GOOD_PATH"),
    proofPath: requiredEnvironment("LAST_KNOWN_GOOD_PROOF_PATH"),
  };
  const result = publicationMode === "repository-migration-seed"
    ? await downloadRepositoryMigrationSeedArtifact({
      ...common,
      currentContext: repositoryMigrationContextFromEnvironment(),
      expectedVercelTeamId: requiredEnvironment("VERCEL_ORG_ID"),
      expectedVercelProjectId: requiredEnvironment("VERCEL_PROJECT_ID"),
    })
    : await downloadLastKnownGoodArtifact({
      ...common,
      expectedIdentity: {
        appCommit: process.env.EXPECTED_LKG_APP_COMMIT,
        primaryDeploymentId: process.env.EXPECTED_LKG_PRIMARY_DEPLOYMENT_ID,
        mirrorDeploymentId: process.env.EXPECTED_LKG_MIRROR_DEPLOYMENT_ID,
        releaseTag: process.env.EXPECTED_LKG_RELEASE_TAG,
        releaseRevision: process.env.EXPECTED_LKG_RELEASE_REVISION,
      },
    });
  console.log(JSON.stringify({
    status: "PASS",
    appCommit: result.identity.appCommit,
    artifactDigest: result.proof.artifactDigest,
    proofDigest: result.proof.proofDigest,
    publicationMode,
    seedEligible: publicationMode === "repository-migration-seed",
    readOnlyDiscovery: true,
  }));
}

async function bootstrapSourceCli() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const repositoryId = Number(requiredEnvironment("GITHUB_REPOSITORY_ID"));
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");
  const eventRef = requiredEnvironment("GITHUB_REF");
  const controlCommit = requiredEnvironment("GITHUB_SHA");
  const workflowSha = requiredEnvironment("GITHUB_WORKFLOW_SHA");
  const workflowRef = requiredEnvironment("GITHUB_WORKFLOW_REF");
  const operation = requiredEnvironment("MIGRATION_OPERATION");
  const consumerRunId = requiredEnvironment("MIGRATION_CONSUMER_RUN_ID");
  const consumerCommit = requiredEnvironment("MIGRATION_CONSUMER_COMMIT");
  const seedPath = resolve(requiredEnvironment("MIGRATION_SEED_PATH"));
  if (repository !== REPOSITORY_MIGRATION_TARGET.repository
    || repositoryId !== REPOSITORY_MIGRATION_TARGET.repositoryId
    || eventName !== "workflow_dispatch"
    || eventRef !== "refs/heads/main"
    || operation !== REPOSITORY_MIGRATION_OPERATION
    || !isCommit(controlCommit)
    || workflowSha !== controlCommit
    || workflowRef !== `${repository}/${REPOSITORY_MIGRATION_WORKFLOW_PATH}@refs/heads/main`
    || basename(seedPath) !== "last-known-good-production.json") {
    throw proofError("REPOSITORY_MIGRATION_BOOTSTRAP_CONTEXT_INVALID");
  }
  const targetToken = requiredEnvironment("GITHUB_TOKEN");
  const publicationPreflight = await assertRepositoryMigrationSeedNotPublished({
    repository,
    repositoryId,
    controlCommit,
    consumerRunId,
    token: targetToken,
  });
  const source = await verifyPinnedRepositoryMigrationSource({
    sourceToken: requiredEnvironment("SOURCE_LKG_READ_TOKEN"),
    targetToken,
    consumerRunId,
    consumerCommit,
    identityPath: resolve(requiredEnvironment("SOURCE_LKG_IDENTITY_PATH")),
    proofPath: resolve(requiredEnvironment("SOURCE_LKG_PROOF_PATH")),
  });
  const token = requiredEnvironment("VERCEL_TOKEN");
  const teamId = requiredEnvironment("VERCEL_ORG_ID");
  const projectId = requiredEnvironment("VERCEL_PROJECT_ID");
  const candidate = {
    source: "last-known-good",
    primary: {
      deploymentId: source.sourceIdentity.primaryDeploymentId,
      appCommit: source.sourceIdentity.appCommit,
      releaseTag: source.sourceIdentity.releaseTag,
      releaseRevision: source.sourceIdentity.releaseRevision,
    },
    mirror: {
      deploymentId: source.sourceIdentity.mirrorDeploymentId,
      appCommit: source.sourceIdentity.appCommit,
      releaseTag: source.sourceIdentity.releaseTag,
      releaseRevision: source.sourceIdentity.releaseRevision,
    },
  };
  const selected = await verifyRollbackCandidate({ candidate, token, teamId, projectId });
  const selectionProof = createReadOnlyRollbackSelectionProof({
    source: selected.source,
    primaryDeploymentId: selected.primary.deploymentId,
    primaryAppCommit: selected.primary.appCommit,
    mirrorDeploymentId: selected.mirror.deploymentId,
    mirrorAppCommit: selected.mirror.appCommit,
    lastKnownGoodAvailable: true,
    lastKnownGoodArtifactProofDigest: source.sourceArtifactProof.proofDigest,
    teamId,
    projectId,
  });
  await writeFile(
    resolve(requiredEnvironment("MIGRATION_SELECTION_PROOF_PATH")),
    `${JSON.stringify(selectionProof, null, 2)}\n`,
    "utf8",
  );
  const seed = createRepositoryMigrationSeedIdentity({
    ...source,
    target: {
      repository,
      repositoryId,
      bootstrapControlCommit: controlCommit,
      bootstrapRunId: requiredEnvironment("GITHUB_RUN_ID"),
      bootstrapRunAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
      workflowPath: REPOSITORY_MIGRATION_WORKFLOW_PATH,
      workflowRef,
      eventName,
      eventRef,
      operation,
      consumerRunId,
      consumerCommit,
    },
    vercelSelectionProof: selectionProof,
  });
  validateRepositoryMigrationSeedIdentity(seed, {
    expectedVercelTeamId: teamId,
    expectedVercelProjectId: projectId,
  });
  await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  const seedName = publicationPreflight.seedName;
  appendOutputs({
    seed_name: seedName,
    publication_mode: "repository-migration-seed",
    seed_eligible: "true",
    product_commit: source.sourceIdentity.appCommit,
    source_deployment_id: source.sourceIdentity.primaryDeploymentId,
    consumer_run_id: consumerRunId,
    seed_provenance_digest: seed.provenanceDigest,
  });
  console.log(JSON.stringify({
    status: "PASS",
    publicationMode: "repository-migration-seed",
    sourceRepository: source.sourceRepositoryMetadata.repository,
    sourceArtifactId: source.sourceArtifactMetadata.artifactId,
    sourceRunId: source.sourceArtifactMetadata.runId,
    productCommit: source.sourceIdentity.appCommit,
    consumerRunId,
    seedProvenanceDigest: seed.provenanceDigest,
  }));
}

async function selectCli() {
  let lastKnownGood = null;
  let lastKnownGoodRejection = null;
  let lastKnownGoodProof = null;
  const lastKnownGoodAvailable = process.env.LAST_KNOWN_GOOD_AVAILABLE === "true";
  if (lastKnownGoodAvailable && (!process.env.LAST_KNOWN_GOOD_PATH || !process.env.LAST_KNOWN_GOOD_PROOF_PATH)) {
    throw new Error("LAST_KNOWN_GOOD_AVAILABLE_BUT_PROOF_MISSING");
  }
  if (process.env.LAST_KNOWN_GOOD_PATH) {
    try {
      const parsed = parseLastKnownGoodCandidate(
        await readFile(process.env.LAST_KNOWN_GOOD_PATH, "utf8"),
      );
      lastKnownGood = parsed.candidate;
      lastKnownGoodRejection = parsed.rejectionCode;
      if (lastKnownGoodAvailable) {
        lastKnownGoodProof = validateLastKnownGoodArtifactProof(
          JSON.parse(await readFile(process.env.LAST_KNOWN_GOOD_PROOF_PATH, "utf8")),
          lastKnownGood,
        );
      }
    } catch (error) {
      lastKnownGoodRejection = String(
        error?.code || error?.message || "LAST_KNOWN_GOOD_ARTIFACT_UNREADABLE",
      );
    }
  }
  if (lastKnownGoodAvailable && (!lastKnownGood || !lastKnownGoodProof || lastKnownGoodRejection)) {
    throw Object.assign(new Error("LAST_KNOWN_GOOD_AVAILABLE_BUT_UNVERIFIED"), {
      code: "LAST_KNOWN_GOOD_AVAILABLE_BUT_UNVERIFIED",
    });
  }
  const selectionDeadlineMs = Number(process.env.ROLLBACK_TARGET_SELECTION_DEADLINE_MS || 60_000);
  const fetchTimeoutMs = Number(process.env.VERCEL_FETCH_TIMEOUT_MS || 5_000);
  if (!Number.isFinite(selectionDeadlineMs) || selectionDeadlineMs < 5_000 || selectionDeadlineMs > 120_000) {
    throw new Error("ROLLBACK_TARGET_SELECTION_DEADLINE_INVALID");
  }
  if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs < 100 || fetchTimeoutMs > 30_000) {
    throw new Error("ROLLBACK_TARGET_FETCH_TIMEOUT_INVALID");
  }
  const token = requiredEnvironment("VERCEL_TOKEN");
  const teamId = requiredEnvironment("VERCEL_ORG_ID");
  const projectId = requiredEnvironment("VERCEL_PROJECT_ID");
  const requireAuditProvenance = strictBooleanEnvironment(
    "REQUIRE_AUDIT_SELECTION_PROVENANCE",
  );
  const auditBindingRequested = requireAuditProvenance
    || Boolean(String(process.env.AUDIT_COMMIT || "").trim());
  if (auditBindingRequested && !process.env.ROLLBACK_SELECTION_PROOF_PATH) {
    throw proofError("READ_ONLY_SELECTION_PROOF_PATH_REQUIRED");
  }
  const auditProvenance = normalizeAuditProvenance(
    auditSelectionProvenanceFromEnvironment(auditBindingRequested),
    { required: auditBindingRequested },
  );
  if (lastKnownGoodAvailable) {
    await verifyRollbackCandidate({
      candidate: normalizeCandidate("last-known-good", lastKnownGood),
      token,
      teamId,
      projectId,
      fetchTimeoutMs,
      deadlineAt: Date.now() + Math.min(selectionDeadlineMs, 30_000),
    }).catch((error) => {
      throw Object.assign(new Error("LAST_KNOWN_GOOD_CONTROL_PLANE_FAIL_CLOSED"), {
        code: "LAST_KNOWN_GOOD_CONTROL_PLANE_FAIL_CLOSED",
        causeCode: error?.code || error?.message,
      });
    });
  }
  const selected = await selectVerifiedRollbackTarget({
    current: process.env.DISABLE_CURRENT_CAPTURE === "true" ? null : optionalIdentity("CURRENT"),
    lastKnownGood,
    emergency: optionalIdentity("EMERGENCY"),
    token,
    teamId,
    projectId,
    fetchTimeoutMs,
    deadlineAt: Date.now() + selectionDeadlineMs,
  });
  let selectionProofDigest = "";
  if (process.env.ROLLBACK_SELECTION_PROOF_PATH) {
    const proof = createReadOnlyRollbackSelectionProof({
      source: selected.source,
      primaryDeploymentId: selected.primary.deploymentId,
      primaryAppCommit: selected.primary.appCommit,
      mirrorDeploymentId: selected.mirror.deploymentId,
      mirrorAppCommit: selected.mirror.appCommit,
      lastKnownGoodAvailable,
      lastKnownGoodArtifactProofDigest: lastKnownGoodProof?.proofDigest || null,
      teamId,
      projectId,
      auditProvenance,
      requireAuditProvenance: auditBindingRequested,
    });
    selectionProofDigest = proof.proofDigest;
    await writeFile(
      process.env.ROLLBACK_SELECTION_PROOF_PATH,
      `${JSON.stringify(proof, null, 2)}\n`,
      "utf8",
    );
  }
  appendOutputs({
    source: selected.source,
    primary_deployment_id: selected.primary.deploymentId,
    primary_app_commit: selected.primary.appCommit,
    mirror_deployment_id: selected.mirror.deploymentId,
    mirror_app_commit: selected.mirror.appCommit,
    selection_proof_digest: selectionProofDigest,
  });
  console.log(JSON.stringify({
    status: "PASS",
    source: selected.source,
    lastKnownGoodCandidateRejected: Boolean(lastKnownGoodRejection),
    lastKnownGoodRejection,
    lastKnownGoodAvailable,
    lastKnownGoodArtifactProofVerified: Boolean(lastKnownGoodProof),
    lastKnownGoodControlPlaneVerified: lastKnownGoodAvailable,
    selectionProofDigest: selectionProofDigest || null,
  }));
}

async function writeCli() {
  let recoveryControlProof = null;
  const recoveryControlProofPath = String(process.env.RECOVERY_CONTROL_PROOF_PATH || "").trim();
  if (recoveryControlProofPath) {
    recoveryControlProof = validateProductionRecoveryControlProof(JSON.parse(
      await readFile(recoveryControlProofPath, "utf8"),
    ));
    if (recoveryControlProof.productCommit !== requiredEnvironment("APP_COMMIT")
      || recoveryControlProof.controlCommit !== requiredEnvironment("GITHUB_SHA")
      || recoveryControlProof.workflowSha !== requiredEnvironment("GITHUB_WORKFLOW_SHA")
      || recoveryControlProof.eventName !== requiredEnvironment("GITHUB_EVENT_NAME")
      || recoveryControlProof.eventRef !== requiredEnvironment("GITHUB_REF")
      || recoveryControlProof.operation !== requiredEnvironment("RECOVERY_OPERATION")
      || recoveryControlProof.repository !== requiredEnvironment("GITHUB_REPOSITORY")
      || recoveryControlProof.workflowRef !== requiredEnvironment("GITHUB_WORKFLOW_REF")
      || recoveryControlProof.runId !== requiredEnvironment("GITHUB_RUN_ID")
      || recoveryControlProof.runAttempt !== requiredEnvironment("GITHUB_RUN_ATTEMPT")) {
      throw new Error("LAST_KNOWN_GOOD_RECOVERY_CONTROL_PROOF_MISMATCH");
    }
  }
  const document = createLastKnownGoodProductionIdentity({
    primaryDeploymentId: requiredEnvironment("PRIMARY_DEPLOYMENT_ID"),
    mirrorDeploymentId: requiredEnvironment("MIRROR_DEPLOYMENT_ID"),
    appCommit: requiredEnvironment("APP_COMMIT"),
    releaseTag: requiredEnvironment("RELEASE_TAG"),
    releaseRevision: requiredEnvironment("RELEASE_REVISION"),
    recoveryControlProof,
  });
  await writeFile(requiredEnvironment("LAST_KNOWN_GOOD_PATH"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "PASS", provenanceDigest: document.provenanceDigest }));
}

async function main() {
  const mode = process.argv[2];
  if (mode === "bootstrap-source") return bootstrapSourceCli();
  if (mode === "discover") return discoverCli();
  if (mode === "download") return downloadCli();
  if (mode === "select") return selectCli();
  if (mode === "write") return writeCli();
  throw new Error(`UNKNOWN_LAST_KNOWN_GOOD_MODE:${mode}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "last_known_good_governance_failed",
      errorCode: String(error?.code || error?.message || "LAST_KNOWN_GOOD_GOVERNANCE_FAILED"),
      failures: Array.isArray(error?.failures) ? error.failures : [],
    }));
    process.exitCode = 1;
  });
}
