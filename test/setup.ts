// The suite asserts on human-readable output, so it must not inherit whatever the ambient
// environment does about color. picocolors treats `"CI" in env` as "color supported" even when
// stdout is a pipe, so on GitHub Actions every dimmed hint and +N/-N count arrives wrapped in
// SGR codes and any plain-text assertion breaks — while the same run passes locally.
//
// Pin it off here, in a preload that runs before any test file imports picocolors. Tests that
// need to prove color still works (`test/output-flags.test.ts`) spawn the CLI with an env they
// control explicitly.
process.env.NO_COLOR ??= "1";

// Escape hatches that change what the suite observes: `AGENTSW_DEBUG` puts an upstream failure's
// private reason into stderr, where the warnings assertions live, and the timeout override is
// read by the test that pins the default budget. Drop both so the run cannot depend on a
// developer's shell; the test that proves debug output works sets the variable itself.
delete process.env.AGENTSW_DEBUG;
delete process.env.AGENTSW_GATEWAY_TIMEOUT_MS;
