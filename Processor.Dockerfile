ARG NODEVERSION=10
FROM node:${NODEVERSION}
ARG NODEVERSION

# Clone the projects into the docker container and compile it
ENV NODE_ENV=production
RUN yarn global add typescript
RUN git clone https://github.com/Coinversable/validana-processor.git#v1.0.1 /usr/node
RUN yarn --cwd /usr/node install
RUN tsc -p /usr/node/tsconfig.json

# Add environment variables
ENV VPROC_NODEVERSION=${NODEVERSION}
#ENV VPROC_SIGNPREFIX=
#ENV VPROC_PRIVATEKEY=
#ENV VPROC_DBPASSWORD=
#ENV VPROC_SENTRYURL=
#ENV VPROC_DBUSER=processor
#ENV VPROC_DBNAME=blockchain
#ENV VPROC_DBHOST=localhost
#ENV VPROC_DBPORT=5432
#ENV VPROC_LOGLEVEL=0
#ENV VPROC_BLOCKINTERVAL=5
#ENV VPROC_TRANSACTIONSPERBLOCK=500
#ENV VPROC_MAXBLOCKSIZE=1000000
#ENV VPROC_MAXMEMORY=1024

#Add user and entry point
USER node
ENTRYPOINT node /usr/node/dist/app.js