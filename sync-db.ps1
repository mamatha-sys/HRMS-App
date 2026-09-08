$ErrorActionPreference = "Stop"

# ==========================================
# HRMS LOCAL -> VPS DATABASE SYNC
# LOCAL DATABASE = MASTER
# WAL-SAFE SQLITE BACKUP
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
Write-Host " WAL-SAFE SQLITE BACKUP"
Write-Host " SAFE MODE + AUTO ROLLBACK"
Write-Host "=========================================="
Write-Host ""

# ==========================================
# STEP 1
# Create WAL-safe local backup
# ==========================================

Write-Host "[1/9] Creating WAL-safe SQLite backup..."

if (!(Test-Path $LocalDb)) {
    throw "Local database not found: $LocalDb"
}

Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

Push-Location "$ProjectRoot\server"

$BackupCode = @'
const Database = require("better-sqlite3");

(async () => {
    const source = new Database("./data/hrms.db", {
        readonly: true
    });

    try {
        await source.backup("./data/hrms-sync-temp.db");
        console.log("SQLite backup completed.");
    } finally {
        source.close();
    }

    const test = new Database("./data/hrms-sync-temp.db", {
        readonly: true
    });

    try {
        const integrity = test.pragma("integrity_check", {
            simple: true
        });

        console.log("Backup integrity:", integrity);

        if (integrity !== "ok") {
            throw new Error(
                "Backup integrity check failed: " + integrity
            );
        }
    } finally {
        test.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
'@

$BackupCode | Set-Content ".\create-safe-backup.cjs" -Encoding UTF8

node ".\create-safe-backup.cjs"

$NodeExit = $LASTEXITCODE

Remove-Item ".\create-safe-backup.cjs" -Force -ErrorAction SilentlyContinue

Pop-Location

if ($NodeExit -ne 0) {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "SQLite backup creation failed."
}

if (!(Test-Path $LocalSnapshot)) {
    throw "SQLite backup was not created."
}

Write-Host "Backup created:"
Write-Host $LocalSnapshot

# ==========================================
# STEP 2
# Validate local backup
# ==========================================

Write-Host ""
Write-Host "[2/9] Validating local backup..."

Push-Location "$ProjectRoot\server"

$LocalCheck = node -e "const Database=require('better-sqlite3'); const db=new Database('./data/hrms-sync-temp.db',{readonly:true}); console.log(db.pragma('integrity_check',{simple:true})); db.close();"

$NodeExit = $LASTEXITCODE

Pop-Location

if ($NodeExit -ne 0) {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Local backup could not be opened."
}

Write-Host "Local integrity:"
Write-Host $LocalCheck

if ($LocalCheck.Trim() -ne "ok") {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "LOCAL BACKUP FAILED INTEGRITY CHECK."
}

Write-Host "Local backup integrity OK."

# ==========================================
# STEP 3
# Upload temporary database
# ==========================================

Write-Host ""
Write-Host "[3/9] Uploading database backup..."

scp -i $SshKey $LocalSnapshot "${VpsHost}:${VpsTempDb}"

if ($LASTEXITCODE -ne 0) {
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Upload failed."
}

Write-Host "Upload completed."

# ==========================================
# STEP 4
# Validate uploaded database
# ==========================================

Write-Host ""
Write-Host "[4/9] Validating uploaded VPS database..."

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
# Stop HRMS and checkpoint old WAL
# ==========================================

Write-Host ""
Write-Host "[5/9] Stopping HRMS and preparing SQLite..."

ssh -i $SshKey $VpsHost "pm2 stop hrms"

if ($LASTEXITCODE -ne 0) {
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Failed to stop HRMS."
}

Write-Host "HRMS stopped."

Write-Host "Checkpointing existing VPS WAL..."

$Checkpoint = ssh -i $SshKey $VpsHost "sqlite3 '$VpsDb' 'PRAGMA wal_checkpoint(TRUNCATE);'"

if ($LASTEXITCODE -ne 0) {
    Write-Host "WAL checkpoint failed."
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Existing VPS WAL checkpoint failed."
}

Write-Host "WAL checkpoint:"
Write-Host $Checkpoint

# ==========================================
# STEP 6
# Backup complete production DB state
# ==========================================

Write-Host ""
Write-Host "[6/9] Backing up current production database..."

ssh -i $SshKey $VpsHost "cp '$VpsDb' '$VpsBackup'"

if ($LASTEXITCODE -ne 0) {
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Failed to create VPS production backup."
}

Write-Host "Production backup:"
Write-Host $BackupName

# ==========================================
# STEP 7
# Remove stale WAL/SHM and replace DB
# ==========================================

Write-Host ""
Write-Host "[7/9] Replacing production database..."

# Remove old WAL/SHM only after HRMS is stopped
# and WAL checkpoint has completed.

ssh -i $SshKey $VpsHost "rm -f '$VpsDb-wal' '$VpsDb-shm'"

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to remove old WAL/SHM files."
    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"
    ssh -i $SshKey $VpsHost "rm -f '$VpsTempDb'"
    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue
    throw "Could not remove old SQLite WAL/SHM files."
}

ssh -i $SshKey $VpsHost "mv '$VpsTempDb' '$VpsDb'"

if ($LASTEXITCODE -ne 0) {
    Write-Host "Database replacement failed."
    Write-Host "Restoring previous database..."

    ssh -i $SshKey $VpsHost "rm -f '$VpsDb-wal' '$VpsDb-shm'"
    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "Database replacement failed."
}

Write-Host "Production database replaced."

# Make absolutely sure no stale sidecar files survived
ssh -i $SshKey $VpsHost "rm -f '$VpsDb-wal' '$VpsDb-shm'"

Write-Host "Old WAL/SHM files cleared."

# ==========================================
# STEP 8
# Validate production and restart
# ==========================================

Write-Host ""
Write-Host "[8/9] Validating production database..."

$ProductionCheck = ssh -i $SshKey $VpsHost "sqlite3 '$VpsDb' 'PRAGMA integrity_check;'"

Write-Host "Production integrity:"
Write-Host $ProductionCheck

if ($LASTEXITCODE -ne 0 -or $ProductionCheck.Trim() -ne "ok") {

    Write-Host ""
    Write-Host "PRODUCTION INTEGRITY FAILED."
    Write-Host "Automatic rollback starting..."

    ssh -i $SshKey $VpsHost "rm -f '$VpsDb-wal' '$VpsDb-shm'"
    ssh -i $SshKey $VpsHost "rm -f '$VpsDb'"
    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"
    ssh -i $SshKey $VpsHost "pm2 save"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "Production integrity failed. Previous database restored."
}

Write-Host "Production database integrity OK."

Write-Host ""
Write-Host "Starting HRMS..."

ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"

if ($LASTEXITCODE -ne 0) {

    Write-Host "HRMS restart failed."
    Write-Host "Automatic database rollback starting..."

    ssh -i $SshKey $VpsHost "pm2 stop hrms"
    ssh -i $SshKey $VpsHost "rm -f '$VpsDb-wal' '$VpsDb-shm'"
    ssh -i $SshKey $VpsHost "rm -f '$VpsDb'"
    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"
    ssh -i $SshKey $VpsHost "pm2 save"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "HRMS restart failed."
}

Start-Sleep -Seconds 5

Write-Host "Checking API health..."

$Health = ssh -i $SshKey $VpsHost "curl -fsS http://127.0.0.1:4000/api/health"

if ($LASTEXITCODE -ne 0) {

    Write-Host ""
    Write-Host "API HEALTH CHECK FAILED."
    Write-Host "Automatic database rollback starting..."

    ssh -i $SshKey $VpsHost "pm2 stop hrms"
    ssh -i $SshKey $VpsHost "rm -f '$VpsDb-wal' '$VpsDb-shm'"
    ssh -i $SshKey $VpsHost "rm -f '$VpsDb'"
    ssh -i $SshKey $VpsHost "cp '$VpsBackup' '$VpsDb'"
    ssh -i $SshKey $VpsHost "pm2 restart hrms --update-env"
    ssh -i $SshKey $VpsHost "pm2 save"

    Remove-Item $LocalSnapshot -Force -ErrorAction SilentlyContinue

    throw "API health check failed."
}

Write-Host "API:"
Write-Host $Health

ssh -i $SshKey $VpsHost "pm2 save"

# ==========================================
# STEP 9
# Cleanup
# ==========================================

Write-Host ""
Write-Host "[9/9] Cleaning temporary files..."

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