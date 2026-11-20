//! Test runners: the frameworks a test configuration runs, and the files each one accepts.
//!
//! A test configuration names its runner in [`crate::RunExtras::test_runner`]; detection fills
//! it in and the user can change it.

mod junit;
mod node;
pub mod reporter;

pub(crate) use node::{Found, deno_task_runner, package_runner};
use serde::Serialize;
use specta::Type;

/// A test framework the IDE knows how to run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestRunnerInfo {
    /// Stable id stored in configurations, e.g. `vitest`.
    pub id: String,
    pub label: String,
    /// Configuration kinds that can run this framework's tests (e.g. `npm` scripts).
    pub config_kinds: Vec<String>,
    /// Files it runs by default (globs relative to the configuration's module).
    pub test_files: Vec<String>,
}

const JS_KINDS: &[&str] = &["npm", "bun", "deno"];
const JS_EXT: &str = "{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

fn runner(id: &str, label: &str, kinds: &[&str], files: &[&str]) -> TestRunnerInfo {
    TestRunnerInfo {
        id: id.to_owned(),
        label: label.to_owned(),
        config_kinds: kinds.iter().map(|k| (*k).to_owned()).collect(),
        test_files: files.iter().map(|f| f.replace("{ext}", JS_EXT)).collect(),
    }
}

/// The runners built into the IDE, with each framework's default test file patterns.
pub fn builtin() -> Vec<TestRunnerInfo> {
    vec![
        runner("jest", "Jest", JS_KINDS, &["**/__tests__/**/*.{ext}", "**/*.{test,spec}.{ext}"]),
        runner("vitest", "Vitest", JS_KINDS, &["**/*.{test,spec}.{ext}"]),
        runner("mocha", "Mocha", JS_KINDS, &["test/**/*.{ext}", "**/*.{test,spec}.{ext}"]),
        runner(
            "node-test",
            "Node.js test runner",
            JS_KINDS,
            &["**/*{.,-,_}test.{ext}", "**/test-*.{ext}", "**/test/**/*.{ext}"],
        ),
        runner("bun-test", "Bun test", JS_KINDS, &["**/*{.,_}{test,spec}.{ext}"]),
        runner("deno-test", "Deno test", &["deno"], &["**/{*_,*.,}test.{ext}"]),
    ]
}
