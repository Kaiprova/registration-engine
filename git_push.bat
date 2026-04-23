@echo off
REM KaiProva registration-engine — stage, commit, push
REM Usage:  git_push.bat "your commit message here"
REM If no message supplied, a default one is used.

cd /d C:\Users\alps2\Projects\kaiprova\registration-engine

REM Kill any stuck git/Git-GUI processes and lock files (safety net)
taskkill /f /im wish.exe 2>nul
taskkill /f /im git.exe 2>nul
timeout /t 1 /nobreak >nul
del /f .git\HEAD.lock 2>nul
del /f .git\index.lock 2>nul

REM Stage only the meaningful changes — avoids line-ending noise in other files
git add public/index.html
git add supabase/schema.sql
git add CLAUDE.md

REM Commit (use message from argument, or fall back to default)
if "%~1"=="" (
  git commit -m "feat(phase1): dashboard look + left sidebar nav (Overview/Mobs/Planner/Offers/Trace)"
) else (
  git commit -m %1
)

REM Push to GitHub — Railway auto-deploys on push to main
git push origin main

echo.
echo Done. Watch Railway build at:
echo https://railway.com/project/4706c603-1a3f-42bf-89b2-7bd61acdb638/service/8657413e-a6ca-4dd6-8776-526511c4d482
echo.
pause
