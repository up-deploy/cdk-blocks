import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../app/app-stack";

/**
 * The guarantee the whole one-stack-per-app model rests on.
 *
 * An app team's stack accumulates components over time: a request adds one, and every later
 * request re-synthesizes the WHOLE app from the manifest. That is only safe if a component's
 * identity depends on nothing but that component. If it ever depended on position, on the
 * number of siblings, or on a hash of the list, then asking for a second bucket would change
 * the first one's logical ID — and a changed logical ID is a DESTROY and CREATE in
 * CloudFormation, not a rename. Someone else's unrelated request would delete your data.
 *
 * It holds by construction: `AppStack` derives the construct id as
 * `${pascal(block)}${pascal(role)?}`, and CDK's `allocateLogicalId` slices the stack
 * off the construct path.
 */

const base = { companyId: "up", appId: "a231", environment: "dev" };

const component = (block: string, role: string) => ({
  block,
  role,
  blockRef: "v0.6.0",
  config: { logBucket: "up-s3-logs-dev-01" },
});

const A = component("s3", "docs");
const B = component("s3", "upload");

type Component = ReturnType<typeof component>;
type TemplateJson = { Resources?: Record<string, unknown>; Outputs?: Record<string, unknown> };

function tpl(components: Component[]): TemplateJson {
  const stack = new AppStack(new App(), "App", {
    ...base,
    stackName: "up-a231-dev",
    components,
  });
  return Template.fromStack(stack).toJSON() as TemplateJson;
}

/**
 * `CDKMetadata` is excluded deliberately, and the reason belongs here rather than in a commit
 * message: its `Analytics` property encodes the construct tree, so it changes CORRECTLY whenever
 * a component is added. Left in, every test below would be red for a non-reason, and the next
 * person to see that would weaken the assertion instead of the exclusion.
 */
function strip(t: TemplateJson) {
  const resources = { ...(t.Resources ?? {}) };
  delete resources.CDKMetadata;
  return { Resources: resources, Outputs: { ...(t.Outputs ?? {}) } };
}

function idsOf(t: TemplateJson): string[] {
  return Object.keys(strip(t).Resources).sort();
}

/**
 * Compared with `toEqual` rather than by stringifying: a change in key ORDER inside a template
 * is not a resource replacement, and a test that fails on it fails for something nobody needs
 * to act on.
 */
function expectUnchanged(before: TemplateJson, after: TemplateJson) {
  const b = strip(before);
  const a = strip(after);
  for (const section of ["Resources", "Outputs"] as const) {
    for (const key of Object.keys(b[section])) {
      expect(Object.keys(a[section])).toContain(key);
      expect(a[section][key]).toEqual(b[section][key]);
    }
  }
}

describe("logical ids are a pure function of the component that owns them", () => {
  // Hardcoded rather than snapshotted, on purpose. The recovery ritual for a failing snapshot is
  // `jest -u`, which makes the assertion self-healing and therefore worth nothing. If these
  // strings ever change, a deployed resource is being REPLACED — that is the finding, not a
  // stale expectation to refresh.
  //
  // First run: print idsOf(tpl([A])) if these fail after a deliberate id-scheme change.
  test("POLICY: the ids for a fixed request are these exact strings", () => {
    const t = tpl([A]);

    expect(idsOf(t)).toEqual([
      "S3DocsBucket5C74284A",
      "S3DocsBucketPolicyBFC20255",
    ]);
    expect(Object.keys(strip(t).Outputs).sort()).toEqual([
      "S3DocsBucketArn",
      "S3DocsBucketName",
      "S3DocsResourceName",
    ]);
  });

  // A removal is an addition read backwards, so ONE assertion covers both: it says A is
  // byte-identical whether or not B is present, which is exactly the claim a removal needs.
  test("POLICY: adding or removing a component leaves the others byte-identical", () => {
    expectUnchanged(tpl([A]), tpl([A, B]));
  });

  // THIS is the assertion that catches a position-dependent id, and it is why the file exists.
  test("POLICY: the request is a SET — order in the manifest never reaches the template", () => {
    expectUnchanged(tpl([A]), tpl([B, A]));
    expect(strip(tpl([A, B]))).toEqual(strip(tpl([B, A])));
  });

  // Asserted as a VALUE, not a shape: this literal is what a requester is shown on their board
  // as "what you got", so it is a contract rather than a convenience.
  test("POLICY: the composed name is a pure function of the request", () => {
    for (const components of [[A], [A, B], [B, A]]) {
      const outputs = strip(tpl(components)).Outputs as Record<string, { Value: string }>;
      expect(outputs.S3DocsResourceName.Value).toBe("up-s3-a231-docs-dev");
    }
  });
});

/**
 * The ceiling an app actually hits.
 *
 * Separate describe rather than a separate file: it is the same property this file exists for —
 * what happens as an app team's stack accumulates components — just at the far end of it.
 */
describe("the outputs quota, not the resource quota, is what an app runs out of", () => {
  // 67 components x 3 outputs each = 201, one over. Roles stay ≤6 chars.
  const many = Array.from({ length: 67 }, (_, i) =>
    component("s3", `r${String(i).padStart(3, "0")}`),
  );

  test("POLICY: an app over 200 outputs is refused with the number and the remedy", () => {
    expect(() => tpl(many)).toThrow(/composes 201 stack outputs/);
    expect(() => tpl(many)).toThrow(/second app/);
  });

  test("one component under the line still synthesizes", () => {
    expect(() => tpl(many.slice(0, 66))).not.toThrow();
  });
});
