ARG POSTGRESVERSION=10
FROM postgres:${POSTGRESVERSION}
ARG POSTGRESVERSION

# If you change these values makes sure to also remove the volume used (which will wipe all data!) for it to update.
ARG PROCESSORNAME=processor
ARG PROCESSORPASS
ARG BACKENDNAME=backend
ARG BACKENDPASS

# Setup script
COPY ./SetupDB.sql /docker-entrypoint-initdb.d/SetupDB
RUN echo -e "#!/bin/bash\n\
	psql -U postgres -c \"SET synchronous_commit TO off;\" -c \"CREATE DATABASE blockchain WITH ENCODING = 'UTF8';\"\n\
	psql -U postgres -d blockchain -v processor_username=$PROCESSORNAME -v processor_password=$PROCESSORPASS \
		-v backend_username=$BACKENDNAME -v backend_password=$BACKENDPASS -f SetupDB" > SetupDB.sh