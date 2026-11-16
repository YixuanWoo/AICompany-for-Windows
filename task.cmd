@echo off
rem 一句话下单的便捷入口：双击或在任意终端里 task.cmd "写一份周报"
rem
rem 为什么要这个 .cmd：中文 Windows 控制台默认代码页 936，node 直接输出 UTF-8 会变成乱码。
rem 先把代码页切到 65001，中文才看得清。
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node scripts\new-task.js %*
exit /b %ERRORLEVEL%
