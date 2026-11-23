@echo off
setlocal
title Notenscanner
cd /d "%~dp0"

rem Die Python-Umgebung liegt absichtlich an einem kurzen, festen Ort:
rem Windows kann einige Bibliotheken aus sehr langen Ordnerpfaden nicht laden.
set "HOME_DIR=%LOCALAPPDATA%\Notenscanner"
set "VENV=%HOME_DIR%\venv"
set "PY=%VENV%\Scripts\python.exe"

if exist "%PY%" goto check

echo.
echo  Erste Einrichtung - das dauert einige Minuten und passiert nur einmal.
echo.
set "BASEPY=python"
where py >nul 2>nul
if not errorlevel 1 set "BASEPY=py -3"
%BASEPY% --version >nul 2>nul
if errorlevel 1 goto nopython
if not exist "%HOME_DIR%" mkdir "%HOME_DIR%"
%BASEPY% -m venv "%VENV%"
if errorlevel 1 goto fail
"%PY%" -m pip install --upgrade pip --quiet

:install
echo  Pakete werden installiert ...
"%PY%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto fail
echo  Erkennungsmodelle werden heruntergeladen ...
"%PY%" -m homr.main --init
if errorlevel 1 goto fail
echo  Texterkennung wird eingerichtet ...
"%PY%" "%~dp0text_ocr.py" --init
if errorlevel 1 goto fail
goto run

:check
"%PY%" -c "import homr, flask, onnxruntime, rapidocr" >nul 2>nul
if errorlevel 1 goto install

:run
"%PY%" "%~dp0app.py"
goto end

:nopython
echo.
echo  Python wurde nicht gefunden.
echo  Bitte Python 3.11 oder neuer von https://www.python.org/downloads/ installieren
echo  (beim Installieren "Add python.exe to PATH" ankreuzen) und diese Datei erneut starten.
echo.
pause
goto end

:fail
echo.
echo  Die Einrichtung ist fehlgeschlagen. Besteht eine Internetverbindung?
echo  Zum Wiederholen diese Datei einfach noch einmal starten.
echo.
pause

:end
endlocal
