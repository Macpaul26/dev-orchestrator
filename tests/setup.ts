/**
 * TEST SETUP - KEEP THE SUITE OFF THE NETWORK.
 *
 * `WorkflowRunner` builds a reasoning model from the environment when one is
 * configured, which is correct in production and unacceptable here: on any
 * machine with a real `ANTHROPIC_API_KEY` exported, every workflow test that
 * reaches the `plan` node would make a live, billable model call, and the suite
 * would stop being deterministic without anyone noticing.
 *
 * So the credential is removed before any test runs. Tests that need a model
 * inject `FakeReasoningModel` explicitly; tests that do not get the
 * deterministic zero-scope plan, which is also what an unconfigured production
 * deployment gets.
 *
 * This is a test-environment control, not a security control - it protects the
 * suite from the network, not the system from anything.
 */
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["ORCHESTRATOR_REASONING_MODEL"];
delete process.env["ORCHESTRATOR_REASONING_TIMEOUT_MS"];
