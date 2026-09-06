import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectStore } from "../src/projects/projectStore.js";
import {
  ImplementationSession, CancellationToken,
} from "../src/implementation/session.js";
import { ToolBridge } from "../src/implementation/toolBridge.js";
import { StoredGrantAuthority } from "../src/implementation/grantAuthority.js";
import { ActivityJournal } from "../src/activity/journal.js";
import { FsBoundary } from "../src/security/fsBoundary.js";
import { SafeFs } from "../src/security/safeFs.js";
import { SafeWriteFs } from "../src/security/writeBoundary.js";
import { DEFAULT_LIMITS } from "../src/security/limits.js";
import { issueGrant, type ImplementationGrant } from "../src/domain/grant.js";
import type { Capability } from "../src/domain/capability.js";
import { ToolName, PROTOCOL_LIMITS } from "../src/domain/toolProtocol.js";
import { LocalGitRepositoryInspector } from "../src/adapters/repository/localGit.js";
import { RepositoryVerifier } from "../src/verification/verifier.js";
import {
  tmpDir, rmDir, git, initRepo, linkDir, DIR_LINKS_SUPPORTED,
} from "./helpers.js";

/**
 * THE CONTROLLED TOOL BRIDGE, UNDER ATTACK.
 *
 * The bridge is the only route from an untrusted agent to a repository, so
 * almost every test here is an attempt to get through it: traversal, absolute
 * paths, junction escapes, forged authority, budget evasion, protocol abuse.
 *
 * These drive the bridge directly rather than through a child process, so each
 * attack is a couple of lines and there can be many of them. The end-to-end
 * proof that a REAL hostile child gets the same answers lives in
 * claudeAdapter.test.ts.
 */

let parent: string;
let repo: string;
let store: ProjectStore;
let journal: ActivityJournal;
let cancellation: CancellationToken;

const RUN = "run_bridge";
const CAPS: Capability[] = ["repo.read", "repo.metadata.read", "repo.file.write", "repo.file.delete"];

function buildSession(over: Partial<Parameters<typeof issueGrant>[0]> = {}): {
  session: ImplementationSession;
  grant: ImplementationGrant;
} {
  const grant = store.saveGrant(
    issueGrant({
      projectId: "proj", runId: RUN, approvalId: "apr_1", approvedBy: "owner",
      allowedScope: ["src/"], capabilities: CAPS, ...over,
    }),
  );
  const boundary = FsBoundary.create(repo);
  const session = new ImplementationSession(
    grant,
    new SafeFs(boundary, DEFAULT_LIMITS),
    new SafeWriteFs(boundary, DEFAULT_LIMITS),
    journal,
    cancellation,
    () => new Date(),
    // The same store-backed authority the runner supplies in production.
    new StoredGrantAuthority(store, grant, store.grantClaimId("proj", grant.grantId)),
  );
  return { session, grant };
}

const bridgeFor = (over: Partial<Parameters<typeof issueGrant>[0]> = {}) => {
  const { session, grant } = buildSession(over);
  return { bridge: new ToolBridge({ session, cancellation, journal }), session, grant };
};

let counter = 0;
const req = (tool: string, args: unknown) => ({
  requestId: `r${(counter += 1)}`, tool, arguments: args,
});

const exists = (rel: string) => fs.existsSync(path.join(repo, rel));

beforeEach(() => {
  parent = tmpDir("orch-bridge-");
  repo = path.join(parent, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "existing.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "outside-scope.ts"), "not yours\n");
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=SUPER_SECRET_VALUE\n");
  fs.mkdirSync(path.join(parent, "outside"), { recursive: true });
  fs.writeFileSync(path.join(parent, "outside", "victim.txt"), "HOST SECRET\n");

  store = new ProjectStore(path.join(parent, "projects"));
  store.createProject({
    id: "proj", name: "Proj", workingDir: repo,
    repoRoot: null, repo: null, checks: [], constraints: [], contextFiles: [],
  });
  journal = new ActivityJournal(store.activityFile("proj", RUN));
  cancellation = new CancellationToken();
});

afterEach(() => rmDir(parent));

// ===========================================================================
describe("the protocol is the whole vocabulary", () => {
  it("exposes exactly four operations", () => {
    expect([...ToolName.options].sort()).toEqual([
      "delete_file", "list_directory", "read_file", "write_file",
    ]);
  });

  it("has NO tool that could execute anything", async () => {
    const { bridge } = bridgeFor();
    for (const tool of [
      "execute", "command", "terminal", "run", "bash", "powershell", "sh",
      "spawn", "eval", "script", "python", "node", "exec", "shell",
      "git_commit", "git_push", "git_add", "git_checkout",
      "fetch", "http", "https", "socket", "network",
      "github_pr", "deploy",
    ]) {
      const response = await bridge.handle(req(tool, {}));
      expect(response.ok, `${tool} must not exist`).toBe(false);
      expect(response.error?.code).toBe("unknown_tool");
    }
  });

  it("contains no filesystem or process import", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "implementation", "toolBridge.ts"),
      "utf8",
    );
    // The regression this guards: replacing a handler with a direct fs call
    // would bypass grant, capability, scope, sensitivity, budget and journal
    // all at once, and would not look obviously wrong.
    expect(source).not.toMatch(/from "node:fs"/);
    expect(source).not.toMatch(/from "node:child_process"/);
    expect(source).not.toMatch(/\b(readFileSync|writeFileSync|unlinkSync|rmSync|spawn|exec)\s*\(/);
  });
});

// ===========================================================================
describe("authority cannot be supplied by the agent", () => {
  const FORGERIES: Record<string, unknown>[] = [
    { grantId: "grn_forged" },
    { projectId: "other-project" },
    { runId: "run_other" },
    { sessionId: "sess_other" },
    { allowedScope: ["."] },
    { capabilities: ["git.mutate", "process.execute"] },
    { workingDir: "/" },
    { maxWrites: 999999 },
    { maxWriteBytes: 999999999 },
    { approvedBy: "the-agent" },
    { approvalId: "apr_forged" },
    { fingerprint: "deadbeef" },
  ];

  for (const forgery of FORGERIES) {
    const field = Object.keys(forgery)[0]!;
    it(`rejects a request carrying "${field}"`, async () => {
      const { bridge } = bridgeFor({ allowedScope: ["src/"] });
      const response = await bridge.handle({
        ...req("read_file", { path: "src/existing.ts" }),
        ...forgery,
      });
      // Not "ignored" - refused. The schema is strict, so authority fields are
      // not representable rather than merely untrusted.
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("invalid_request");
    });
  }

  it("rejects forged authority inside the arguments object too", async () => {
    const { bridge } = bridgeFor();
    const response = await bridge.handle(
      req("read_file", { path: "src/existing.ts", grantId: "grn_forged", scope: ["."] }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("invalid_arguments");
  });

  it("uses ITS OWN session regardless of what the agent sends", async () => {
    // Two live sessions with different scopes. A request handled by bridge A
    // must be decided by session A, whatever it claims to be.
    const a = bridgeFor({ allowedScope: ["src/"] });
    const b = bridgeFor({ allowedScope: ["."], approvalId: "apr_2" });
    void b;

    const denied = await a.bridge.handle(req("write_file", {
      path: "outside-scope.ts", contents: "x",
    }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("out_of_scope");
    expect(fs.readFileSync(path.join(repo, "outside-scope.ts"), "utf8")).toBe("not yours\n");
  });
});

// ===========================================================================
describe("path security", () => {
  const ESCAPES = [
    "../outside/victim.txt",
    "../../outside/victim.txt",
    "src/../../outside/victim.txt",
    "src/../../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "\\\\server\\share\\secret.txt",
    "..",
    "src/..",
    "./../outside/victim.txt",
  ];

  for (const target of ESCAPES) {
    it(`refuses to READ "${target}"`, async () => {
      const { bridge } = bridgeFor({ allowedScope: ["."] });
      const response = await bridge.handle(req("read_file", { path: target }));
      expect(response.ok).toBe(false);
      // Whatever the reason, no content ever comes back.
      expect(JSON.stringify(response)).not.toContain("HOST SECRET");
    });

    it(`refuses to WRITE "${target}"`, async () => {
      const { bridge } = bridgeFor({ allowedScope: ["."] });
      const response = await bridge.handle(req("write_file", { path: target, contents: "PWNED" }));
      expect(response.ok).toBe(false);
      expect(fs.readFileSync(path.join(parent, "outside", "victim.txt"), "utf8"))
        .toBe("HOST SECRET\n");
    });
  }

  it("refuses a prefix collision", async () => {
    fs.mkdirSync(path.join(repo, "src-generated"), { recursive: true });
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(
      req("write_file", { path: "src-generated/x.ts", contents: "x" }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("out_of_scope");
    expect(exists("src-generated/x.ts")).toBe(false);
  });

  it("refuses a path into the orchestrator's own store", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const relative = path.relative(repo, store.root).split(path.sep).join("/");
    const response = await bridge.handle(
      req("write_file", { path: `${relative}/proj/project.json`, contents: "{}" }),
    );
    expect(response.ok).toBe(false);
  });

  it("refuses an absurdly long path before doing any work", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(
      req("read_file", { path: "a/".repeat(PROTOCOL_LIMITS.maxPathLength) }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("invalid_arguments");
  });

  it("refuses a NUL byte in a path", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(
      req("write_file", { path: "src/a.ts\u0000.png", contents: "x" }),
    );
    expect(response.ok).toBe(false);
  });
});

describe.skipIf(!DIR_LINKS_SUPPORTED)("link escapes", () => {
  beforeEach(() => {
    expect(linkDir(path.join(parent, "outside"), path.join(repo, "src", "escape"))).toBe(true);
  });

  it("refuses to read through an escaping junction", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(req("read_file", { path: "src/escape/victim.txt" }));
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain("HOST SECRET");
  });

  it("refuses to write through an escaping junction", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(
      req("write_file", { path: "src/escape/victim.txt", contents: "PWNED" }),
    );
    expect(response.ok).toBe(false);
    expect(fs.readFileSync(path.join(parent, "outside", "victim.txt"), "utf8"))
      .toBe("HOST SECRET\n");
  });

  it("refuses to delete through an escaping junction", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(req("delete_file", { path: "src/escape/victim.txt" }));
    expect(response.ok).toBe(false);
    expect(fs.existsSync(path.join(parent, "outside", "victim.txt"))).toBe(true);
  });

  it("refuses to CREATE a new file through an escaping junction", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(
      req("write_file", { path: "src/escape/planted.txt", contents: "x" }),
    );
    expect(response.ok).toBe(false);
    expect(fs.existsSync(path.join(parent, "outside", "planted.txt"))).toBe(false);
  });
});

// ===========================================================================
describe("sensitive files", () => {
  it("never returns a secret's contents", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(req("read_file", { path: ".env" }));

    expect(JSON.stringify(response)).not.toContain("SUPER_SECRET_VALUE");
    if (response.ok) {
      // Reachable in scope, but content is withheld rather than returned.
      const result = response.result as { available: boolean; contents: string | null };
      expect(result.available).toBe(false);
      expect(result.contents).toBeNull();
    }
  });

  it("refuses to write a sensitive file", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(
      req("write_file", { path: ".env.production", contents: "TOKEN=planted" }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("sensitive_path");
    expect(exists(".env.production")).toBe(false);
  });

  it("refuses to delete a sensitive file", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(req("delete_file", { path: ".env" }));
    expect(response.ok).toBe(false);
    expect(exists(".env")).toBe(true);
  });

  it("does not leak a secret into the activity journal", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    await bridge.handle(req("read_file", { path: ".env" }));
    await bridge.handle(req("write_file", { path: ".env", contents: "TOKEN=ANOTHER_SECRET" }));

    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain("SUPER_SECRET_VALUE");
    expect(raw).not.toContain("ANOTHER_SECRET");
  });

  it("still reports a sensitive file's EXISTENCE in a listing, without contents", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(req("list_directory", { path: "." }));
    expect(response.ok).toBe(true);
    const entries = (response.result as { entries: { path: string; sensitive: boolean }[] }).entries;
    const env = entries.find((e) => e.path === ".env");
    expect(env?.sensitive).toBe(true);
    expect(JSON.stringify(response)).not.toContain("SUPER_SECRET_VALUE");
  });
});

// ===========================================================================
describe("capability enforcement", () => {
  it("denies a write when the grant omits the capability", async () => {
    const { bridge } = bridgeFor({
      capabilities: ["repo.read", "repo.metadata.read"] as Capability[],
    });
    const response = await bridge.handle(
      req("write_file", { path: "src/x.ts", contents: "x" }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("capability_not_granted");
    expect(exists("src/x.ts")).toBe(false);
  });

  it("denies a delete when the grant omits the capability", async () => {
    const { bridge } = bridgeFor({
      capabilities: ["repo.read", "repo.metadata.read", "repo.file.write"] as Capability[],
    });
    const response = await bridge.handle(req("delete_file", { path: "src/existing.ts" }));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("capability_not_granted");
    expect(exists("src/existing.ts")).toBe(true);
  });

  it("denies a read when the grant omits the capability", async () => {
    const { bridge } = bridgeFor({ capabilities: ["repo.metadata.read"] as Capability[] });
    const response = await bridge.handle(req("read_file", { path: "src/existing.ts" }));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("capability_not_granted");
  });
});

// ===========================================================================
describe("mutation budget", () => {
  it("allows exactly the budgeted number of mutations, and no more", async () => {
    const { bridge } = bridgeFor({ maxWrites: 3 });
    for (let i = 0; i < 3; i += 1) {
      const ok = await bridge.handle(req("write_file", { path: `src/f${i}.ts`, contents: "x" }));
      expect(ok.ok, `write ${i} should be allowed`).toBe(true);
    }
    const beyond = await bridge.handle(req("write_file", { path: "src/f3.ts", contents: "x" }));
    expect(beyond.ok).toBe(false);
    expect(beyond.error?.code).toBe("write_budget_exhausted");
    expect(exists("src/f3.ts")).toBe(false);
  });

  it("counts deletes against the same budget", async () => {
    const { bridge } = bridgeFor({ maxWrites: 2 });
    expect((await bridge.handle(req("write_file", { path: "src/a.ts", contents: "x" }))).ok).toBe(true);
    expect((await bridge.handle(req("delete_file", { path: "src/a.ts" }))).ok).toBe(true);
    const third = await bridge.handle(req("write_file", { path: "src/b.ts", contents: "x" }));
    expect(third.ok).toBe(false);
    expect(exists("src/b.ts")).toBe(false);
  });

  it("allows a file EXACTLY at the byte ceiling and refuses one byte more", async () => {
    const { bridge } = bridgeFor({ maxWriteBytes: 64 });
    const atLimit = await bridge.handle(
      req("write_file", { path: "src/at.ts", contents: "x".repeat(64) }),
    );
    expect(atLimit.ok).toBe(true);

    const overLimit = await bridge.handle(
      req("write_file", { path: "src/over.ts", contents: "x".repeat(65) }),
    );
    expect(overLimit.ok).toBe(false);
    expect(overLimit.error?.code).toBe("file_too_large");
    expect(exists("src/over.ts")).toBe(false);
  });

  it("reports the budget but gives the agent no way to change it", async () => {
    const { bridge } = bridgeFor({ maxWrites: 5 });
    const response = await bridge.handle(
      req("write_file", { path: "src/a.ts", contents: "x" }),
    );
    const result = response.result as { mutationsUsed: number; mutationsAllowed: number };
    expect(result.mutationsUsed).toBe(1);
    expect(result.mutationsAllowed).toBe(5);

    // Every route to raising it is refused by the strict schema.
    for (const attempt of [{ maxWrites: 500 }, { mutationsAllowed: 500 }]) {
      const forged = await bridge.handle({
        ...req("write_file", { path: "src/b.ts", contents: "x" }), ...attempt,
      });
      expect(forged.ok).toBe(false);
    }
  });
});

// ===========================================================================
describe("protocol hardening", () => {
  it("survives malformed JSON", async () => {
    const { bridge } = bridgeFor();
    for (const raw of ["{", "", "not json", "[1,2,3", '{"a":'] ) {
      const response = await bridge.handleRaw(raw);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("malformed_json");
    }
  });

  it("rejects structurally invalid requests without throwing", async () => {
    const { bridge } = bridgeFor();
    for (const raw of [
      null, 42, "a string", [], {},
      { tool: "read_file" },                       // no requestId
      { requestId: "", tool: "read_file" },        // empty id
      { requestId: "r", tool: 42 },                // wrong type
      { requestId: "r" },                          // no tool
      { requestId: "x".repeat(500), tool: "read_file", arguments: { path: "a" } },
    ]) {
      const response = await bridge.handle(raw);
      expect(response.ok).toBe(false);
      expect(response.error).not.toBeNull();
    }
  });

  it("rejects wrong argument types", async () => {
    const { bridge } = bridgeFor();
    for (const args of [
      { path: 42 }, { path: null }, { path: ["a"] }, { path: {} },
      { path: "src/a.ts", contents: 42 },
      { path: "src/a.ts", contents: null },
    ]) {
      const response = await bridge.handle(req("write_file", args));
      expect(response.ok).toBe(false);
    }
  });

  it("rejects a duplicate request id", async () => {
    const { bridge } = bridgeFor();
    const request = { requestId: "same", tool: "read_file", arguments: { path: "src/existing.ts" } };
    expect((await bridge.handle(request)).ok).toBe(true);

    const replay = await bridge.handle(request);
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("duplicate_request_id");
  });

  it("rejects a replayed id even for a DIFFERENT operation", async () => {
    const { bridge } = bridgeFor();
    await bridge.handle({ requestId: "id1", tool: "read_file", arguments: { path: "src/existing.ts" } });
    const sneaky = await bridge.handle({
      requestId: "id1", tool: "write_file", arguments: { path: "src/new.ts", contents: "x" },
    });
    expect(sneaky.ok).toBe(false);
    expect(exists("src/new.ts")).toBe(false);
  });

  it("refuses oversized content before touching the filesystem", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const response = await bridge.handle(
      req("write_file", {
        path: "src/huge.ts",
        contents: "x".repeat(PROTOCOL_LIMITS.maxContentBytes + 1),
      }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("invalid_arguments");
    expect(exists("src/huge.ts")).toBe(false);
  });

  it("caps the number of requests one session may make", async () => {
    const { session } = buildSession();
    const bridge = new ToolBridge({ session, cancellation, journal, limits: { maxRequests: 3 } });
    for (let i = 0; i < 3; i += 1) {
      await bridge.handle(req("list_directory", { path: "." }));
    }
    const beyond = await bridge.handle(req("list_directory", { path: "." }));
    expect(beyond.ok).toBe(false);
    expect(beyond.error?.code).toBe("too_many_requests");
  });

  it("bounds what a read can return", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    fs.writeFileSync(path.join(repo, "src", "big.ts"), "y".repeat(400 * 1024));
    const response = await bridge.handle(req("read_file", { path: "src/big.ts" }));
    if (response.ok) {
      const result = response.result as { contents: string | null };
      expect((result.contents ?? "").length).toBeLessThanOrEqual(PROTOCOL_LIMITS.maxReadBytes);
    }
  });

  it("never returns an absolute host path in a response", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["."] });
    const responses = [
      await bridge.handle(req("read_file", { path: "src/existing.ts" })),
      await bridge.handle(req("list_directory", { path: "src" })),
      await bridge.handle(req("write_file", { path: "src/n.ts", contents: "x" })),
    ];
    for (const response of responses) {
      const text = JSON.stringify(response);
      expect(text).not.toContain(repo);
      expect(text).not.toContain(parent);
    }
  });

  it("keeps error messages free of paths, grant ids and limits", async () => {
    const { bridge, grant } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(
      req("write_file", { path: "../outside/victim.txt", contents: "x" }),
    );
    expect(response.ok).toBe(false);
    const message = response.error?.message ?? "";
    expect(message).not.toContain(grant.grantId);
    expect(message).not.toContain(repo);
    expect(message).not.toContain(parent);
    // The refusal names a category, not the path that was attempted.
    expect(message).not.toContain("victim.txt");
  });
});

// ===========================================================================
describe("cancellation and grant lifecycle", () => {
  it("refuses every request after cancellation", async () => {
    const { bridge } = bridgeFor();
    expect((await bridge.handle(req("write_file", { path: "src/before.ts", contents: "x" }))).ok)
      .toBe(true);

    cancellation.cancel("human stopped it");

    for (const tool of ["read_file", "list_directory", "write_file", "delete_file"]) {
      const response = await bridge.handle(
        req(tool, { path: "src/after.ts", contents: "x" }),
      );
      expect(response.ok, `${tool} after cancellation`).toBe(false);
      expect(response.error?.code).toBe("cancelled");
    }
    expect(exists("src/after.ts")).toBe(false);
    // No rollback: work done before cancellation stands.
    expect(exists("src/before.ts")).toBe(true);
  });

  it("refuses everything once the bridge is closed", async () => {
    const { bridge } = bridgeFor();
    bridge.close();
    const response = await bridge.handle(req("write_file", { path: "src/x.ts", contents: "x" }));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("session_closed");
    expect(exists("src/x.ts")).toBe(false);
  });

  it("stops working the moment the grant is CONSUMED mid-session", async () => {
    // The strongest per-invocation test: the session was valid when built, and
    // the grant is spent underneath it while it is still in use.
    const { bridge, grant } = bridgeFor();
    expect((await bridge.handle(req("write_file", { path: "src/one.ts", contents: "x" }))).ok)
      .toBe(true);

    expect(store.claimGrant("proj", grant.grantId)).not.toBeNull();

    const after = await bridge.handle(req("write_file", { path: "src/two.ts", contents: "x" }));
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe("consumed");
    expect(exists("src/two.ts")).toBe(false);
  });

  it("stops working when the grant EXPIRES mid-session", async () => {
    const { session } = buildSession({
      lifetimeMs: 1000, now: new Date(Date.now() - 60_000),
    });
    const bridge = new ToolBridge({ session, cancellation, journal });
    const response = await bridge.handle(req("write_file", { path: "src/x.ts", contents: "x" }));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("expired");
    expect(exists("src/x.ts")).toBe(false);
  });

  it("gives the agent no way to obtain, clone or revive a grant", async () => {
    const { bridge, grant } = bridgeFor();
    store.claimGrant("proj", grant.grantId);

    for (const attempt of [
      req("write_file", { path: "src/x.ts", contents: "x" }),
      { ...req("write_file", { path: "src/x.ts", contents: "x" }), grantId: "grn_new" },
      { ...req("write_file", { path: "src/x.ts", contents: "x" }), status: "active" },
    ]) {
      const response = await bridge.handle(attempt);
      expect(response.ok).toBe(false);
    }
    // Still exactly one grant, still consumed.
    expect(store.listGrants("proj")).toHaveLength(1);
    expect(store.getGrant("proj", grant.grantId)!.status).toBe("consumed");
  });
});

// ===========================================================================
describe("the activity journal is orchestrator-owned", () => {
  it("records both completions and refusals", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    await bridge.handle(req("write_file", { path: "src/ok.ts", contents: "x" }));
    await bridge.handle(req("write_file", { path: "outside-scope.ts", contents: "x" }));
    await bridge.handle(req("nonsense", {}));

    const types = new ActivityJournal(store.activityFile("proj", RUN))
      .read().map((r) => r.type);
    expect(types).toContain("bridge_request_completed");
    expect(types).toContain("bridge_request_rejected");
    // The session's own denial record is still produced.
    expect(types).toContain("write_denied");
  });

  it("records a refusal the agent would never mention", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    await bridge.handle(req("delete_file", { path: "outside-scope.ts" }));

    const denied = new ActivityJournal(store.activityFile("proj", RUN))
      .read().filter((r) => r.type === "bridge_request_completed") as
      { ok: boolean; denial: string | null }[];
    expect(denied.some((r) => !r.ok && r.denial === "out_of_scope")).toBe(true);
  });

  it("logs no file contents", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const secret = "BRIDGE_CONTENT_SECRET_xyz";
    await bridge.handle(req("write_file", { path: "src/s.ts", contents: `const s="${secret}";` }));

    const raw = fs.readFileSync(store.activityFile("proj", RUN), "utf8");
    expect(raw).not.toContain(secret);
  });

  it("gives the bridge no method an agent could use to write the journal", () => {
    const surface = Object.getOwnPropertyNames(ToolBridge.prototype);
    for (const forbidden of ["append", "log", "record", "journal", "emit"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
describe("independent verification still decides what changed", () => {
  it("attributes what the bridge actually did, not what an agent claims", async () => {
    const inspector = new LocalGitRepositoryInspector({ workingDir: repo });
    const verifier = new RepositoryVerifier(inspector);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await verifier.captureBaseline();

    const { bridge, grant } = bridgeFor({ allowedScope: ["src/"] });
    await bridge.handle(req("write_file", { path: "src/real.ts", contents: "real\n" }));
    await bridge.handle(req("write_file", { path: "outside-scope.ts", contents: "denied\n" }));

    const verified = await verifier.verify({
      runId: RUN,
      // The agent's fabrication.
      claimedSummary: "I created src/imaginary.ts and updated everything.",
      claimedFiles: ["src/imaginary.ts"],
      baseline,
      allowedScope: grant.allowedScope,
    });

    expect(verified.report.observedFiles).toContain("src/real.ts");
    expect(verified.report.observedFiles).not.toContain("src/imaginary.ts");
    expect(verified.evidence.claims.claimedButNotObserved).toContain("src/imaginary.ts");
    // The denied write never reached the repository at all.
    expect(verified.evidence.attribution.attributable).not.toContain("outside-scope.ts");
  });

  it("a successful tool response is not verification", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(
      req("write_file", { path: "src/done.ts", contents: "x" }),
    );
    expect(response.ok).toBe(true);
    // The response says the orchestrator performed a write. It says nothing
    // about whether the task is complete, correct, or in scope overall - those
    // remain questions for Phase 3 attribution and the human review gate.
    expect(Object.keys(response.result as object)).not.toContain("verified");
    expect(Object.keys(response.result as object)).not.toContain("testsPassed");
  });
});

// ===========================================================================
describe("legitimate work still functions", () => {
  it("reads, lists, writes and deletes inside the approved scope", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });

    const read = await bridge.handle(req("read_file", { path: "src/existing.ts" }));
    expect(read.ok).toBe(true);
    expect((read.result as { contents: string }).contents).toContain("export const a");

    const list = await bridge.handle(req("list_directory", { path: "src" }));
    expect(list.ok).toBe(true);

    const write = await bridge.handle(
      req("write_file", { path: "src/created.ts", contents: "export const b = 2;\n" }),
    );
    expect(write.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "src", "created.ts"), "utf8")).toContain("const b");

    const remove = await bridge.handle(req("delete_file", { path: "src/created.ts" }));
    expect(remove.ok).toBe(true);
    expect(exists("src/created.ts")).toBe(false);
  });

  it("creates intermediate directories inside the scope", async () => {
    const { bridge } = bridgeFor({ allowedScope: ["src/"] });
    const response = await bridge.handle(
      req("write_file", { path: "src/deep/nested/x.ts", contents: "x" }),
    );
    expect(response.ok).toBe(true);
    expect(exists("src/deep/nested/x.ts")).toBe(true);
  });
});
