@echo off
echo ==========================================
echo ML Brain Service Fixer
echo ==========================================
echo.
echo Stopping ml-brain container...
docker-compose stop ml-brain
docker-compose rm -f ml-brain

echo.
echo Rebuilding ml-brain container...
docker-compose build ml-brain

echo.
echo Starting ml-brain container...
docker-compose up -d ml-brain

echo.
echo Waiting for service to initialize (10 seconds)...
timeout /t 10 /nobreak

echo.
echo Checking service health...
curl -I http://127.0.0.1:8001/health

echo.
echo Container Logs (Last 20 lines):
docker logs --tail 20 ml-brain

echo.
echo ==========================================
echo Done. If you see "HTTP/1.1 200 OK" above, the service is fixed.
echo You may need to restart the main application if it doesn't reconnect automatically.
echo ==========================================
pause
