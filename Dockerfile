FROM node:lts-alpine
LABEL maintainer="Erron Silver <4406479+vonerrol@users.noreply.github.com>"

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package.json package-lock.json /usr/src/app/

RUN npm install

COPY src /usr/src/app/src

CMD ["npm", "start"]
