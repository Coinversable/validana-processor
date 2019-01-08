/**
 * @license
 * Copyright Coinversable B.V. All Rights Reserved.
 *
 * Use of this source code is governed by a AGPLv3-style license that can be
 * found in the LICENSE file at https://validana.io/license
 */

import * as Cluster from "cluster";
import {
	Crypto, Log, Basic, QueryStatus, TxStatus, DBTransaction, DBBlock, Block,
	Transaction, CreatePayload, DeletePayload, PrivateKey
} from "validana-core";
import { Config } from "./config";

/** How a raw transaction looks like without the extra data we use for quick lookoup. (Except for create_ts and status.) */
interface UnprocessedTx extends DBTransaction {
	//If available order on this when processing transactions, followed by ordering on transaction_id, which is unique.
	create_ts: number | null;

	//Has the transaction been processed and what was the result?
	status: TxStatus.New | TxStatus.ProcessingAccepted | TxStatus.ProcessingRejected;
}

/** Extension to the transaction class that included the status we got from the smart contract. */
class TransactionWithStatus extends Transaction {
	//Status is a reserved keyword, use txStatus instead.
	public txStatus: TxStatus.Accepted | TxStatus.Rejected | undefined;

	constructor(tx: UnprocessedTx) {
		super(tx);
		if (tx.status === TxStatus.ProcessingAccepted) {
			this.txStatus = TxStatus.Accepted;
		} else if (tx.status === TxStatus.ProcessingRejected) {
			this.txStatus = TxStatus.Rejected;
		}
	}
}

/** The processor is responsible for validating and processing all transactions in the database and putting them in blocks. */
export class Processor extends Basic {

	//Queries for various actions
	private readonly versionQuery = "SELECT current_setting('server_version_num');";
	private readonly getNewTxsQuery = "SELECT transaction_id, contract_hash, valid_till, payload::text, public_key, signature, version, create_ts " +
		`FROM basics.transactions WHERE status = '${TxStatus.New}' ORDER BY create_ts LIMIT $1;`;
	private readonly getProcessingTxsQuery = "SELECT transaction_id, contract_hash, valid_till, payload::text, public_key, signature, version, create_ts, status " +
		`FROM basics.transactions WHERE status = '${TxStatus.ProcessingAccepted}' OR status = '${TxStatus.ProcessingRejected}';`;
	private readonly invalidateTxQuery = `UPDATE basics.transactions SET status = '${TxStatus.Invalid}', ` +
		"message = $2, processed_ts = $3, contract_type = $4 WHERE transaction_id = $1;";
	private readonly processingTxQuery = "UPDATE basics.transactions SET status = $2, message = $3, contract_type = $4, " +
		"sender = $5, receiver = $6, extra1 = $7, extra2 = $8 WHERE transaction_id = $1;";
	private readonly previousBlockQuery = "SELECT * FROM basics.blocks ORDER BY block_id DESC LIMIT 1;";
	private readonly addBlockQuery = "INSERT INTO basics.blocks(block_id, previous_block_hash, processed_ts, transactions, " +
		"transactions_amount, signature, version) VALUES($1, $2, $3, $4, $5, $6, $7);";
	private readonly beginQuery = "BEGIN;";
	private readonly commitBlockQuery = "SET LOCAL synchronous_commit TO ON; COMMIT;";
	private readonly commitQuery = "COMMIT;";
	private readonly rollbackQuery = "ROLLBACK;";

	//Information needed for mining
	private failures = 0; //How many times in a row it failed to mine.
	private justConnected = true; //Did we just connect to the DB or not?
	private hasProcessingTransactions = false; //Are there any transactions that are currently processing
	private isMining = false; //Is it currently processing a block
	private shouldRollback = false; //Should we rollback a transaction we were previously doing?
	private minedFirstBlock = false;
	private timeWarning = false; //Has it warned about timestamp being to low?

	//Information about the previous block that was mined and with that information for the current block
	private previousBlockHash: Buffer;
	private previousBlockTs: number;
	private currentBlockId: number;

	private static config: Readonly<Config>;
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
		}, Crypto.utf8ToBinary(config.VPROC_SIGNPREFIX));

		Processor.config = config;
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
			//If we had multiple failures in a row the problem seems to not resolve itsself. We will still try to mine again...
			if (this.failures > 3) {
				Log.error("Processor failed to mine multiple times in a row.");
			}

			//Check if it is still busy, if so skip mining, but don't mark as no longer mining.
			if (this.isMining) {
				return this.abortMining("Processor under heavy load, skipping mining.", false, undefined, true);
			}

			//Start mining
			let result: QueryStatus;
			const blockTransactions: TransactionWithStatus[] = [];
			const miningStartTime = Date.now();
			this.isMining = true;

			//Connect to the DB (if it isn't connected already). This will set justConnected to true if needed.
			await this.connect();

			//Rollback old in progress transactions (won't emit an error if there is nothing to roll back!)
			if (this.shouldRollback || this.justConnected) {
				if ((result = await this.query(this.rollbackQuery, [])).error !== undefined) {
					return this.abortMining("Failed to rollback transactions after reconnecting.", true, result.error);
				}

				//Get all smart contracts (again) as we may have just rolled back a contract we added/deleted.
				const loadError = await this.loadSmartContracts();
				if (loadError !== undefined) {
					return this.abortMining("Failed to retrieve smart contracts.", false, loadError);
				}

				this.shouldRollback = false;
			}

			if (!this.minedFirstBlock) {
				if ((result = await this.query(this.versionQuery, [])).error !== undefined) {
					return this.abortMining("Failed to verify postgres version.", false, result.error);
				} else {
					const ourPostgresVersion = Number.parseInt(result.rows[0].current_setting, 10);
					if (Number.isNaN(ourPostgresVersion) || ourPostgresVersion < 90500) {
						await Log.fatal("Too old or invalid postgres version, requires at least 9.5, shutting down.");
						return await Processor.shutdown(52);
					} else {
						if (ourPostgresVersion >= 110000) {
							Log.warn("The blockchain has not been tested for postgres version 11 or later, use at your own risk!");
						}
						Log.options.tags!.postgresVersion = result.rows[0].current_setting;
					}
				}
			}

			//Finish processing transactions that are not yet in a block (no real limit here)
			if (this.hasProcessingTransactions || this.justConnected) {
				if ((result = await this.query(this.getProcessingTxsQuery, [])).error !== undefined) {
					return this.abortMining("Failed to retrieve processing transactions.", false, result.error);
				} else {
					//Sort all transactions on the timestamp the user told us they were created (or otherwise by transaction id)
					// tslint:disable-next-line:strict-boolean-expressions (In this case this is what we want, we also handle null as 0).
					(result.rows as UnprocessedTx[]).sort((a, b) => a.create_ts! - b.create_ts! || (a.transaction_id < b.transaction_id ? -1 : 1));

					for (const tx of result.rows as UnprocessedTx[]) {
						blockTransactions.push(new TransactionWithStatus(tx));
					}
				}
			}

			//If we just connected to the DB we don't know the current state, so get everything again.
			if (this.justConnected) {
				//Retrieve previous block information
				if ((result = await this.query(this.previousBlockQuery, [])).error !== undefined) {
					return this.abortMining("Failed to retrieve previous block.", false, result.error);
				} else if (result.rows.length > 0) {
					this.currentBlockId = (result.rows[0] as DBBlock).block_id + 1;
					this.previousBlockTs = (result.rows[0] as DBBlock).processed_ts;
					this.previousBlockHash = new Block(result.rows[0] as DBBlock).getHash(this.signPrefix!);
				} else {
					this.currentBlockId = 0;
					this.previousBlockTs = 0;
					this.previousBlockHash = Buffer.alloc(32);
					Log.warn("No previous blocks found, this should only happen in case of the first block being mined.");
				}
			}

			//If we did have old transactions do not add new ones to ensure we don't mix the order of transactions should it crash again.
			if (blockTransactions.length === 0) {
				let unprocessedTxs: UnprocessedTx[] = [];

				//Gather all transactions it should process
				if ((result = await this.query(this.getNewTxsQuery, [Processor.config.VPROC_TRANSACTIONSPERBLOCK], "getTxs")).error !== undefined) {
					return this.abortMining("Failed to load transactions.", false, result.error);
				} else {
					unprocessedTxs = result.rows;
				}

				//Sort all transactions on the timestamp the user told us they were created (or otherwise by transaction id)
				// tslint:disable-next-line:strict-boolean-expressions (In this case this is what we want, we also handle null as 0).
				unprocessedTxs.sort((a, b) => a.create_ts! - b.create_ts! || (a.transaction_id < b.transaction_id ? -1 : 1));

				//Keep track of the total size of all the transactions inside the block, to ensure blocks don't become too large.
				let currentBlocktxsSize = 0;

				//Process all transactions
				for (const unprocessedTx of unprocessedTxs) {
					//If we (almost) ran out of time finish the current block.
					if (Date.now() - miningStartTime > Processor.config.VPROC_BLOCKINTERVAL * 1000 - 100) {
						break;
					}
					//Check if there is still space remaining in the current block
					//Create the transaction from the database.
					try {
						const tx = new TransactionWithStatus(unprocessedTx);

						currentBlocktxsSize += tx.data.length;
						if (currentBlocktxsSize > Processor.config.VPROC_MAXBLOCKSIZE - Block.emptyLength) {
							break;
						}

						if ((result = await this.query(this.beginQuery, [])).error !== undefined) {
							return this.abortMining("Failed to begin transaction", true, result.error);
						}

						//Process the transaction
						await this.processTx(tx, this.currentBlockId, this.processorAddress, this.previousBlockTs, this.previousBlockHash, true);

						//If there is any reason why this transaction is invalid or should be retried roll it back.
						if (Processor.txInvalidReason !== undefined || Processor.txShouldRetry) {
							if ((result = await this.query(this.rollbackQuery, [])).error !== undefined) {
								return this.abortMining("Failed to rollback a transaction.", true, result.error);
							}
						} else {
							//All params for marking the transaction as processing
							const payload: { [index: string]: any } = tx.getPayloadJson() === undefined ? {} : tx.getPayloadJson()!;
							let contractType: string;
							//Add the contract type.
							if (Processor.txContractHash.equals(Processor.createContractHash)) {
								contractType = "Create Contract";
								Log.info(`New contract: ${(tx.getPayloadJson() as CreatePayload).type} (version: ${(tx.getPayloadJson() as CreatePayload).version}) `);
							} else if (Processor.txContractHash.equals(Processor.deleteContractHash)) {
								contractType = "Delete Contract";
								Log.info(`Contract deleted: ${(tx.getPayloadJson() as DeletePayload).hash} `);
							} else if (this.contractMap.get(Processor.txContractHash.toString()) === undefined) {
								Log.warn(`Transaction ${Crypto.binaryToHex(tx.getId())} was created for unknown contract: ${Crypto.binaryToHex(Processor.txContractHash)}`);
								contractType = "Unknown";
							} else {
								contractType = this.contractMap.get(Processor.txContractHash.toString())!.type;
							}
							const params: Array<string | Buffer> = [
								tx.getId(),
								Processor.txRejectReason === undefined ? TxStatus.ProcessingAccepted : TxStatus.ProcessingRejected,
								Processor.txRejectReason === undefined ? "OK" : Crypto.makeUtf8Postgres(Processor.txRejectReason.slice(0, 128)),
								//Some extra values to make the transaction more easily searchable
								contractType,
								tx.getAddress(),
								payload.receiver === undefined ? undefined : payload.receiver.toString().slice(0, 35),
								payload.extra1 === undefined ? undefined : payload.extra1.toString().slice(0, 64),
								payload.extra2 === undefined ? undefined : payload.extra2.toString().slice(0, 64)
							];
							//Mark the transaction as processing.
							if ((result = await this.query(this.processingTxQuery, params, "processingTx")).error !== undefined) {
								return this.abortMining("Failed to set transaction to processing.", true, result.error);
							}
							if ((result = await this.query(this.commitQuery, [])).error !== undefined) {
								return this.abortMining("Failed to commit transaction.", true, result.error);
							}
							this.hasProcessingTransactions = true;
							//Everything went correctly, set transaction to be put in the block with the correct status
							if (Processor.txRejectReason !== undefined) {
								tx.txStatus = TxStatus.Rejected;
							} else {
								tx.txStatus = TxStatus.Accepted;
							}
							blockTransactions.push(tx);

							Log.debug(`Processed transaction ${Crypto.binaryToHex(tx.getId())}, of type: ${contractType}, result: `
								+ (Processor.txRejectReason === undefined ? "OK" : Processor.txRejectReason));
						}
					} catch (error) {
						Processor.txInvalidReason = error.message;
					}

					//If the transaction is invalid mark it as such
					if (Processor.txInvalidReason !== undefined && !Processor.txShouldRetry) {
						//Determine contract type
						let contractType = "Unknown";
						if (this.contractMap.has(unprocessedTx.contract_hash.toString())) {
							contractType = this.contractMap.get(unprocessedTx.contract_hash.toString())!.type;
						} else if (unprocessedTx.contract_hash.equals(Processor.createContractHash)) {
							contractType = "Create Contract";
						} else if (unprocessedTx.contract_hash.equals(Processor.deleteContractHash)) {
							contractType = "Delete Contract";
						}
						Log.warn(`Invalid transaction: ${Crypto.binaryToHex(unprocessedTx.transaction_id)} for contract ${contractType}: ${Processor.txInvalidReason}`);
						//Add params (We do not make invalid transactions searchable, only provide basic info)
						const params = [
							unprocessedTx.transaction_id,
							Crypto.makeUtf8Postgres(Processor.txInvalidReason.slice(0, 128)),
							Date.now(),
							contractType
						];
						//Doesn't matter if this fails, it won't be part of a block anyway.
						if ((result = await this.query(this.invalidateTxQuery, params, "invalidateTx")).error !== undefined) {
							Log.warn(`Failed to mark transaction ${Crypto.binaryToHex(unprocessedTx.transaction_id)} as invalid.`, result.error);
						}
					}
				}
			}

			//Get the current time, should be greater then the previous one.
			let currentTime = Date.now();
			if (currentTime <= this.previousBlockTs) {
				//If this happens the previous block had a too high timestamp. Nothing we can do about it now, so just continue.
				if (!this.timeWarning) {
					this.timeWarning = true;
					Log.warn(`Previous block time: ${this.previousBlockTs}, current block time: ${currentTime}`);
					Log.error("Block mining timestamp too low.");
				}
				currentTime = this.previousBlockTs + 1;
			} else {
				this.timeWarning = false;
			}

			//Start transaction for block
			if ((result = await this.query(this.beginQuery, [])).error !== undefined) {
				return this.abortMining("Failed to begin block transaction.", true, result.error);
			}

			//Mark all processing transactions as processed
			if (blockTransactions.length > 0) {
				let query2 = `UPDATE basics.transactions AS t SET block_id = ${this.currentBlockId}, processed_ts = ${currentTime}, `
					+ "position_in_block = c.position_in_block, status = c.status FROM (VALUES ";
				const params: Buffer[] = [];
				//Add first result and make sure it is interpreted as transaction_status
				query2 += `($${1}::bytea, ${0}, '${blockTransactions[0].txStatus}'::basics.transaction_status)`;
				params.push(blockTransactions[0].getId());
				//Add comma for any remaining results
				for (let i = 1; i < blockTransactions.length; i++) {
					query2 += `, ($${i + 1}, ${i}, '${blockTransactions[i].txStatus}')`;
					params.push(blockTransactions[i].getId());
				}
				query2 += " ) AS c(transaction_id, position_in_block, status) WHERE c.transaction_id = t.transaction_id;";
				//Check the success.
				if ((result = await this.query(query2, params)).error !== undefined) {
					return this.abortMining("Failed to set transactions to accepted/rejected.", true, result.error);
				}
			}

			//Create the block
			const block = Block.sign({
				version: 1,
				block_id: this.currentBlockId,
				transactions: Transaction.merge(blockTransactions),
				previous_block_hash: this.previousBlockHash,
				processed_ts: currentTime
			}, this.signPrefix!, this.privateKey);

			//Insert the block
			const blockParams: Array<Buffer | number> = [
				block.id,
				block.getPreviousBlockHash(),
				block.processedTs,
				block.getTransactions(),
				block.transactionsAmount,
				block.getSignature(),
				1 //Version
			];
			if ((result = await this.query(this.addBlockQuery, blockParams, "addBlock")).error !== undefined) {
				return this.abortMining("Failed to insert new block.", true, result.error);
			}

			//If everything went correctly: finish transaction for block
			if ((result = await this.query(this.commitBlockQuery, [])).error !== undefined) {
				return this.abortMining("Failed to commit block transaction.", true, result.error);
			}

			//We succeeded, set information for the new block and reset information for mining
			this.previousBlockHash = block.getHash(this.signPrefix!);
			this.previousBlockTs = currentTime;
			this.currentBlockId++;
			this.failures = 0;
			this.justConnected = false;
			this.hasProcessingTransactions = false;
			this.isMining = false;

			if (!this.minedFirstBlock) {
				Log.info("Succesfully mined first block, everything seems to be working.");
				this.minedFirstBlock = true;
			}

			//Report to the master that we mined a block and our current memory usage.
			this.worker.send({ type: "report", memory: process.memoryUsage().heapTotal / 1024 / 1024 });
		} catch (error) {
			//Most likely location for something to go wrong, log the error to have a decent stacktrace and then rethrow it.
			Log.error("Unknown mining error", error);
			throw error;
		}
	}

	/**
	 * Abort mining the current block
	 * @param reason Why do we abort mining
	 * @param rollback Is there a transaction in progress we should rollback?
	 * @param error An optional error.
	 * @param wasStillMining Was it still mining?
	 */
	private abortMining(reason: string, rollback: boolean, error?: Error | undefined, wasStillMining: boolean = false): void {
		this.failures++;
		this.isMining = wasStillMining;
		this.shouldRollback = this.shouldRollback || rollback;
		Log.warn(reason, error !== undefined ? new Error(error.message) : undefined);
	}
}
