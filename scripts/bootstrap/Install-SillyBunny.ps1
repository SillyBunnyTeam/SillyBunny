# SillyBunny bootstrap installer for Windows.
#
# Runs before the repository exists, either through Install-SillyBunny.cmd or as
#   irm https://github.com/SillyBunnyTeam/SillyBunny/releases/latest/download/Install-SillyBunny.ps1 | iex
# Under `iex` this text runs in the caller's session, so everything lives inside a
# function (no leaked preferences) and failures throw instead of calling `exit`,
# which would close the user's PowerShell window.
[CmdletBinding()]
param(
    [string]$Dir = '',
    [string]$Ref = 'release',
    [string]$Repo = 'https://github.com/SillyBunnyTeam/SillyBunny.git',
    [string]$MigrateFrom = '',
    [switch]$NoStart,
    [ValidateSet('', 'bun', 'node')]
    [string]$Runtime = ''
)

function Install-SillyBunny {
    param(
        [string]$Dir,
        [string]$Ref,
        [string]$Repo,
        [string]$MigrateFrom,
        [bool]$NoStart,
        [bool]$RefOverridden,
        [bool]$RunWizard,
        [string]$Runtime,
        [string]$InstallerName
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # Portable Git fallback for machines without winget, Chocolatey or Scoop.
    $minGitVersion = '2.56.0'
    $minGitBaseUrl = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1'
    $minGitPackages = @{
        'x64' = @{ File = 'MinGit-2.56.0-64-bit.zip'; Sha256 = '064b440ff870ed5198527e8f3a92cdf5bd2fd0fedf5e718af95e3fdaddeff718' }
        'arm64' = @{ File = 'MinGit-2.56.0-arm64.zip'; Sha256 = 'cb3b0f2d486ea52673227151a5baf5bc13861ff80e74e94e46d614d1bfcd5c06' }
    }

    function Write-Step([string]$Message) {
        Write-Host "[SillyBunny] $Message"
    }

    function Test-Command([string]$Name) {
        return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
    }

    function Add-SessionPath([string]$Candidate) {
        if ([string]::IsNullOrWhiteSpace($Candidate) -or -not (Test-Path -LiteralPath $Candidate)) {
            return
        }
        if (($env:Path -split ';') -notcontains $Candidate) {
            $env:Path = "$Candidate;$env:Path"
        }
    }

    function Update-KnownGitPaths {
        if ($env:ProgramFiles) { Add-SessionPath (Join-Path $env:ProgramFiles 'Git\cmd') }
        $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
        if ($programFilesX86) { Add-SessionPath (Join-Path $programFilesX86 'Git\cmd') }
        if ($env:LocalAppData) {
            Add-SessionPath (Join-Path $env:LocalAppData 'Programs\Git\cmd')
            Add-SessionPath (Join-Path $env:LocalAppData 'SillyBunny\MinGit\cmd')
        }
        Add-SessionPath (Join-Path $env:USERPROFILE 'scoop\shims')
    }

    function Test-Git {
        Update-KnownGitPaths
        if (-not (Test-Command 'git')) { return $false }
        & git --version *> $null
        return $LASTEXITCODE -eq 0
    }

    function Install-MinGit {
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
        $key = if ($arch -eq 'ARM64') { 'arm64' } elseif ($arch -eq 'AMD64') { 'x64' } else { '' }
        if (-not $key) {
            throw "No portable Git is available for $arch. Install Git from https://git-scm.com/downloads, then rerun this installer."
        }

        $package = $minGitPackages[$key]
        $root = Join-Path $env:LocalAppData 'SillyBunny'
        $target = Join-Path $root 'MinGit'
        $zip = Join-Path $root $package.File

        Write-Step "Downloading portable Git $minGitVersion..."
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri "$minGitBaseUrl/$($package.File)" -OutFile $zip

        $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ($hash -ne $package.Sha256) {
            Remove-Item -LiteralPath $zip -Force
            throw "The portable Git download failed its checksum check (got $hash). Nothing was installed."
        }

        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $target
        Remove-Item -LiteralPath $zip -Force

        # Persist for later launches of Start.bat; the current session is updated below.
        $gitCmd = Join-Path $target 'cmd'
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not $userPath) { $userPath = '' }
        if (($userPath -split ';') -notcontains $gitCmd) {
            [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ";$gitCmd").TrimStart(';')), 'User')
        }
        Add-SessionPath $gitCmd
    }

    function Install-Git {
        if (Test-Git) { return }

        Write-Step 'Git was not found. Installing it...'
        $attempts = @(
            @{ Name = 'winget'; Run = { & winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements } },
            @{ Name = 'choco'; Run = { & choco install git -y } },
            @{ Name = 'scoop'; Run = { & scoop install git } }
        )

        foreach ($attempt in $attempts) {
            if (-not (Test-Command $attempt.Name)) { continue }
            try {
                & $attempt.Run
            } catch {
                Write-Step "$($attempt.Name) could not install Git: $_"
            }
            if (Test-Git) { return }
        }

        Install-MinGit
        if (-not (Test-Git)) {
            throw "Git was installed, but 'git' is still unavailable in this session."
        }
    }

    function Resolve-FullPath([string]$Path) {
        if ($Path -eq '~') { $Path = $env:USERPROFILE }
        elseif ($Path.StartsWith('~\') -or $Path.StartsWith('~/')) { $Path = Join-Path $env:USERPROFILE $Path.Substring(2) }
        $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
        return $full.TrimEnd('\', '/')
    }

    function Test-SillyBunnyDir([string]$Path) {
        $packageJson = Join-Path $Path 'package.json'
        if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { return $false }
        return [bool](Select-String -LiteralPath $packageJson -Pattern '"name"\s*:\s*"sillybunny"' -Quiet)
    }

    function Test-EmptyDir([string]$Path) {
        return $null -eq (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)
    }

    function Test-UnderPath([string]$Path, [string]$Parent) {
        if ([string]::IsNullOrWhiteSpace($Parent)) { return $false }
        $parentFull = $Parent.TrimEnd('\') + '\'
        return ($Path + '\').StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)
    }

    # git clones only into an empty folder, and people often save the installer into
    # the folder they want to install to. Checking for the file itself sidesteps
    # short (8.3) names, junctions and casing that would defeat a path comparison.
    function Test-HoldsInstaller([string]$Path) {
        return $InstallerName -and (Test-Path -LiteralPath (Join-Path $Path $InstallerName) -PathType Leaf)
    }

    # Git writes progress to stderr. Under Windows PowerShell 5.1 that output becomes
    # an error record once a caller redirects it (`*>&1`, a log file), and Stop would
    # abort a clone that is working; trust the exit code instead.
    function Invoke-Git {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & git @args
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed." }
    }

    # Data root relative to the install folder, or an absolute path.
    function Get-DataRoot([string]$Path) {
        $config = Join-Path $Path 'config.yaml'
        $value = ''
        if (Test-Path -LiteralPath $config -PathType Leaf) {
            $line = Get-Content -LiteralPath $config | Where-Object { $_ -match '^dataRoot:' } | Select-Object -First 1
            if ($line) {
                $value = ($line -replace '^dataRoot:\s*', '' -replace '\s+#.*$', '').Trim().Trim('"', "'")
            }
        }
        if (-not $value) { $value = './data' }
        return $value
    }

    function Test-AbsolutePath([string]$Path) {
        return [System.IO.Path]::IsPathRooted($Path) -and -not $Path.StartsWith('.')
    }

    function Get-RelativeDataRoot([string]$Value) {
        $relative = ($Value -replace '^\.[\\/]', '').TrimEnd('\', '/')
        $segments = $relative -split '[\\/]'
        if (-not $relative -or $segments -contains '..' -or $relative -eq '.') {
            throw "The old config.yaml has a dataRoot outside its folder ($Value). Set an absolute dataRoot there, then rerun."
        }
        return $relative
    }

    function Assert-MigrationSource([string]$Source, [string]$Target) {
        if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "The folder to migrate from does not exist: $Source" }
        if (-not (Test-SillyBunnyDir $Source)) { throw "This doesn't look like a SillyBunny folder: $Source" }

        if (Test-Path -LiteralPath (Join-Path $Source '.git')) {
            # A proper bootstrap-managed Git install has scripts\Self-Update.ps1 alongside
            # .git. Old ZIP releases that were packaged from a git clone also contain .git
            # but do not have the self-update script, so migration from them is allowed.
            if (Test-Path -LiteralPath (Join-Path $Source 'scripts\Self-Update.ps1')) {
                throw "$Source is already a Git install and updates itself. Run its Start.bat instead of migrating."
            }
            Write-Step "Note: $Source contains a .git folder but no Self-Update.ps1; treating it as a ZIP release."
        }

        if ($Source -ieq $Target) {
            throw "The old install is at the target folder. Pick a new folder with -Dir, for example: -Dir `"$env:USERPROFILE\SillyBunny-new`""
        }
        if (Test-UnderPath $Target $Source) { throw 'The new install folder cannot be inside the old one.' }

        $dataRoot = Get-DataRoot $Source
        if (-not (Test-AbsolutePath $dataRoot)) { Get-RelativeDataRoot $dataRoot | Out-Null }
    }

    function Copy-UntrackedEntries([string]$Source, [string]$Target, [string]$Relative, [System.Collections.Generic.List[string]]$Copied) {
        $from = Join-Path $Source $Relative
        if (-not (Test-Path -LiteralPath $from -PathType Container)) { return }
        $to = Join-Path $Target $Relative
        New-Item -ItemType Directory -Force -Path $to | Out-Null

        foreach ($entry in Get-ChildItem -LiteralPath $from -Force) {
            $gitPath = "$($Relative -replace '\\', '/')/$($entry.Name)"
            $tracked = & git -C $Target ls-files -- $gitPath
            if ($tracked) { continue }
            Copy-Item -LiteralPath $entry.FullName -Destination $to -Recurse -Force
            $Copied.Add("$Relative\$($entry.Name)")
        }
    }

    function Copy-OldInstall([string]$Source, [string]$Target) {
        $copied = New-Object 'System.Collections.Generic.List[string]'
        Write-Step "Copying your data from $Source. The old folder is left as it is."

        $config = Join-Path $Source 'config.yaml'
        if (Test-Path -LiteralPath $config -PathType Leaf) {
            Copy-Item -LiteralPath $config -Destination $Target -Force
            $copied.Add('config.yaml')
        }

        $dataRoot = Get-DataRoot $Source
        if (Test-AbsolutePath $dataRoot) {
            Write-Step "Your data root is $dataRoot, outside the old folder; the new install will keep using it."
        } else {
            $relative = Get-RelativeDataRoot $dataRoot
            $from = Join-Path $Source $relative
            if (Test-Path -LiteralPath $from -PathType Container) {
                $to = Join-Path $Target $relative
                New-Item -ItemType Directory -Force -Path $to | Out-Null
                foreach ($entry in Get-ChildItem -LiteralPath $from -Force) {
                    Copy-Item -LiteralPath $entry.FullName -Destination $to -Recurse -Force
                }
                $copied.Add("$relative\")
            }
        }

        Copy-UntrackedEntries $Source $Target 'plugins' $copied
        Copy-UntrackedEntries $Source $Target 'public\scripts\extensions\third-party' $copied

        foreach ($name in @('secrets.json', 'certs')) {
            $path = Join-Path $Source $name
            if (Test-Path -LiteralPath $path) {
                Copy-Item -LiteralPath $path -Destination $Target -Recurse -Force
                $copied.Add($name)
            }
        }

        if ($copied.Count -gt 0) {
            Write-Step 'Copied:'
            foreach ($item in $copied) { Write-Host "    $item" }
        } else {
            Write-Step 'Nothing to copy was found in the old folder.'
        }
    }

    function Start-SillyBunny([string]$Target) {
        if ($NoStart) {
            Write-Step "Done. Start SillyBunny by running Start.bat in $Target"
            return
        }
        Write-Step 'Starting SillyBunny...'
        Push-Location -LiteralPath $Target
        try {
            $env:SILLYBUNNY_USE_BUN  = if ($Runtime -eq 'bun')  { '1' } else { $null }
            $env:SILLYBUNNY_USE_NODE = if ($Runtime -eq 'node') { '1' } else { $null }
            & cmd.exe /c Start.bat
        } finally {
            Remove-Item Env:\SILLYBUNNY_USE_BUN  -ErrorAction SilentlyContinue
            Remove-Item Env:\SILLYBUNNY_USE_NODE -ErrorAction SilentlyContinue
            Pop-Location
        }
    }

    # Interactive setup wizard. Shown when no user-facing parameters were passed
    # and the session is interactive (i.e. the user double-clicked Install-SillyBunny.cmd
    # or ran the script directly in a console with no arguments).
    # Returns a hashtable with Dir, MigrateFrom, and NoStart keys.
    function Invoke-Wizard {
        $defaultDir = Join-Path $env:USERPROFILE 'SillyBunny'
        $wizDir = ''
        $wizMigrateFrom = ''
        $wizNoStart = $false
        $wizRuntime = ''

        Write-Host ''
        Write-Host '[SillyBunny] Setup'
        Write-Host ('=' * 42)
        Write-Host ''

        # Step 1 — install directory
        Write-Host 'Install directory'
        Write-Host '  Where should SillyBunny be installed?'
        Write-Host "  Leave blank for the default: $defaultDir"
        while ($true) {
            $answer = Read-Host '  >'
            $candidate = if ($answer.Trim()) { $answer.Trim() } else { $defaultDir }
            if (Test-HoldsInstaller (Resolve-FullPath $candidate)) {
                Write-Host "  That folder holds this installer ($InstallerName), and the install needs an empty folder."
                Write-Host "  Pick another folder, for example: $(Join-Path (Resolve-FullPath $candidate) 'SillyBunny')"
                continue
            }
            if ($answer.Trim()) { $wizDir = $answer.Trim() }
            break
        }

        # Step 2 — migration
        Write-Host ''
        Write-Host 'Migrate from an older installation? (optional)'
        Write-Host '  If you have a previous SillyBunny ZIP release, enter its folder path'
        Write-Host '  to copy your chats, settings, and plugins to the new install.'
        Write-Host '  Leave blank to skip.'
        while ($true) {
            $answer = Read-Host '  >'
            if (-not $answer.Trim()) { break }
            $expanded = $answer.Trim()
            if ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
                $expanded = Join-Path $env:USERPROFILE $expanded.Substring(2)
            }
            if (-not (Test-Path -LiteralPath $expanded -PathType Container)) {
                Write-Host '  That folder does not exist. Try again, or leave blank to skip.'
                continue
            }
            $wizMigrateFrom = $expanded
            break
        }

        # Step 3 — runtime (Windows always supports Bun; this step is always shown)
        Write-Host ''
        Write-Host 'Runtime'
        Write-Host '  Which JavaScript runtime should SillyBunny use?'
        Write-Host '  Bun is faster; Node.js is the fallback for systems where Bun has issues.'
        $answer = Read-Host '  [B]un / [n]ode (default: Bun)'
        if ($answer.Trim() -imatch '^n(ode)?$') {
            $wizRuntime = 'node'
        } else {
            $wizRuntime = 'bun'
        }

        # Step 4 — start after install
        Write-Host ''
        $answer = Read-Host 'Start SillyBunny when setup finishes? [Y/n]'
        if ($answer.Trim() -imatch '^n(o)?$') { $wizNoStart = $true }

        # Summary
        $displayDir = if ($wizDir) { $wizDir } else { $defaultDir }
        $startLabel = if ($wizNoStart) { 'No' } else { 'Yes' }
        Write-Host ''
        Write-Host ('=' * 42)
        Write-Host "  Install to:          $displayDir"
        if ($wizMigrateFrom) { Write-Host "  Migrate from:        $wizMigrateFrom" }
        Write-Host "  Start after install: $startLabel"
        if ($wizRuntime) { Write-Host "  Runtime:             $wizRuntime" }
        Write-Host ('=' * 42)
        # Discard the reply; uncaptured, it would become part of the return value.
        $null = Read-Host 'Press Enter to begin, or Ctrl+C to cancel'
        Write-Host ''

        return @{ Dir = $wizDir; MigrateFrom = $wizMigrateFrom; NoStart = $wizNoStart; Runtime = $wizRuntime }
    }

    if ($Ref.StartsWith('-') -or $Repo.StartsWith('-')) { throw 'Invalid -Ref or -Repo value.' }

    if ($RunWizard) {
        $wizResult = Invoke-Wizard
        if ($wizResult.Dir)          { $Dir         = $wizResult.Dir }
        if ($wizResult.MigrateFrom)  { $MigrateFrom = $wizResult.MigrateFrom }
        if ($wizResult.NoStart)      { $NoStart      = $true }
        if ($wizResult.Runtime)      { $Runtime      = $wizResult.Runtime }
    }

    if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE 'SillyBunny' }
    $Dir = Resolve-FullPath $Dir
    if ($MigrateFrom) { $MigrateFrom = Resolve-FullPath $MigrateFrom }

    foreach ($oneDrive in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
        if (Test-UnderPath $Dir $oneDrive) {
            Write-Warning "$Dir is inside OneDrive. Syncing can lock or corrupt files while SillyBunny runs; a folder outside OneDrive is safer."
            break
        }
    }

    Install-Git

    if (Test-Path -LiteralPath (Join-Path $Dir '.git')) {
        if (-not (Test-SillyBunnyDir $Dir)) { throw "$Dir is a Git checkout of something else. Pick another folder with -Dir." }
        if ($MigrateFrom) { throw "$Dir already has an install. Migrate into a new folder with -Dir." }
        Write-Step "SillyBunny is already installed in $Dir. Updating it instead of reinstalling."
        if ($RefOverridden) { Write-Step '-Ref is ignored for an existing install.' }
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'scripts\Self-Update.ps1') -Optional
        Start-SillyBunny $Dir
        return
    }

    if ((Test-Path -LiteralPath $Dir) -and -not (Test-EmptyDir $Dir)) {
        if (Test-SillyBunnyDir $Dir) {
            throw "$Dir is an old ZIP install. Install into a new folder and copy your data across with: -Dir `"$env:USERPROFILE\SillyBunny-new`" -MigrateFrom `"$Dir`""
        }
        if (Test-HoldsInstaller $Dir) {
            throw "$Dir holds this installer ($InstallerName), and the install needs an empty folder. Install into a subfolder instead: -Dir `"$(Join-Path $Dir 'SillyBunny')`""
        }
        throw "$Dir exists and isn't empty. Pick another folder with -Dir."
    }

    if ($MigrateFrom) { Assert-MigrationSource $MigrateFrom $Dir }

    Write-Step "Downloading SillyBunny ($Ref) into $Dir..."
    $parent = Split-Path -Parent $Dir
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Invoke-Git -c advice.detachedHead=false clone --filter=blob:none --branch $Ref -- $Repo $Dir

    & git -C $Dir symbolic-ref --quiet HEAD *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Step "Installed tag $Ref. Automatic updates are off for a pinned tag."
        Write-Step "To follow stable releases later, run: git -C `"$Dir`" checkout release"
    }

    if ($MigrateFrom) { Copy-OldInstall $MigrateFrom $Dir }

    Start-SillyBunny $Dir
}

# Show the wizard when no user-facing parameters were explicitly passed and the
# session is interactive (double-clicked .cmd or run directly in a console).
$runWizard = (
    -not $PSBoundParameters.ContainsKey('Dir') -and
    -not $PSBoundParameters.ContainsKey('MigrateFrom') -and
    -not $PSBoundParameters.ContainsKey('NoStart') -and
    [Environment]::UserInteractive
)

# Empty under `irm | iex`, where no installer file exists on disk.
$installerName = if ($PSCommandPath) { Split-Path -Leaf $PSCommandPath } else { '' }

Install-SillyBunny -Dir $Dir -Ref $Ref -Repo $Repo -MigrateFrom $MigrateFrom -NoStart $NoStart.IsPresent -RefOverridden ($PSBoundParameters.ContainsKey('Ref')) -RunWizard $runWizard -Runtime $Runtime -InstallerName $installerName
