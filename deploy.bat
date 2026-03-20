@echo off
set DEST=\\truenas.local\docker\keybr.com

robocopy . "%DEST%" Dockerfile docker-compose.yaml dashboard.Dockerfile dashboard.ts .env /NFL /NDL /NJH /NJS
