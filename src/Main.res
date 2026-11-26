type process
@val external process: process = "process"
@get external argv: process => array<string> = "argv"
@set external setExitCode: (process, int) => unit = "exitCode"

let subcommands = [RenovateResume.subcommand, RenovateFixup.subcommand]

let fail = message => {
  Console.error(message)
  process->setExitCode(2)
}

switch Cli.parse(subcommands, process->argv->Array.slice(~start=2)) {
| Help => Console.log(Cli.usage(subcommands))
| Missing => fail(Cli.usage(subcommands))
| Unknown(name) => fail(`unknown subcommand: ${name}\n\n${Cli.usage(subcommands)}`)
| Run(s, args) => await s.run(args)
}
