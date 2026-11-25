{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_24,
}:
buildNpmPackage {
  pname = "unmango-ci";
  version = "0.0.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./rescript.json
      ./rolldown.config.mjs
      ./src
      (lib.fileset.fileFilter (f: f.hasExt "res") ./test)
    ];
  };

  nodejs = nodejs_24;
  npmDeps = importNpmLock { npmRoot = ./.; };
  npmConfigHook = importNpmLock.npmConfigHook;

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node_modules/.bin/retest 'test/*.res.mjs'
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 -t $out/lib/unmango-ci dist/unmango-ci.mjs dist/unmango-ci.mjs.map
    makeWrapper ${lib.getExe nodejs_24} $out/bin/unmango-ci \
      --add-flags "--enable-source-maps $out/lib/unmango-ci/unmango-ci.mjs"
    runHook postInstall
  '';

  meta = {
    description = "The CLI behind unmango/ci's actions";
    license = lib.licenses.mit;
    mainProgram = "unmango-ci";
  };
}
