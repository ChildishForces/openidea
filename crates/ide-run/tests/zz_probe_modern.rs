#[test]
#[ignore]
fn probe() {
    for c in ide_run::detect(std::path::Path::new("/Users/chris/Development/modern-test")) {
        println!(
            "{:<55} kind={:<12} test={} runner={:?} module={:?} cwd={:?} :: {} {}",
            c.id,
            c.kind,
            c.is_test,
            c.extras.test_runner,
            c.extras.module,
            c.cwd,
            c.command,
            c.args.join(" ")
        );
    }
}
