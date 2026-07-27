import type { AzureDevOpsClient } from "../ado/client.js";
import { randomUUID } from "node:crypto";
import type { Publisher } from "../domain/ports.js";
import type { PublicationState } from "../domain/types.js";
import {
  contentHash,
  detectManualConflicts,
  PublicationConflictError,
  shouldCreateLifecycle,
  updateManagedDescription,
} from "./state.js";

interface Ref {
  readonly name: string;
  readonly objectId: string;
}

interface PullRequest {
  readonly pullRequestId: number;
  readonly status: "active" | "completed" | "abandoned";
  readonly description?: string;
  readonly sourceRefName?: string;
  readonly targetRefName?: string;
  readonly title?: string;
}

const LIFECYCLE_BRANCH_PREFIX = "refs/heads/edgar/";
const PULL_REQUEST_TITLE = "Refresh generated documentation";
const GIT_SECURITY_NAMESPACE = "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
const REQUIRED_PUBLICATION_PERMISSIONS = 2 + 4 + 16 + 16_384;

export class AzureDevOpsPublisher implements Publisher {
  public constructor(
    private readonly client: AzureDevOpsClient,
    private readonly project: string,
    private readonly repository: string,
    private readonly targetBranch: string,
    private readonly documentationRoot: string,
    private readonly reviewers: readonly string[] = [],
  ) {}

  public async probe(): Promise<void> {
    await this.targetRef();
    const repository = await this.client.get<{
      id: string;
      project: { id: string };
    }>(
      `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}`,
    );
    const token = `repoV2/${repository.project.id}/${repository.id}`;
    const result = await this.client.get<{ value: boolean[] }>(
      `/_apis/permissions/${GIT_SECURITY_NAMESPACE}/${String(REQUIRED_PUBLICATION_PERMISSIONS)}`,
      {
        tokens: token,
        alwaysAllowAdministrators: "false",
      },
    );
    if (result.value[0] !== true) {
      throw new Error(
        "Azure DevOps identity lacks repository read, contribute, create-branch, or pull-request permissions",
      );
    }
  }

  public async publish(
    files: Readonly<Record<string, string>>,
    priorState: PublicationState | null,
  ): Promise<PublicationState> {
    if (Object.keys(files).length === 0) {
      return priorState ?? { generatorFileHashes: {}, pendingConflicts: [] };
    }
    const target = await this.targetRef();
    const currentState = await this.resolvePublicationState(priorState);
    const freshLifecycle = shouldCreateLifecycle(currentState);
    const existingLifecycle = currentState?.lifecycleBranch;
    if (!freshLifecycle && !existingLifecycle) {
      throw new Error("Active publication state is missing its lifecycle branch");
    }
    const lifecycleBranch = freshLifecycle
      ? `${LIFECYCLE_BRANCH_PREFIX}${target.objectId.slice(0, 12)}-${randomUUID().slice(0, 8)}`
      : existingLifecycle!;
    try {
      const activeFiles = await this.loadBranchFiles(
        Object.keys(files),
        freshLifecycle ? this.targetBranch : lifecycleBranch,
      );
      const alreadyCurrent = new Set(
        Object.entries(files)
          .filter(([path, content]) => activeFiles[path] === content)
          .map(([path]) => path),
      );
      const conflicts = detectManualConflicts(
        Object.keys(files),
        activeFiles,
        currentState?.generatorFileHashes ?? {},
        true,
        files,
      );
      const conflictSet = new Set(conflicts);
      const publishable = Object.fromEntries(
        Object.entries(files).filter(
          ([path]) => !conflictSet.has(path) && !alreadyCurrent.has(path),
        ),
      );
      const managedHashes = Object.fromEntries(
        Object.entries(files)
          .filter(([path]) => !conflictSet.has(path))
          .map(([path, content]) => [path, contentHash(content)]),
      );
      if (freshLifecycle && Object.keys(publishable).length === 0) {
        return {
          ...currentState,
          targetHead: target.objectId,
          generatorFileHashes: {
            ...(currentState?.generatorFileHashes ?? {}),
            ...managedHashes,
          },
          pendingConflicts: conflicts,
        };
      }
      const oldObjectId = freshLifecycle
        ? "0000000000000000000000000000000000000000"
        : await this.refObjectId(lifecycleBranch);
      if (freshLifecycle) {
        await this.client.send(
          "POST",
          `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/refs`,
          [{ name: lifecycleBranch, oldObjectId, newObjectId: target.objectId }],
        );
      }
      if (Object.keys(publishable).length > 0) {
        await this.client.send(
          "POST",
          `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/pushes`,
          {
            refUpdates: [
              {
                name: lifecycleBranch,
                oldObjectId: freshLifecycle ? target.objectId : oldObjectId,
              },
            ],
            commits: [
              {
                comment: "Refresh evidence-backed documentation",
                changes: Object.entries(publishable).map(([path, content]) => ({
                  changeType: activeFiles[path] === undefined ? "add" : "edit",
                  item: { path: `/${this.documentationRoot}/${path}` },
                  newContent: { content, contentType: "rawtext" },
                })),
              },
            ],
          },
        );
      }
      const managed =
        conflicts.length === 0
          ? "Evidence-backed documentation refresh."
          : `Evidence-backed documentation refresh.\n\nManual conflicts preserved:\n${conflicts.map((path) => `- ${path}`).join("\n")}`;
      const pullRequestId = await this.upsertPullRequest(
        freshLifecycle,
        currentState?.pullRequestId,
        lifecycleBranch,
        managed,
      );
      return {
        pullRequestId,
        pullRequestStatus: "active",
        lifecycleBranch,
        targetHead: target.objectId,
        generatorFileHashes: {
          ...(currentState?.generatorFileHashes ?? {}),
          ...managedHashes,
        },
        pendingConflicts: conflicts,
      };
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 409) {
        throw new PublicationConflictError();
      }
      throw error;
    }
  }

  private async resolvePublicationState(
    state: PublicationState | null,
  ): Promise<PublicationState | null> {
    let verifiedActiveId: number | undefined;
    if (state?.pullRequestId && state.pullRequestStatus === "active") {
      const current = await this.client.get<PullRequest>(
        `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/pullrequests/${String(state.pullRequestId)}`,
      );
      if (current.status === "active") {
        verifiedActiveId = current.pullRequestId;
      } else {
        state = { ...state, pullRequestStatus: current.status };
      }
    }

    const discovered = await this.findActiveLifecyclePullRequest();
    if (verifiedActiveId !== undefined) {
      if (discovered && discovered.pullRequestId !== verifiedActiveId) {
        throw new Error("Multiple active EDGAR pull requests found for the target branch");
      }
      return state;
    }
    if (!discovered) return state;
    if (!discovered.sourceRefName) {
      throw new Error("Managed pull request is missing its source branch");
    }
    return {
      ...state,
      pullRequestId: discovered.pullRequestId,
      pullRequestStatus: "active",
      lifecycleBranch: discovered.sourceRefName,
      generatorFileHashes: state?.generatorFileHashes ?? {},
      pendingConflicts: state?.pendingConflicts ?? [],
    };
  }

  private async findActiveLifecyclePullRequest(): Promise<PullRequest | undefined> {
    const pullRequests: PullRequest[] = [];
    for await (const page of this.client.pages<PullRequest>(
      `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/pullrequests`,
      {
        "searchCriteria.status": "active",
        "searchCriteria.targetRefName": this.targetBranch,
      },
    )) {
      pullRequests.push(...page);
    }
    const managed = pullRequests.filter(
      (pullRequest) =>
        pullRequest.status === "active" &&
        pullRequest.targetRefName === this.targetBranch &&
        pullRequest.sourceRefName?.startsWith(LIFECYCLE_BRANCH_PREFIX) === true,
    );
    if (managed.length > 1) {
      throw new Error("Multiple active EDGAR pull requests found for the target branch");
    }
    return managed[0];
  }

  private async upsertPullRequest(
    fresh: boolean,
    existingId: number | undefined,
    lifecycleBranch: string,
    managedDescription: string,
  ): Promise<number> {
    if (fresh) {
      const reviewerPayload =
        this.reviewers.length === 0 ? {} : { reviewers: this.reviewers.map((id) => ({ id })) };
      const created = await this.client.send<PullRequest>(
        "POST",
        `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/pullrequests`,
        {
          sourceRefName: lifecycleBranch,
          targetRefName: this.targetBranch,
          title: PULL_REQUEST_TITLE,
          description: updateManagedDescription("", managedDescription),
          isDraft: true,
          ...reviewerPayload,
        },
      );
      return created.pullRequestId;
    }
    if (existingId === undefined) throw new Error("Active publication state is missing its PR id");
    const existing = await this.client.get<PullRequest>(
      `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/pullrequests/${String(existingId)}`,
    );
    await this.client.send(
      "PATCH",
      `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/pullrequests/${String(existingId)}`,
      {
        description: updateManagedDescription(existing.description ?? "", managedDescription),
      },
    );
    return existingId;
  }

  private async loadBranchFiles(
    paths: readonly string[],
    branch: string,
  ): Promise<Record<string, string | undefined>> {
    const result: Record<string, string | undefined> = {};
    for (const path of paths) {
      try {
        const response = await this.client.get<unknown>(
          `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/items`,
          {
            path: `/${this.documentationRoot}/${path}`,
            includeContent: "true",
            versionDescriptorVersion: branch.replace(/^refs\/heads\//, ""),
            versionDescriptorVersionType: "branch",
          },
        );
        result[path] =
          typeof response === "string"
            ? response
            : typeof response === "object" &&
                response !== null &&
                "content" in response &&
                typeof response.content === "string"
              ? response.content
              : undefined;
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
        result[path] = undefined;
      }
    }
    return result;
  }

  private async targetRef(): Promise<Ref> {
    const name = this.targetBranch.replace(/^refs\/heads\//, "");
    const response = await this.client.get<{ value: Ref[] }>(
      `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/refs`,
      { filter: `heads/${name}` },
    );
    const ref = response.value.find((item) => item.name === `refs/heads/${name}`);
    if (!ref) throw new Error(`Target branch not found: ${name}`);
    return ref;
  }

  private async refObjectId(refName: string): Promise<string> {
    const response = await this.client.get<{ value: Ref[] }>(
      `/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repository)}/refs`,
      { filter: refName.replace(/^refs\//, "") },
    );
    const ref = response.value.find((item) => item.name === refName);
    if (!ref) throw new Error(`Lifecycle branch not found: ${refName}`);
    return ref.objectId;
  }
}
