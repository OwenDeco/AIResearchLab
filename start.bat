@echo off
title AI Research Lab

echo Starting backend...
start "AI Lab - Backend" cmd /k "cd /d C:\ClaudeProjects\AIResearchLab\backend && .venv\Scripts\activate && python -m uvicorn main:app --reload --port 8002"

echo Starting frontend...
start "AI Lab - Frontend" cmd /k "cd /d C:\ClaudeProjects\AIResearchLab\frontend && npm run dev"

echo Waiting for servers to start...
timeout /t 6 /nobreak >nul

echo Opening app...
start http://localhost:5173
