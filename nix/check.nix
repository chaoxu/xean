{ pkgs, bun, projectRoot }:
let
  source = builtins.path {
    path = projectRoot;
    name = "xean-check-source";
    filter = path: type:
      let
        relative = pkgs.lib.removePrefix (toString projectRoot + "/") (toString path);
        top = builtins.head (pkgs.lib.splitString "/" relative);
      in path == projectRoot || builtins.elem top [
        "tests" "examples" "experiments" "scripts" "packages" "docs" "patches" "vendor" "node_modules"
        "README.md" "AGENTS.md" "CHANGELOG.md" "LICENSE" "package.json" "tsconfig.json" "bun.lock" ".prettierignore"
      ];
  };
in pkgs.runCommand "xean-check" {
  nativeBuildInputs = [ bun ];
} ''
  export HOME="$TMPDIR/home"
  export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
  mkdir -p "$HOME"
  cp -R ${source} source
  chmod -R u+w source
  cd source
  bun --no-install --no-env-file scripts/check.ts
  touch "$out"
''
