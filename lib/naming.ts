/**
 * The platform's resource-naming guarantee, in one place.
 *
 *   <companyId>-<block>-<appId>[-<role>]-<environment>-<issueId>
 *   up         -s3     -0011            -dev          -163
 *   up         -s3     -0011   -docs    -dev          -170
 *
 * `issueId` is the GitHub issue that requested the component. It is written into the
 * manifest when the component is added and NEVER rewritten, so a later request cannot
 * rename survivors (a renamed resource is a destroy-and-create in CloudFormation).
 *
 * `role` is optional (max 6 chars): a purpose hint and a cost tag when the requester
 * sets one. Uniqueness is `(block, role-or-empty, issueId)`, so N components of the
 * same block are allowed without inventing a counter.
 *
 * Every block composes its name through this function, so the guarantee that tags and
 * cost attribution rely on cannot drift block by block.
 */

/** Optional purpose segment: lowercase, no hyphens, 1-6 characters. */
export const ROLE_PATTERN = /^[a-z][a-z0-9]{0,5}$/;

/** GitHub issue number, as a decimal string with no leading zeros. */
export const ISSUE_ID_PATTERN = /^[1-9][0-9]*$/;

export interface ResourceNameParts {
  /** Tag namespace and name prefix, from config/environments/<env>.yaml. */
  readonly companyId: string;
  /** The catalog entry name, e.g. `s3`. */
  readonly block: string;
  /** The app this component belongs to. */
  readonly appId: string;
  /**
   * What the resource is for, e.g. `docs`. Optional. Omitted from the name when absent.
   */
  readonly role?: string;
  /** The environment ring. */
  readonly environment: string;
  /** The change-request issue that created this component. Immutable after add. */
  readonly issueId: string;
}

export function composeResourceName(parts: ResourceNameParts): string {
  if (parts.role !== undefined && parts.role !== "") {
    if (!ROLE_PATTERN.test(parts.role)) {
      throw new Error(
        `Invalid role '${parts.role}' — must match ${ROLE_PATTERN.source} ` +
          `(lowercase, no hyphens, 1-6 characters). The role is an optional purpose hint ` +
          `and cost tag, for example 'docs' or 'upload'.`,
      );
    }
  }

  if (!ISSUE_ID_PATTERN.test(parts.issueId)) {
    throw new Error(
      `Invalid issueId '${parts.issueId}' — must match ${ISSUE_ID_PATTERN.source} ` +
        `(the GitHub issue number of the change request, no leading zeros).`,
    );
  }

  const segments = [parts.companyId, parts.block, parts.appId];
  if (parts.role !== undefined && parts.role !== "") {
    segments.push(parts.role);
  }
  segments.push(parts.environment, parts.issueId);
  return segments.join("-");
}
