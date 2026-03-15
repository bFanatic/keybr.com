FROM node:24

WORKDIR /usr/src/app

RUN git clone https://github.com/bFanatic/keybr.com.git .
RUN npm install
RUN npm run compile && npm run build

EXPOSE 3000

CMD ["npm", "run", "start-docker"]
