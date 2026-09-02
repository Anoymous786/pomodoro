$root = 'C:\Users\utsi2\Desktop\pomodoro-dashboard'
Select-String -LiteralPath (Join-Path $root 'app\(main)\task\[id]\page.tsx') -Pattern 'data-testid' | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }
