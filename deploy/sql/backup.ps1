# IE 改善平台 — SQL Server 原生备份 + 保留策略（P0-3）
#
# 用法（默认不自动执行，需人工/任务计划显式调用）：
#   powershell -ExecutionPolicy Bypass -File deploy/sql/backup.ps1 `
#       -Database IEPlatform -BackupDir D:\backup\ie -RetentionDays 14
#   # 干跑：只打印计划，不连库、不写文件、不删文件
#   powershell -ExecutionPolicy Bypass -File deploy/sql/backup.ps1 `
#       -Database IEPlatform -BackupDir D:\backup\ie -DryRun
#
# 认证：默认 Windows 集成认证（-E）。SQL 认证时传 -SqlUser，口令通过 -SqlPassword 传入后
#       仅写入进程环境变量 SQLCMDPASSWORD，不落盘、不写日志、不入库。
# 校验：备份后立即执行 RESTORE VERIFYONLY（读回备份 + 校验 CHECKSUM），失败则非 0 退出。
#       完整恢复演练（恢复到临时库 + DBCC CHECKDB）见 docs/deployment/DEPLOY-CONFIG.md。
#
# 退出码：0 成功；2 缺少 sqlcmd；其余为 sqlcmd 返回码。
param(
  [Parameter(Mandatory = $true)][string]$Database,
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [string]$SqlInstance = '127.0.0.1',
  [int]$RetentionDays = 14,
  [string]$SqlUser = '',
  [string]$SqlPassword = '',
  [switch]$DryRun,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $BackupDir ("{0}-{1}.bak" -f $Database, $stamp)
$logFile = Join-Path $BackupDir '_backup.log'

function Write-Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try {
    if (Test-Path (Split-Path $logFile -Parent)) {
      Add-Content -Path $logFile -Value $line -Encoding UTF8
    }
  } catch { Write-Host "WARN log write failed: $($_.Exception.Message)" }
}

# 备份文件路径里的单引号在 T-SQL 中需双写
$bakEscaped = $bak.Replace("'", "''")
$backupSql = "BACKUP DATABASE [$Database] TO DISK = N'$bakEscaped' WITH INIT, COMPRESSION, CHECKSUM, STATS = 10;"
$verifySql = "RESTORE VERIFYONLY FROM DISK = N'$bakEscaped' WITH CHECKSUM;"

if ($DryRun) {
  Write-Log "DRY-RUN database=$Database instance=$SqlInstance auth=$(if ($SqlUser) { $SqlUser } else { 'integrated' })"
  Write-Log "DRY-RUN backup target: $bak"
  Write-Log "DRY-RUN sql: $backupSql"
  if (-not $SkipVerify) { Write-Log "DRY-RUN verify sql: $verifySql" }
  Write-Log "DRY-RUN retention: delete '$Database-YYYYMMDD-HHMMSS.bak' older than $RetentionDays days under $BackupDir"
  exit 0
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$sqlcmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
if (-not $sqlcmd) {
  Write-Log 'ERROR sqlcmd not found. Install SQL Server command-line utilities or run this on the SQL Server host.'
  exit 2
}

$authArgs = @('-S', $SqlInstance, '-b')
if ($SqlUser) {
  $env:SQLCMDPASSWORD = $SqlPassword
  $authArgs += @('-U', $SqlUser)
} else {
  $authArgs += '-E'
}

function Invoke-Sql([string]$query) {
  & sqlcmd @authArgs -Q $query
  return $LASTEXITCODE
}

$t0 = Get-Date
Write-Log "START backup database=$Database target=$bak"
$rc = Invoke-Sql $backupSql
if ($rc -ne 0) {
  Write-Log "ERROR backup failed rc=$rc"
  Remove-Item Env:SQLCMDPASSWORD -ErrorAction SilentlyContinue
  exit $rc
}
$sizeMb = (Get-Item $bak).Length / 1MB
Write-Log ('OK backup {0} ({1:N1} MB) in {2:N1}s' -f $bak, $sizeMb, ((Get-Date) - $t0).TotalSeconds)

if (-not $SkipVerify) {
  $rcVerify = Invoke-Sql $verifySql
  if ($rcVerify -ne 0) {
    Write-Log "ERROR RESTORE VERIFYONLY failed rc=$rcVerify (backup exists but is not readable/valid)"
    Remove-Item Env:SQLCMDPASSWORD -ErrorAction SilentlyContinue
    exit $rcVerify
  }
  Write-Log 'OK RESTORE VERIFYONLY passed (backup readable, CHECKSUM verified)'
}

# 保留策略：只删本库命名规则内的 .bak，且严格早于 RetentionDays；其他文件一律不碰
$pattern = '^{0}-\d{{8}}-\d{{6}}\.bak$' -f [regex]::Escape($Database)
$cutoff = (Get-Date).AddDays(-$RetentionDays)
$deleted = 0
Get-ChildItem -Path $BackupDir -Filter '*.bak' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match $pattern -and $_.LastWriteTime -lt $cutoff } |
  ForEach-Object {
    Write-Log "RETENTION delete $($_.Name) (lastWrite=$($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')))"
    Remove-Item -Path $_.FullName -Force
    $deleted += 1
  }
Write-Log "OK retention deleted=$deleted older-than-days=$RetentionDays"

Remove-Item Env:SQLCMDPASSWORD -ErrorAction SilentlyContinue
exit 0
