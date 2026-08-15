param(
  [Parameter(Mandatory = $true)]
  [string]$PreparedDirectory
)

$resolvedRoot = [System.IO.Path]::GetFullPath($PreparedDirectory)
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
  throw "Prepared book directory does not exist: $resolvedRoot"
}

$packages = @()
foreach ($source in Get-ChildItem -LiteralPath $resolvedRoot -Directory -Filter '*.media' | Sort-Object Name) {
  $manifest = Join-Path $source.FullName 'book-media-manifest.json'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "Media staging directory has no manifest: $($source.FullName)"
  }
  $bookKey = $source.Name.Substring(0, $source.Name.Length - '.media'.Length)
  if ($bookKey -notmatch '^[a-z0-9][a-z0-9-]{2,179}$') {
    throw "Unsafe prepared book key: $bookKey"
  }
  $destination = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot "$bookKey.media.zip"))
  if (-not $destination.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside the prepared directory: $destination"
  }
  Compress-Archive -Path (Join-Path $source.FullName '*') -DestinationPath $destination -CompressionLevel Optimal -Force
  $packages += [pscustomobject]@{
    book_key = $bookKey
    filename = [System.IO.Path]::GetFileName($destination)
    bytes = (Get-Item -LiteralPath $destination).Length
  }
}

if (-not $packages.Count) {
  throw "No *.media staging directories were found in $resolvedRoot"
}

$packages | ConvertTo-Json -Depth 4
