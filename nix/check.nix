{ fleetRoot, projectRoot, tests ? "", mode ? "check" }:
let
  fleet = builtins.getFlake ("path:" + fleetRoot);
  system = builtins.currentSystem;
  pkgs = fleet.inputs.nixpkgs.legacyPackages.${system};
  bun = fleet.packages.${system}.bun;
  source = builtins.path {
    path = builtins.toPath projectRoot;
    name = "xean-source";
    filter = path: type:
      let top = builtins.head (pkgs.lib.splitString "/" (pkgs.lib.removePrefix (projectRoot + "/") (toString path)));
      in path == projectRoot || !(builtins.elem top [ ".git" "runs" ".xean" "dist" ]);
  };
in pkgs.runCommand "xean-check" {
  nativeBuildInputs = [ bun ];
} ''
  cp -R ${source} source
  chmod -R u+w source
  cd source
  ${if mode == "distribution" then "bun --no-install --no-env-file tests/distribution.ts"
    else "bun --no-install --no-env-file scripts/dev.ts ${mode} ${tests}"}
  touch "$out"
''
