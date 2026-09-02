$root = 'C:\Users\utsi2\Desktop\pomodoro-dashboard'
$ids = @('ws-filter-clear','ws-filter-row','ct-name','ct-days-3','ct-create','rs-new-step','step-toggle-','newtask-blank-hint','ws-title','stats-practice-days')
foreach ($id in $ids) {
  $hits = Get-ChildItem -LiteralPath $root -Recurse -Include *.tsx,*.ts -File | Where-Object { $_.FullName -notmatch 'node_modules|\.next' } | Select-String -SimpleMatch ($id) -List | ForEach-Object { $_.Path.Substring($root.Length+1) }
  Write-Output "$id => $($hits -join ', ')"
}
