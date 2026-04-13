# 꼭 .env 를 설정하고 사용해주세요!!
# server-manager
- Node.js 로 작성한 간단한 서버 파일 탐색기 & 프로세스 확인 웹사이트

## Features
- Process add/delete/restart with pm2
- File read/write/explore

## Install

### Node.js
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
```
### Repository
```bash
git clone https://github.com/soyuo/server-manager
cd server-manager
npm install
npm run build
```
- (please ignore expressWs type warning..)
### pm2 Setup
```bash
npm i -g pm2
pm2 start 'node server.js' --name server
pm2 save
pm2 startup
sudo env PATH=... pm2 startup systemd -u root --hp /root
```
- when you enter `pm2 startup`, PATH indicates!
### check
```bash
pm2 list
```
