import { describe, it, expect } from "vitest";
import {
  issueGrant, grantIdFor, fingerprintGrant,
  assertGrantUsable, assertCapability, assertInScope, grantIsMutating,
  GrantDenied, MAX_GRANT_LIFETIME_MS,
  type ImplementationGrant,
} from "../src/domain/grant.js";
import {
  Capability, capabilityMatrix, isImplemented, assertGrantable,
  CapabilityNotAvailable, IMPLEMENTED_CAPABILITIES,
} from "../src/domain/capability.js";

/**
 * AUTHORISATION.
 *
 * A grant is the only thing that turns "a human approved a plan" into write
 * capability. These tests pin down what it permits and - mostly - what it does
 * not, because every property below is one an agent would benefit from breaking.
 */

const baseInput = {
  projectId: "proj",
  runId: "run_1",
  approvalId: "apr_1",
  approvedBy: "owner",
  allowedScope: ["src/"],
  capabilities: ["repo.file.write", "repo.read"] as Capability[],
};

const grant = (over: Partial<Parameters<typeof issueGrant>[0]> = {}) =>
  issueGrant({ ...baseInput, ...over });

const context = { projectId: "proj", runId: "run_1" };

describe("the capability model", () => {
  it("declares capabilities that are deliberately not implemented", () => {
    for (const capability of ["git.mutate", "process.execute", "network.access"] as Capability[]) {
      expect(Capability.options).toContain(capability);
      expect(isImplemented(capability)).toBe(false);
    }
  });

  it("implements only bounded repository access in this phase", () => {
    expect([...IMPLEMENTED_CAPABILITIES].sort()).toEqual([
      "repo.file.delete", "repo.file.write", "repo.metadata.read", "repo.read",
    ]);
  });

  it("refuses to make an unimplemented capability grantable", () => {
    expect(() => assertGrantable("git.mutate")).toThrow(CapabilityNotAvailable);
    expect(() => assertGrantable("process.execute")).toThrow(CapabilityNotAvailable);
    expect(() => assertGrantable("network.access")).toThrow(CapabilityNotAvailable);
  });

  it("reports a matrix a human can read", () => {
    const matrix = capabilityMatrix();
    const write = matrix.find((m) => m.capability === "repo.file.write")!;
    expect(write.implemented).toBe(true);
    expect(write.risk).toBe("HIGH");
    expect(write.requires).toContain("grant");

    const shell = matrix.find((m) => m.capability === "process.execute")!;
    expect(shell.implemented).toBe(false);
    expect(shell.requires).toBe("not implemented");
  });
});

describe("issuing a grant", () => {
  it("binds it to a project, a run and a human approval", () => {
    const g = grant();
    expect(g.projectId).toBe("proj");
    expect(g.runId).toBe("run_1");
    expect(g.approvalId).toBe("apr_1");
    expect(g.approvedBy).toBe("owner");
  });

  it("always expires", () => {
    const g = grant();
    expect(Date.parse(g.expiresAt)).toBeGreaterThan(Date.parse(g.notBefore));
  });

  it("caps the lifetime however long the caller asks for", () => {
    const g = grant({ lifetimeMs: 999 * 60 * 60 * 1000 });
    const lifetime = Date.parse(g.expiresAt) - Date.parse(g.notBefore);
    expect(lifetime).toBeLessThanOrEqual(MAX_GRANT_LIFETIME_MS);
  });

  it("REFUSES to mint an unimplemented capability rather than dropping it", () => {
    // Silently issuing a lesser grant would hide the caller's misunderstanding.
    expect(() => grant({ capabilities: ["repo.read", "git.mutate"] as Capability[] }))
      .toThrow(CapabilityNotAvailable);
    expect(() => grant({ capabilities: ["process.execute"] as Capability[] }))
      .toThrow(CapabilityNotAvailable);
  });

  it("produces a deterministic id from (run, attempt), for replay safety", () => {
    expect(grantIdFor("run_1", 0)).toBe(grantIdFor("run_1", 0));
    expect(grantIdFor("run_1", 0)).not.toBe(grantIdFor("run_1", 1));
  });

  it("knows whether it can mutate anything", () => {
    expect(grantIsMutating(grant())).toBe(true);
    expect(grantIsMutating(grant({ capabilities: ["repo.read"] as Capability[] }))).toBe(false);
  });
});

describe("a grant must be usable before anything happens", () => {
  it("accepts a well-formed, current grant", () => {
    expect(() => assertGrantUsable(grant(), context)).not.toThrow();
  });

  it("denies when there is NO grant at all", () => {
    try {
      assertGrantUsable(null, context);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("no_grant");
    }
  });

  it("denies an EXPIRED grant", () => {
    const g = grant({ lifetimeMs: 1000, now: new Date(Date.now() - 60_000) });
    try {
      assertGrantUsable(g, context);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("expired");
    }
  });

  it("denies a grant that is not yet valid", () => {
    const future = new Date(Date.now() + 60_000);
    const g = grant({ now: future });
    try {
      assertGrantUsable(g, context);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("not_yet_valid");
    }
  });

  it("denies the WRONG PROJECT", () => {
    try {
      assertGrantUsable(grant(), { projectId: "other", runId: "run_1" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("wrong_project");
    }
  });

  it("denies the WRONG RUN", () => {
    try {
      assertGrantUsable(grant(), { projectId: "proj", runId: "run_999" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("wrong_run");
    }
  });

  it("denies a revoked or already-consumed grant", () => {
    for (const status of ["revoked", "consumed"] as const) {
      try {
        assertGrantUsable({ ...grant(), status }, context);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as GrantDenied).reason).toBe(status);
      }
    }
  });
});

describe("a MODIFIED grant is rejected", () => {
  /** Every field an agent would want to change, and the tampering must show. */
  const tampering: [string, (g: ImplementationGrant) => ImplementationGrant][] = [
    ["widened scope", (g) => ({ ...g, allowedScope: ["/"] })],
    ["extra scope entry", (g) => ({ ...g, allowedScope: [...g.allowedScope, "secrets/"] })],
    ["added capability", (g) => ({ ...g, capabilities: [...g.capabilities, "git.mutate"] })],
    ["extended expiry", (g) => ({ ...g, expiresAt: new Date(Date.now() + 864e5).toISOString() })],
    ["raised write budget", (g) => ({ ...g, maxWrites: 1_000_000 })],
    ["raised size limit", (g) => ({ ...g, maxWriteBytes: 1_000_000_000 })],
    ["different approver", (g) => ({ ...g, approvedBy: "the-agent" })],
    ["different approval", (g) => ({ ...g, approvalId: "apr_forged" })],
    ["re-pointed run", (g) => ({ ...g, runId: "run_1", projectId: "proj", grantId: "grn_other" })],
  ];

  for (const [label, mutate] of tampering) {
    it(`detects ${label}`, () => {
      const forged = mutate(grant());
      try {
        assertGrantUsable(forged, context);
        expect.unreachable("tampering should have been detected");
      } catch (error) {
        expect((error as GrantDenied).reason).toBe("tampered");
      }
    });
  }

  it("only passes when the fingerprint is recomputed for the ACTUAL contents", () => {
    // Re-fingerprinting a widened grant makes it internally consistent - which
    // is exactly why the stored copy, not the presented one, is authoritative.
    // See the runner test for that half.
    const widened = { ...grant(), allowedScope: ["/"] };
    const consistent = { ...widened, fingerprint: fingerprintGrant(widened) };
    expect(() => assertGrantUsable(consistent, context)).not.toThrow();
  });
});

describe("capability checks", () => {
  it("permits a capability the grant carries", () => {
    expect(() => assertCapability(grant(), "repo.file.write")).not.toThrow();
  });

  it("denies a capability the grant does not carry", () => {
    try {
      assertCapability(grant({ capabilities: ["repo.read"] as Capability[] }), "repo.file.write");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("capability_not_granted");
    }
  });

  it("denies an unimplemented capability EVEN IF the grant somehow carries it", () => {
    // A grant read back from disk, or hand-edited, must not activate something
    // that has no implementation behind it.
    const smuggled = { ...grant(), capabilities: ["git.mutate"] as Capability[] };
    try {
      assertCapability(smuggled, "git.mutate");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("capability_not_implemented");
    }
  });
});

describe("scope checks use the same rules as drift detection", () => {
  it("permits a file inside an authorised directory", () => {
    expect(() => assertInScope(grant(), "src/a.ts")).not.toThrow();
    expect(() => assertInScope(grant(), "src/deep/nested/b.ts")).not.toThrow();
  });

  it("denies a sibling directory", () => {
    expect(() => assertInScope(grant(), "tests/a.ts")).toThrow(GrantDenied);
  });

  it("denies a prefix collision", () => {
    expect(() => assertInScope(grant(), "src-generated/a.ts")).toThrow(GrantDenied);
  });

  it("denies traversal and absolute paths", () => {
    for (const bad of ["../outside.ts", "src/../../etc/passwd", "/etc/passwd"]) {
      expect(() => assertInScope(grant(), bad)).toThrow(GrantDenied);
    }
  });

  it("FAILS CLOSED on an empty scope - it authorises nothing", () => {
    const empty = grant({ allowedScope: [] });
    try {
      assertInScope(empty, "src/a.ts");
      expect.unreachable("an empty scope must authorise nothing");
    } catch (error) {
      expect((error as GrantDenied).reason).toBe("out_of_scope");
      expect((error as GrantDenied).message).toContain("no paths at all");
    }
  });

  it("normalises separators, so a Windows path cannot dodge the check", () => {
    expect(() => assertInScope(grant(), "src\\a.ts")).not.toThrow();
    expect(() => assertInScope(grant(), "tests\\a.ts")).toThrow(GrantDenied);
  });
});
