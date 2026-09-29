#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: sh install.sh [--project <project-directory>]" >&2
  exit 2
}

project=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || usage
      project=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "$project" ]; then
  [ -d "$project" ] || { echo "Project directory does not exist: $project" >&2; exit 1; }
  root="$project/.opencode"
else
  root="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
fi

plugins="$root/plugins"
runtime="$root/runtime"
mkdir -p "$plugins" "$runtime"
cp "$source_dir/agy-model-provider.ts" "$plugins/agy-model-provider.ts"
cp "$source_dir/agy-activity-tools.ts" "$plugins/agy-activity-tools.ts"
cp "$source_dir/agy-openai-bridge.mjs" "$runtime/agy-openai-bridge.mjs"
cp "$source_dir/opencode.provider.example.jsonc" "$root/agy-provider.config.example.jsonc"

printf 'Installed AGY plugins: %s\n' "$plugins"
printf 'Installed AGY bridge:  %s\n' "$runtime/agy-openai-bridge.mjs"
printf 'Next: merge providers.agy-cli from %s\n' "$root/agy-provider.config.example.jsonc"
echo "into your existing OpenCode V2 config without replacing other settings or its default model."
echo "Add a model entry for each slug from 'agy models'; keep tools enabled for the display-only activity cards."
echo "Restart OpenCode, then test an agy-cli model. Monitor commands: /agy-monitor-on and /agy-monitor-off."
