@echo off
title HRMS One-Click Deployment

cd /d C:\Users\USER\Downloads\HRMS\HRMS-App

echo.
echo ==========================================
echo HRMS One-Click Deployment
echo ==========================================
echo.

echo [1/5] Creating SQLite snapshot...
call snapshot_db.bat

REM Make sure we're back in the project root
cd /d C:\Users\USER\Downloads\HRMS\HRMS-App

echo.
echo [2/5] Adding Git changes...
git add .

echo.
echo [3/5] Creating commit...
set /p msg=Enter commit message:
if "%msg%"=="" set msg=HRMS update

git commit -m "%msg%"

echo.
echo [4/5] Pushing to GitHub...
git push origin main

echo.
echo [5/5] Deployment triggered.
echo GitHub Actions:
echo https://github.com/mamatha-sys/HRMS-App/actions
pause