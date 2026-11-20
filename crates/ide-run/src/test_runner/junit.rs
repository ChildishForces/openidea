//! JUnit XML reports turned into the IDE's test messages (TeamCity service messages with node ids, as
//! the IDE's reporters print them), for frameworks that can only write a report file (`bun test`).

use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::path::Path;

#[derive(Default)]
struct Node {
    suite: bool,
    name: String,
    file: Option<String>,
    line: Option<String>,
    seconds: f64,
    skipped: bool,
    failure: Option<(String, String)>,
    children: Vec<Node>,
}

fn attr(tag: &BytesStart, key: &str) -> Option<String> {
    tag.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| a.normalized_value(XmlVersion::Implicit1_0).ok().map(|v| v.into_owned()))
}

fn node(tag: &BytesStart, suite: bool) -> Node {
    Node {
        suite,
        name: attr(tag, "name").unwrap_or_default(),
        file: attr(tag, "file"),
        line: attr(tag, "line"),
        seconds: attr(tag, "time").and_then(|t| t.parse().ok()).unwrap_or(0.0),
        ..Node::default()
    }
}

/// The report's top-level suites (one per test file), or `None` for XML that isn't a JUnit report.
fn parse(xml: &str) -> Option<Vec<Node>> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Node> = vec![Node { suite: true, ..Node::default() }];
    // Inside `<failure>` / `<error>`: its text collects here.
    let mut failure: Option<(String, String)> = None;
    loop {
        let event = reader.read_event().ok()?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(tag) | Event::Empty(tag) => match tag.name().as_ref() {
                "testsuite" | "testcase" => {
                    stack.push(node(&tag, tag.name().as_ref() == "testsuite"));
                    if empty {
                        let done = stack.pop()?;
                        stack.last_mut()?.children.push(done);
                    }
                }
                "failure" | "error" => {
                    let started = (attr(&tag, "message").unwrap_or_default(), String::new());
                    if empty {
                        stack.last_mut()?.failure = Some(started);
                    } else {
                        failure = Some(started);
                    }
                }
                "skipped" => stack.last_mut()?.skipped = true,
                _ => {}
            },
            Event::End(tag) => match tag.name().as_ref() {
                "testsuite" | "testcase" => {
                    let done = stack.pop()?;
                    stack.last_mut()?.children.push(done);
                }
                "failure" | "error" => stack.last_mut()?.failure = failure.take(),
                _ => {}
            },
            Event::Text(text) => {
                if let Some((_, body)) = &mut failure {
                    body.push_str(&text.xml_content(XmlVersion::Implicit1_0));
                }
            }
            Event::CData(text) => {
                if let Some((_, body)) = &mut failure {
                    body.push_str(text.as_ref());
                }
            }
            Event::GeneralRef(reference) => {
                if let Some((_, body)) = &mut failure {
                    let escaped = format!("&{};", reference.as_ref());
                    body.push_str(&quick_xml::escape::unescape(&escaped).ok()?);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let root = stack.pop()?;
    if !stack.is_empty() {
        return None;
    }
    // `<testsuites>` holds the files; a lone `<testsuite>` is one.
    let files = root.children.into_iter().flat_map(|n| if n.suite && n.file.is_none() { n.children } else { vec![n] });
    Some(files.collect())
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '|' => out.push_str("||"),
            '\'' => out.push_str("|'"),
            '[' => out.push_str("|["),
            ']' => out.push_str("|]"),
            '\n' => out.push_str("|n"),
            '\r' => out.push_str("|r"),
            c => out.push(c),
        }
    }
    out
}

fn message(out: &mut String, kind: &str, attrs: &[(&str, Option<&str>)]) {
    out.push_str("##teamcity[");
    out.push_str(kind);
    for (key, value) in attrs {
        if let Some(value) = value {
            out.push_str(&format!(" {key}='{}'", escape(value)));
        }
    }
    out.push_str("]\n");
}

struct Emitter<'a> {
    out: String,
    ids: usize,
    dir: &'a Path,
    selected: &'a dyn Fn(&str) -> bool,
}

impl Emitter<'_> {
    fn id(&mut self) -> String {
        self.ids += 1;
        self.ids.to_string()
    }

    fn location(&self, file: Option<&str>, line: Option<&str>) -> Option<String> {
        let file = self.dir.join(file?);
        Some(match line {
            Some(line) => format!("file://{}:{line}", file.display()),
            None => format!("file://{}", file.display()),
        })
    }

    /// Whether the run selected the test (or a test under the suite): a name filter (`-t`) reports the
    /// tests it left out as skipped.
    /// `ancestors`: the names of the suites around `node` (not the file's).
    fn shown(&self, node: &Node, ancestors: &[&str]) -> bool {
        let names = [ancestors, &[node.name.as_str()]].concat();
        if node.suite {
            return node.children.iter().any(|c| self.shown(c, &names));
        }
        !node.skipped || (self.selected)(&names.join(" "))
    }

    /// `ancestors`: as for [`Self::shown`]; a file's tests have none.
    fn emit(&mut self, node: &Node, parent: &str, file: Option<&str>, ancestors: &[&str]) {
        let file = node.file.as_deref().or(file);
        let id = self.id();
        let location = self.location(file, node.line.as_deref());
        if node.suite {
            message(
                &mut self.out,
                "testSuiteStarted",
                &[
                    ("name", Some(&node.name)),
                    ("nodeId", Some(&id)),
                    ("parentNodeId", Some(parent)),
                    ("locationHint", location.as_deref()),
                ],
            );
            let names: Vec<&str> = if parent == "0" { Vec::new() } else { [ancestors, &[node.name.as_str()]].concat() };
            let shown: Vec<&Node> = node.children.iter().filter(|c| self.shown(c, &names)).collect();
            for child in shown {
                self.emit(child, &id, file, &names);
            }
            message(&mut self.out, "testSuiteFinished", &[("nodeId", Some(&id))]);
            return;
        }
        message(
            &mut self.out,
            "testStarted",
            &[
                ("name", Some(&node.name)),
                ("nodeId", Some(&id)),
                ("parentNodeId", Some(parent)),
                ("locationHint", location.as_deref()),
            ],
        );
        if let Some((text, details)) = &node.failure {
            let value = |label: &str| text.lines().find_map(|l| l.strip_prefix(label)).map(str::trim);
            let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default();
            message(
                &mut self.out,
                "testFailed",
                &[
                    ("nodeId", Some(&id)),
                    ("message", Some(first)),
                    ("details", Some(if details.trim().is_empty() { text } else { details })),
                    ("expected", value("Expected:")),
                    ("actual", value("Received:")),
                ],
            );
        } else if node.skipped {
            message(&mut self.out, "testIgnored", &[("nodeId", Some(&id))]);
        }
        let duration = ((node.seconds * 1000.0).round() as u64).to_string();
        message(&mut self.out, "testFinished", &[("nodeId", Some(&id)), ("duration", Some(&duration))]);
    }
}

/// The report as the IDE's test messages: files, suites and tests the run selected. Paths in the report
/// are relative to `dir`, the run's directory; `selected` tells whether a skipped test's full name
/// (suite names and its own, joined with spaces) matches the run's name filter.
pub(crate) fn messages(xml: &str, dir: &Path, selected: &dyn Fn(&str) -> bool) -> Option<String> {
    let files = parse(xml)?;
    let mut emitter = Emitter { out: String::new(), ids: 0, dir, selected };
    let shown: Vec<&Node> = files.iter().filter(|f| f.children.iter().any(|c| emitter.shown(c, &[]))).collect();
    for file in shown {
        emitter.emit(file, "0", None, &[]);
    }
    Some(emitter.out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" failures="1" skipped="2">
  <testsuite name="src/math.test.ts" file="src/math.test.ts" tests="5">
    <testsuite name="add" file="src/math.test.ts" line="15" tests="3">
      <testcase name="adds positive numbers" classname="add" time="0.0028" file="src/math.test.ts" line="16">
        <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 6&#10;Received: 5&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 6&#10;Received: 5&#10;</failure>
      </testcase>
      <testcase name="handles zero" classname="add" time="0.000015" file="src/math.test.ts" line="18" />
      <testcase name="later" classname="add" time="0" file="src/math.test.ts" line="19"><skipped /></testcase>
    </testsuite>
    <testsuite name="subtract" file="src/math.test.ts" line="21" tests="1">
      <testcase name="subtracts numbers" classname="subtract" time="0" file="src/math.test.ts" line="22"><skipped /></testcase>
    </testsuite>
  </testsuite>
</testsuites>"#;

    #[test]
    fn a_bun_report_becomes_the_tree_of_the_tests_the_run_selected() {
        let selected = |name: &str| name.starts_with("add");
        let out = messages(REPORT, Path::new("/work/pkg"), &selected).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        let f = "file:///work/pkg/src/math.test.ts";
        assert_eq!(
            lines[0],
            format!(
                "##teamcity[testSuiteStarted name='src/math.test.ts' nodeId='1' parentNodeId='0' locationHint='{f}']"
            )
        );
        assert_eq!(
            lines[1],
            format!("##teamcity[testSuiteStarted name='add' nodeId='2' parentNodeId='1' locationHint='{f}:15']")
        );
        assert_eq!(
            lines[2],
            format!(
                "##teamcity[testStarted name='adds positive numbers' nodeId='3' parentNodeId='2' locationHint='{f}:16']"
            )
        );
        assert!(lines[3].starts_with("##teamcity[testFailed nodeId='3' message='expect(received).toBe(expected)' details='AssertionError: expect"), "{}", lines[3]);
        assert!(lines[3].ends_with("expected='6' actual='5']"), "{}", lines[3]);
        assert_eq!(lines[4], "##teamcity[testFinished nodeId='3' duration='3']");
        // `.skip` inside the selection shows as ignored; `subtract`, left out by `-t`, doesn't show.
        assert!(out.contains("##teamcity[testIgnored nodeId='5']"), "{out}");
        assert!(!out.contains("subtract"), "{out}");
        // Without a filter every skipped test shows.
        assert!(messages(REPORT, Path::new("/work/pkg"), &|_| true).unwrap().contains("subtracts numbers"));
    }

    #[test]
    fn other_xml_is_not_a_report() {
        assert_eq!(messages("<testsuites><testsuite>", Path::new("/"), &|_| true), None);
        assert_eq!(messages("not xml <", Path::new("/"), &|_| true).as_deref().unwrap_or(""), "");
    }
}
