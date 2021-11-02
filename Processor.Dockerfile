ARG NODEVERSION=16
FROM node:${NODEVERSION}

# Clone the projects into the docker container and compile it
ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
RUN yarn global add typescript
RUN git clone https://github.com/Coinversable/validana-processor.git --branch v2.2.0 /usr/node
RUN yarn --cwd /usr/node install --frozen-lockfile
RUN tsc -p /usr/node/tsconfig.json

# Add environment variables
# For example pick the name of your application.
#ENV VPROC_SIGNPREFIX=
# For example use the following site or commands: https://coinversable.github.io/validana-client
# docker build -t validana_proc https://raw.githubusercontent.com/Coinversable/validana-processor/master/Processor.Dockerfile
# docker run -it --entrypoint /usr/local/bin/yarn validana_proc --silent --cwd /usr/node keysjson
#ENV VPROC_PRIVATEKEY=
#ENV VPROC_DBPASSWORD=
#ENV VPROC_SENTRYURL=
#ENV VPROC_DBUSER=processor
#ENV VPROC_DBNAME=blockchain
#ENV VPROC_DBHOST=localhost
#ENV VPROC_DBPORT=5432
#ENV VPROC_LOGLEVEL=0
#ENV VPROC_BLOCKINTERVAL=60
#ENV VPROC_MINBLOCKINTERVAL=5
#ENV VPROC_TRANSACTIONSPERBLOCK=500
#ENV VPROC_MAXBLOCKSIZE=1000000
#ENV VPROC_MAXMEMORY=1024
#ENV VPROC_EXCLUDEREJECTED=false
# Also available: $severity
#ENV VPROC_LOGFORMAT $color$timestamp: $message: $error

#Add user and entry point
USER node
WORKDIR /usr/node
ENTRYPOINT ["node","dist/index.js"]