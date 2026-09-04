@echo off
title HRMS SQLite Snapshot Creator

REM Save the current folder
pushd C:\Users\USER\Downloads\HRMS\HRMS-App\server

echo.
echo ==========================================
echo Creating SQLite snapshot...
echo ==========================================
echo.

node -e "const fs=require('fs'); fs.copyFileSync('data/hrms.db','data/hrms-upload.db'); console.log('Snapshot created.');"

echo.
echo Snapshot saved as server\data\hrms-upload.db

REM Return to the previous folder
popd