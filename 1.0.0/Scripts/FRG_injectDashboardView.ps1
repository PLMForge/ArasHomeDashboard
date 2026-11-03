<#
    FRG_injectDashboardView.ps1

    Splices the FRG widget registration into the Aras-shipped Razor view
    Modules/aras.innovator.core.ItemWindow/Views/dashboardEditorView.cshtml.

    Three independent, individually-guarded edits. Each is idempotent, so the
    script is safe to re-run and will self-heal a partial application:

      1. no-cache response headers on the rendered view
      2. widen the dashboard.es.js import to include the names we need
      3. the registration call itself, inside createDashboardLayout()

    Exits 1 on any condition that would produce a wrong result, so that
    <exec failonerror="true"> aborts the install rather than half-applying.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Output "[FRG] $msg" }
function Fail($msg) { Write-Output "[FRG][ERROR] $msg"; exit 1 }

if (-not (Test-Path -LiteralPath $Path)) {
    Fail "View not found: $Path"
}

$content = [System.IO.File]::ReadAllText($Path)
$original = $content

# Kept so the write below can put it back. At startup the Client app compares
# the newest modification time under Modules\ (and styles\less, Solutions)
# with jsBundles\data.json, and rebuilds its bundles when they differ. The app
# pool can't write to jsBundles, so that rebuild fails on every start, adding
# seconds to each cold start. Leaving the view's time unchanged avoids it.
$originalWriteTimeUtc = [System.IO.File]::GetLastWriteTimeUtc($Path)

# Stock views ship with either CRLF or LF depending on the release. Inserted
# blocks use the view's own line ending so the file stays consistent.
$nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
function ConvertTo-ViewNewlines([string]$text) { return ($text -replace "`r?`n", $nl) }

# --- guard: refuse to run against a hand-edited copy -----------------------
# If the view already defines these loaders inline (a hand-made copy of the
# widgets), splicing on top would register every widget twice.
foreach ($legacy in @('loadInBasketCountsLayout', 'loadPinnedItemTypesLayout', 'loadRecentlyViewedLayout')) {
    if ($content -match [regex]::Escape($legacy)) {
        Fail ("Found pre-existing inline widget code ('{0}') in the view. " -f $legacy +
              "Restore dashboardEditorView.cshtml to its stock Aras content, then re-run the install.")
    }
}

# --- edit 1: no-cache headers ----------------------------------------------
$hdrMarker = 'FRG no-cache headers'
if ($content -match [regex]::Escape($hdrMarker)) {
    Write-Step 'no-cache headers already present; skipping'
}
else {
    $hdrAnchor = 'Layout = "Shared/_cuiTabItemViewLayout.cshtml";'
    if ($content -notmatch [regex]::Escape($hdrAnchor)) {
        Fail "Anchor for the no-cache headers not found (expected: $hdrAnchor)"
    }
    $hdrBlock = @"
$hdrAnchor

	// BEGIN $hdrMarker - managed by FRG_DashboardWidgets
	// The module URL in this view is salted and retires itself when the
	// installer bumps filesRevision. This rendered HTML is not, so without these
	// headers the browser keeps serving a cached page that still names the OLD
	// salted URL and the bump has no visible effect. Only ~2.5KB, so
	// revalidating is cheap.
	Context.Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
	Context.Response.Headers["Pragma"] = "no-cache";
	// END $hdrMarker
"@
    $content = $content.Replace($hdrAnchor, (ConvertTo-ViewNewlines $hdrBlock))
    Write-Step 'inserted no-cache headers'
}

# --- edit 2: widen the dashboard.es.js import ------------------------------
# The registration block needs all three names, and they MUST come from the
# view's existing import: a second import could load a second copy of the
# WidgetLayout class, and the widgets would then never render.
$required = @('addWidgetLayout', 'addFormCustomizer', 'WidgetLayout')
# In multiline mode .NET's $ matches only before \n, so (?=\r?$) is needed
# for views with CRLF line endings.
$importRx = [regex]'(?m)^(?<pre>[ \t]*import\s*\{)(?<names>[^}]*)(?<post>\}\s*from\s*[^\r\n]*dashboard\.es\.js[^\r\n]*)(?=\r?$)'
$m = $importRx.Match($content)
if (-not $m.Success) {
    Fail 'Could not locate the `import { ... } from ".../jsBundles/dashboard.es.js"` statement in the view.'
}
$names = @($m.Groups['names'].Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$missing = @($required | Where-Object { $names -notcontains $_ })
if ($missing.Count -eq 0) {
    Write-Step 'dashboard.es.js import already exposes the required names; skipping'
}
else {
    $names += $missing
    $newImport = $m.Groups['pre'].Value + ' ' + ($names -join ', ') + ' ' + $m.Groups['post'].Value
    $content = $importRx.Replace($content, [System.Text.RegularExpressions.MatchEvaluator] { param($x) $newImport }, 1)
    Write-Step ("widened dashboard.es.js import with: {0}" -f ($missing -join ', '))
}

# --- edit 3: the registration call -----------------------------------------
$regMarker = 'BEGIN FRG dashboard widgets'
if ($content -match [regex]::Escape($regMarker)) {
    Write-Step 'registration block already present; skipping'
}
else {
    # Anchor on a line present in the stock view, and insert ahead of it so
    # registration completes before the layout is built.
    $regAnchor = "const node = document.getElementById('dashboard-editor');"
    if ($content -notmatch [regex]::Escape($regAnchor)) {
        Fail "Anchor for the registration block not found (expected: $regAnchor)"
    }
    # ContentWithSalt, NOT Content: the salted URL changes whenever the
    # installer bumps filesRevision, so browsers fetch the new file -- no manual
    # ?v= is needed or wanted. The relative imports inside
    # FRG_registerWidgets.js inherit the salt.
    # (No bare at-sign in the block below -- Razor would parse it as code and
    # the view would fail to render.)
    $regBlock = @"
// $regMarker - managed by FRG_DashboardWidgets
			try {
				const frg = await import(
					'@Url.ContentWithSalt("~/customer/dashboard/FRG_registerWidgets.js")'
				);
				await frg.registerAll({ addWidgetLayout, addFormCustomizer, WidgetLayout });
			} catch (ex) {
				console.error('[FRG] widget registration failed', ex);
			}
			// END FRG dashboard widgets

			$regAnchor
"@
    $content = $content.Replace($regAnchor, (ConvertTo-ViewNewlines $regBlock))
    Write-Step 'inserted widget registration block'
}

# --- write back -------------------------------------------------------------
if ($content -eq $original) {
    Write-Step 'no changes required'
    exit 0
}

# Preserve the BOM: the stock view ships with one and Razor is sensitive to it.
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($Path, $content, $utf8Bom)
# Put the original modification time back (see $originalWriteTimeUtc above).
# The app restart that follows the install still compiles the edited view.
[System.IO.File]::SetLastWriteTimeUtc($Path, $originalWriteTimeUtc)
Write-Step "updated $Path (modification time kept)"
exit 0
