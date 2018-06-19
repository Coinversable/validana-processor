/* Create database. */
--CREATE DATABASE blockchain WITH ENCODING = 'UTF8';
--\c blockchain

/* Create schema for all non-smart contract data, all smart contract data is in the public schema. */
CREATE SCHEMA IF NOT EXISTS basics;

/* Create types */
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
		CREATE TYPE basics.transaction_status AS ENUM (
			'new',
			'processing_accepted',
			'processing_rejected',
			'invalid',
			'accepted',
			'rejected'
        );
	END IF;
END $$;

/* Create tables for the blockchain itself. */
CREATE TABLE IF NOT EXISTS basics.transactions (
	/* hex encoded 128 bit unique identifier for this transaction. */
	transaction_id BYTEA PRIMARY KEY NOT NULL CHECK (octet_length(transaction_id) = 16),
	
	/* Version of the transaction. */
	version SMALLINT NOT NULL CHECK (0 <= version AND version < 256),
	
	/* Hex encoded sha256 hash of contract code that is used for this transaction. Blockchain invalidates transactions for unexisting contracts.
	In case it is all 0s it means a new contract is created. In case it is all Fs it means a contract is removed. */
	contract_hash BYTEA NOT NULL CHECK (octet_length(contract_hash) = 32),

	/* Untill and including what previousBlockTS the transaction is valid. 0 means no expiration time.*/
	valid_till BIGINT NOT NULL CHECK (0 <= valid_till AND valid_till <= 9007199254740991),
	
	/* Payload given to the contract for execution. */
	payload JSON NOT NULL,
	
	/* Hex encoded compressed elliptic curve public key. */
	public_key BYTEA NOT NULL CHECK (octet_length(public_key) = 33),
	
	/* Hex encoded signature. */
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
	
	/* The type of contract, e.g. 'Address' or 'Transfer'. Determined from contract_hash at the time of processing. */
	contract_type VARCHAR(64),
	
	/* To whom the transaction was send. (Some transactions are send to no-one in particular, just for faster searching.) */
	receiver VARCHAR(35),
	
	/* Extra columns the smart contract can use for faster indexing. */
	extra1 VARCHAR(64),
	extra2 VARCHAR(64),

	/* Other info: */

	/* When the transaction was created. Used for sorting which transaction goes first in a block but can do without. */
	create_ts BIGINT
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
	
	/* Hex encoded signature */
	signature BYTEA NOT NULL CHECK (octet_length(signature) = 64)
);

CREATE TABLE IF NOT EXISTS basics.contracts (
	/* The hash of the contract code. */
	contract_hash BYTEA PRIMARY KEY NOT NULL CHECK (octet_length(contract_hash) = 32),
	
	/* The contract type, e.g. 'address' or 'transfer'. */
	contract_type VARCHAR(64) NOT NULL,
	
	/* The version of the contract, to help the user. */
	contract_version VARCHAR(32) NOT NULL,
	
	/* A short description of the contract, to help the user. */
	description VARCHAR(256) NOT NULL,
	
	/* Address of who created the contract. */
	creator VARCHAR(35) NOT NULL,
	
	/* The template that the payload should have. */
	contract_template JSON NOT NULL,
	
	/* The actual contract code. Could be empty. */
	code BYTEA NOT NULL
);

/* Create indexes after tables are created. */
CREATE INDEX IF NOT EXISTS sender ON basics.transactions (sender);
CREATE INDEX IF NOT EXISTS receiver ON basics.transactions (receiver);
CREATE INDEX IF NOT EXISTS transaction_processed_ts ON basics.transactions (processed_ts);
CREATE INDEX IF NOT EXISTS transaction_status ON basics.transactions (status);

/* Big performance improvement. By default this is turned to on in postgres.
Please note that the processor assumes it always reads the up to date version of the database.
	If load balancing software cannot garantee this set it to remote_apply instead of off.
Turning this to off means that a backend may report back information, such as a transaction being
	delived to the processor or a transaction being processed that is about to be put into a block, that
	(due to a crash) can still be lost. Note that transactions can be refused by the processor (e.g. due
	to an invalid signature), so turning this on will not guarantee any transaction reported to be
	succesfully delived will actually make it into a block.
For blocks (as given to the nodes) this setting will temporarily be turned back on, so they will
	never be lost through a crash. */
SET synchronous_commit TO OFF;

/* Add users and their permissions. Should be done after all tables are created!
The connection limit is needed to ensure only 1 processor can run at once! */
DO $$
BEGIN
	REVOKE ALL ON SCHEMA public FROM PUBLIC;

	/* The processor user is only to be used by the processor. */
	IF NOT EXISTS (SELECT * FROM pg_catalog.pg_user WHERE usename = 'processor') THEN
		CREATE ROLE processor WITH LOGIN PASSWORD /*'Processor password here'*/ CONNECTION LIMIT 1;
	END IF;

	GRANT CONNECT ON DATABASE blockchain TO processor;
	GRANT USAGE ON SCHEMA basics TO processor;
	GRANT SELECT, UPDATE ON TABLE basics.transactions TO processor;
	GRANT SELECT, INSERT ON TABLE basics.blocks TO processor;
	GRANT SELECT, INSERT, DELETE ON TABLE basics.contracts TO processor;
	GRANT ALL PRIVILEGES ON SCHEMA public TO processor;
	GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO processor;

	/* The backend user can be used for any backend that wishes to interact with the blockchain in any way. */
	IF NOT EXISTS (SELECT * FROM pg_catalog.pg_user WHERE usename = 'backend') THEN
		CREATE ROLE backend WITH LOGIN PASSWORD /*'Backend password here'*/;
	END IF;

	GRANT CONNECT ON DATABASE blockchain TO backend;
	GRANT USAGE ON SCHEMA basics TO backend;
	GRANT INSERT (transaction_id, contract_hash, valid_till, payload, public_key, signature, version, create_ts) ON TABLE basics.transactions TO backend;
	GRANT SELECT ON ALL TABLES IN SCHEMA basics TO backend;
	GRANT USAGE ON SCHEMA public TO backend;
	GRANT SELECT ON ALL TABLES IN SCHEMA public TO backend;
	ALTER DEFAULT PRIVILEGES FOR ROLE processor IN SCHEMA public GRANT SELECT ON TABLES TO backend;
END $$;