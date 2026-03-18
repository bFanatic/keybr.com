@echo off
set DEST=\\truenas.local\docker\keybr.com

robocopy . "%DEST%" /E /XD node_modules .git /NFL /NDL /NJH /NJS
