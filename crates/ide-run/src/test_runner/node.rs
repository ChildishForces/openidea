//! Which test runner a package.json script or deno task runs.

use serde_json::Value as Json;
use std::path::Path;

/// How a script's runner was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Found {
    /// The script (or a script it runs) calls the runner; `watch` when it never exits on its own.
    Script { watch: bool },
    /// The script names no runner; the package depends on exactly one (or its config file decides).
    Dependency,
}

/// The test runner `scripts[name]` of `pkg` (a package in `dir`) runs, and how that was found.
pub(crate) fn package_runner(pkg: &Json, dir: &Path, name: &str) -> Option<(&'static str, Found)> {
    let scripts = pkg.get("scripts").and_then(Json::as_object);
    let body = scripts.and_then(|s| s.get(name)).and_then(Json::as_str)?;
    match scan(body, &|n| scripts.and_then(|s| s.get(n)).and_then(Json::as_str), 0) {
        Scan::Runner(id, watch) => Some((id, Found::Script { watch })),
        // Turbo, Nx, `npm run test --workspaces`…: each package's own configuration runs its tests.
        Scan::Delegates => None,
        Scan::Nothing => dependency_runner(pkg, dir).map(|id| (id, Found::Dependency)),
    }
}

/// The test runner a deno task runs (`deno test …`), and whether it only watches.
pub(crate) fn deno_task_runner(task: &Json) -> Option<(&'static str, bool)> {
    let body = task.as_str().or_else(|| task.get("command").and_then(Json::as_str))?;
    match scan(body, &|_| None, 0) {
        Scan::Runner(id, watch) => Some((id, watch)),
        _ => None,
    }
}

enum Scan {
    Runner(&'static str, bool),
    Delegates,
    Nothing,
}

const ORCHESTRATORS: &[&str] =
    &["turbo", "nx", "lerna", "npm-run-all", "npm-run-all2", "run-p", "run-s", "concurrently", "wireit", "ultra"];
const WORKSPACE_FLAGS: &[&str] = &["--workspaces", "-ws", "--workspace", "-w", "-r", "--recursive", "--filter", "-F"];

/// The first runner the command line `body` calls; `script` resolves the package's other scripts.
fn scan<'a>(body: &'a str, script: &dyn Fn(&str) -> Option<&'a str>, depth: u8) -> Scan {
    let mut delegates = false;
    for segment in body.split("&&").flat_map(|s| s.split("||")).flat_map(|s| s.split([';', '|'])) {
        let tokens: Vec<&str> = segment.split_whitespace().map(|t| t.trim_matches(['"', '\''])).collect();
        match scan_segment(&tokens, script, depth) {
            Scan::Runner(id, watch) => return Scan::Runner(id, watch),
            Scan::Delegates => delegates = true,
            Scan::Nothing => {}
        }
    }
    if delegates { Scan::Delegates } else { Scan::Nothing }
}

fn is_assignment(token: &str) -> bool {
    token.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with('-')
    })
}

fn has(rest: &[&str], flags: &[&str]) -> bool {
    rest.iter().any(|t| flags.contains(t))
}

fn scan_segment<'a>(tokens: &[&'a str], script: &dyn Fn(&str) -> Option<&'a str>, depth: u8) -> Scan {
    let mut i = 0;
    while let Some(&token) = tokens.get(i) {
        let rest = &tokens[i + 1..];
        let next = rest.first().copied().unwrap_or("");
        // `./node_modules/.bin/jest` is `jest`.
        let program = token.rsplit(['/', '\\']).next().unwrap_or(token);
        match program {
            _ if is_assignment(token) => i += 1,
            "cross-env" | "env" => i += 1,
            "dotenv" => i += rest.iter().position(|t| *t == "--").map_or(tokens.len(), |p| p + 2),
            "npx" | "bunx" | "pnpx" => i += 1 + rest.iter().take_while(|t| t.starts_with('-')).count(),
            "vitest" => {
                let run = next == "run" || has(rest, &["--run"]);
                return Scan::Runner("vitest", !run || has(rest, &["--watch", "-w"]));
            }
            "jest" => return Scan::Runner("jest", has(rest, &["--watch", "--watchAll"])),
            "react-scripts" | "craco" if next == "test" => {
                return Scan::Runner("jest", !has(rest, &["--watchAll=false"]));
            }
            "mocha" | "_mocha" => return Scan::Runner("mocha", has(rest, &["--watch", "-w"])),
            "node" | "tsx" if has(rest, &["--test"]) => {
                return Scan::Runner("node-test", has(rest, &["--watch"]));
            }
            "bun" if next == "test" => return Scan::Runner("bun-test", has(rest, &["--watch"])),
            "deno" if next == "test" => return Scan::Runner("deno-test", has(rest, &["--watch"])),
            "npm" | "pnpm" | "yarn" | "bun" => {
                if matches!(next, "exec" | "dlx" | "x") {
                    i += 2 + rest[1..].iter().take_while(|t| t.starts_with('-')).count();
                    continue;
                }
                let name = match next {
                    "run" | "run-script" => rest.get(1).copied().unwrap_or(""),
                    "test" | "t" | "tst" if program == "npm" => "test",
                    _ if program == "npm" => return Scan::Nothing,
                    other => other,
                };
                if has(rest, WORKSPACE_FLAGS) {
                    return Scan::Delegates;
                }
                match script(name) {
                    Some(body) if depth < 3 => return scan(body, script, depth + 1),
                    Some(_) => return Scan::Nothing,
                    // `pnpm vitest`, `yarn jest`: the package's binary.
                    None => i += 1,
                }
            }
            _ if ORCHESTRATORS.contains(&program) => return Scan::Delegates,
            _ => return Scan::Nothing,
        }
    }
    Scan::Nothing
}

const CONFIG_EXT: &[&str] = &["ts", "mts", "cts", "js", "mjs", "cjs", "json"];

fn has_config(dir: &Path, stems: &[&str]) -> bool {
    stems.iter().any(|stem| CONFIG_EXT.iter().any(|ext| dir.join(format!("{stem}.{ext}")).is_file()))
}

/// The one test framework the package depends on; with several, the one that has a config file.
fn dependency_runner(pkg: &Json, dir: &Path) -> Option<&'static str> {
    let depends = |names: &[&str]| {
        ["devDependencies", "dependencies"]
            .iter()
            .filter_map(|k| pkg.get(*k).and_then(Json::as_object))
            .any(|deps| names.iter().any(|n| deps.contains_key(*n)))
    };
    let candidates: Vec<&'static str> = [
        ("vitest", depends(&["vitest"])),
        ("jest", depends(&["jest", "jest-cli", "@jest/core", "ts-jest"])),
        ("mocha", depends(&["mocha"])),
    ]
    .into_iter()
    .filter_map(|(id, yes)| yes.then_some(id))
    .collect();
    if let [only] = candidates[..] {
        return Some(only);
    }
    let configured: Vec<&'static str> = candidates
        .into_iter()
        .filter(|id| match *id {
            "vitest" => has_config(dir, &["vitest.config", "vitest.workspace"]),
            "jest" => has_config(dir, &["jest.config"]) || pkg.get("jest").is_some(),
            _ => has_config(dir, &[".mocharc"]) || dir.join(".mocharc.yml").is_file() || pkg.get("mocha").is_some(),
        })
        .collect();
    if let [only] = configured[..] { Some(only) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn runner(scripts: Json, name: &str) -> Option<(&'static str, Found)> {
        package_runner(&json!({ "scripts": scripts }), Path::new("/nonexistent"), name)
    }

    fn script(id: &'static str) -> Option<(&'static str, Found)> {
        Some((id, Found::Script { watch: false }))
    }

    #[test]
    fn plain_runner_calls() {
        assert_eq!(runner(json!({ "test": "vitest run" }), "test"), script("vitest"));
        assert_eq!(runner(json!({ "test": "jest" }), "test"), script("jest"));
        assert_eq!(runner(json!({ "test": "mocha 'test/**/*.spec.js'" }), "test"), script("mocha"));
        assert_eq!(runner(json!({ "test": "node --test" }), "test"), script("node-test"));
        assert_eq!(runner(json!({ "test": "tsx --test src" }), "test"), script("node-test"));
        assert_eq!(runner(json!({ "test": "bun test" }), "test"), script("bun-test"));
        assert_eq!(runner(json!({ "test": "./node_modules/.bin/jest --ci" }), "test"), script("jest"));
        assert_eq!(runner(json!({ "test": "node src/index.js" }), "test"), None);
    }

    #[test]
    fn watch_mode() {
        let watch = |id| Some((id, Found::Script { watch: true }));
        assert_eq!(runner(json!({ "t": "vitest" }), "t"), watch("vitest"));
        assert_eq!(runner(json!({ "t": "vitest --run" }), "t"), script("vitest"));
        assert_eq!(runner(json!({ "t": "jest --watchAll" }), "t"), watch("jest"));
        assert_eq!(runner(json!({ "t": "react-scripts test" }), "t"), watch("jest"));
        assert_eq!(runner(json!({ "t": "react-scripts test --watchAll=false" }), "t"), script("jest"));
        assert_eq!(runner(json!({ "t": "node --test --watch" }), "t"), watch("node-test"));
    }

    #[test]
    fn wrappers_and_env_prefixes() {
        assert_eq!(runner(json!({ "test": "OPENIDEA_FAIL=1 vitest run" }), "test"), script("vitest"));
        assert_eq!(runner(json!({ "test": "cross-env NODE_ENV=test jest" }), "test"), script("jest"));
        assert_eq!(runner(json!({ "test": "dotenv -e .env.test -- mocha" }), "test"), script("mocha"));
        assert_eq!(runner(json!({ "test": "npx --yes vitest run" }), "test"), script("vitest"));
        assert_eq!(runner(json!({ "test": "pnpm exec jest" }), "test"), script("jest"));
        assert_eq!(runner(json!({ "test": "pnpm vitest run" }), "test"), script("vitest"));
        assert_eq!(runner(json!({ "test": "tsc --noEmit && vitest run" }), "test"), script("vitest"));
    }

    #[test]
    fn follows_scripts_it_runs() {
        let scripts = json!({ "test": "npm run test:unit", "test:unit": "yarn unit", "unit": "jest" });
        assert_eq!(runner(scripts, "test"), script("jest"));
        assert_eq!(runner(json!({ "ci": "npm test", "test": "bun test" }), "ci"), script("bun-test"));
        // A script running itself does not loop.
        assert_eq!(runner(json!({ "test": "npm run test" }), "test"), None);
    }

    #[test]
    fn delegating_scripts_name_no_runner() {
        let pkg = json!({ "scripts": { "test": "turbo test" }, "devDependencies": { "vitest": "1" } });
        assert_eq!(package_runner(&pkg, Path::new("/nonexistent"), "test"), None);
        let pkg = json!({ "scripts": { "test": "npm run test --workspaces" }, "devDependencies": { "jest": "1" } });
        assert_eq!(package_runner(&pkg, Path::new("/nonexistent"), "test"), None);
    }

    #[test]
    fn falls_back_to_the_one_dependency() {
        let pkg = json!({ "scripts": { "test": "echo run" }, "devDependencies": { "ts-jest": "1" } });
        assert_eq!(package_runner(&pkg, Path::new("/nonexistent"), "test"), Some(("jest", Found::Dependency)));
        let both = json!({ "scripts": { "test": "echo run" }, "devDependencies": { "jest": "1", "vitest": "1" } });
        assert_eq!(package_runner(&both, Path::new("/nonexistent"), "test"), None);
        let keyed = json!({ "scripts": { "test": "x" }, "devDependencies": { "jest": "1", "mocha": "1" }, "jest": {} });
        assert_eq!(package_runner(&keyed, Path::new("/nonexistent"), "test"), Some(("jest", Found::Dependency)));
    }

    #[test]
    fn config_files_break_a_tie() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("vitest.config.mts"), "").unwrap();
        let pkg = json!({ "scripts": { "test": "x" }, "devDependencies": { "jest": "1", "vitest": "1" } });
        assert_eq!(package_runner(&pkg, dir.path(), "test"), Some(("vitest", Found::Dependency)));
    }

    #[test]
    fn deno_tasks() {
        assert_eq!(deno_task_runner(&json!("deno test -A")), Some(("deno-test", false)));
        assert_eq!(deno_task_runner(&json!({ "command": "deno test --watch" })), Some(("deno-test", true)));
        assert_eq!(deno_task_runner(&json!("deno run main.ts")), None);
    }
}
