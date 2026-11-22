# The checks and packages a collection build covers, for nix-eval-jobs.
{
  flake ? null,
  outputs ? builtins.getFlake flake,
  # Space-separated.
  systems,
  # "true" adds flakeModules.ci's nightly list.
  full ? "false",
}:
let
  inherit (builtins)
    attrNames
    elem
    filter
    head
    isAttrs
    isString
    listToAttrs
    split
    ;

  wanted = filter (s: isString s && s != "") (split " " systems);
  set =
    names:
    listToAttrs (
      map (name: {
        inherit name;
        value = true;
      }) names
    );

  # flakeModules.ci doesn't export its exclude and nightly lists; read them back from its Hercules jobs.
  hci = outputs.herculesCI or null;
  hasLists = isAttrs hci && hci ? onPush.default.outputs;
  ref = head (hci.ciSystems or [ "x86_64-linux" ]);
  names = jobs: type: attrNames (jobs.${type}.${ref} or { });

  keep =
    type:
    if !hasLists then
      _: true
    else
      let
        known = set (names outputs type);
        kept = set (
          names hci.onPush.default.outputs type
          ++ (if full == "true" then names (hci.onSchedule.nightly.outputs or { }) type else [ ])
        );
      in
      # A name missing on the reference system is on no list.
      name: !(known ? ${name}) || kept ? ${name};

  select =
    type:
    let
      k = keep type;
      all = outputs.${type} or { };
      filtered = attrs: removeAttrs attrs (filter (n: !k n) (attrNames attrs));
    in
    listToAttrs (
      map (system: {
        name = system;
        value = filtered all.${system};
      }) (filter (s: elem s (attrNames all)) wanted)
    );
in
{
  checks = select "checks";
  packages = select "packages";
}
