FROM postgres:10

ARG PROCESSORNAME=processor
ARG PROCESSORPASS
ARG BACKENDNAME=backend
ARG BACKENDPASS

COPY ./SetupDB.sql /docker-entrypoint-initdb.d/SetupDB.sql
RUN sed -i -r \
	-e "s/^--CREATE DATABASE /CREATE DATABASE /g" \
	-e "s/^--\\\\c /\\\\c /g" \
	-e "s/\/\*'Processor password here'\*\//'$PROCESSORPASS'/g" \
	-e "s/usename = 'processor'/usename = '$PROCESSORNAME'/g" \
	-e "s/ROLE processor/ROLE $PROCESSORNAME/g" \
	-e "s/TO processor;/TO $PROCESSORNAME;/g" \
	-e "s/\/\*'Backend password here'\*\//'$BACKENDPASS'/g" \
	-e "s/usename = 'backend'/usename = '$BACKENDNAME'/g" \
	-e "s/ROLE backend/ROLE $BACKENDNAME/g" \
	-e "s/TO backend;/TO $BACKENDNAME;/g" \
	/docker-entrypoint-initdb.d/SetupDB.sql