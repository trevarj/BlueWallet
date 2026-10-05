#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pin=$(cat "$root/bhwi-ffi.commit")
[[ "$pin" =~ ^[0-9a-f]{40}$ ]] || { echo 'bhwi-ffi.commit must contain one full commit SHA' >&2; exit 1; }
version="0.1.0-bluewallet.$pin"

mkdir -p "$root/.bhwi-build" "$root/.bhwi-maven"
source_dir=$(mktemp -d "$root/.bhwi-build/source.XXXXXX")
publication_init=""
trap 'rm -rf "$source_dir"; if [[ -n "$publication_init" ]]; then rm -f "$publication_init"; fi' EXIT
publication_init=$(mktemp "$root/.bhwi-build/publication.XXXXXX.gradle")
cat > "$publication_init" <<'GRADLE'
gradle.projectsEvaluated {
    def publishing = gradle.rootProject.project(":lib").extensions.getByType(org.gradle.api.publish.PublishingExtension)
    def publication = publishing.publications.named("release", org.gradle.api.publish.maven.MavenPublication).get()
    publication.version = System.getProperty("bluewallet.bhwi.version")
}
GRADLE

git init -q "$source_dir"
git -C "$source_dir" fetch --depth 1 https://github.com/wizardsardine/bhwi-ffi.git "$pin"
git -C "$source_dir" checkout --detach -q FETCH_HEAD
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$pin" ]]
[[ -z "$(git -C "$source_dir" status --porcelain --untracked-files=all)" ]]

# A failed production must not leave an older artifact available to the consumer.
rm -rf "$root/.bhwi-maven/com/wizardsardine/bhwi-ffi-android"
(
  cd "$source_dir"
  nix --extra-experimental-features 'nix-command flakes' develop --max-jobs 1 --cores 2 \
    --no-write-lock-file "path:$source_dir" -c bash -euo pipefail -c '
    export CMAKE_BUILD_PARALLEL_LEVEL=2 CARGO_BUILD_JOBS=2 BUNDLE_JOBS=2 UV_THREADPOOL_SIZE=2
    export MAKEFLAGS="${MAKEFLAGS:+$MAKEFLAGS }-j2 SHELL=$BASH"
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=2048 --v8-pool-size=2"
    export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-XX:ActiveProcessorCount=2"
    revision=$(git rev-parse HEAD)
    [[ "$revision" == "$2" ]]
    version="$3"
    [[ -z "$(git status --porcelain --untracked-files=all)" ]]
    lock_digest=$(sha256sum Cargo.lock)
    build_identity=$(printf "source_revision=%s\nsource_dirty=false\npublication_version=%s\ncargo_lock_sha256=%s\n" \
      "$revision" "$version" "${lock_digest%% *}")
    echo "$build_identity"
    bash tools/build-android.sh
    jni_libs=android/lib/src/main/jniLibs
    binding=android/lib/src/main/kotlin/uniffi/bhwi_ffi/bhwi_ffi.kt
    binding_digest=$(sha256sum "$binding")
    printf "%s\ngenerated_kotlin_namespace=uniffi.bhwi_ffi\ngenerated_kotlin_sha256=%s\n" \
      "$build_identity" "${binding_digest%% *}" > target/android-build-provenance.txt
    sha256sum Cargo.lock "$binding" \
      "$jni_libs/arm64-v8a/libbhwi_ffi.so" "$jni_libs/x86_64/libbhwi_ffi.so" > target/android-build-inputs.sha256
    bash android/gradlew -p android --no-daemon --no-build-cache --console=plain \
      --max-workers=2 --no-parallel \
      "-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m -XX:ActiveProcessorCount=2" \
      -Pkotlin.compiler.execution.strategy=in-process \
      --init-script "$4" "-Dbluewallet.bhwi.version=$version" \
      -Dmaven.repo.local="$1" :lib:publishToMavenLocal
    cat target/android-build-provenance.txt
    sha256sum --check target/android-build-inputs.sha256
    aar="$1/com/wizardsardine/bhwi-ffi-android/$version/bhwi-ffi-android-$version.aar"
    cmp android/lib/build/outputs/aar/lib-release.aar "$aar"
    echo "==> AAR SHA-256"
    sha256sum "$aar"
    echo "==> actual AAR native contents (ABI/path and SHA-256)"
    entries=$(unzip -Z1 "$aar")
    for want in jni/arm64-v8a/libbhwi_ffi.so jni/x86_64/libbhwi_ffi.so; do
      grep -qx "$want" <<<"$entries" || { echo "missing from AAR: $want" >&2; exit 1; }
    done
    while IFS= read -r entry; do
      case "$entry" in
        jni/*.so)
          digest=$(unzip -p "$aar" "$entry" | sha256sum)
          digest=${digest%% *}
          echo "$digest  $entry"
          expected=$(sha256sum "$jni_libs/${entry#jni/}")
          test "$digest" = "${expected%% *}" || { echo "AAR native input mismatch: $entry" >&2; exit 1; }
          ;;
      esac
    done <<<"$entries"
  ' -- "$root/.bhwi-maven" "$pin" "$version" "$publication_init"
)

artifact="$root/.bhwi-maven/com/wizardsardine/bhwi-ffi-android/$version/bhwi-ffi-android-$version"
test -f "$artifact.aar"
test -f "$artifact.pom"
printf 'BHWI source %s published to %s\n' "$pin" "$root/.bhwi-maven"
