$root = 'C:\Users\utsi2\Desktop\pomodoro-dashboard'
foreach ($id in @('rs-new-step','step-toggle-','newtask-blank-hint','ws-title','stats-practice-days')) {
  $hits = Get-ChildItem -LiteralPath $root -Recurse -Include *.tsx -File | Where-Object { $_.FullName -notmatch 'node_modules|\.next' } | Select-String -SimpleMatch $id -List | ForEach-Object { $_.Path.Substring($root.Length+1) }
  Write-Output "$id => $($hits -join ', ')"
}
Select-String -LiteralPath (Join-Path $root 'app\(main)\task\new\page.tsx') -Pattern 'data-testid' | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }
