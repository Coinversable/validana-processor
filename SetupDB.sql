/*
 * Setup script should be called from psql, where certain variables must be set, for example:
 * Note: Please check if there are options you want to use or skip, especially if using an existing database cluster.
 * psql -U postgres -d blockchain -v processor_username=processor -v processor_password= \
 *     -v backend_username=backend -v backend_password= -f SetupDB.sql
 */


/* Big performance improvement. By default this is turned to on in postgres.
Please note that the processor assumes it always reads the up to date version of the database.
	If load balancing software cannot garantee this set it to remote_apply instead of off.
For blocks (as given to the nodes) this setting will locally be turned back on, so they will
	never be lost through a crash. */
--SET synchronous_commit TO off;


/* Create the database. */
--CREATE DATABASE blockchain WITH ENCODING = 'UTF8';
--\c blockchain

/********************************************************************
 * Setup core                                                       *
 ********************************************************************/

/* Create schema for all non-smart contract data, all smart contract data is in the public schema. */
CREATE SCHEMA IF NOT EXISTS basics;

CREATE TABLE IF NOT EXISTS basics.contracts (
	/* The hash of the contract code. */
	contract_hash BYTEA PRIMARY KEY NOT NULL CHECK (octet_length(contract_hash) = 32),
	/* The contract type/name. */
	contract_type VARCHAR(64) NOT NULL,
	/* The version of the contract, to help the user. */
	contract_version VARCHAR(32) NOT NULL,
	/* A short description of the contract, to help the user. */
	description VARCHAR(256) NOT NULL,
	/* Address of who created the contract. */
	creator VARCHAR(35) NOT NULL,
	/* The template that the payload should have. */
	contract_template JSON NOT NULL,
	/* The actual contract code. */
	code BYTEA NOT NULL,
	/* The version of validana this smart contract was created for. To support backwards compatibility. */
	validana_version SMALLINT NOT NULL DEFAULT 1
);

/* Add the smartcontract and smartcontractmanager roles. The node/processor user should have these roles. */
DO $$ BEGIN
	/* Smart contract can do everything in the public schema. */
	IF NOT EXISTS (SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'smartcontract') THEN
		CREATE ROLE smartcontract;
	END IF;
	/* Smart contract manager can create/delete smart contracts. */
	IF NOT EXISTS (SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'smartcontractmanager') THEN
		CREATE ROLE smartcontractmanager;
	END IF;
END $$;

/* Give needed user rights to smartcontract and smartcontractmanager. */
GRANT ALL PRIVILEGES ON SCHEMA public TO smartcontract;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO smartcontract;
GRANT SELECT (datname, encoding) ON TABLE pg_catalog.pg_database TO smartcontract;
GRANT SELECT (indexrelid, indkey) ON TABLE pg_catalog.pg_index TO smartcontract;
GRANT SELECT ON TABLE information_schema.tables, information_schema.columns, information_schema.element_types,
	information_schema.key_column_usage, information_schema.referential_constraints, information_schema.table_constraints,
	information_schema.constraint_column_usage, information_schema.constraint_table_usage, information_schema.check_constraints TO smartcontract;
GRANT USAGE ON SCHEMA basics TO smartcontractmanager;
GRANT SELECT, INSERT, DELETE ON TABLE basics.contracts TO smartcontractmanager;

/*
 * Revoke everything they should not have access to (including the common non-deterministic functions).
 * If you need this for other users in your database you can skip this, however make sure not to use them in smart contracts!
 */
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pg_catalog, information_schema FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION setseed, random, nextval, currval, lastval, now, statement_timestamp, timeofday, transaction_timestamp,
	clock_timestamp, to_timestamp(text, text), to_timestamp(double precision), age(timestamp, timestamp),
	pg_xact_commit_timestamp, pg_last_committed_xact, inet_client_addr, inet_client_port, inet_server_addr,
	inet_server_port, version, set_config, current_setting(text), current_setting(text, boolean), 
	txid_snapshot_in, txid_snapshot_out, txid_snapshot_recv, txid_snapshot_send, txid_current, txid_current_snapshot,
	txid_snapshot_xmin, txid_snapshot_xmax, txid_snapshot_xip, txid_status FROM PUBLIC;

/********************************************************************
 * Setup from the processor                                         *
 ********************************************************************/

/* Create types */
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
		CREATE TYPE basics.transaction_status AS ENUM ('new', 'invalid', 'accepted', 'rejected');
	END IF;
END $$;

/* Create tables for the blockchain itself. */
CREATE TABLE IF NOT EXISTS basics.transactions (
	/* 128 bit unique identifier for this transaction. */
	transaction_id BYTEA PRIMARY KEY NOT NULL CHECK (octet_length(transaction_id) = 16),
	/* Version of the transaction. */
	version SMALLINT NOT NULL CHECK (0 <= version AND version < 256),
	/* sha256 hash of contract code that is used for this transaction. */
	contract_hash BYTEA NOT NULL CHECK (octet_length(contract_hash) = 32),
	/* Until and including what previousBlockTS the transaction is valid. 0 means no expiration time. */
	valid_till BIGINT NOT NULL CHECK (0 <= valid_till AND valid_till <= 9007199254740991),
	/* Payload given to the contract for execution. */
	payload JSON NOT NULL,
	/* compressed elliptic curve public key. */
	public_key BYTEA NOT NULL CHECK (octet_length(public_key) = 33),
	/* elliptic curve signature. */
	signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
	
	/* Current status of the transaction: */
	/* Whether the transaction been processed and was accepted by the contract. */
	status basics.transaction_status NOT NULL DEFAULT 'new',
	/* A message from the smart contract (e.g. if it processed the transaction or why not). */
	message VARCHAR(128),
	/* When the block this transaction is in was processed. (milliseconds since unix epoch) */
	processed_ts BIGINT CHECK (0 <= processed_ts AND processed_ts <= 9007199254740991),
	/* The block this transaction was in. */
	block_id BIGINT CHECK (0 <= block_id AND block_id <= 9007199254740991),
	/* The position in the block it was in. */
	position_in_block SMALLINT CHECK (0 <= position_in_block),
	
	/* Information added for quick lookup once the transaction has been processed: */
	/* Who send the transaction. Calculated from public_key */
	sender VARCHAR(35),
	/* The type/name of the contract. Determined from contract_hash at the time of processing. */
	contract_type VARCHAR(64),
	/* To whom the transaction was send. (Some transactions are send to no-one in particular, just for faster searching.) */
	receiver VARCHAR(35),

	/* Other info: */
	/* When the transaction was created. Used for sorting which transaction goes first in a block. */
	create_ts BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS basics.blocks (
	/* The id of this block. */
	block_id BIGINT PRIMARY KEY NOT NULL CHECK (0 <= block_id AND block_id <= 9007199254740991),
	/* Version of the block. */
	version SMALLINT NOT NULL CHECK (0 <= version AND version < 256),
	/* The hash of the previous block, to ensure all later blocks become invalid when 1 becomes invalid. */
	previous_block_hash BYTEA NOT NULL CHECK (octet_length(previous_block_hash) = 32),
	/* The time at which this block has been processed. (milliseconds since unix epoch) */
	processed_ts BIGINT NOT NULL CHECK (0 <= processed_ts AND processed_ts <= 9007199254740991),
	/* All transactions in this block, base64 JSON transactions. */
	transactions BYTEA NOT NULL,
	/* The amount of transactions in  this block. */
	transactions_amount SMALLINT NOT NULL CHECK (0 <= transactions_amount),
	/* elliptic curve signature */
	signature BYTEA NOT NULL CHECK (octet_length(signature) = 64)
);

/* Create databases for gathering metrics. By default no metrics are collected and you
	may want to collect them in a different database, but having an empty tables doesn't matter. */
CREATE TABLE IF NOT EXISTS basics.metrics (
	/* The name of the metric. */
	metric TEXT NOT NULL,
	/* The id of the worker. */
	worker INT NOT NULL DEFAULT -1,
	/* The value of the metric. */
	value BIGINT NOT NULL,
	PRIMARY KEY(metric, worker)
);

/* Create indexes after tables are created. */
CREATE INDEX IF NOT EXISTS transaction_processed_ts ON basics.transactions (processed_ts);
CREATE INDEX IF NOT EXISTS transaction_status ON basics.transactions (status) WHERE status = 'new';

/*
 * Add users and their permissions.
 * Postgres does not support IF NOT EXISTS for CREATE ROLE.
 * It also does not support variables inside a DO block.
 */
SET vars.processor_username = :'processor_username';
SET vars.processor_password = :'processor_password';
SET vars.backend_username = :'backend_username';
SET vars.backend_password = :'backend_password';
DO $$ BEGIN
	/* The processor user is only to be used by the processor. */
	IF NOT EXISTS (SELECT * FROM pg_catalog.pg_user WHERE usename = current_setting('vars.processor_username')) THEN
		EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L CONNECTION LIMIT 1;',
			current_setting('vars.processor_username'), current_setting('vars.processor_password'));
	END IF;
	EXECUTE format('GRANT CONNECT ON database %I TO %I;', current_database(), current_setting('vars.processor_username'));
	/* The backend user can be used for any backend that wishes to interact with the blockchain in any way. */
	IF NOT EXISTS (SELECT * FROM pg_catalog.pg_user WHERE usename = current_setting('vars.backend_username')) THEN
		EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L;',
			current_setting('vars.backend_username'), current_setting('vars.backend_password'));
	END IF;
	EXECUTE format('GRANT CONNECT ON database %I TO %I;', current_database(), current_setting('vars.backend_username'));
END $$;

/* Set permissions of the processor. */
GRANT smartcontract, smartcontractmanager TO :processor_username;
GRANT USAGE ON SCHEMA basics TO :processor_username;
GRANT SELECT, UPDATE ON TABLE basics.transactions TO :processor_username;
GRANT SELECT, INSERT ON TABLE basics.blocks TO :processor_username;
GRANT EXECUTE ON FUNCTION current_setting(text) TO :processor_username;

/* Set permissions of the backend. */
GRANT USAGE ON SCHEMA basics, public TO :backend_username;
GRANT SELECT ON ALL TABLES IN SCHEMA basics, public, pg_catalog, information_schema TO :backend_username;
GRANT INSERT (transaction_id, contract_hash, valid_till, payload, public_key, signature, version, create_ts) ON TABLE basics.transactions TO :backend_username;
GRANT INSERT, UPDATE, DELETE ON TABLE basics.metrics TO :backend_username;
ALTER DEFAULT PRIVILEGES FOR ROLE :processor_username, smartcontract, smartcontractmanager IN SCHEMA public GRANT SELECT ON TABLES TO :backend_username;
GRANT EXECUTE ON FUNCTION setseed, random, nextval, currval, lastval, now, statement_timestamp, timeofday, transaction_timestamp,
	clock_timestamp, to_timestamp(text, text), to_timestamp(double precision), age(timestamp, timestamp),
	pg_xact_commit_timestamp, pg_last_committed_xact, inet_client_addr, inet_client_port, inet_server_addr,
	inet_server_port, version, set_config, current_setting(text), current_setting(text, boolean), 
	txid_snapshot_in, txid_snapshot_out, txid_snapshot_recv, txid_snapshot_send, txid_current, txid_current_snapshot,
	txid_snapshot_xmin, txid_snapshot_xmax, txid_snapshot_xip, txid_status TO :backend_username;