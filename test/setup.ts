// The suite asserts on human-readable output, so it must not inherit whatever the ambient
// environment does about color. picocolors treats `"CI" in env` as "color supported" even when
// stdout is a pipe, so on GitHub Actions every dimmed hint and +N/-N count arrives wrapped in
// SGR codes and any plain-text assertion breaks — while the same run passes locally.
//
// Pin it off here, in a preload that runs before any test file imports picocolors. Tests that
// need to prove color still works (`test/output-flags.test.ts`) spawn the CLI with an env they
// control explicitly.
process.env.NO_COLOR ??= "1";
