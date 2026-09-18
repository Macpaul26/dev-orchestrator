import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  LineSource, ProtocolClient, SessionPayload, describeResponse, type RequestChannel,
} from "../src/bridge/protocolClient.js";
import { ToolRequest, ToolResponse } from "../src/domain/toolProtocol.js";

/**
 * THE CLAUDE CODE BRIDGE - the child's side of the protocol, without Claude.
 *
 * The bridge is the executable the orchestrator launches. What is tested here
 * is the half that can be tested deterministically: that it speaks the
 * protocol exactly, that it cannot ask for anything the protocol does not
 * offer, and that it holds no authority. The Claude Code half is exercised by
 * a real run, on purpose - a fake would prove nothing about the real binary.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function harness(runId = "run_test") {
  const sent: string[] = [];
  const channel: RequestChannel = { send: (line) => { sent.push(line); } };
  const stdin = new PassThrough();
  const client = new ProtocolClient(channel, new LineSource(stdin), runId);
  const respond = (response: unknown): void => { stdin.write(`${JSON.stringify(response)}\n`); };
  return { sent, stdin, client, respond };
}

describe("the bridge speaks the protocol exactly", () => {
  it("sends a valid ToolRequest per call and correlates the response by requestId", async () => {
    const h = harness();
    const pending = h.client.readFile("src/a.ts");
    expect(h.sent).toHaveLength(1);
    const request = ToolRequest.parse(JSON.parse(h.sent[0]!));
    expect(request.tool).toBe("read_file");
    expect(request.arguments).toEqual({ path: "src/a.ts" });
    // A response for a DIFFERENT request id is ignored, not misattributed.
    h.respond({ requestId: "someone-else", ok: true, result: { kind: "read_file", path: "x", available: true, contents: "nope" } });
    h.respond({ requestId: request.requestId, ok: true, result: { kind: "read_file", path: "src/a.ts", available: true, contents: "export const a = 1;" } });
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(describeResponse(response).text).toBe("export const a = 1;");
    h.client.close();
  });

  it("records a mutation only when the orchestrator said OK", async () => {
    const h = harness();
    const denied = h.client.writeFile("secret/.env", "x");
    const [first] = h.sent.map((l) => ToolRequest.parse(JSON.parse(l)));
    h.respond({ requestId: first!.requestId, ok: false, error: { code: "out_of_scope", message: "outside the approved scope" } });
    const d = await denied;
    expect(d.ok).toBe(false);
    expect(describeResponse(d)).toEqual({ text: "DENIED (out_of_scope): outside the approved scope", isError: true });
    expect(h.client.mutated).toEqual([]);

    const allowed = h.client.writeFile("src/a.ts", "export const a = 2;");
    const second = ToolRequest.parse(JSON.parse(h.sent[1]!));
    h.respond({ requestId: second.requestId, ok: true, result: { kind: "write_file", path: "src/a.ts", bytes: 19, created: false, mutationsUsed: 1, mutationsAllowed: 200 } });
    expect((await allowed).ok).toBe(true);
    expect(h.client.mutated).toEqual(["src/a.ts"]);
    h.client.close();
  });

  it("can only ask for the four protocol tools - the type and the schema both refuse anything else", () => {
    expect(() => ToolRequest.parse({ requestId: "r", tool: "execute", arguments: {} })).toThrow();
    expect(() => ToolRequest.parse({ requestId: "r", tool: "read_file", arguments: {}, grantId: "grn_x" })).toThrow();
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "bridge", "protocolClient.ts"), "utf8");
    for (const forbidden of ['"execute"', '"shell"', '"git"', "child_process", "spawn(", "exec("]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("parses the session payload and refuses one that names another protocol", () => {
    const ok = SessionPayload.parse({
      protocol: "orchestrator.implementation.v1", runId: "r", projectId: "p", grantId: "g",
      instruction: "do it", allowedScope: ["src"], capabilities: ["repo.read"],
    });
    expect(ok.planSummary).toBe("");
    expect(() => SessionPayload.parse({ protocol: "v2", runId: "r", projectId: "p", grantId: "g", instruction: "x" })).toThrow();
  });

  it("renders a withheld file as an error, not as empty content", () => {
    const withheld = ToolResponse.parse({
      requestId: "r", ok: true,
      result: { kind: "read_file", path: ".env", available: false, withheldReason: "sensitive" },
    });
    expect(describeResponse(withheld)).toEqual({ text: 'File ".env" is not available: sensitive', isError: true });
  });
});

describe("the bridge holds no authority", () => {
  it("imports nothing from the grant, approval, store, registry, session or security layers", () => {
    const dir = path.join(__dirname, "..", "src", "bridge");
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const forbidden of [
        "domain/grant.js", "domain/approval.js", "domain/capability.js",
        "/projects/", "/tools/", "/implementation/", "/security/", "/graph/", "/experience/",
        "/models/", "/adapters/", "node:fs", "node:child_process",
      ]) {
        for (const specifier of specifiers) {
          // protocolClient uses node:fs for ONE thing: writing to fd 3.
          if (forbidden === "node:fs" && name === "protocolClient.ts") continue;
          expect(specifier, `${name} must not import ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
    // And the only fs use in the client is the fd-3 write.
    const client = fs.readFileSync(path.join(dir, "protocolClient.ts"), "utf8");
    expect(client.match(/fs\.\w+/g)).toEqual(["fs.writeSync"]);
  });

  it("disallows every built-in Claude Code tool and allows only the four orchestrator tools", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "bridge", "claudeBridge.ts"), "utf8");
    for (const builtin of ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent"]) {
      expect(source, `${builtin} must be disallowed`).toMatch(new RegExp(`DISALLOWED_BUILTINS[^;]*"${builtin}"`, "s"));
    }
    expect(source).toContain("settingSources: []");
    expect(source).toContain('permissionMode: "default"');
    expect(source).toMatch(/behavior: "deny"/);
    expect(source).not.toContain("bypassPermissions");
    expect(source).not.toContain("acceptEdits");
  });

  it("is not imported by any production module - the orchestrator launches it as a process, never as code", () => {
    const root = path.resolve(__dirname, "..", "src");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts") || full.includes(path.join("src", "bridge"))) continue;
        // IMPORT SPECIFIERS, not prose: the CLI's help text names the bridge's
        // path, which is documentation, not a dependency.
        const specifiers = [...fs.readFileSync(full, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
        if (specifiers.some((sp) => sp.includes("/bridge/"))) importers.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(importers).toEqual([]);
  });
});
