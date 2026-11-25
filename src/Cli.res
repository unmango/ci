type subcommand = {
  name: string,
  summary: string,
  run: array<string> => promise<unit>,
}

type command =
  | Help
  | Missing
  | Unknown(string)
  | Run(subcommand, array<string>)

let parse = (subcommands, argv) =>
  switch argv[0] {
  | None => Missing
  | Some("-h" | "--help" | "help") => Help
  | Some(name) =>
    switch subcommands->Array.find(s => s.name == name) {
    | Some(s) => Run(s, argv->Array.slice(~start=1))
    | None => Unknown(name)
    }
  }

let usage = subcommands => {
  let lines = subcommands->Array.map(s => `  ${s.name}  ${s.summary}`)
  ["Usage: unmango-ci <subcommand> [args...]", "", "Subcommands:", ...lines]->Array.join("\n")
}
