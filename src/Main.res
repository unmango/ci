type process
@val external process: process = "process"
@get external argv: process => array<string> = "argv"
@set external setExitCode: (process, int) => unit = "exitCode"

let subcommands: array<Cli.subcommand> = []

switch Cli.parse(subcommands, process->argv->Array.slice(~start=2)) {
| Help => Console.log(Cli.usage(subcommands))
| Missing =>
  Console.error(Cli.usage(subcommands))
  process->setExitCode(2)
| Unknown(name) =>
  Console.error(`unknown subcommand: ${name}\n\n${Cli.usage(subcommands)}`)
  process->setExitCode(2)
| Run(s, args) => await s.run(args)
}
