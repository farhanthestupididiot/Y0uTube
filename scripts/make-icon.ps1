# make-icon.ps1
# Regenerates Y0uTube's icons from a source logo PNG:
#   - build/tray.png   32x32 PNG (tray fallback)
#   - build/tray.ico   multi-size ICO (16/24/32/48/64/128/256, crisp at all DPIs)
#   - build/icon.ico   same multi-size ICO (installer / app icon)
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1
# Optional: -Source <path-to-png> (defaults to build/youtube-logo.png)

param(
  [string]$Source = ""
)

Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $PSScriptRoot "..\build"
if (-not $Source) { $Source = Join-Path $buildDir "youtube-logo.png" }
if (-not (Test-Path $Source)) { Write-Error "Source icon not found: $Source"; exit 1 }

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source))

# Auto-crop to the non-transparent bounding box (YouTube's logo has padding).
function Get-AlphaBounds([System.Drawing.Bitmap]$bmp) {
  $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      if ($bmp.GetPixel($x, $y).A -gt 0) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return @($minX, $minY, $maxX, $maxY)
}

$b = Get-AlphaBounds $src
$w = $b[2] - $b[0] + 1
$h = $b[3] - $b[1] + 1
if ($w -le 0 -or $h -le 0) { Write-Error "Source image has no opaque pixels"; exit 1 }

$cropped = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($cropped)
$g.DrawImage($src,
  (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
  (New-Object System.Drawing.Rectangle($b[0], $b[1], $w, $h)),
  [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()

function Resize-Square([System.Drawing.Bitmap]$img, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gr.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gr.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $gr.Clear([System.Drawing.Color]::Transparent)
  $gr.DrawImage($img, 0, 0, $size, $size)
  $gr.Dispose()
  return $bmp
}

# Emit a multi-size ICO (PNG-compressed entries, supported on Windows Vista+).
function Write-Ico([System.Drawing.Bitmap]$img, [int[]]$sizes, [string]$outPath) {
  $pngs = @()
  foreach ($s in $sizes) {
    $tmp = Join-Path $env:TEMP ("y0utube-icon-$s.png")
    $bmp = Resize-Square $img $s
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $pngs += , [pscustomobject]@{ size = $s; bytes = [System.IO.File]::ReadAllBytes($tmp) }
    Remove-Item $tmp -Force
  }
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint16]0)          # reserved
  $bw.Write([uint16]1)          # type: icon
  $bw.Write([uint16]$pngs.Count)
  $offset = 6 + 16 * $pngs.Count
  foreach ($p in $pngs) {
    $s = $p.size
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # width
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # height
    $bw.Write([byte]0)                                        # colors
    $bw.Write([byte]0)                                        # reserved
    $bw.Write([uint16]1)                                      # color planes
    $bw.Write([uint16]32)                                     # bits per pixel
    $bw.Write([uint32]$p.bytes.Length)                        # size
    $bw.Write([uint32]$offset)                                # offset
    $offset += $p.bytes.Length
  }
  foreach ($p in $pngs) { $bw.Write($p.bytes) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($outPath, $ms.ToArray())
  $bw.Dispose(); $ms.Dispose()
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)

# tray.png: 32x32 single-size fallback.
$tray = Resize-Square $cropped 32
$tray.Save((Join-Path $buildDir "tray.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()

Write-Ico $cropped $sizes (Join-Path $buildDir "tray.ico")
Write-Ico $cropped $sizes (Join-Path $buildDir "icon.ico")
$cropped.Dispose()

Write-Host "Icons regenerated:"
Get-ChildItem (Join-Path $buildDir "tray.png"), (Join-Path $buildDir "tray.ico"), (Join-Path $buildDir "icon.ico") | Select-Object Name, Length
