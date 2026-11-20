//! The IDE's own test reporters (see `reporters/`): loaded into a test run, they report each test as
//! TeamCity service messages on stdout, which the IDE turns into the test tree and hides from the console.

use crate::RunConfig;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const FILES: [(&str, &str); 3] = [
    ("vitest.mjs", include_str!("reporters/vitest.mjs")),
    ("jest.cjs", include_str!("reporters/jest.cjs")),
    ("node.mjs", include_str!("reporters/node.mjs")),
];

/// How a framework loads the IDE's reporter next to its own.
struct Reporter {
    file: &'static str,
    /// The framework's reporter option: given by the user, their choice wins.
    option: &'static str,
    /// The arguments loading the reporter at `path`, keeping the framework's own console output.
    args: fn(path: &str) -> Vec<String>,
}

const VITEST: Reporter = Reporter {
    file: "vitest.mjs",
    option: "--reporter",
    args: |path| vec!["--includeTaskLocation".into(), "--reporter=default".into(), format!("--reporter={path}")],
};
const JEST: Reporter = Reporter {
    file: "jest.cjs",
    option: "--reporters",
    args: |path| vec!["--testLocationInResults".into(), "--reporters=default".into(), format!("--reporters={path}")],
};
// Any `--test-reporter` replaces Node's default, so `spec` is named too; each needs a destination.
const NODE_TEST: Reporter = Reporter {
    file: "node.mjs",
    option: "--test-reporter",
    args: |path| {
        let stdout = "--test-reporter-destination=stdout".to_owned();
        vec!["--test-reporter=spec".into(), stdout.clone(), format!("--test-reporter={path}"), stdout]
    },
};

/// The reporter a run of `config` loads: test runs of a framework that has one, through a
/// `package.json` script, with their output in the console (a terminal would show the messages).
fn reporter_for(config: &RunConfig) -> Option<&'static Reporter> {
    if !config.is_test || config.extras.emulate_terminal || !matches!(config.kind.as_str(), "npm" | "bun") {
        return None;
    }
    let reporter = match config.extras.test_runner.as_deref()? {
        "vitest" => &VITEST,
        "jest" => &JEST,
        "node-test" => &NODE_TEST,
        _ => return None,
    };
    let chosen = config.args.iter().any(|a| a == reporter.option || a.starts_with(&format!("{}=", reporter.option)));
    (!chosen).then_some(reporter)
}

/// A JUnit report the framework writes when the run ends (`bun test` has no reporter API): the run turns
/// it into the IDE's test messages then.
#[derive(Clone, Debug)]
pub struct EndReport {
    path: PathBuf,
    /// The run's directory: the report's paths are relative to it.
    dir: PathBuf,
    /// The run's name filter (`-t`): the report lists the tests it left out as skipped.
    filter: Option<String>,
}

impl EndReport {
    /// The report as test messages for stdout, removing the file; `None` when the run wrote no report.
    pub fn take(&self) -> Option<String> {
        let xml = std::fs::read_to_string(&self.path).ok()?;
        let _ = std::fs::remove_file(&self.path);
        let filter = self.filter.as_deref().and_then(|f| regex_lite::Regex::new(f).ok());
        let selected = |name: &str| filter.as_ref().is_none_or(|f| f.is_match(name));
        super::junit::messages(&xml, &self.dir, &selected)
    }
}

/// `bun test`'s `-t` / `--test-name-pattern` value.
fn name_filter(args: &[String]) -> Option<String> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "-t" || arg == "--test-name-pattern" {
            return args.next().cloned();
        }
        if let Some(value) = arg.strip_prefix("--test-name-pattern=").or_else(|| arg.strip_prefix("-t=")) {
            return Some(value.to_owned());
        }
    }
    None
}

/// Writes the reporter files under `dir` (unchanged files stay).
fn install(dir: &Path) -> io::Result<()> {
    for (name, text) in FILES {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).is_ok_and(|current| current == text) {
            continue;
        }
        std::fs::create_dir_all(dir)?;
        std::fs::write(&path, text)?;
    }
    Ok(())
}

/// Loads the IDE's reporter for `config`'s test runner, installed under `dir`, into the run; the
/// framework's own reporter keeps printing the console output. `bun test` writes a JUnit report instead
/// (in `dir`), returned to be read when the run, in `run_dir`, ends.
pub fn add(config: &mut RunConfig, dir: &Path, run_dir: &Path) -> io::Result<Option<EndReport>> {
    if let Some(report) = bun_report(config, dir, run_dir)? {
        return Ok(Some(report));
    }
    let Some(reporter) = reporter_for(config) else { return Ok(None) };
    install(dir)?;
    let at = script_args_start(config);
    let args = (reporter.args)(&dir.join(reporter.file).display().to_string());
    config.args.splice(at..at, args);
    Ok(None)
}

fn bun_report(config: &mut RunConfig, dir: &Path, run_dir: &Path) -> io::Result<Option<EndReport>> {
    if !config.is_test
        || config.extras.emulate_terminal
        || !matches!(config.kind.as_str(), "npm" | "bun")
        || config.extras.test_runner.as_deref() != Some("bun-test")
        || config.args.iter().any(|a| a == "--dots" || a == "--reporter" || a.starts_with("--reporter="))
    {
        return Ok(None);
    }
    static RUNS: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("bun-{}-{}.xml", std::process::id(), RUNS.fetch_add(1, Ordering::Relaxed)));
    let at = script_args_start(config);
    let args = ["--reporter=junit".to_owned(), format!("--reporter-outfile={}", path.display())];
    config.args.splice(at..at, args);
    Ok(Some(EndReport { path, dir: run_dir.to_path_buf(), filter: name_filter(&config.args) }))
}

/// Where the script's own arguments start, adding the `--` npm, yarn and bun need before them (pnpm
/// passes `--` on to the script). The reporter's options go first: `node --test` stops reading options
/// at the first file.
fn script_args_start(config: &mut RunConfig) -> usize {
    if let Some(separator) = config.args.iter().position(|a| a == "--") {
        return separator + 1;
    }
    if matches!(crate::wrap::program_name(&config.command).as_str(), "npm" | "yarn" | "bun") {
        config.args.push("--".into());
        return config.args.len();
    }
    // `pnpm run test …` / `pnpm test …`
    let script = if matches!(config.args.first().map(String::as_str), Some("run" | "run-script")) { 2 } else { 1 };
    script.min(config.args.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vitest_script(command: &str, args: &[&str]) -> RunConfig {
        RunConfig {
            id: "npm:test".into(),
            name: "test".into(),
            kind: "npm".into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cwd: None,
            env: Default::default(),
            detected: true,
            is_test: true,
            debug_adapter: None,
            allow_parallel: false,
            extras: crate::RunExtras { test_runner: Some("vitest".into()), ..Default::default() },
        }
    }

    #[test]
    fn vitest_script_runs_load_the_reporter_before_the_script_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("test reporters");
        let mut c = vitest_script("npm", &["run", "test"]);
        add(&mut c, &dir, Path::new("/")).unwrap();
        let reporter = format!("--reporter={}", dir.join("vitest.mjs").display());
        assert_eq!(c.args, ["run", "test", "--", "--includeTaskLocation", "--reporter=default", &reporter]);
        assert_eq!(std::fs::read_to_string(dir.join("vitest.mjs")).unwrap(), FILES[0].1);

        let mut c = vitest_script("npm", &["run", "test", "--", "src/a.test.ts", "-t", "^a$"]);
        add(&mut c, &dir, Path::new("/")).unwrap();
        assert_eq!(c.args[..4], ["run", "test", "--", "--includeTaskLocation"]);
        assert_eq!(c.args[5..], [reporter.as_str(), "src/a.test.ts", "-t", "^a$"]);
        // pnpm would hand `--` to Vitest, which then stops reading options.
        let mut c = vitest_script("/usr/local/bin/pnpm", &["run", "test", "src/a.test.ts"]);
        add(&mut c, &dir, Path::new("/")).unwrap();
        assert_eq!(c.args[..3], ["run", "test", "--includeTaskLocation"]);
        assert_eq!(c.args.last().unwrap(), "src/a.test.ts");
    }

    #[test]
    fn jest_script_runs_load_the_jest_reporter() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = vitest_script("npm", &["run", "test"]);
        c.extras.test_runner = Some("jest".into());
        add(&mut c, dir.path(), Path::new("/")).unwrap();
        let reporter = format!("--reporters={}", dir.path().join("jest.cjs").display());
        assert_eq!(c.args, ["run", "test", "--", "--testLocationInResults", "--reporters=default", &reporter]);
        assert_eq!(std::fs::read_to_string(dir.path().join("jest.cjs")).unwrap(), FILES[1].1);
        // `--reporter` is Vitest's; Jest's own choice is `--reporters`.
        let mut chosen = vitest_script("npm", &["run", "test", "--", "--reporters=jest-junit"]);
        chosen.extras.test_runner = Some("jest".into());
        let before = chosen.clone();
        add(&mut chosen, dir.path(), Path::new("/")).unwrap();
        assert_eq!(chosen, before);
    }

    #[test]
    fn node_test_runs_get_the_reporter_before_their_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = vitest_script("npm", &["run", "test", "--", "--test-name-pattern=^add$", "src/a.test.ts"]);
        c.extras.test_runner = Some("node-test".into());
        add(&mut c, dir.path(), Path::new("/")).unwrap();
        let reporter = format!("--test-reporter={}", dir.path().join("node.mjs").display());
        let stdout = "--test-reporter-destination=stdout";
        assert_eq!(
            c.args,
            [
                "run",
                "test",
                "--",
                "--test-reporter=spec",
                stdout,
                &reporter,
                stdout,
                "--test-name-pattern=^add$",
                "src/a.test.ts"
            ]
        );
    }

    #[test]
    fn bun_test_runs_write_a_junit_report_read_when_they_end() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = vitest_script("bun", &["run", "test", "--", "./src/a.test.ts", "-t", "^add(?: |$)"]);
        c.extras.test_runner = Some("bun-test".into());
        let report = add(&mut c, dir.path(), Path::new("/work/pkg")).unwrap().unwrap();
        let outfile = c.args[4].strip_prefix("--reporter-outfile=").unwrap().to_owned();
        assert_eq!(c.args[..4], ["run", "test", "--", "--reporter=junit"]);
        assert_eq!(c.args[5..], ["./src/a.test.ts", "-t", "^add(?: |$)"]);
        assert_eq!(report.take(), None, "no report written yet");
        std::fs::write(
            &outfile,
            r#"<testsuites><testsuite name="src/a.test.ts" file="src/a.test.ts">
                 <testsuite name="add" file="src/a.test.ts" line="1"><testcase name="adds" file="src/a.test.ts" line="2" time="0.001"/></testsuite>
                 <testsuite name="subtract" file="src/a.test.ts" line="5"><testcase name="subtracts" file="src/a.test.ts" line="6"><skipped/></testcase></testsuite>
               </testsuite></testsuites>"#,
        )
        .unwrap();
        let messages = report.take().unwrap();
        assert!(messages.contains("name='adds'") && !messages.contains("subtract"), "{messages}");
        assert!(messages.contains("file:///work/pkg/src/a.test.ts:2"), "{messages}");
        assert!(!Path::new(&outfile).exists(), "the report is removed once read");
    }

    #[test]
    fn other_runs_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let unchanged = |c: RunConfig| {
            let mut changed = c.clone();
            add(&mut changed, dir.path(), Path::new("/")).unwrap();
            assert_eq!(changed, c);
        };
        unchanged(vitest_script("npm", &["run", "test", "--", "--reporter=json"]));
        let mut mocha = vitest_script("npm", &["run", "test"]);
        mocha.extras.test_runner = Some("mocha".into());
        unchanged(mocha);
        let mut terminal = vitest_script("npm", &["run", "test"]);
        terminal.extras.emulate_terminal = true;
        unchanged(terminal);
        let mut not_a_test = vitest_script("npm", &["run", "dev"]);
        not_a_test.is_test = false;
        unchanged(not_a_test);
    }
}
