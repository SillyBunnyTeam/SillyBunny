[CmdletBinding()]
param(
    [switch]$Optional
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Finish-Early {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if ($Optional) {
        Write-Warning "Skipping self-update: $Message"
        exit 0
    }

    throw "Self-update failed: $Message"
}

function Invoke-Git {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    $output = & git @Arguments 2>&1
    $exitCode = $LASTEXITCODE

    return [pscustomobject]@{
        Output = @($output)
        ExitCode = $exitCode
    }
}

function Restore-LoneBunLockChange {
    $trackedResult = Invoke-Git ls-files --error-unmatch bun.lock
    if ($trackedResult.ExitCode -ne 0) {
        return
    }

    $statusResult = Invoke-Git status --porcelain --untracked-files=normal
    if ($statusResult.ExitCode -ne 0) {
        Finish-Early 'could not read the repository status.'
    }

    $statusLines = @($statusResult.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($statusLines.Count -ne 1) {
        return
    }

    $statusLine = $statusLines[0].ToString()
    if ($statusLine.Length -lt 4 -or $statusLine.Substring(3) -ne 'bun.lock') {
        return
    }

    Write-Host 'Restoring tracked bun.lock before self-update...'
    $restoreResult = Invoke-Git restore --staged --worktree -- bun.lock
    if ($restoreResult.ExitCode -eq 0) {
        return
    }

    [void](Invoke-Git reset HEAD -- bun.lock)
    $checkoutResult = Invoke-Git checkout -- bun.lock
    if ($checkoutResult.ExitCode -ne 0) {
        Finish-Early 'could not restore generated bun.lock.'
    }
}

$repoDir = Split-Path -Parent $PSScriptRoot
Set-Location $repoDir

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Finish-Early 'Git is not installed.'
}

$insideWorkTree = Invoke-Git rev-parse --is-inside-work-tree
if ($insideWorkTree.ExitCode -ne 0) {
    Finish-Early 'this checkout is not a Git repository.'
}

$currentBranchResult = Invoke-Git symbolic-ref --quiet --short HEAD
$currentBranch = ($currentBranchResult.Output | Select-Object -First 1).ToString().Trim()
if ($currentBranchResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch)) {
    Finish-Early 'detached HEAD checkouts cannot be updated automatically.'
}

$upstreamRefResult = Invoke-Git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
$upstreamRef = ($upstreamRefResult.Output | Select-Object -First 1).ToString().Trim()
if ($upstreamRefResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($upstreamRef)) {
    Finish-Early "branch '$currentBranch' does not have an upstream configured."
}

Restore-LoneBunLockChange

$statusResult = Invoke-Git status --porcelain --untracked-files=normal
if ($statusResult.ExitCode -ne 0) {
    Finish-Early 'could not read the repository status.'
}

if (($statusResult.Output -join "`n").Trim().Length -gt 0) {
    Finish-Early 'the working tree is not clean. Commit, stash, or remove local changes first.'
}

$upstreamRemote = $upstreamRef.Split('/')[0]

Write-Host "Checking for updates on $upstreamRef..."
$fetchResult = Invoke-Git fetch --quiet $upstreamRemote
if ($fetchResult.ExitCode -ne 0) {
    Finish-Early "could not fetch from '$upstreamRemote'."
}

$countsResult = Invoke-Git rev-list --left-right --count 'HEAD...@{upstream}'
if ($countsResult.ExitCode -ne 0) {
    Finish-Early 'could not compare the local branch with its upstream.'
}

$countsText = ($countsResult.Output | Select-Object -First 1).ToString().Trim()
$countsParts = $countsText -split '\s+'
if ($countsParts.Length -lt 2) {
    Finish-Early 'received an unexpected response while comparing revisions.'
}

$ahead = [int]$countsParts[0]
$behind = [int]$countsParts[1]

if ($ahead -gt 0 -and $behind -gt 0) {
    Finish-Early "branch '$currentBranch' has diverged from '$upstreamRef'. Resolve it manually before using self-update."
}

if ($ahead -gt 0) {
    Write-Host "Local branch '$currentBranch' is already ahead of '$upstreamRef'; nothing to pull."
    exit 0
}

if ($behind -eq 0) {
    Write-Host 'SillyBunny is already up to date.'
    exit 0
}

$beforeResult = Invoke-Git rev-parse --short HEAD
$beforeRev = ($beforeResult.Output | Select-Object -First 1).ToString().Trim()
if ($beforeResult.ExitCode -ne 0) {
    Finish-Early 'could not read the current revision.'
}

Write-Host 'Updating SillyBunny...'
$pullResult = Invoke-Git pull --ff-only
if ($pullResult.ExitCode -ne 0) {
    Finish-Early 'git pull --ff-only failed.'
}

$afterResult = Invoke-Git rev-parse --short HEAD
$afterRev = ($afterResult.Output | Select-Object -First 1).ToString().Trim()
if ($afterResult.ExitCode -ne 0) {
    Finish-Early 'the repository updated, but the new revision could not be read.'
}

Write-Host "Updated SillyBunny from $beforeRev to $afterRev."
