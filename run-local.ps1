# CX Portal - local web server for Windows (no installs needed).
# Started by run-local.bat. Serves this folder at http://localhost:8080/
# and opens it in your browser. Close this window to stop the server.
#
# Why a server and not just double-clicking index.html: browsers block the
# app's service worker and some file loads on file:// pages, so the portal
# must be served over http://localhost.

param([int]$Port = 8080)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sep = [IO.Path]::DirectorySeparatorChar
$rootPrefix = $root.TrimEnd($sep) + $sep
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.mjs' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
  '.avif' = 'image/avif'; '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'
  '.pdf' = 'application/pdf'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host "Could not start on port $Port (is it already in use?)." -ForegroundColor Red
  Write-Host "Try: run-local.bat 8090"
  Read-Host 'Press Enter to close'
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  CX Portal is running at $url" -ForegroundColor Green
Write-Host '  Keep this window open while you use the app. Close it to stop.'
Write-Host ''
try { Start-Process $url } catch { Write-Host "  Open $url in your browser." }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    # Never serve anything outside this folder.
    if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
      $res.StatusCode = 404
      $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [IO.File]::ReadAllBytes($full)
    }
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    $res.OutputStream.Close()
  }
}
