<#
  注册「审计与日志保留期清理」Windows 计划任务（P0-3）

  默认行为：每天 02:30 运行 **干跑**（只统计、不删除）。
  切换真实删除：管理员执行
      .\register-audit-retention-task.ps1 -Apply
  取消任务：
      .\unregister-audit-retention-task.ps1

  说明：
  - 脚本本体 app/api/scripts/audit-retention.ts 默认干跑，只有 --apply 才删；
  - 输出同时写 logs\audit-retention.log（脚本自身 JSON 行）与 logs\audit-retention-task.out.log（stdout）；
  - 默认以当前用户注册（需保持登录才执行）；服务器无人值守场景用 -RunAsSystem（需管理员权限）。
#>
param(
  [string]$TaskName = 'IE-Audit-Retention-DryRun',
  [string]$ApiDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\app\api')).Path,
  [string]$Time = '02:30',
  [switch]$Apply,
  [switch]$RunAsSystem,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $ApiDir 'dist\scripts\audit-retention.js'
if (-not (Test-Path $scriptPath)) {
  throw "未找到编译产物：$scriptPath。请先在 app/api 执行 npm run build。"
}

$applyArg = if ($Apply) { ' --apply' } else { '' }
$logFile = Join-Path $ApiDir 'logs\audit-retention-task.out.log'
$command = "cmd /c cd /d `"$ApiDir`" && node `"dist\scripts\audit-retention.js`"$applyArg >> `"$logFile`" 2>&1"

Write-Host "任务名   : $TaskName"
Write-Host "执行时间 : 每天 $Time"
Write-Host "模式     : $(if ($Apply) { '真实删除 (-Apply)' } else { '干跑（默认，不删除）' })"
Write-Host "命令     : $command"

if ($DryRun) {
  Write-Host 'DryRun：仅打印，不注册计划任务。'
  exit 0
}

# 已存在则先删除，保证重复执行幂等
# 注意：不要用 schtasks /Query 做存在性判断——任务不存在时它写 stderr，
# 在 $ErrorActionPreference='Stop' 下会被 PowerShell 当成终止错误。
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  schtasks /Delete /TN $TaskName /F | Out-Null
}

$createArgs = @('/Create', '/TN', $TaskName, '/SC', 'DAILY', '/ST', $Time, '/TR', $command, '/F')
if ($RunAsSystem) {
  $createArgs += @('/RU', 'SYSTEM', '/RL', 'HIGHEST')
}

& schtasks.exe @createArgs
if ($LASTEXITCODE -ne 0) {
  throw "schtasks 注册失败（exit $LASTEXITCODE）。无人值守请用管理员 PowerShell 加 -RunAsSystem。"
}

Write-Host '注册完成。核对：'
schtasks /Query /TN $TaskName /V /FO LIST
