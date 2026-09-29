param(
  [string]$Project
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Project) {
  $projectPath = (Resolve-Path -LiteralPath $Project).Path
  $root = Join-Path $projectPath ".opencode"
} else {
  $root = Join-Path $HOME ".config\opencode"
}

$plugins = Join-Path $root "plugins"
$runtime = Join-Path $root "runtime"
New-Item -ItemType Directory -Force -Path $plugins, $runtime | Out-Null
Copy-Item -LiteralPath (Join-Path $source "agy-model-provider.ts") -Destination (Join-Path $plugins "agy-model-provider.ts") -Force
Copy-Item -LiteralPath (Join-Path $source "agy-activity-tools.ts") -Destination (Join-Path $plugins "agy-activity-tools.ts") -Force
Copy-Item -LiteralPath (Join-Path $source "agy-openai-bridge.mjs") -Destination (Join-Path $runtime "agy-openai-bridge.mjs") -Force
Copy-Item -LiteralPath (Join-Path $source "opencode.provider.example.jsonc") -Destination (Join-Path $root "agy-provider.config.example.jsonc") -Force

Write-Host "Installed AGY plugins: $plugins"
Write-Host "Installed AGY bridge:  $(Join-Path $runtime 'agy-openai-bridge.mjs')"
Write-Host "Next: merge providers.agy-cli from $(Join-Path $root 'agy-provider.config.example.jsonc')"
Write-Host "into your existing OpenCode V2 config without replacing other settings or its default model."
Write-Host "Add a model entry for each slug from 'agy models'; keep tools enabled for the display-only activity cards."
Write-Host "Restart OpenCode, then test an agy-cli model. Monitor commands: /agy-monitor-on and /agy-monitor-off."
