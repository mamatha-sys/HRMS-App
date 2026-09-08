$ErrorActionPreference = "Stop"

# ==========================================
# HRMS LOCAL → VPS DATABASE SYNC
# LOCAL DATABASE = MASTER
# SAFE MODE + AUTO ROLLBACK
# ==========================================

$ProjectRoot = "C:\Users\USER\Downloads\HRMS\HRMS-App"

$LocalDb       = "$ProjectRoot\server\data\hrms.db"
$LocalSnapshot = "$ProjectRoot\server\data\hrms-sync-temp.db"

$VpsHost   = "root@72.61.233.104"
$SshKey    = "$env:USERPROFILE\.ssh\hostinger_hrms"

$VpsDbDir  = "/opt/HRMS-App/server/data"
$VpsDb     = "$VpsDbDir/hrms.db"
$VpsTempDb = "$VpsDbDir/hrms-sync-temp.db"

$Timestamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupName = "hrms-before-sync-$Timestamp.db"
$VpsBackup  = "$VpsDbDir/$BackupName"

Write-Host ""
Write-Host "=========================================="
Write-Host " HRMS DATABASE SYNC"
Write-Host " LOCAL = MASTER"
Write-Host " SAFE MODE + AUTO ROLLBACK"
Write-Host "=========================================="
Write-Host ""

# ==========================================
# STEP 1
# Create SQLite snapshot
# ==========================================

Write-Host "[1/8] Creating SQLite snapshot..."

if (!(Test-Path $LocalDb)) {
    throw "Local database not found: $LocalDb"
}

Push-Location "$ProjectRoot\server"

node create-db-snapshot.cjs

if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "SQLite snapshot creation failed."
}

Pop-Location

if (!(Test-Path $LocalSnapshot)) {
    throw "Snapshot was not created."
}

Write-Host "Snapshot created:"
Write-Host $LocalSnapshot

# ==========================================
# STEP 2
# Validate snapshot locally
# ==========================================

Write-Host ""
Write-Host "[2/8] Validating local snapshot..."

Push-Location "$ProjectRoot\server"

$LocalCheck = node -e "const Database=require('better-sqlite3'); const db=new Database('./data/hrms-sync-temp.db',{readonly:true}); const r=db.prepare('PRAGMA integrity_check').all(); console.log(r.map(x=>x.integrity_check).join('\n')); db.close();"

$NodeExit = $LASTEXITCODE

Pop-Location

if ($NodeExit -ne 0) {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Local snapshot could not be opened by better-sqlite3."
}

Write-Host "Local integrity:"
Write-Host $LocalCheck

if ($LocalCheck.Trim() -ne "ok") {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "LOCAL SNAPSHOT FAILED INTEGRITY CHECK."
}

Write-Host "Local snapshot integrity OK."

# ==========================================
# STEP 3
# Upload to VPS
# ==========================================

Write-Host ""
Write-Host "[3/8] Uploading snapshot..."

scp -i $SshKey $LocalSnapshot "${VpsHost}:${VpsTempDb}"

if ($LASTEXITCODE -ne 0) {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Upload failed."
}

Write-Host "Upload completed."

# ==========================================
# STEP 4
# Validate uploaded VPS DB
# ==========================================

Write-Host ""
Write-Host "[4/8] Validating uploaded VPS database..."

$VpsCheck = ssh -i $SshKey $VpsHost "sqlite3 '$VpsTempDb' 'PRAGMA integrity_check;'"

if ($LASTEXITCODE -ne 0) {
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "VPS temporary database validation failed."
}

Write-Host "VPS integrity:"
Write-Host $VpsCheck

if ($VpsCheck.Trim() -ne "ok") {
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Uploaded VPS database failed integrity check."
}

Write-Host "VPS temporary database integrity OK."

# ==========================================
# STEP 5
# Stop HRMS + Backup
# ==========================================

Write-Host ""
Write-Host "[5/8] Preparing production..."

Write-Host "Stopping HRMS..."

ssh -i $SshKey $VpsHost "pm2 stop hrms"

if ($LASTEXITCODE -ne 0) {
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Failed to stop HRMS."
}

Write-Host "Creating VPS backup..."

ssh -i $SshKey $VpsHost "cp '$VpsDb' '$VpsBackup'"

if ($LASTEXITCODE -ne 0) {
    ssh -i $SshKey $VpsHost "pm2 restart hrms"
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Failed to create VPS backup."
}

Write-Host "Backup created:"
Write-Host $BackupName

# ==========================================
# STEP 6
# Replace production DB
# ==========================================

Write-Host ""
Write-Host "[6/8] Replacing production database..."

ssh -i $SshKey $VpsHost "mv '$VpsTempDb' '$VpsDb'"

if ($LASTEXITCODE -ne 0) {

    Write-Host "Replacement failed."
    Write-Host "Restoring backup..."

    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "Database replacement failed."
}

Write-Host "Production database replaced."

Write-Host "Checking production integrity..."

$ProductionCheck = ssh -i $SshKey $VpsHost "sqlite3 '$VpsDb' 'PRAGMA integrity_check;'"

Write-Host $ProductionCheck

if ($LASTEXITCODE -ne 0 -or $ProductionCheck.Trim() -ne "ok") {

    Write-Host ""
    Write-Host "Integrity failed."
    Write-Host "Restoring previous database..."

    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms"
    ssh -i $SshKey $VpsHost "pm2 save"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "Production integrity failed. Previous database restored."
}

Write-Host "Production integrity OK."

# ==========================================
# STEP 7
# Restart HRMS
# ==========================================

Write-Host ""
Write-Host "[7/8] Starting HRMS..."

ssh -i $SshKey $VpsHost "pm2 restart hrms"

if ($LASTEXITCODE -ne 0) {

    Write-Host "HRMS restart failed."
    Write-Host "Restoring previous database..."

    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms"
    ssh -i $SshKey $VpsHost "pm2 save"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "HRMS restart failed."
}

ssh -i $SshKey $VpsHost "pm2 save"

Start-Sleep -Seconds 5

Write-Host "Checking API..."

$Health = ssh -i $SshKey $VpsHost "curl -fsS http://127.0.0.1:4000/api/health"

if ($LASTEXITCODE -ne 0) {

    Write-Host ""
    Write-Host "API health failed."
    Write-Host "Restoring previous database..."

    ssh -i $SshKey $VpsHost "pm2 stop hrms"
    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms"
    ssh -i $SshKey $VpsHost "pm2 save"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "API health check failed."
}

Write-Host "API:"
Write-Host $Health

# ==========================================
# STEP 8
# Cleanup
# ==========================================

Write-Host ""
Write-Host "[8/8] Cleaning temporary files..."

Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"

Write-Host ""
Write-Host "=========================================="
Write-Host " DATABASE SYNC SUCCESSFUL"
Write-Host "=========================================="
Write-Host ""
Write-Host "Local DB : MASTER"
Write-Host "VPS DB   : UPDATED"
Write-Host "Backup   : $BackupName"
Write-Host "API      : $Health"
Write-Host ""