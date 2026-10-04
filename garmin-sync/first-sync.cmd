@echo off
rem One-time first Garmin login from home (Garmin blocks cloud IPs).
rem Saves session tokens to Supabase Vault; the cloud sync resumes from them.
cd /d "%~dp0"
echo ==== %date% %time% ==== >> first-sync.log
".venv\Scripts\python.exe" sync_all.py --days 60 >> first-sync.log 2>&1
echo exit code %errorlevel% >> first-sync.log
