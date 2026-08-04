/**
 * The platform's resource-naming guarantee, in one place.
 *
 *   <companyId>-<block>-<appId>[-<role>]-<environment>
 *   up         -s3     -0011            -dev
 *   up         -s3     -0011   -docs    -dev
 *
 * `role` says what the resource is FOR, and it is the ONLY thing distinguishing two
 * components of the same block inside one app's stack. That is deliberate: two components
 * of the same block serving the same purpose is a naming problem the requester fixes,
 * not a case needing a counter. An app wanting a second bucket alongside `docs` gives it
 * a role that says what it is for — `uploads`, `archive` — and the name stays
 * self-describing. One component per block may omit it.
 *
 * So nothing is computed here. A name is a pure function of facts the request already
 * carries, which means it can be predicted before the request is made and never depends on
 * what else the app happens to contain. A counter could not promise that: it would have to
 * be read from the app's current set, and deleting a component would renumber the survivors
 * — and a renamed resource is a DESTROY and CREATE in CloudFormation, not a rename.
 *
 * Every block composes its name through this function, so the guarantee that tags and
 * cost attribution rely on cannot drift block by block.
 */

/** Optional purpose segment: lowercase, no hyphens, 1-6 characters. */
export const ROLE_PATTERN = /^[a-z][a-z0-9]{0,5}$/;

export interface ResourceNameParts {
  /** Tag namespace and name prefix, from config/environments/<env>.yaml. */
  readonly companyId: string;
  /** The catalog entry name, e.g. `s3`. */
  readonly block: string;
  /** The app this component belongs to. */
  readonly appId: string;
  /**
   * What the resource is for, e.g. `docs`. Optional — but it is the ONLY discriminator
   * between two components of the same block, so a second same-block component must set it.
   */
  readonly role?: string;
  /** The environment ring. */
  readonly environment: string;
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

  const segments = [parts.companyId, parts.block, parts.appId];
  if (parts.role !== undefined && parts.role !== "") {
    segments.push(parts.role);
  }
  segments.push(parts.environment);
  return segments.join("-");
}
