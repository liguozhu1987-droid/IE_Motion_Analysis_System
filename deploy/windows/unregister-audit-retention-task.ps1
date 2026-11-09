<#
  卸载「审计与日志保留期清理」Windows 计划任务。
  只删除计划任务，不动 app/api/logs 下已产生的执行日志。
#>
param(
  [string]$TaskName = 'IE-Audit-Retention-DryRun',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 用 Get-ScheduledTask 判断存在性（schtasks /Query 对不存在的任务会写 stderr，
# 在 ErrorActionPreference=Stop 下被当成终止错误）
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Write-Host "任务不存在（可能已卸载）：$TaskName"
  exit 0
}

if ($DryRun) {
  Write-Host "DryRun：将删除任务 $TaskName（未执行）"
  exit 0
}

schtasks /Delete /TN $TaskName /F
if ($LASTEXITCODE -ne 0) {
  throw "schtasks 删除失败（exit $LASTEXITCODE）"
}
Write-Host "已卸载任务：$TaskName"
