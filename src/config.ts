/*!
 * @license
 * Copyright Coinversable B.V. All Rights Reserved.
 *
 * Use of this source code is governed by a AGPLv3-style license that can be
 * found in the LICENSE file at https://validana.io/license
 */

import * as FS from "fs";
import * as Path from "path";
import { Crypto, Log, PrivateKey } from "@coinversable/validana-core";
import { Cluster as ClusterType } from "cluster";
// eslint-disable-next-line
const Cluster: ClusterType = require("cluster");

/** The config for the processor. Using all capitalized names because this is the standard for environment variables. */
export interface Config extends StringConfig, NumberConfig, BooleanConfig { }
export interface StringConfig {
	VPROC_DBUSER: string; //The database user
	VPROC_DBPASSWORD: string; //The database password
	VPROC_DBNAME: string; //The database name
	VPROC_DBHOST: string; //The database port
	VPROC_SIGNPREFIX: string; //The prefix used for signing for this copy of the processor, to ensure transactions are only valid in this blockchain.
	VPROC_PRIVATEKEY: string; //Private key of the processor.
	VPROC_SENTRYURL: string; //The sentry url for error reporting (optional)
	VPROC_LOGFORMAT: string; //Format used for logging
}
export interface NumberConfig {
	VPROC_LOGLEVEL: number; //The Debug level we use.
	VPROC_DBPORT: number; //The database host
	VPROC_MAXMEMORY: number; //How much memory is the processor allowed to use before we restart it.
	VPROC_BLOCKINTERVAL: number; //Maximum amount of time it has to create a block (once it starts) (in seconds).
	VPROC_MINBLOCKINTERVAL: number; //Mimimum amount of time that must be between 2 blocks (in seconds).
	VPROC_TRANSACTIONSPERBLOCK: number; //The maximum number of transactions in a block
	VPROC_MAXBLOCKSIZE: number; //The maximum size of a block (in bytes)
}
export interface BooleanConfig {
	VPROC_EXCLUDEREJECTED: boolean; //Exclude rejected transaction from blocks
}

//The default values
const stringConfig: StringConfig = {
	VPROC_DBUSER: "processor",
	VPROC_DBNAME: "blockchain",
	VPROC_DBHOST: "localhost",
	//Some values have no default value, we will check later if they exist if necessary.
	VPROC_SIGNPREFIX: "",
	VPROC_DBPASSWORD: "",
	VPROC_PRIVATEKEY: "",
	VPROC_SENTRYURL: "",
	VPROC_LOGFORMAT: ""
};
const numberConfig: NumberConfig = {
	VPROC_LOGLEVEL: 0,
	VPROC_DBPORT: 5432,
	VPROC_MAXMEMORY: 1024,
	VPROC_BLOCKINTERVAL: 60,
	VPROC_MINBLOCKINTERVAL: 5,
	VPROC_TRANSACTIONSPERBLOCK: 100,
	VPROC_MAXBLOCKSIZE: 1000000
};
const boolConfig: BooleanConfig = {
	VPROC_EXCLUDEREJECTED: false
};

/** Load the configuration values from the environment variables and config file. */
export function loadConfig(): Readonly<Config> {
	loadEnv();
	if (!Cluster.isWorker) {
		loadFile();
		validate();
	}

	return Object.assign({}, stringConfig, numberConfig, boolConfig);
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
			const envValue = Number.parseInt(processKey); //eslint-disable-line radix
			if (!Number.isSafeInteger(envValue)) {
				throw new Error(`Invalid value for environment variable: ${key}, expected a number.`);
			} else {
				numberConfig[key as keyof NumberConfig] = envValue;
			}
		}
	}
	for (const key of Object.keys(boolConfig)) {
		const processKey = process.env[key];
		if (processKey !== undefined) {
			if (processKey !== "true" && processKey !== "false") {
				throw new Error(`Invalid value for environment variable: ${key}, expected 'true' or 'false'.`);
			} else {
				boolConfig[key as keyof BooleanConfig] = processKey === "true";
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
		let configFile: { [key: string]: any };
		try {
			configFile = JSON.parse(Crypto.binaryToUtf8(FS.readFileSync(configPath)));
		} catch (error) {
			throw new Error(`Unable to load config file: ${configPath}: ${(error as Error).message}: ${(error as Error).stack}.`);
		}
		if (typeof configFile !== "object" || configFile === null) {
			throw new Error("Config must be a json object.");
		}

		//Load all values from the config file
		for (const key of Object.keys(configFile)) {
			if (stringConfig.hasOwnProperty(key)) {
				if (typeof configFile[key] !== "string") {
					throw new Error(`Invalid type in config file for key: ${key}, expected a string.`);
				} else {
					stringConfig[key as keyof StringConfig] = configFile[key];
				}
			} else if (numberConfig.hasOwnProperty(key)) {
				if (!Number.isSafeInteger(configFile[key])) {
					throw new Error(`Invalid type in config file for key: ${key}, expected an integer.`);
				} else {
					numberConfig[key as keyof NumberConfig] = configFile[key];
				}
			} else if (boolConfig.hasOwnProperty(key)) {
				if (typeof configFile[key] !== "boolean") {
					throw new Error(`Invalid type in config file for key: ${key}, expected a boolean.`);
				} else {
					boolConfig[key as keyof BooleanConfig] = configFile[key];
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
	if (version[0] < 7 || version[0] === 7 && version[1] < 6) {
		throw new Error(`Processor requires at least node js version 7.6 to function, while currently running: ${process.versions.node}.`);
	}
	//Bug in setInterval makes it stop working after 2^31 ms = 25 days
	if (version[0] === 10 && version[1] <= 8) {
		throw new Error(`Please upgrade to node js version >=10.9, there is a problematic bug in earlier 10.x versions. Running version: ${process.versions.node}.`);
	}
	//Check if all numbers have a valid value (NaN always results to false comparisons) and are in range:
	if (numberConfig.VPROC_DBPORT <= 0 || numberConfig.VPROC_DBPORT > 65535) {
		throw new Error(`Invalid db port: ${numberConfig.VPROC_DBPORT}, should be 1-65535.`);
	}
	if (numberConfig.VPROC_LOGLEVEL < Log.Debug || numberConfig.VPROC_LOGLEVEL > Log.None) {
		throw new Error(`Invalid log level: ${numberConfig.VPROC_LOGLEVEL}, should be 0-5.`);
	}
	if (numberConfig.VPROC_MINBLOCKINTERVAL <= 0) {
		throw new Error(`Invalid block min interval: ${numberConfig.VPROC_MINBLOCKINTERVAL}, should be at least 1 second.`);
	}
	if (numberConfig.VPROC_BLOCKINTERVAL < numberConfig.VPROC_MINBLOCKINTERVAL) {
		throw new Error(`Invalid block interval: ${numberConfig.VPROC_BLOCKINTERVAL}, should be at least MINBLOCKINTERVAL.`);
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
		Log.options.tags.address = PrivateKey.fromWIF(stringConfig.VPROC_PRIVATEKEY).getAddress();
	}
	//Check if this processor has a sign previx
	if (stringConfig.VPROC_SIGNPREFIX === "" || Crypto.utf8ToBinary(stringConfig.VPROC_SIGNPREFIX).length > 255) {
		throw new Error(`Too long or missing signprefix: ${stringConfig.VPROC_SIGNPREFIX}.`);
	}
}