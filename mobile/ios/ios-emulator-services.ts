///<reference path="../../.d.ts"/>
"use strict";

import Future = require("fibers/future");
import * as path from "path";
import * as shell from "shelljs";

interface IiOSSim {
	getRunningSimulator(appIdentifier: string): { id: string };
	getApplicationPath(runningSimulatorId: string, appIdentifier: string): string;
}

class IosEmulatorServices implements Mobile.IiOSSimulatorService {
	constructor(private $logger: ILogger,
		private $emulatorSettingsService: Mobile.IEmulatorSettingsService,
		private $errors: IErrors,
		private $childProcess: IChildProcess,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $hostInfo: IHostInfo,
		private $options: ICommonOptions,
		private $fs: IFileSystem,
		private $bplistParser: IBinaryPlistParser,
		private $dispatcher: IFutureDispatcher) { }

	public getEmulatorId(): IFuture<string> {
		return Future.fromResult("");
	}

	public checkDependencies(): IFuture<void> {
		return Future.fromResult();
	}

	public checkAvailability(dependsOnProject: boolean = true): IFuture<void> {
		return (() => {
			if(!this.$hostInfo.isDarwin) {
				this.$errors.fail("iOS Simulator is available only on Mac OS X.");
			}

			let platform = this.$devicePlatformsConstants.iOS;
			if(dependsOnProject && !this.$emulatorSettingsService.canStart(platform).wait()) {
				this.$errors.fail("The current project does not target iOS and cannot be run in the iOS Simulator.");
			}
		}).future<void>()();
	}

	public startEmulator(app: string, emulatorOptions?: Mobile.IEmulatorOptions): IFuture<any> {
		return (() => {
			return this.startEmulatorCore(app, emulatorOptions);
		}).future<any>()();
	}

	public postDarwinNotification(notification: string): IFuture<void> {
		let iosSimPath = require.resolve("ios-sim-portable");
		let nodeCommandName = process.argv[0];

		let opts = [ "notify-post", notification ];

		if (this.$options.device) {
			opts.push("--device", this.$options.device);
		}

		return this.$childProcess.exec(`${nodeCommandName} ${iosSimPath} ${opts.join(' ')}`);
	}

	public sync(appIdentifier: string, projectFilesPath: string, notRunningSimulatorAction: () => IFuture<void>, getApplicationPathForiOSSimulatorAction: () => IFuture<string>): IFuture<void> {
		let syncAction = (applicationPath: string) => (() => { shell.cp("-Rf", projectFilesPath, applicationPath); }).future<void>()();
		return this.syncCore(appIdentifier, notRunningSimulatorAction, syncAction, getApplicationPathForiOSSimulatorAction);
	}

	public syncFiles(appIdentifier: string, projectFilesPath: string,  projectFiles: string[], notRunningSimulatorAction: () => IFuture<void>, getApplicationPathForiOSSimulatorAction: () => IFuture<string>, relativeToProjectBasePathAction?: (_projectFile: string) => string): IFuture<void> {
		let syncAction = (applicationPath: string) => this.transferFiles(appIdentifier, projectFiles, relativeToProjectBasePathAction, applicationPath);
		return this.syncCore(appIdentifier, notRunningSimulatorAction, syncAction, getApplicationPathForiOSSimulatorAction);
	}

	public transferFiles(appIdentifier: string, projectFiles: string[], relativeToProjectBasePathAction?: (_projectFile: string) => string, applicationPath?: string): IFuture<void> {
		return (() => {
			applicationPath = applicationPath || this.getApplicationPath(appIdentifier);
			_.each(projectFiles, projectFile => {
				let destinationPath = path.join(applicationPath, relativeToProjectBasePathAction(projectFile));
				this.$logger.trace(`Transfering ${projectFile} to ${destinationPath}`);
				shell.cp("-Rf", projectFile, destinationPath);
			});
		}).future<void>()();
	}

	public isSimulatorRunning(): IFuture<boolean> {
		return (() => {
			try {
				let output = this.$childProcess.exec("ps cax | grep launchd_sim").wait();
				return output.indexOf('launchd_sim') !== -1;
			} catch(e) {
				return false;
			}
		}).future<boolean>()();
	}

	private _iosSim: IiOSSim = null;
	private get iosSim(): IiOSSim {
		if (!this._iosSim) {
			this._iosSim = require("ios-sim-portable");
		}

		return this._iosSim;
	}

	private startEmulatorCore(app: string, emulatorOptions?: Mobile.IEmulatorOptions): any {
		this.$logger.info("Starting iOS Simulator");
		let iosSimPath = require.resolve("ios-sim-portable");
		let nodeCommandName = process.argv[0];

		if(this.$options.availableDevices) {
			this.$childProcess.spawnFromEvent(nodeCommandName, [iosSimPath, "device-types"], "close", { stdio: "inherit" }).wait();
			return;
		}

		let opts = [
			iosSimPath,
			"launch", app, emulatorOptions.appId // TODO: Refactor this -> should be separate parameter
		];

		if (this.$options.timeout) {
			opts = opts.concat("--timeout", this.$options.timeout);
		}

		if(this.$options.sdk) {
			opts = opts.concat("--sdkVersion", this.$options.sdk);
		}

		if(!this.$options.justlaunch) {
			opts.push("--logging");
		} else {
			if(emulatorOptions) {
				if(emulatorOptions.stderrFilePath) {
					opts = opts.concat("--stderr", emulatorOptions.stderrFilePath);
				}
				if(emulatorOptions.stdoutFilePath) {
					opts = opts.concat("--stdout", emulatorOptions.stdoutFilePath);
				}
			}

			opts.push("--exit");
		}

		if(this.$options.device) {
			opts = opts.concat("--device", this.$options.device);
		} else if (emulatorOptions && emulatorOptions.deviceType) {
			opts = opts.concat("--device", emulatorOptions.deviceType);
		}

		if(emulatorOptions && emulatorOptions.args) {
			opts.push(`--args=${emulatorOptions.args}`);
		}

		if(emulatorOptions && emulatorOptions.waitForDebugger) {
			opts.push("--waitForDebugger");
		}

		let stdioOpts = { stdio: (emulatorOptions && emulatorOptions.captureStdin) ? "pipe" : "inherit" };

		return this.$childProcess.spawn(nodeCommandName, opts, stdioOpts);
	}

	private syncCore(appIdentifier: string, notRunningSimulatorAction: () => IFuture<void>, syncAction: (_applicationPath: string) => IFuture<void>, getApplicationPathForiOSSimulatorAction: () => IFuture<string>): IFuture<void> {
		return (() => {
			if(!this.isSimulatorRunning().wait()) {
				notRunningSimulatorAction().wait();
			}

			let runningSimulatorId = this.getRunningSimulatorId(appIdentifier);

			let applicationPath = this.getApplicationPath(appIdentifier);
			if (applicationPath) {
				syncAction(applicationPath).wait();

				let applicationName = path.basename(applicationPath);

				try {
					this.$childProcess.exec(`killall ${applicationName.split(".")[0]}`).wait();
				} catch(e) {
					this.$logger.trace("Unable to kill simulator: " + e);
				}
			} else {
				let app = getApplicationPathForiOSSimulatorAction().wait();
				this.$childProcess.exec(`xcrun simctl install ${runningSimulatorId} ${app}`).wait();
			}

			setTimeout(() => {
				// Killall doesn't always finish immediately, and the subsequent
				// start fails since the app is already running.
				// Give it some time to die before we attempt restarting.
				this.$childProcess.exec(`xcrun simctl launch ${runningSimulatorId} ${appIdentifier}`);
			}, 500);
		}).future<void>()();
	}

	private getApplicationPath(appIdentifier: string): string {
		let runningSimulatorId = this.getRunningSimulatorId(appIdentifier);
		let applicationPath = this.iosSim.getApplicationPath(runningSimulatorId, appIdentifier);
		return applicationPath;
	}

	private getRunningSimulatorId(appIdentifier: string): string {
		let runningSimulator = this.iosSim.getRunningSimulator(appIdentifier);
		let runningSimulatorId = runningSimulator.id;
		return runningSimulatorId;
	}
}
$injector.register("iOSEmulatorServices", IosEmulatorServices);