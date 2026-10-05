{
  description = "BlueWallet BHWI Android proof-of-concept build";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/767b0d3ec98a143ad9ed7dfc0d5553510ac27133";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "x86_64-darwin" "aarch64-darwin" ];
    in {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };
          ndkVersion = "28.2.13676358";
          androidSdk = (pkgs.androidenv.composeAndroidPackages {
            cmdLineToolsVersion = "11.0";
            platformToolsVersion = "36.0.2";
            platformVersions = [ "36" ];
            buildToolsVersions = [ "36.0.0" ];
            includeNDK = true;
            ndkVersions = [ ndkVersion ];
            includeCmake = true;
            cmakeVersions = [ "3.22.1" ];
            includeEmulator = false;
            includeSystemImages = false;
          }).androidsdk;
          sdkRoot = "${androidSdk}/libexec/android-sdk";
          npmScriptShell = pkgs.runCommandLocal "bluewallet-npm-script-shell" { } ''
            mkdir -p "$out/bin"
            {
              printf '#!%s\n' '${pkgs.bash}/bin/bash'
              declare -f isScript patchShebangs
              cat <<'EOF'
            set -euo pipefail
            export PATH="${pkgs.lib.makeBinPath [ pkgs.nodejs_24 pkgs.coreutils pkgs.findutils pkgs.gnused ]}:$PATH"
            NIX_STORE=${builtins.storeDir}
            shopt -s nullglob
            executables=()
            IFS=: read -r -a search_paths <<< "$PATH"
            for directory in "''${search_paths[@]}"; do
              case "$directory" in
                */node_modules/.bin)
                  [[ -d "$directory" ]] || continue
                  modules_dir=$(readlink -f "''${directory%/.bin}")
                  for executable in "$directory"/*; do
                    if [[ -f "$executable" && -x "$executable" ]]; then
                      target=$(readlink -f "$executable")
                      if [[ "$target" == "$modules_dir/"* ]]; then
                        executables+=("$target")
                      fi
                    fi
                  done
                  ;;
              esac
            done
            if (( ''${#executables[@]} )); then
              patchShebangs --build "''${executables[@]}" >&2
            fi
            package_dir=$(pwd -P)
            case "$package_dir" in
              */node_modules/*)
                patchShebangs --build "$package_dir" >&2
                ;;
            esac
            exec ${pkgs.bash}/bin/bash "$@"
            EOF
            } > "$out/bin/npm-script-shell"
            chmod +x "$out/bin/npm-script-shell"
          '';
          projectBundler = (pkgs.bundler.override { ruby = pkgs.ruby_3_4; }).overrideAttrs (old: {
            name = "bundler-2.6.9";
            version = "2.6.9";
            suffix = "2.6.9";
            src = pkgs.fetchurl {
              url = "https://rubygems.org/gems/bundler-2.6.9.gem";
              sha256 = "a25675ffbd055ae1186766cc1e120b4cf62588e88abb59b99c57e22b1c55c9eb";
            };
            meta = old.meta // {
              changelog = "https://github.com/ruby/rubygems/blob/bundler-v2.6.9/bundler/CHANGELOG.md";
            };
          });
          # AGP executes no-shebang Prefab launchers via /bin/sh; keep FHS paths private to the build.
          androidEnv = pkgs.buildFHSEnv {
            name = "bluewallet-android";
            targetPkgs = _: [ pkgs.nodejs_24 pkgs.python3 pkgs.zlib ];
            unshareUser = true;
            runScript = "${pkgs.bash}/bin/bash";
            profile = ''
              export npm_config_script_shell=/bin/bash
            '';
          };
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.jdk17
              androidSdk
              pkgs.nix
              pkgs.git
              pkgs.bash
              pkgs.curl
              pkgs.unzip
              pkgs.zip
              pkgs.xxd
              pkgs.python3
              pkgs.ruby_3_4
              projectBundler
              pkgs.gnumake
              pkgs.pkg-config
              pkgs.which
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ androidEnv ];
            buildInputs = [ pkgs.libffi ];
            JAVA_HOME = pkgs.jdk17.home;
            ANDROID_HOME = sdkRoot;
            ANDROID_SDK_ROOT = sdkRoot;
            ANDROID_NDK_HOME = "${sdkRoot}/ndk/${ndkVersion}";
            ANDROID_NDK_ROOT = "${sdkRoot}/ndk/${ndkVersion}";
            GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdkRoot}/build-tools/36.0.0/aapt2";
            BUNDLE_PATH = "vendor/bundle";
            CMAKE_BUILD_PARALLEL_LEVEL = "2";
            CARGO_BUILD_JOBS = "2";
            BUNDLE_JOBS = "2";
            MAKEFLAGS = "-j2 SHELL=${pkgs.bash}/bin/bash";
            UV_THREADPOOL_SIZE = "2";
            npm_config_script_shell = "${npmScriptShell}/bin/npm-script-shell";
            shellHook = ''
              export PATH="${sdkRoot}/build-tools/36.0.0:${sdkRoot}/cmdline-tools/11.0/bin:$PATH"
              export NODE_OPTIONS="''${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=2048 --v8-pool-size=2"
              export JAVA_TOOL_OPTIONS="''${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-XX:ActiveProcessorCount=2"
            '';
          };
        });
    };
}
