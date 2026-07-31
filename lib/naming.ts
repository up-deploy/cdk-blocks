/**
 * The platform's resource-naming guarantee, in one place.
 *
 *   <companyId>-<block>-<appId>-<role>-<environment>-<seq>
 *   up         -s3     -a231   -docs  -dev          -01
 *
 * `role` says what the resource is FOR, and it is what makes two components of the same
 * block distinguishable inside one app's stack. `seq` separates two components with the
 * same role; a new role starts again at `01`.
 *
 * `seq` is supplied, never derived from position. If the platform counted components to
 * assign it, deleting the first would renumber the second, and a renamed resource is a
 * DESTROY and CREATE in CloudFormation, not a rename.
 *
 * Every block composes its name through this function, so the guarantee that tags and cost
 * attribution rely on cannot drift block by block.
 */

/** Lowercase, no hyphens, 3-12 chars. Hyphen-free keeps each segment visually distinct. */
export const ROLE_PATTERN = /^[a-z][a-z0-9]{2,11}$/;

/** Two digits. `01` unless the same role already exists in this app and environment. */
export const SEQ_PATTERN = /^\d{2}$/;

export const DEFAULT_SEQ = "01";

export interface ResourceNameParts {
  /** Tag namespace and name prefix, from config/environments/<env>.yaml. */
  readonly companyId: string;
  /** The catalog entry name, e.g. `s3`. */
  readonly block: string;
  /** The app this component belongs to. */
  readonly appId: string;
  /** What the resource is for, e.g. `docs`. */
  readonly role: string;
  /** The environment ring. */
  readonly environment: string;
  /** Two digits, defaults to `01`. */
  readonly seq?: string;
}

export function composeResourceName(parts: ResourceNameParts): string {
  const seq = parts.seq ?? DEFAULT_SEQ;

  if (!ROLE_PATTERN.test(parts.role)) {
    throw new Error(
      `Invalid role '${parts.role}' — must match ${ROLE_PATTERN.source} ` +
        `(lowercase, no hyphens, 3-12 characters). The role says what the resource is for, ` +
        `for example 'docs' or 'uploads'.`,
    );
  }

  if (!SEQ_PATTERN.test(seq)) {
    throw new Error(
      `Invalid seq '${seq}' — must be two digits, for example '01'. ` +
        `A second component with the same role is '02'; a different role starts at '01'.`,
    );
  }

  return [parts.companyId, parts.block, parts.appId, parts.role, parts.environment, seq].join("-");
}
