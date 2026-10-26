$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$runtimeFiles = @('main.js','manifest.json','tasks.cjs','preload.cjs','window.html','window.css','renderer.js','desktop-host.exe','README.md','LICENSE')
foreach ($runtimeFile in $runtimeFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $runtimeFile) -PathType Leaf)) { throw "Missing package file: $runtimeFile" }
}
$distDir = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$archive = Join-Path $distDir ("desktop-agenda-$($manifest.version)-windows.zip")
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create)
try {
    $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($runtimeFile in $runtimeFiles) {
            $entry = $zip.CreateEntry("desktop-agenda/$runtimeFile", [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try { $contents = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $runtimeFile)); $entryStream.Write($contents,0,$contents.Length) }
            finally { $entryStream.Dispose() }
        }
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
$checksum = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumFile = Join-Path $distDir 'SHA256SUMS.txt'
[System.IO.File]::WriteAllText($checksumFile, "$checksum  $([System.IO.Path]::GetFileName($archive))`n", [System.Text.UTF8Encoding]::new($false))
Write-Output $archive
Write-Output $checksumFile
