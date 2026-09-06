# No-container launcher for the leia local-model shims on Windows.
# Needs only uv (https://docs.astral.sh/uv/); it manages an isolated
# Python + the exact dependencies each model wants, per run.
#
# Usage: .\run.ps1 <model> [extra server.py args...]
#   .\run.ps1 kokoro       # best CPU quality  -> http://127.0.0.1:8880
#   .\run.ps1 piper        # fastest           -> http://127.0.0.1:8881
# Then open leia's options -> Local servers. See docs/local-tts.md.
#
# If script execution is blocked:
#   powershell -ExecutionPolicy Bypass -File shims\run.ps1 kokoro
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Model,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-Location $PSScriptRoot # works from any cwd (repo root, shims\, elsewhere)

$deps = switch ($Model) {
  "kokoro"    { @("kokoro-onnx", "onnxruntime") }
  "piper"     { @("piper-tts") }
  "kittentts" { @("kittentts==0.1.3", "huggingface_hub") }
  "neutts"    { @("neutts==1.4.1") }
  "edge"      { @("edge-tts==7.2.8", "miniaudio==1.71") }
  "stub"      { @() }
  default { Write-Error "unknown model: $Model"; exit 2 }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "uv not found - install it first:"
  Write-Host '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  Write-Host "  (or: pip install uv)"
  exit 1
}

$uvArgs = @("run", "--quiet")
foreach ($d in @("fastapi", "uvicorn") + $deps) { $uvArgs += @("--with", $d) }
& uv @uvArgs python server.py --model $Model @Rest
exit $LASTEXITCODE
