@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "ENV_FILE=%ROOT_DIR%\.env"
set "DOCKER_IMAGE="

if not exist "%ENV_FILE%" (
  echo Missing .env file: "%ENV_FILE%"
  echo Add DOCKER_IMAGE to .env first.
  exit /b 1
)

for /f "usebackq tokens=* delims=" %%L in ("%ENV_FILE%") do (
  set "LINE=%%L"
  if defined LINE (
    if not "!LINE:~0,1!"=="#" (
      for /f "tokens=1,* delims==" %%A in ("!LINE!") do (
        if /i "%%A"=="DOCKER_IMAGE" (
          set "DOCKER_IMAGE=%%B"
        )
      )
    )
  )
)

if not defined DOCKER_IMAGE (
  echo Missing DOCKER_IMAGE in .env
  exit /b 1
)

for /f "tokens=* delims= " %%A in ("%DOCKER_IMAGE%") do set "DOCKER_IMAGE=%%A"

pushd "%ROOT_DIR%"
if errorlevel 1 exit /b 1

echo Building image %DOCKER_IMAGE%...
docker build -t %DOCKER_IMAGE% -f Dockerfile .
if errorlevel 1 (
  popd
  exit /b 1
)

echo Pushing image %DOCKER_IMAGE%...
docker push %DOCKER_IMAGE%
if errorlevel 1 (
  popd
  exit /b 1
)

popd

echo Done: %DOCKER_IMAGE%
exit /b 0
