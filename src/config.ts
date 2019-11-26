/**
 * @license
 * Copyright Coinversable B.V. All Rights Reserved.
 *
 * Use of this source code is governed by a AGPLv3-style license that can be
 * found in the LICENSE file at https://validana.io/license
 */

import * as Cluster from "cluster";
import * as FS from "fs";
import * as Path from "path";
import { Crypto, Log, PrivateKey } from "@coinversable/validana-core";

/** The config for the processor. Using all capitalized names because this is the standard for environment variables. */
export interface Config extends StringConfig, NumberConfig { }
export interface StringConfig {
	VPROC_NODEVERSION: string; //The required node js version.
	VPROC_DBUSER: string; //The database user
	VPROC_DBPASSWORD: string; //The database password
	VPROC_DBNAME: string; //The database name
	VPROC_DBHOST: string; //The database port
	VPROC_SIGNPREFIX: string; //The prefix used for signing for this copy of the processor, to ensure transactions are only valid in this blockchain.
	VPROC_PRIVATEKEY: string; //Private key of the processor.
	VPROC_SENTRYURL: string; //The sentry url for error reporting (optional)
}
export interface NumberConfig {
	VPROC_LOGLEVEL: number; //The Debug level we use.
	VPROC_DBPORT: number; //The database host
	VPROC_MAXMEMORY: number; //How much memory is the processor allowed to use before we restart it.
	VPROC_BLOCKINTERVAL: number; //Block frequency of the processor (in seconds).
	VPROC_TRANSACTIONSPERBLOCK: number; //The maximum number of transactions in a block
	VPROC_MAXBLOCKSIZE: number; //The maximum size of a block (in bytes)
}

//The default values
const stringConfig: StringConfig = {
	VPROC_NODEVERSION: "10",
	VPROC_DBUSER: "processor",
	VPROC_DBNAME: "blockchain",
	VPROC_DBHOST: "localhost",
	//Some values have no default value, we will check later if they exist if necessary.
	VPROC_SIGNPREFIX: "",
	VPROC_DBPASSWORD: "",
	VPROC_PRIVATEKEY: "",
	VPROC_SENTRYURL: ""
};
const numberConfig: NumberConfig = {
	VPROC_LOGLEVEL: 0,
	VPROC_DBPORT: 5432,
	VPROC_MAXMEMORY: 1024,
	VPROC_BLOCKINTERVAL: 5,
	VPROC_TRANSACTIONSPERBLOCK: 100,
	VPROC_MAXBLOCKSIZE: 1000000
};

/** Load the configuration values from the environment variables and config file. */
export function loadConfig(): Readonly<Config> {
	loadEnv();
	if (Cluster.isMaster) {
		loadFile();
		validate();
	}

	return Object.assign(stringConfig, numberConfig);
}

/** Load all keys from environment variables. */
function loadEnv(): void {
	//Load all keys from environmental variables
	for (const key of Object.keys(stringConfig)) {
		const processKey = process.env[key];
		if (processKey !== undefined) {
			stringConfig[key as keyof StringConfig] = processKey;
		}
	}
	for (const key of Object.keys(numberConfig)) {
		const processKey = process.env[key];
		if (processKey !== undefined) {
			const envValue = Number.parseInt(processKey);
			if (!Number.isSafeInteger(envValue)) {
				throw new Error(`Invalid value for environment variable: ${key}, expected a number.`);
			} else {
				numberConfig[key as keyof NumberConfig] = envValue;
			}
		}
	}
}

/** Load all keys from the config file. */
function loadFile(): void {
	//arg 0 is node.exe, arg 1 is this script.js, arg2+ are the passed arguments
	if (process.argv.length >= 3) {
		//Determine where the config file should be and if it exists.
		const configPath = Path.resolve(process.argv[process.argv.length - 1]);
		if (!FS.existsSync(configPath)) {
			throw new Error(`Unable to find file: ${configPath}.`);
		}
		//Load config file.
		let configFile: any;
		try {
			configFile = JSON.parse(Crypto.binaryToUtf8(FS.readFileSync(configPath)));
		} catch (error) {
			throw new Error(`Unable to load config file: ${configPath}: ${(error as Error).message}: ${(error as Error).stack}.`);
		}

		//Load all values from the config file
		for (const key of Object.keys(configFile)) {
			if (stringConfig.hasOwnProperty(key)) {
				if (typeof configFile[key] !== "string") {
					throw new Error(`Invalid type in config file for key: ${key}, expected a string.`);
				} else {
					stringConfig[key as keyof StringConfig] = configFile[key].toString();
				}
			} else if (numberConfig.hasOwnProperty(key)) {
				if (!Number.isSafeInteger(configFile[key])) {
					throw new Error(`Invalid type in config file for key: ${key}, expected an integer.`);
				} else {
					numberConfig[key as keyof NumberConfig] = configFile[key];
				}
			} else {
				Log.warn(`Unknown config file key: ${key}`);
			}
		}
	}
}

/** Validate if all values are correct. */
function validate(): void {
	//Check if we are running at least node js version 7.6, as is needed for the processor to function.
	const version: number[] = [];
	for (const subVersion of process.versions.node.split(".")) {
		version.push(Number.parseInt(subVersion, 10));
	}
	if (!(version[0] > 7 || version[0] === 7 && version[1] >= 6)) {
		throw new Error(`Processor requires at least node js version 7.6 to function, while currently running: ${process.versions.node}.`);
	}
	//Check if we are running the required version according to the config (at least the mayor version should be provided by the config).
	const configVersion: string[] = stringConfig.VPROC_NODEVERSION.split(".");
	for (let i = 0; i < configVersion.length || i < 1; i++) {
		if (!(configVersion[i] === "x" || version[i] === Number.parseInt(configVersion[i], 10))) {
			throw new Error(`Invalid node js version, running version: ${process.versions.node}, required version by config: ${stringConfig.VPROC_NODEVERSION}.`);
		}
	}
	//Check if all numbers have a valid value (NaN always results to false comparisons) and are in range:
	if (numberConfig.VPROC_DBPORT <= 0 || numberConfig.VPROC_DBPORT > 65535) {
		throw new Error(`Invalid db port: ${numberConfig.VPROC_DBPORT}, should be 1-65535.`);
	}
	if (numberConfig.VPROC_LOGLEVEL < Log.Debug || numberConfig.VPROC_LOGLEVEL > Log.None) {
		throw new Error(`Invalid log level: ${numberConfig.VPROC_LOGLEVEL}, should be 0-5.`);
	}
	if (numberConfig.VPROC_BLOCKINTERVAL <= 0) {
		throw new Error(`Invalid block interval: ${numberConfig.VPROC_BLOCKINTERVAL}, should be at least 1 second.`);
	}
	if (numberConfig.VPROC_TRANSACTIONSPERBLOCK <= 0) {
		throw new Error(`Invalid max transactions per block: ${numberConfig.VPROC_TRANSACTIONSPERBLOCK}, should be at least 1.`);
	}
	if (numberConfig.VPROC_MAXMEMORY < 128) {
		throw new Error(`Invalid max memory: ${numberConfig.VPROC_MAXMEMORY}, should be at least 128 MB.`);
	}
	if (numberConfig.VPROC_MAXBLOCKSIZE < 110000) {
		throw new Error(`Invalid max block size: ${numberConfig.VPROC_MAXBLOCKSIZE}, should be at least 110000 bytes.`);
	}
	//Check if database password and the private key are provided and valid
	if (stringConfig.VPROC_DBPASSWORD === "") {
		throw new Error(`No database password provided.`);
	}
	if (!PrivateKey.isValidWIF(stringConfig.VPROC_PRIVATEKEY)) {
		//Do not log private key
		throw new Error(`Invalid private key. (Only compressed keys with prefix 0x80 are supported.)`);
	} else {
		Log.options.tags!.address = PrivateKey.fromWIF(stringConfig.VPROC_PRIVATEKEY).getAddress();
	}
	//Check if this processor has a sign previx
	if (stringConfig.VPROC_SIGNPREFIX === "" || Crypto.utf8ToBinary(stringConfig.VPROC_SIGNPREFIX).length > 255) {
		throw new Error(`Too long or missing signprefix: ${stringConfig.VPROC_SIGNPREFIX}.`);
	}
}