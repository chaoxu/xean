{ fleetRoot, projectRoot, tests ? "", mode ? "check" }:
let
  fleet = builtins.getFlake ("path:" + fleetRoot);
  system = builtins.currentSystem;
  pkgs = fleet.inputs.nixpkgs.legacyPackages.${system};
  bun = fleet.packages.${system}.bun;
  source = builtins.path {
    path = builtins.toPath projectRoot;
    name = "xean-pi-prototype-source";
    filter = path: type:
      let top = builtins.head (pkgs.lib.splitString "/" (pkgs.lib.removePrefix (projectRoot + "/") (toString path)));
      in path == projectRoot || !(builtins.elem top [ ".git" "runs" ".xean" ]);
  };
in pkgs.runCommand "xean-pi-prototype-check" {
  nativeBuildInputs = [ bun ];
} ''
  cp -R ${source} source
  chmod -R u+w source
  cd source
  ${pkgs.lib.optionalString (mode == "check") ''
    bun --no-install --no-env-file node_modules/typescript/bin/tsc --noEmit
    bun --no-install --no-env-file node_modules/prettier/bin/prettier.cjs --check src apps tests scripts examples docs package.json tsconfig.json README.md AGENTS.md
    bun --no-install --no-env-file scripts/dependencies.ts
  ''}
  ${if mode == "distribution" then "bun --no-install --no-env-file scripts/check-distribution.ts"
    else "bun --no-install --no-env-file test ${if tests == "" then "tests" else tests}"}
  touch "$out"
''
