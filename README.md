1. tsc && node ./dist/index/jupiter.js
2. systemctl start jupiter
3. journalctl -u jupiter.service -f
4. pm2 start index 
