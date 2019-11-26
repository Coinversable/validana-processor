/*!
 * @license
 * Copyright Coinversable B.V. All Rights Reserved.
 *
 * Use of this source code is governed by a AGPLv3-style license that can be
 * found in the LICENSE file at https://validana.io/license
 */

import * as Cluster from "cluster";
import { Crypto, Log, Basic, TxStatus, DBTransaction, DBBlock, Block, Transaction, CreatePayload, DeletePayload, PrivateKey, Sandbox } from "@coinversable/validana-core";
import { Config } from "./config";

interface ExtendedDBTransaction extends DBTransaction {
	addedToBlock: undefined | true;
	message?: string;
	status?: TxStatus.Accepted | TxStatus.Rejected | TxStatus.Invalid | "retry";
	contractType?: string;
	sender?: string;
	receiver?: string;
}

/** The processor is responsible for validating and processing all transactions in the database and putting them in blocks. */
export class Processor extends Basic {

	//Queries for various actions
	private readonly versionQuery = "SELECT current_setting('server_version_num');";
	private readonly getNewTxsQuery = "SELECT transaction_id, contract_hash, valid_till, payload::text, public_key, signature, version " +
		`FROM basics.transactions WHERE status = '${TxStatus.New}' ORDER BY create_ts LIMIT $1;`;
	private readonly previousBlockQuery = "SELECT * FROM basics.blocks ORDER BY block_id DESC LIMIT 1;";
	private readonly updateTransactionsQuery = "UPDATE basics.transactions SET processed_ts = txs.processed_ts, " +
		"status = txs.status, message = txs.message, contract_type = txs.contract_type, sender = txs.sender, " +
		"receiver = txs.receiver, block_id = txs.block_id, position_in_block = txs.position_in_block " +
		"FROM (SELECT * FROM json_populate_recordset(NULL::basics.transactions, $1::JSON)) AS txs " +
		"WHERE transactions.transaction_id = txs.transaction_id;";
	private readonly beginBlockQuery = "BEGIN; SET LOCAL ROLE smartcontract; SAVEPOINT transaction;";
	private readonly rollbackSavepointQuery = "ROLLBACK TO SAVEPOINT transaction;";
	private readonly newSavepointQuery = "RELEASE SAVEPOINT transaction; SAVEPOINT transaction;";
	private readonly addBlockQuery = "INSERT INTO basics.blocks(block_id, previous_block_hash, processed_ts, transactions, " +
		"transactions_amount, signature, version) VALUES($1, $2, $3, $4, $5, $6, $7);";
	private readonly commitBlockQuery = "SET LOCAL synchronous_commit TO ON; COMMIT;";

	//Information needed for mining
	private failures = 0; //How many times in a row it failed to mine.
	private justConnected = true; //Did we just connect to the DB or not?
	private isMining = false; //Is it currently processing a block
	private shouldRollback = false; //Should we rollback a transaction we were previously doing?
	private warnedPostgresVersion = false;
	private minedFirstBlock = false;
	private timeWarning = false; //Has it warned about timestamp being to low?

	//Information about the previous block that was mined and with that information for the current block
	private previousBlockHash: Buffer;
	private previousBlockTs: number;
	private currentBlockId: number;

	private readonly config: Readonly<Config>;
	private readonly worker: Cluster.Worker;
	private readonly privateKey: PrivateKey;
	private readonly processorAddress: string;

	/**
	 * Create the processor.
	 * @param worker The worker that created the processor
	 * @param config The config for the processor to use
	 */
	constructor(worker: Cluster.Worker, config: Readonly<Config>) {
		super({
			user: config.VPROC_DBUSER,
			database: config.VPROC_DBNAME,
			password: config.VPROC_DBPASSWORD,
			port: config.VPROC_DBPORT,
			host: config.VPROC_DBHOST
		}, Crypto.utf8ToBinary(config.VPROC_SIGNPREFIX), (init) => this.worker.send({ type: "init", init }));

		this.config = config;
		this.worker = worker;
		this.privateKey = PrivateKey.fromWIF(config.VPROC_PRIVATEKEY);
		this.processorAddress = this.privateKey.getAddress();

		//Set default values for previous block
		this.currentBlockId = 0;
		this.previousBlockTs = 0;
		this.previousBlockHash = Buffer.alloc(32);
	}

	/**
	 * Mines a single block (if it is not busy already).
	 * If it was in the middle of mining a block (when it crashed) rollback and finish the processing transactions first.
	 * If not it retrieves all unprocessed transactions and for each transaction:
	 * 		validates, execute smart contract and mark them as processing.
	 * It will then create a block and mark all the processing transactions as processed.
	 */
	public async mineBlock(): Promise<void> {
		try {
			//Check if the minimum time passed since we last mined a block, otherwise skip this time
			if (this.previousBlockTs + this.config.VPROC_MINBLOCKINTERVAL * 1000 > Sandbox.special.DateNow() + 500) {
				return this.abortMining(undefined, false);
			}

			//If we had multiple failures in a row the problem seems to not resolve itsself. We will still try to mine again...
			if (this.failures > 3) {
				Log.error("Processor failed to mine multiple times in a row.");
			}

			if (this.isMining) { //If we are still mining skip this time (but dont mark as no longer mining)
				return this.abortMining("Processor under heavy load, skipping mining.", false, undefined, true);
			} else { //Start mining
				this.isMining = true;
			}

			//Connect to the DB (if it isn't connected already).
			this.justConnected = await this.connect() || this.justConnected;

			//Rollback old in progress transactions (won't cause an error if there is nothing to roll back!)
			if (this.shouldRollback || this.justConnected) {
				try {
					await this.query("ROLLBACK;", []);
				} catch (error) {
					return this.abortMining("Failed to rollback transactions after reconnecting.", true, error);
				}

				try { //Get all smart contracts (again) as we may have just rolled back a contract we added/deleted.
					await this.loadSmartContracts();
				} catch (error) {
					return this.abortMining("Failed to retrieve smart contracts.", false, error);
				}

				this.shouldRollback = false;
			}

			//If we just connected verify the state again as it may have changed.
			if (this.justConnected) {
				try { //Verify our postgres version is high enough to work.
					const result = (await this.query(this.versionQuery, [])).rows[0];
					const ourPostgresVersion = Number.parseInt(result.current_setting, 10);
					if (Number.isNaN(ourPostgresVersion) || ourPostgresVersion < 90500) {
						return await Processor.shutdown(52, "Too old or invalid postgres version, requires at least 9.5, shutting down.");
					} else {
						if (ourPostgresVersion >= 120000 && !this.warnedPostgresVersion) {
							this.warnedPostgresVersion = true;
							Log.warn("Validana has not been tested for postgres version 12+, use at your own risk!");
						}
						Log.options.tags.postgresVersion = result.current_setting;
					}
				} catch (error) {
					return this.abortMining("Failed to verify postgres version.", false, error);
				}

				try { //Get the latest block that is in the database.
					const result: DBBlock | undefined = (await this.query(this.previousBlockQuery, [])).rows[0];
					if (result !== undefined) {
						this.currentBlockId = result.block_id + 1;
						this.previousBlockTs = result.processed_ts;
						this.previousBlockHash = new Block(result).getHash(this.signPrefix!);
					} else {
						this.currentBlockId = 0;
						this.previousBlockTs = 0;
						this.previousBlockHash = Buffer.alloc(32);
						Log.warn("No previous blocks found, this should only happen in case of the first block being mined.");
					}
				} catch (error) {
					return this.abortMining("Failed to retrieve previous block.", false, error);
				}

				try { //Set statement timeout so queries (mainly from smart contracts) don't take forever long.
					await this.query(`SET statement_timeout = ${this.config.VPROC_BLOCKINTERVAL * 1000};`, []);
				} catch (error) {
					return this.abortMining("Failed to set statement_timeout.", false, error);
				}
			}

			let unprocessedTxs: ExtendedDBTransaction[] = [];
			try { //Gather all transactions it should process ordered by create_ts
				unprocessedTxs = (await this.query(this.getNewTxsQuery, [this.config.VPROC_TRANSACTIONSPERBLOCK], "getTxs")).rows;
			} catch (error) {
				return this.abortMining("Failed to load transactions.", false, error);
			}

			try { //Start creating the new block
				await this.query(this.beginBlockQuery, []);
			} catch (error) {
				return this.abortMining("Failed to begin block transaction.", true, error);
			}
			const currentBlockTxs: Transaction[] = [];
			let currentBlockTs = Date.now();
			let currentBlockSize = Block.emptyLength;
			if (currentBlockTs <= this.previousBlockTs) {
				//If this happens the previous block had a too high timestamp. Nothing we can do about it now, so just continue.
				if (!this.timeWarning) {
					this.timeWarning = true;
					Log.warn(`Previous block time: ${this.previousBlockTs}, current block time: ${currentBlockTs}`);
					Log.error("Block mining timestamp too low.");
				}
				currentBlockTs = this.previousBlockTs + 1;
			} else {
				this.timeWarning = false;
			}

			//Process all transactions
			const processedTxs: ExtendedDBTransaction[] = [];
			for (const unprocessedTx of unprocessedTxs) {
				//Check if the block will not become too large
				if (currentBlockSize + unprocessedTx.payload.length + Transaction.emptyLength > this.config.VPROC_MAXBLOCKSIZE) {
					break;
				}

				//Create the transaction
				let tx: Transaction | undefined;
				try {
					tx = new Transaction(unprocessedTx);
				} catch (error) {
					unprocessedTx.status = TxStatus.Invalid;
					unprocessedTx.message = Crypto.makeUtf8Postgres(error.message.slice(0, 128));
					processedTxs.push(unprocessedTx);
					Log.warn(`Invalid transaction: ${unprocessedTx.transaction_id}, reason: ${unprocessedTx.message}`);
					continue;
				}

				//Process the transaction
				const processResult = await this.processTx(tx, this.currentBlockId, currentBlockTs, this.processorAddress, this.previousBlockTs, this.previousBlockHash, true);
				unprocessedTx.status = processResult.status === "v1Rejected" ? TxStatus.Rejected : processResult.status;
				unprocessedTx.message = Crypto.makeUtf8Postgres(processResult.message.slice(0, 128));

				//Rollback if needed
				if (processResult.status !== "accepted" && processResult.status !== "v1Rejected") {
					try {
						await this.query(this.rollbackSavepointQuery, []);
					} catch (error) {
						return this.abortMining("Failed to rollback a transaction.", true, error);
					}
				} else {
					try {
						await this.query(this.newSavepointQuery, []);
					} catch (error) {
						return this.abortMining("Failed to set savepoint.", true, error);
					}
				}

				//Fill in basic info
				if (this.contractMap.has(unprocessedTx.contract_hash.toString())) {
					unprocessedTx.contractType = this.contractMap.get(unprocessedTx.contract_hash.toString())!.type;
				} else if (unprocessedTx.contract_hash.equals(Processor.createContractHash)) {
					unprocessedTx.contractType = "Create Contract";
				} else if (unprocessedTx.contract_hash.equals(Processor.deleteContractHash)) {
					unprocessedTx.contractType = "Delete Contract";
				} else {
					unprocessedTx.contractType = "Unknown";
				}

				//If the transaction should be added to the blockchain.
				if (processResult.status === "accepted" || processResult.status === "v1Rejected" ||
					(processResult.status === "rejected" && !this.config.VPROC_EXCLUDEREJECTED)) {

					//Make transaction searchable with extra info (use String() so it also works on null)
					const payload: { [index: string]: any } = tx.getPayloadJson() ?? {};
					unprocessedTx.sender = tx.getAddress();
					// tslint:disable-next-line: no-null-keyword
					unprocessedTx.receiver = payload.receiver == null ? undefined : String(payload.receiver).slice(0, 35);

					//Add the transaction
					unprocessedTx.addedToBlock = true;
					currentBlockTxs.push(tx);
					currentBlockSize += unprocessedTx.payload.length + Transaction.emptyLength;

					//Log that we processed it.
					if (Processor.txContractHash.equals(Processor.createContractHash)) {
						Log.info(`New contract: ${(payload as CreatePayload).type} (version: ${(payload as CreatePayload).version})`);
					} else if (Processor.txContractHash.equals(Processor.deleteContractHash)) {
						Log.info(`Contract deleted: ${(payload as DeletePayload).hash}`);
					} else {
						Log.debug(`Processed transaction ${Crypto.binaryToHex(tx.getId())}, of type: ${unprocessedTx.contractType}, result: ${unprocessedTx.message}`);
					}
				} else if (unprocessedTx.status === "invalid") {
					Log.warn(`Invalid transaction: ${Crypto.binaryToHex(unprocessedTx.transaction_id)} for contract ${unprocessedTx.contractType}: ${unprocessedTx.message}`);
				} else if (unprocessedTx.status === "rejected") {
					Log.debug(`Rejected transaction: ${Crypto.binaryToHex(unprocessedTx.transaction_id)} for contract ${unprocessedTx.contractType}: ${unprocessedTx.message}`);
				}

				if (unprocessedTx.status !== "retry") {
					processedTxs.push(unprocessedTx);
				}

				//If we (almost) ran out of time finish the current block.
				if (Date.now() - 100 > this.previousBlockTs + (this.config.VPROC_MINBLOCKINTERVAL + this.config.VPROC_BLOCKINTERVAL) * 1000) {
					break;
				}
			}
			try { //Reset permissions
				await this.query("RESET ROLE;", []);
			} catch (error) {
				return this.abortMining("Failed to reset role.", true, error);
			}

			let positionInBlock = 0;
			//Postgres module has a habit of encoding arrays as postgres arrays instead of json arrays, so stringify now.
			const toInsert = processedTxs.filter((tx) => tx.status !== "retry").map((tx) => ({
				//Escape sequence for binary data
				transaction_id: "\\x" + Crypto.binaryToHex(tx.transaction_id),
				status: tx.status,
				message: tx.message,
				contract_type: tx.contractType,
				sender: tx.sender,
				receiver: tx.receiver,
				processed_ts: currentBlockTs,
				block_id: tx.addedToBlock === true ? this.currentBlockId : undefined,
				position_in_block: tx.addedToBlock === true ? positionInBlock++ : undefined
			}));
			//If there is at least one non-retry transaction
			if (toInsert.length > 0) {
				try {
					await this.query(this.updateTransactionsQuery, [JSON.stringify(toInsert)]);
				} catch (error) {
					return this.abortMining("Failed to update transactions.", true, error);
				}
			}

			//Check if we need to create a block
			let block: Block | undefined;
			if (currentBlockTxs.length === 0 && this.previousBlockTs !== 0 &&
				this.previousBlockTs + (this.config.VPROC_MINBLOCKINTERVAL + this.config.VPROC_BLOCKINTERVAL) * 1000 > Date.now() + 500) {

				//If there is no need to create a block do a normal commit.
				if (!Basic.isShuttingDown) {
					try {
						await this.query("COMMIT;", []);
					} catch (error) {
						return this.abortMining("Failed to commit transactions.", true, error);
					}
				}

				if (toInsert.length > 0) {
					try { //Notify listeners that there are new transactions
						await this.query(`NOTIFY blocks, '${JSON.stringify({ ts: currentBlockTs, other: toInsert.length - currentBlockTxs.length })}';`, []);
					} catch (error) {
						Log.warn("Failed to notify listeners of new invalid transactions.", error);
					}
				}
			} else {
				//If there is a need to create a block
				block = Block.sign({
					version: 1,
					block_id: this.currentBlockId,
					transactions: Transaction.merge(currentBlockTxs),
					previous_block_hash: this.previousBlockHash,
					processed_ts: currentBlockTs
				}, this.signPrefix!, this.privateKey);

				const blockParams: Array<Buffer | number> = [
					block.id,
					block.getPreviousBlockHash(),
					block.processedTs,
					block.getTransactions(),
					block.transactionsAmount,
					block.getSignature(),
					1 //Version
				];

				try { //Create the block
					await this.query(this.addBlockQuery, blockParams, "addBlock");
				} catch (error) {
					return this.abortMining("Failed to insert new block.", true, error);
				}
				if (!Basic.isShuttingDown) {
					try { //If everything went correctly: finish transaction for block
						await this.query(this.commitBlockQuery, []);
					} catch (error) {
						return this.abortMining("Failed to commit block transaction.", true, error);
					}
				}
				try { //Notify listeners that a new block has been processed. We want creating blocks to succeed even if this fails.
					await this.query(`NOTIFY blocks, '${JSON.stringify({
						block: this.currentBlockId, ts: currentBlockTs, txs: currentBlockTxs.length, other: toInsert.length - currentBlockTxs.length
					})}';`, []);
				} catch (error) {
					Log.warn("Failed to notify listeners of new block.", error);
				}

				//We succeeded, set information for the next block
				this.previousBlockHash = block.getHash(this.signPrefix!);
				this.previousBlockTs = currentBlockTs;
				this.currentBlockId++;
				if (!this.minedFirstBlock) {
					Log.info("Succesfully mined first block, everything seems to be working.");
					this.minedFirstBlock = true;
				}
			}

			//Reset information for mining
			this.failures = 0;
			this.justConnected = false;
			this.isMining = false;

			//Report to the master that we mined a block and our current memory usage.
			const memory = process.memoryUsage();
			this.worker.send({ type: "report", memory: (memory.heapTotal + memory.external) / 1024 / 1024 });
		} catch (error) {
			//Most likely location for something to go wrong, log the error to have a decent stacktrace and then rethrow it.
			Log.error("Unknown mining error", error);
			throw error;
		}
	}

	/**
	 * Abort mining the current block
	 * @param reason Why do we abort mining. undefined if no problems and we just want to abort
	 * @param rollback Is there a transaction in progress we should rollback?
	 * @param error An optional error.
	 * @param wasStillMining Was it still mining?
	 */
	private abortMining(reason: string | undefined, rollback: boolean, error?: Error | undefined, wasStillMining: boolean = false): void {
		this.isMining = wasStillMining;
		this.shouldRollback = this.shouldRollback || rollback;
		if (reason !== undefined) {
			this.failures++;
			Log.warn(reason, error !== undefined ? new Error(error.message) : undefined);
		}
	}
}