
import { loadConfig } from "../config";
import { PrivateKey, Log } from "@coinversable/validana-core";

describe("Config", () => {
	//Remove all arguments, so it doesn't go looking for a file.
	process.argv.splice(0);

	//Base config with a value for all required keys.
	process.env.VPROC_DBPASSWORD = "test";
	process.env.VPROC_PRIVATEKEY = PrivateKey.generate().toWIF();
	process.env.VPROC_SIGNPREFIX = "test";
	const config: any = loadConfig();
	for (const key of Object.keys(config)) {
		config[key] = config[key].toString();
	}
	const processEnv = Object.assign({}, process.env, config);

	describe("Environment variables", () => {
		beforeEach(() => {
			process.env = Object.assign({}, processEnv);
			loadConfig();
		});

		it("Load string succesful", () => {
			process.env.VPROC_DBNAME = "348y9hfawjofl";
			expect(loadConfig().VPROC_DBNAME).toEqual("348y9hfawjofl");
		});
		it("Load number succesful", () => expect(() => {
			process.env.VPROC_DBPORT = "1234";
			loadConfig();
		}).not.toThrow());
		it("Load number error", () => expect(() => {
			process.env.VPROC_BLOCKINTERVAL = "awjdif";
			loadConfig();
		}).toThrow());
		it("Load boolean succesful", () => expect(() => {
			process.env.VPROC_EXCLUDEREJECTED = "true";
			loadConfig();
		}).not.toThrow());
		it("Load boolean error", () => expect(() => {
			process.env.VPROC_EXCLUDEREJECTED = "asdfa";
			loadConfig();
		}).toThrow());

		it("Block size", () => expect(() => {
			process.env.VPROC_MAXBLOCKSIZE = "109999";
			loadConfig();
		}).toThrow());
		it("memory", () => expect(() => {
			process.env.VPROC_MAXMEMORY = "25";
			loadConfig();
		}).toThrow());
		it("tx per block", () => expect(() => {
			process.env.VPROC_TRANSACTIONSPERBLOCK = "0";
			loadConfig();
		}).toThrow());
		it("min block interval", () => expect(() => {
			process.env.VPROC_MINBLOCKINTERVAL = "100";
			loadConfig();
		}).toThrow());
		it("block interval", () => expect(() => {
			process.env.VPROC_BLOCKINTERVAL = "0";
			loadConfig();
		}).toThrow());
		it("log level", () => expect(() => {
			process.env.VPROC_LOGLEVEL = (Log.Debug - 1).toString();
			loadConfig();
		}).toThrow());
		it("log level", () => expect(() => {
			process.env.VPROC_LOGLEVEL = (Log.None + 1).toString();
			loadConfig();
		}).toThrow());
		it("db port", () => expect(() => {
			process.env.VPROC_DBPORT = "0";
			loadConfig();
		}).toThrow());

		it("Missing password", () => expect(() => {
			process.env.VPROC_DBPASSWORD = "";
			loadConfig();
		}).toThrow());
		it("Missing private key", () => expect(() => {
			process.env.VPROC_PRIVATEKEY = "";
			loadConfig();
		}).toThrow());
		it("Missing sign prefix", () => expect(() => {
			process.env.VPROC_SIGNPREFIX = "";
			loadConfig();
		}).toThrow());
	});

	describe("Config file", () => {
		//
	});

	describe("Env and config file", () => {
		//
	});
});