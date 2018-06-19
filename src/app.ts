/**
 * @license
 * Copyright Coinversable B.V. All Rights Reserved.
 *
 * Use of this source code is governed by a AGPLv3-style license that can be
 * found in the LICENSE file at https://validana.io/license
 */

import * as Cluster from "cluster";
import { Log, Sandbox } from "validana-core";
import { Processor } from "./processor";
import { Config, loadConfig } from "./config";

//What if there is an exception that was not cought
process.on("uncaughtException", (error: Error) => {
	Sandbox.unSandbox();
	if (error.stack === undefined) {
		error.stack = "";
	}
	//Do not accidentially capture the private key or password
	if (typeof config !== "undefined") {
		if (config.VPROC_PRIVATEKEY !== undefined) {
			error.message = error.message.replace(new RegExp(config.VPROC_PRIVATEKEY, "g"), "");
			error.stack = error.stack.replace(new RegExp(config.VPROC_PRIVATEKEY, "g"), "");
		}
		if (config.VPROC_DBPASSWORD !== undefined) {
			error.message = error.message.replace(new RegExp(config.VPROC_DBPASSWORD, "g"), "");
			error.stack = error.stack.replace(new RegExp(config.VPROC_DBPASSWORD, "g"), "");
		}
		if (config.VPROC_SENTRYURL !== undefined) {
			error.message = error.message.replace(new RegExp(config.VPROC_SENTRYURL, "g"), "");
			error.stack = error.stack.replace(new RegExp(config.VPROC_SENTRYURL, "g"), "");
		}
	}
	Log.fatal("uncaughtException", error).then(() => process.exit(1));
});
process.on("unhandledRejection", (reason: any, _: Promise<any>) => {
	Sandbox.unSandbox();
	Log.fatal(`unhandledRejection: ${reason}`, new Error("unhandledRejection")).then(() => process.exit(1));
});
process.on("warning", (warning: Error) => {
	const shouldSandbox = Sandbox.isSandboxed();
	Sandbox.unSandbox();

	//We only use them while in the sandbox.
	if (warning.message.indexOf("'GLOBAL' is deprecated") === -1 && warning.message.indexOf("'root' is deprecated") === -1) {
		Log.error("Process warning", warning);
	}

	if (shouldSandbox) {
		Sandbox.sandbox();
	}
});

//Load the config
let config: Readonly<Config>;
try {
	config = loadConfig();
	if (config.VPROC_SENTRYURL !== "") {
		Log.setReportErrors(config.VPROC_SENTRYURL);
	}
} catch (error) {
	Log.fatal(`${error.message} Exiting process.`);
	process.exit(1);
}

//Set log information:
Log.options.tags!.master = Cluster.isMaster.toString();
Log.options.tags!.processorVersion = "1.0.0";
Log.Level = config!.VPROC_LOGLEVEL;

let isShuttingDown: boolean = false;
let isGraceful: boolean = true;

//Start the master or worker.
if (Cluster.isMaster) {
	setupMaster();
} else {
	setupWorker();
}

/** Setup the master. The masters only task is to ensure the worker stays online. */
function setupMaster(): void {
	//Everything loaded correctly, notify user the process is running and create the worker.
	Log.info(`Master (pid: ${process.pid}) is running`);
	createWorker();

	//If the worker shuts down.
	Cluster.on("exit", (worker: Cluster.Worker, code: number, _: string) => {
		if (code === 0) {
			//Should only happen if master told worker to shut down, for example when we tell the master to shut down.
			Log.info(`Worker ${worker.id} (pid: ${worker.process.pid}) exited.`);
		} else {
			Log.info(`Worker ${worker.id} (pid: ${worker.process.pid}) died with code ${code}`);
			Log.error(`Worker died with code ${code}`);
			if (code >= 50 && code < 60) {
				//So far only db corruption, wrong postgres version or another instance already running will result in this.
				Log.fatal("Worker signaled it should stay down due to an error it cannot recover from.",
					undefined).then(() => shutdownMaster(true, code));
				return;
			}
		}

		//Restart worker after a 1 second timeout.
		if (!isShuttingDown) {
			setTimeout(createWorker, 1000);
		}
	});

	let notMinedTimes: number = 0;
	Cluster.on("online", () => notMinedTimes = 0);

	//If a worker mines a block.
	Cluster.on("message", (worker, message) => {
		if (typeof message === "object" && message.type === "report" && typeof message.memory === "number") {
			notMinedTimes = 0;
			if (message.memory > config.VPROC_MAXMEMORY) {
				Log.error("Processor using too much memory, restarting processor.");
				shutdownWorker(worker.id.toString(), true);
			}
		} else {
			Log.error("Processor send unknown message.");
		}
	});

	//Check if the worker is still mining.
	setInterval(() => {
		//How many times in a row has it failed to mine?
		if (notMinedTimes === 2) {
			Log.error("Processor failed to mine multiple times in a row, restarting processor.");
			for (const id of Object.keys(Cluster.workers)) {
				shutdownWorker(id, true);
			}
		} else if (notMinedTimes > 0 && notMinedTimes < 2) {
			Log.warn("Processor failed to mine.");
		}
		notMinedTimes++;
	}, config.VPROC_BLOCKINTERVAL * 1000 * 2);

	//What to do if we receive a signal to shutdown
	process.on("SIGINT", () => shutdownMaster(false));
	process.on("SIGTERM", () => shutdownMaster(true));
}

/** Shutdown the master. */
function shutdownMaster(hardkill: boolean, code: number = 0): void {
	if (!isShuttingDown) {
		Log.info("Master shutting down...");

		isShuttingDown = true;

		//Send shutdown signal to all workers.
		isGraceful = true;
		for (const id of Object.keys(Cluster.workers)) {
			shutdownWorker(id, hardkill);
		}

		setInterval(() => {
			if (Object.keys(Cluster.workers).length === 0) {
				Log.info("Shutdown completed");
				process.exit(code === 0 && !isGraceful ? 1 : code);
			}
		}, 500);
	}
}

/** Setup the worker. The worker has the task of actually doing the mining. */
function setupWorker(): void {
	//If this process encounters an error when being created/destroyed. We do not do a graceful shutdown in this case.
	Cluster.worker.on("error", (error) => {
		Log.error("Worker encountered an error", error);

		process.exit(1);
	});

	Log.info(`Worker ${Cluster.worker.id} (pid: ${process.pid}) started`);

	//Create the processor and start mining
	const processor = new Processor(Cluster.worker, config);
	setTimeout(() => processor.mineBlock(), 0);
	setInterval(() => processor.mineBlock(), config.VPROC_BLOCKINTERVAL * 1000);

	//If the master sends a shutdown message we do a graceful shutdown.
	Cluster.worker.on("message", (message: string) => {
		Log.info(`Worker ${process.pid} received message: ${message}`);
		if (message === "shutdown" && !isShuttingDown) {
			//The processor will also end the process after it is done.
			isShuttingDown = true;
			Processor.shutdown();
		}
	});

	//What to do if we receive a signal to shutdown?
	process.on("SIGTERM", () => {
		Log.info(`Worker ${process.pid} received SIGTERM`);
		if (!isShuttingDown) {
			isShuttingDown = true;
			Processor.shutdown();
		}
	});
	process.on("SIGINT", () => {
		Log.info(`Worker ${process.pid} received SIGINT`);
		if (!isShuttingDown) {
			isShuttingDown = true;
			Processor.shutdown();
		}
	});
}

/** Create a new worker. Will retry until it succeeds. */
function createWorker(timeout: number = 5000): void {
	try {
		Cluster.fork(config);
	} catch (error) {
		if (timeout >= 60000) {
			//Problem seems to not resolve itsself.
			Log.error("Failed to start the worker many times in a row.", error);
		} else {
			Log.warn("Failed to start worker", error);
		}
		//Increase retry time up to 5 min max.
		setTimeout(createWorker, timeout, Math.min(timeout * 1.5, 300000));
	}
}

/**
 * Shutdown a worker.
 * @param id the id of the worker to shut down.
 * @param hardkill whether to kill the worker if it does not gracefully shutdown within 10 seconds.
 */
function shutdownWorker(id: string, hardkill: boolean): void {
	//Send shutdown message for a chance to do a graceful shutdown.
	if (Cluster.workers[id] !== undefined) {
		Cluster.workers[id]!.send("shutdown", undefined, (error: Error | null) => {
			//Doesn't matter if it fails, there will be a hard kill in 10 seconds.
			//(write EPIPE errors mean the worker closed the connection, properly because it already exited.)
			if (error !== null && error.message !== "write EPIPE") {
				Log.warn(`Worker ${id} shutdown failed`, error);
			}
		});
	} else {
		Log.info(`Trying to shutdown non-existing worker ${id}`);
		Log.error("Trying to shutdown non-existing worker");
	}

	//Give every handler 10 seconds to shut down before doing a hard kill.
	if (hardkill) {
		setTimeout(() => {
			if (Cluster.workers[id] !== undefined) {
				isGraceful = false;
				Log.info(`Worker ${id} not shutting down.`);
				Log.fatal("Hard killing worker, is there a contract with an infinite loop somewhere?");
				process.kill(Cluster.workers[id]!.process.pid, "SIGKILL");
			}
		}, 10000);
	}
}