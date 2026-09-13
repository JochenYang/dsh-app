# Render a template's PPTD pages to the picker's JPEG preview convention.
#
# The generator (generate-template-variant.mjs) parses each `.page` YAML into a
# flat, already-resolved scene JSON (fonts chosen, colors literal) so this
# rasterizer only has to draw: solid-fill shapes, polylines and text lines on a
# 960x540 point canvas, scaled to the 560px-wide preview the picker expects.
# System.Drawing keeps the preview a real render of the layout (not a reused
# bitmap) without adding an image dependency to the plugin.
param(
  [Parameter(Mandatory = $true)][string]$Scene,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Width = 560,
  [int]$Quality = 70
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$json = [System.IO.File]::ReadAllText($Scene, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$scale = $Width / [double]$json.width
$height = [int][Math]::Round([double]$json.height * $scale)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

function To-Color([string]$hex) { return [System.Drawing.ColorTranslator]::FromHtml($hex) }
function SX([double]$value) { return [single]($value * $scale) }

function Get-Alignment([string]$align) {
  switch ($align) {
    'center' { return [System.Drawing.StringAlignment]::Center }
    'right' { return [System.Drawing.StringAlignment]::Far }
    default { return [System.Drawing.StringAlignment]::Near }
  }
}

foreach ($page in $json.pages) {
  $bitmap = New-Object System.Drawing.Bitmap $Width, $height
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear((To-Color $page.bg))

  foreach ($item in $page.items) {
    $x = SX $item.x; $y = SX $item.y; $w = SX $item.w; $h = SX $item.h
    switch ($item.t) {
      'rect' {
        $fill = New-Object System.Drawing.SolidBrush (To-Color $item.fill)
        $g.FillRectangle($fill, $x, $y, $w, $h)
        $fill.Dispose()
        if ([double]$item.sw -gt 0) {
          $pen = New-Object System.Drawing.Pen (To-Color $item.stroke), ([single][Math]::Max(1, (SX $item.sw)))
          $g.DrawRectangle($pen, $x, $y, $w, $h)
          $pen.Dispose()
        }
      }
      'ellipse' {
        $fill = New-Object System.Drawing.SolidBrush (To-Color $item.fill)
        $g.FillEllipse($fill, $x, $y, $w, $h)
        $fill.Dispose()
        if ([double]$item.sw -gt 0) {
          $pen = New-Object System.Drawing.Pen (To-Color $item.stroke), ([single][Math]::Max(1, (SX $item.sw)))
          $g.DrawEllipse($pen, $x, $y, $w, $h)
          $pen.Dispose()
        }
      }
      'roundRect' {
        $radius = [single][Math]::Min([Math]::Min($w, $h) * 0.14, (SX 12))
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $radius * 2
        $path.AddArc($x, $y, $d, $d, 180, 90)
        $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
        $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
        $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $fill = New-Object System.Drawing.SolidBrush (To-Color $item.fill)
        $g.FillPath($fill, $path)
        $fill.Dispose()
        if ([double]$item.sw -gt 0) {
          $pen = New-Object System.Drawing.Pen (To-Color $item.stroke), ([single][Math]::Max(1, (SX $item.sw)))
          $g.DrawPath($pen, $path)
          $pen.Dispose()
        }
        $path.Dispose()
      }
      'line' {
        $pen = New-Object System.Drawing.Pen (To-Color $item.color), ([single][Math]::Max(1, (SX $item.w)))
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Flat
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Flat
        $pts = @()
        foreach ($p in $item.pts) { $pts += (New-Object System.Drawing.PointF (SX ($item.x + $p.x)), (SX ($item.y + $p.y))) }
        if ($pts.Count -ge 2) { $g.DrawLines($pen, [System.Drawing.PointF[]]$pts) }
        $pen.Dispose()
      }
      'text' {
        $style = [System.Drawing.FontStyle]::Regular
        if ($item.bold) { $style = [System.Drawing.FontStyle]::Bold }
        $size = [single][Math]::Max(1, ($item.size * $scale))
        $font = New-Object System.Drawing.Font $item.font, $size, $style, ([System.Drawing.GraphicsUnit]::Pixel)
        $brush = New-Object System.Drawing.SolidBrush (To-Color $item.color)
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = Get-Alignment $item.align
        $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::NoClip
        $lineHeight = [single]($item.size * $item.lineHeight * $scale)
        $lines = $item.text -split "`n"
        # Vertical anchoring: mirror how the renderer places the native text
        # block inside the same bounds (top default, middle/bottom optional).
        $blockHeight = $lines.Count * $lineHeight
        $startY = $y
        if ($item.valign -eq 'middle') { $startY = $y + ($h - $blockHeight) / 2 }
        elseif ($item.valign -eq 'bottom') { $startY = $y + $h - $blockHeight }
        for ($i = 0; $i -lt $lines.Count; $i++) {
          $rect = New-Object System.Drawing.RectangleF $x, ($startY + $i * $lineHeight), $w, ($lineHeight * 1.35)
          $g.DrawString($lines[$i], $font, $brush, $rect, $format)
        }
        $format.Dispose(); $brush.Dispose(); $font.Dispose()
      }
    }
  }

  $bitmap.Save((Join-Path $OutDir ($page.name + '.jpg')), $jpeg, $encoderParams)
  $g.Dispose()
  $bitmap.Dispose()
}
