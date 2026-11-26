open Test

let gate: Cli.subcommand = {name: "gate", summary: "Wait for Hercules", run: async _ => ()}
let subcommands = [gate]

let parsesTo = (argv, expected) =>
  assertion(~operator="parsesTo", (a, b) => a == b, Cli.parse(subcommands, argv), expected)

test("no arguments is missing a subcommand", () => parsesTo([], Missing))

test("help flags ask for help", () => {
  parsesTo(["-h"], Help)
  parsesTo(["--help"], Help)
  parsesTo(["help"], Help)
})

test("a known subcommand runs with the remaining arguments", () =>
  parsesTo(["gate", "--sha", "abc"], Run(gate, ["--sha", "abc"]))
)

test("an unknown subcommand is reported by name", () => parsesTo(["nope"], Unknown("nope")))

test("usage lists every subcommand", () =>
  assertion(
    ~operator="includes",
    (usage, line) => usage->String.includes(line),
    Cli.usage(subcommands),
    "  gate  Wait for Hercules",
  )
)
