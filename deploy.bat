@echo off
set DEST=\\truenas.local\docker\keybr.com

copy /Y dashboard.Dockerfile "%DEST%\dashboard.Dockerfile"
copy /Y dashboard.ts "%DEST%\dashboard.ts"
copy /Y docker-compose.yaml "%DEST%\docker-compose.yaml"
copy /Y Dockerfile "%DEST%\Dockerfile"
