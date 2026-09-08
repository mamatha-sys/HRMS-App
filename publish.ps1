$ErrorActionPreference = "Stop"

$ProjectRoot = "C:\Users\USER\Downloads\HRMS\HRMS-App"

Write-Host ""
Write-Host "=================================================="
Write-Host " HRMS PUBLISH"
Write-Host " LOCAL = MASTER"
Write-Host "=================================================="
Write-Host ""

Set-Location $ProjectRoot

Write-Host "[1/4] Checking Git status..."
git status --short

Write-Host ""
Write-Host "[2/4] Synchronizing LOCAL database -> VPS..."
& "$ProjectRoot\sync-db.ps1"

if ($LASTEXITCODE -ne 0) {
    throw "Database synchronization failed. GitHub push cancelled."
}

Write-Host ""
Write-Host "Database synchronization completed successfully."

Write-Host ""
Write-Host "[3/4] Committing code changes..."

$CommitMessage = $args -join " "

if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    $CommitMessage = "Update HRMS"
}

git add .

git diff --cached --quiet

if ($LASTEXITCODE -eq 0) {
    Write-Host "No code changes to commit."
}
else {
    git commit -m $CommitMessage

    if ($LASTEXITCODE -ne 0) {
        throw "Git commit failed."
    }
}

Write-Host ""
Write-Host "[4/4] Pushing to GitHub..."

git push origin main

if ($LASTEXITCODE -ne 0) {
    throw "GitHub push failed."
}

Write-Host ""
Write-Host "=================================================="
Write-Host " HRMS PUBLISH COMPLETED"
Write-Host "=================================================="
Write-Host ""
Write-Host "Database : Local -> VPS"
Write-Host "Code     : Local -> GitHub"
Write-Host "VPS      : Automatic deployment"
Write-Host ""
Write-Host "Commit:"
git rev-parse --short HEAD
Write-Host ""
