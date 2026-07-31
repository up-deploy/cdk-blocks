/**
 * The platform's resource-naming guarantee, in one place.
 *
 *   <companyId>-<block>-<appId>-<role>-<environment>
 *   up         -s3     -a231   -docs  -dev
 *
 * `role` says what the resource is FOR, and it is the ONLY thing distinguishing two
 * components of the same block inside one app's stack. That is deliberate: two components
 * of the same block serving the same purpose is a naming problem, not a case needing a
 * counter. An app wanting a second bucket alongside `docs` gives it a role that says what
 * it is for — `uploads`, `docsarchive` — and the name stays self-describing.
 *
 * So nothing is computed here. A name is a pure function of facts the request already
 * carries, which means it can be predicted before the request is made and never depends on
 * what else the app happens to contain. A counter could not promise that: it would have to
 * be read from the app's current set, and deleting a component would renumber the survivors
 * — and a renamed resource is a DESTROY and CREATE in CloudFormation, not a rename.
 *
 * Every block composes its name through this function, so the guarantee that tags and cost
 * attribution rely on cannot drift block by block.
 */

/** Lowercase, no hyphens, 3-12 chars. Hyphen-free keeps each segment visually distinct. */
export const ROLE_PATTERN = /^[a-z][a-z0-9]{2,11}$/;

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
}

export function composeResourceName(parts: ResourceNameParts): string {
  if (!ROLE_PATTERN.test(parts.role)) {
    throw new Error(
      `Invalid role '${parts.role}' — must match ${ROLE_PATTERN.source} ` +
        `(lowercase, no hyphens, 3-12 characters). The role says what the resource is for, ` +
        `for example 'docs' or 'uploads'.`,
    );
  }

  return [parts.companyId, parts.block, parts.appId, parts.role, parts.environment].join("-");
}
