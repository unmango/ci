type buffer
type options = {encoding: string, maxBuffer: float}
// Past the 1 MiB default a large lock file would overflow.
let options = encoding => {encoding, maxBuffer: 1073741824.}

@module("node:child_process")
external text: (string, array<string>, options) => string = "execFileSync"
@module("node:child_process")
external bytes: (string, array<string>, options) => buffer = "execFileSync"
@send external toString: (buffer, string) => string = "toString"

let staged = base =>
  text("git", ["diff", "--cached", "--raw", "-z", "--no-renames", base], options("utf8"))

let blobBase64 = blob =>
  bytes("git", ["cat-file", "blob", blob], options("buffer"))->toString("base64")
