# Renders the 1200x630 social preview card for TradeLista.
# Drawn with GDI+ rather than pulled out of a browser canvas as base64, so the
# image data never has to travel through a tool result.
Add-Type -AssemblyName System.Drawing

$W = 1200; $H = 630
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

function C([int]$r, [int]$gr, [int]$b) { [System.Drawing.Color]::FromArgb(255, $r, $gr, $b) }
function CA([int]$a, [int]$r, [int]$gr, [int]$b) { [System.Drawing.Color]::FromArgb($a, $r, $gr, $b) }

$BG     = C 10 14 20
$TEXT   = C 231 237 245
$DIM    = C 139 150 168
$GREEN  = C 31 209 138
$RED    = C 240 71 90
$ACCENT = C 79 140 255
$BORDER = C 35 43 58

# Rounded rectangle as a reusable path.
function RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x,        $y,        $d, $d, 180, 90)
  $p.AddArc($x+$w-$d,  $y,        $d, $d, 270, 90)
  $p.AddArc($x+$w-$d,  $y+$h-$d,  $d, $d,   0, 90)
  $p.AddArc($x,        $y+$h-$d,  $d, $d,  90, 90)
  $p.CloseFigure()
  return $p
}

# Soft coloured wash, same tint the hero section carries.
function Glow([single]$cx, [single]$cy, [single]$rad, $col) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddEllipse($cx-$rad, $cy-$rad, $rad*2, $rad*2)
  $br = New-Object System.Drawing.Drawing2D.PathGradientBrush($p)
  $br.CenterColor = $col
  $br.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $col.R, $col.G, $col.B))
  $g.FillPath($br, $p)
  $br.Dispose(); $p.Dispose()
}

$g.Clear($BG)
Glow 300 120 760 (CA 56 79 140 255)
Glow 1060 610 620 (CA 40 31 209 138)

# --- app icon, same 112-unit grid as the site header ---
$LX = 72; $LY = 60; $LS = 88
$K = $LS / 112.0
$path = RoundRect $LX $LY $LS $LS (28*$K)
$lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point($LX, $LY)),
        (New-Object System.Drawing.Point(($LX+$LS), ($LY+$LS))),
        (C 0 0 0), (C 128 129 248))
$g.FillPath($lg, $path); $lg.Dispose(); $path.Dispose()

$WHITE28 = CA 71 255 255 255
$grid = @(
  @($WHITE28, $GREEN,   $WHITE28),
  @($RED,     $WHITE28, $GREEN),
  @($WHITE28, $GREEN,   $RED)
)
$off = @(16, 44, 72)
for ($r = 0; $r -lt 3; $r++) {
  for ($c = 0; $c -lt 3; $c++) {
    $cell = RoundRect ($LX + $off[$c]*$K) ($LY + $off[$r]*$K) (24*$K) (24*$K) (6*$K)
    $br = New-Object System.Drawing.SolidBrush($grid[$r][$c])
    $g.FillPath($br, $cell); $br.Dispose(); $cell.Dispose()
  }
}

$FAM = "Segoe UI"
function Font([single]$size, $style) { New-Object System.Drawing.Font($FAM, $size, $style, [System.Drawing.GraphicsUnit]::Pixel) }
$BOLD = [System.Drawing.FontStyle]::Bold
$REG  = [System.Drawing.FontStyle]::Regular

# Text sits on exact pixel origins; StringFormat.GenericTypographic stops GDI+
# padding each run, which otherwise shifts the two-colour wordmark apart.
$sf = [System.Drawing.StringFormat]::GenericTypographic
$sf.FormatFlags = $sf.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces

function Text([string]$s, [single]$x, [single]$y, $font, $col) {
  $br = New-Object System.Drawing.SolidBrush($col)
  $g.DrawString($s, $font, $br, $x, $y, $sf)
  $br.Dispose()
}
function TextW([string]$s, $font) { return $g.MeasureString($s, $font, 2000, $sf).Width }

# --- wordmark ---
$fWord = Font 58 $BOLD
Text "Trade" 180 76 $fWord $TEXT
$wTrade = TextW "Trade" $fWord
Text "Lista" (180 + $wTrade) 76 $fWord $ACCENT

# --- headline ---
$fHead = Font 62 $BOLD
Text "Your trading journal,"  72 228 $fHead $TEXT
Text "not a PDF graveyard."   72 304 $fHead $TEXT

# --- supporting line ---
$fSub = Font 28 $REG
Text "Every closed MT4 / MT5 trade becomes a clean calendar"  72 396 $fSub $DIM
Text "- green or red, in %, with the reflection built in."    72 438 $fSub $DIM

# --- a week of the actual product, so the picture makes the same argument ---
$vals = @(189, 333, 221, $null, $null, 127, -285)
$days = @("MON","TUE","WED","THU","FRI","SAT","SUN")
$x0 = 72; $y0 = 512; $cw = 132; $ch = 76; $gap = 18
$fDay = Font 15 $BOLD
$fVal = Font 25 $BOLD
for ($i = 0; $i -lt 7; $i++) {
  $x = $x0 + $i * ($cw + $gap)
  $v = $vals[$i]
  $cell = RoundRect $x $y0 $cw $ch 14
  if ($null -eq $v) { $fill = CA 255 17 23 34; $edge = $BORDER }
  elseif ($v -gt 0) { $fill = CA 33 31 209 138; $edge = CA 87 31 209 138 }
  else              { $fill = CA 33 240 71 90; $edge = CA 87 240 71 90 }
  $br = New-Object System.Drawing.SolidBrush($fill)
  $g.FillPath($br, $cell); $br.Dispose()
  $pen = New-Object System.Drawing.Pen($edge, 1.5)
  $g.DrawPath($pen, $cell); $pen.Dispose(); $cell.Dispose()

  if ($null -eq $v) { $dayCol = C 77 87 104 } else { $dayCol = $DIM }
  Text $days[$i] ($x + 14) ($y0 + 12) $fDay $dayCol
  if ($null -ne $v) {
    if ($v -gt 0) { $s = "+$v"; $col = $GREEN } else { $s = "$v"; $col = $RED }
    Text $s ($x + 14) ($y0 + 38) $fVal $col
  }
}

$out = $args[0]
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$pars = New-Object System.Drawing.Imaging.EncoderParameters(1)
$pars.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 92L)
$bmp.Save($out, $enc, $pars)

$g.Dispose(); $bmp.Dispose()
Write-Output "written: $out"
