import { Processor } from "../processor";
import { PrivateKey, Transaction, CreatePayload, Crypto, Log } from "@coinversable/validana-core";
import { Client, types } from "pg";
import { Config } from "../config";
import { Worker } from "cluster";
import { execSync } from "child_process";

//Only do integration tests if set
if (process.env.integration === "true" || process.env.INTEGRATION === "true") {
	//Settings used for setting up a test database
	types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
	types.setTypeParser(1016, (val: string) => val.length === 2 ? [] : val.slice(1, -1).split(",").map((v) => Number.parseInt(v, 10)));
	const testdbName = "validana_automatictest_proc";
	const testUser = "validana_automatictest";
	const testPassword = "validana_automatictest";
	const postgresPassword = "postgres";

	//Helper class for executing tests
	class ProcessorTest extends Processor {
		public static errorCounter = -1;
		public static errorCode: string | undefined;

		constructor(worker: Worker, config: Config) {
			super(worker, config);
		}

		protected query(query: string, params: any[], name?: string): Promise<any> {
			ProcessorTest.errorCounter--;
			if (ProcessorTest.errorCounter === 0) {
				throw new Error(query);
			}
			return super.query(query, params, name);
		}

		public static async endConnection(): Promise<void> {
			if (ProcessorTest.client !== undefined) {
				await ProcessorTest.client.end();
			}
		}
	}

	describe("Processor", () => {
		const dummyWorker = { send: () => { } };
		const signPrefix = Buffer.from("test");
		const privateKey = PrivateKey.generate();
		const config = {
			VPROC_BLOCKINTERVAL: 0.5,
			VPROC_MINBLOCKINTERVAL: 0,
			VPROC_DBUSER: testUser,
			VPROC_DBPASSWORD: testPassword,
			VPROC_DBNAME: testdbName,
			VPROC_DBPORT: 5432,
			VPROC_DBHOST: "localhost",
			VPROC_SIGNPREFIX: signPrefix.toString(),
			VPROC_PRIVATEKEY: privateKey.toWIF(),
			VPROC_TRANSACTIONSPERBLOCK: 3,
			VPROC_MAXBLOCKSIZE: 110000,
			VPROC_EXCLUDEREJECTED: true
		};
		const proc = new ProcessorTest(dummyWorker as any, config as any);
		const helperClient = new Client({ user: testUser, password: testPassword, database: testdbName, port: 5432, host: "localhost" });
		const insertTx = (trx: Transaction, date = Date.now()) => {
			return helperClient.query("INSERT INTO basics.transactions(version, transaction_id, contract_hash, " +
				"valid_till, payload, signature, public_key, create_ts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);",
				[trx.version, trx.getId(), trx.getContractHash(), trx.validTill, trx.getPayloadBinary().toString(),
				trx.getSignature(), trx.getPublicKeyBuffer(), date]);
		};
		const countUnprocessed = async () => {
			const count = await helperClient.query("SELECT count(*) FROM basics.transactions WHERE status = 'new';", []);
			return count.rows[0].count;
		};
		const txById = async (id: Buffer) => {
			const transaction = await helperClient.query("SELECT * FROM basics.transactions WHERE transaction_id = $1;", [id]);
			return transaction.rows[0];
		};
		const latestBlock = async () => {
			const block = await helperClient.query("SELECT * FROM basics.blocks ORDER BY block_id DESC LIMIT 1;", []);
			return block.rows[0];
		};
		const payload: CreatePayload = {
			type: "bla",
			version: "1.0",
			description: "Does nothing",
			template: {},
			init: "",
			code: Buffer.from("//").toString("base64"),
			validanaVersion: 2
		};
		const tx = {
			version: 1,
			contract_hash: Buffer.alloc(32),
			valid_till: 0,
			payload: JSON.stringify(payload)
		};

		beforeAll(async () => {
			try { //Create the test database
				const setupClient = new Client({ user: "postgres", password: postgresPassword, database: "postgres", port: 5432, host: "localhost" });
				await setupClient.connect();
				await setupClient.query(`CREATE DATABASE ${testdbName} WITH ENCODING = 'UTF8';`);
				await setupClient.end();
			} catch (error) { } //In case the database already existed: do nothing
			try { //Setup the test database
				execSync(`psql -U postgres -d ${testdbName} -v processor_username=${testUser} -v processor_password=${testPassword} ` +
					`-v backend_username=${testUser} -v backend_password=${testPassword} -f SetupDB.sql`,
					{ env: Object.assign({ PGPASSWORD: postgresPassword }, process.env), stdio: "ignore" });
				const setupClient = new Client({ user: "postgres", password: postgresPassword, database: testdbName, port: 5432, host: "localhost" });
				await setupClient.connect();
				await setupClient.query(`ALTER ROLE ${testUser} CONNECTION LIMIT -1;` +
					`GRANT DELETE ON ALL TABLES IN SCHEMA basics TO ${testUser};`);
				await setupClient.end();
			} catch (error) { } //In case setup is done manually: do nothing

			//Connect the helper client
			await helperClient.connect();

			//Do not spam console output
			Log.Level = Log.Fatal;
		});

		afterAll(async () => {
			await helperClient.end();
		});

		describe("Setup", () => {
			beforeEach(async () => {
				//Reset any data if needed
				const resetData =
					`DELETE FROM basics.transactions; ` +
					`DELETE FROM basics.blocks; ` +
					`DELETE FROM basics.contracts;`;
				await helperClient.query(resetData);
				//Mine a block to ensure previous block ts has a good value and everything is fully reset.
				await ProcessorTest.endConnection();
				await proc.mineBlock();
				await ProcessorTest.endConnection();
			});

			it("Still mining", async () => {
				await Promise.all([
					proc.mineBlock(),
					proc.mineBlock()
				]);
				//We already mined 1 before the tests
				expect((await latestBlock()).block_id).toBe(1);
			});
			it("invalid tx format", async () => {
				const contractCode = "return 'a89hwf';";
				const id = Transaction.generateId();
				const trx = Transaction.sign(Object.assign({}, tx, {
					transaction_id: id,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 2
					}))
				}), signPrefix, privateKey);
				helperClient.query("INSERT INTO basics.transactions(version, transaction_id, contract_hash, " +
					"valid_till, payload, signature, public_key, create_ts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);",
					[0, trx.getId(), trx.getContractHash(), trx.validTill, trx.getPayloadBinary().toString(),
						trx.getSignature(), trx.getPublicKeyBuffer(), Date.now()]);
				await proc.mineBlock();
				expect((await txById(id)).status).toBe("invalid");
			});
			it("Error load previous block", async () => {
				const contractCode = "return 'a89hwf';";
				await proc.mineBlock();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 2
					}))
				}), signPrefix, privateKey));
				await proc.mineBlock();
				const block = await latestBlock();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					contract_hash: Crypto.hash256('"use strict";' + contractCode),
					payload: JSON.stringify({})
				}), signPrefix, privateKey));
				await ProcessorTest.endConnection();
				ProcessorTest.errorCounter = 2;
				await proc.mineBlock();
				expect((await latestBlock()).block_id).toBe(block.block_id);
				expect(await countUnprocessed()).toBe(1);
				await proc.mineBlock();
				expect((await latestBlock()).block_id).toBe(block.block_id + 1);
				expect(await countUnprocessed()).toBe(0);
			});
			it("Error everywhere", async () => {
				const contractCode = "return 'a89hwf7ujr';";
				const id = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 2
					}))
				}), signPrefix, privateKey));
				//There are 14 steps needed from disconnected to succesfully mining a block.
				for (let i = 1; i < 13; i++) {
					//Test what happens when there is an error in any of these steps.
					ProcessorTest.errorCounter = i;
					await proc.mineBlock();
					expect((await txById(id)).status).toBe("new");
				}
				//14th should succeed
				await proc.mineBlock();
				expect((await txById(id)).status).toBe("accepted");
			});
			it("Error in fastquery", async () => {
				const contractCode = "queryFast('INSERT INTO bla (bla) VALUES (1);', []); return 'a89hwf';";
				await proc.mineBlock();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const id = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id,
					contract_hash: Crypto.hash256(contractCode),
					payload: JSON.stringify({})
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect((await txById(id)).status).toBe("invalid");
			});
			it("Error retry", async () => {
				const contractCode = "await query('SELECT 1;', []); return 'as8ydh9gfn';";
				const id = Transaction.generateId();
				await proc.mineBlock();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				ProcessorTest.errorCounter = 2;
				await proc.mineBlock();
				expect((await txById(id)).status).toBe("new");
				await proc.mineBlock();
				expect((await txById(id)).status).toBe("accepted");
			});
			it("Error rollback", async () => {
				const contractCode = "return 'a89hwf';";
				const contractHash = Crypto.hash256(contractCode);
				await proc.mineBlock();
				//Create a new contract, which fails to commit
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				ProcessorTest.errorCounter = 3;
				await proc.mineBlock();
				//Now we do a transaction that relies on this contract. This should not be possible as cache should be cleared.
				const id2 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id2,
					contract_hash: contractHash,
					payload: JSON.stringify({})
				}), signPrefix, privateKey), 1);
				await proc.mineBlock();
				expect((await txById(id2)).contract_type).toBe("Unknown");
			});
			it("Has previous block", async () => {
				//We really want it to be empty for this test, not even a single block for proper previous block ts.
				const resetData =
					`DELETE FROM basics.transactions; ` +
					`DELETE FROM basics.blocks; ` +
					`DELETE FROM basics.contracts;`;
				await helperClient.query(resetData);
				expect(await latestBlock()).toBe(undefined);
				await proc.mineBlock();
				expect((await latestBlock()).block_id).toBe(0);
				await ProcessorTest.endConnection();
				await proc.mineBlock();
				expect((await latestBlock()).block_id).toBe(1);
			});
		});

		describe("Mine", () => {
			beforeEach(async () => {
				//Reset any data if needed
				const resetData =
					`DELETE FROM basics.transactions; ` +
					`DELETE FROM basics.blocks; ` +
					`DELETE FROM basics.contracts;`;
				await helperClient.query(resetData);
				//Mine a block to ensure previous block ts has a good value
				await proc.mineBlock();
				//Reset connection status
				await ProcessorTest.endConnection();
			});

			it("Simple Tx", async () => {
				const contractCode = "return '1';";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					contract_hash: Crypto.hash256(contractCode),
					payload: JSON.stringify({})
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect(await countUnprocessed()).toBe(0);
				expect((await latestBlock()).transactions_amount).toBe(2);
			});
			it("Max block size", async () => {
				const contractCode = "return '1';" + "f".repeat(60000);
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const contractCode2 = "return '1';" + "g".repeat(60000);
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode2).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect(await countUnprocessed()).toBe(1);
				expect((await latestBlock()).transactions_amount).toBe(1);
				await proc.mineBlock();
				expect(await countUnprocessed()).toBe(0);
				expect((await latestBlock()).transactions_amount).toBe(1);
			});
			it("valid, invalid, valid", async () => {
				const contractCode = "return '1'; //aoisdfhj";
				const id1 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id1,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const contractCode2 = "return if";
				const id2 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id2,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode2).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const contractCode3 = "return '1'; //8z9hfrnv";
				const id3 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id3,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode3).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect((await txById(id1)).status).toBe("accepted");
				expect((await txById(id2)).status).toBe("invalid");
				expect((await txById(id3)).status).toBe("accepted");
			});
			it("single invalid", async () => {
				const contractCode = "return else";
				const id1 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id1,
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect((await txById(id1)).status).toBe("invalid");
				expect((await latestBlock()).transactions_amount).toBe(0);
			});
			it("max tx per block + 1", async () => {
				const contractCode1 = "return 1; //a892h4fn";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode1).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const contractCode2 = "return 1; //z8fjosf";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode2).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const contractCode3 = "return 1; //xv89zyh";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode3).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const contractCode4 = "return 1; //mfghj";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode4).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect(await countUnprocessed()).toBe(1);
				await proc.mineBlock();
				expect(await countUnprocessed()).toBe(0);
			});
			it("rejected v1", async () => {
				const contractCode = "return 'Not ok';";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 1
					}))
				}), signPrefix, privateKey));
				const id2 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id2,
					contract_hash: Crypto.hash256(contractCode),
					payload: JSON.stringify({})
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect((await txById(id2)).status).toBe("rejected");
				expect((await latestBlock()).transactions_amount).toBe(2);
			});
			it("rejected v2", async () => {
				const contractCode = "return reject('bla');";
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: Transaction.generateId(),
					payload: JSON.stringify(Object.assign({}, payload, {
						code: Buffer.from(contractCode).toString("base64"),
						validanaVersion: 2
					}))
				}), signPrefix, privateKey));
				const id2 = Transaction.generateId();
				await insertTx(Transaction.sign(Object.assign({}, tx, {
					transaction_id: id2,
					contract_hash: Crypto.hash256('"use strict";' + contractCode),
					payload: JSON.stringify({})
				}), signPrefix, privateKey));
				await proc.mineBlock();
				expect((await txById(id2)).status).toBe("rejected");
				expect((await latestBlock()).transactions_amount).toBe(1);
			});
		});
	});
}