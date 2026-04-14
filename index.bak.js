const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

import {Logger, bigIntStatsOptions, FILE_NAME_DIRECTORY_SEPARATOR_ERROR,
	FILE_HANDLE_CLOSE_REASON, closeFileHandle, getOptimalChunkSize} from "./internals.js";

/** @type {Object.<TimeLimitedFileCache>} */
const cacheFromEntityKey = {};





class TimeLimitedFileCache
{
	/**
	 * @typedef {Object} WriteResultType
	 * @property {symbol} SKIPPED_SAME_AS_MEMORY_CACHE
	 * @property {symbol} CANCELED_BY_NEWER_REQUEST
	 * @property {symbol} COMPLETED_SUCCESSFULLY
	 */

	/**
	 * @typedef {WriteResultType[keyof WriteResultType]} WriteResultKey
	 * @see {TimeLimitedFileCache.WRITE_RESULT}
	 */

	/** @type {WriteResultType} */
	static WRITE_RESULT = Object.freeze({
		SKIPPED_SAME_AS_MEMORY_CACHE: Symbol(),
		CANCELED_BY_NEWER_REQUEST: Symbol(),
		COMPLETED_SUCCESSFULLY: Symbol()
	});

	static #enableConstruction = false;

	static maxOpenFileHandles = 16;

	static fileHandleTTL = 1000 * 60;

	/**
	 * 書き込みストリームによる処理でストリームが正しく閉じられなかった場合などに、強制的に次の読み取り／書き込みへ処理を渡す際の待機ミリ秒数。
	 * @type {number}
	 * @default 3000
	 * @example
	 * const cache = TimeLimitedFileCache.fromDirectory("cache");
	 * const writeStreamAgent = await cache.writeAsStream("file.txt");
	 * await writeStreamAgent.write(Buffer.from("Hello, World!"));
	 *
	 * @example
	 * const streamClose = writeStreamAgent.end({waitForClose: true});
	 * streamClose.then(agent => {
	 *     //必ず次の読み取り／書き込みに処理が渡ります
	 * }.catch({error, agent} =>{
	 *     //書き込みストリームを完了しようとした時、または書き込みストリームの完了の後の
	 *     //ストリームを閉じようとした時にエラーが発生すると、次の読み取り／書き込みに処理が渡りませんが、
	 *     //TimeLimitedFileCache.writeStreamErrorTimeout または、
	 *     //cache.writeAsStream() メソッドの第 3 引数に渡したミリ秒数が経過すると
	 *     //強制的に次の読み取り／書き込みに処理が渡ります
	 * }
	 *
	 * @example
	 * const streamClose = writeStreamAgent.end({waitForClose: false});
	 * streamClose.then(agent => {
	 *     //必ず次の読み取り／書き込みに処理が渡ります
	 * }).catch({error, agent} =>{
	 *     //書き込みストリームを完了しようとした時にエラーが発生すると、次の読み取り／書き込みに処理が渡りませんが、
	 *     //TimeLimitedFileCache.writeStreamErrorTimeout または、
	 *     //cache.writeAsStream() メソッドの第 3 引数に渡したミリ秒数が経過すると
	 *     //強制的に次の読み取り／書き込みに処理が渡ります
	 * })
	 */
	static writeStreamErrorTimeout = 3000;

	/**
	 *
	 * @param {string} name
	 * @return {IOProfile}
	 */
	static createNewIOProfile(name)
	{
		IOProfile.checkProfileName(name);
		return new IOProfile(name);
	}

	/** @return {Object<IOProfile>} */
	static listIOProfiles() { return IOProfile.profiles; }

	/**
	 *
	 * @param {string} fullPath
	 * @return {Promise<LogicalVolume>}
	 */
	static getLogicalVolume(fullPath)
	{
		return new Promise((resolve, reject) =>
		{
			fs.promises.stat(fullPath, bigIntStatsOptions).then((stats)=>
			{
				const vol = LogicalVolume.getFromStatsDeviceID(stats.dev);
				if(!vol.hostDevice)
					vol.hostDevice = StorageDevice.getFromId(`unknown ${unknowDeviceCount++}`);

				resolve(vol);
			}).catch(reject);
		});
	}

	/** @return {Object<LogicalVolume>} */
	static listLogicalVolumes() { return Object.create(LogicalVolume.fromStatsDeviceId); }

	/** @return {Map<string, StorageDevice>} */
	static listStorageDevices() { return StorageDevice.devices; }


	/** Object.<Promise<CacheDirectory, Error>> */
	static #fromDirectoryPromise = {};

	/**
	 *
	 * @param {string} directory
	 * @param {boolean} [create=false]
	 * @return {Promise<CacheDirectory, Error>}>}
	 */
	static fromDirectory(directory, create=false)
	{
		if(typeof this.#fromDirectoryPromise[directory] === "undefined")
		{
			this.#fromDirectoryPromise[directory] = new Promise((resolve, reject) =>
			{
				if(!checkedDirectoryPath.has(directory))
				{
					if(!path.isAbsolute(directory))
						throw new Error("TimeLimitedFileCache.fromDirectory() に指定するディレクトリパスは絶対パスで指定してください");

					checkedDirectoryPath.add(directory);
				}

				if(typeof CacheDirectory.directoryFromFullPath[directory] === "undefined")
					CacheDirectory.directoryFromFullPath[directory] = new CacheDirectory(directory);

				const cacheDirectory = CacheDirectory.directoryFromFullPath[directory];
				let logger;if(Logger) logger = Logger.loggers.get(cacheDirectory);
				CacheDirectory.acquireEntity(cacheDirectory, logger, create).then(entity=>
				{
					FileSystemEntry.updateEntity(DirectoryEntity, cacheDirectory, entity);
					if(entity) resolve(cacheDirectory);
				}).catch(reject).finally(() =>
				{
					delete this.#fromDirectoryPromise[directory];
				});
			});
		}

		return this.#fromDirectoryPromise[directory];
	}

	static #autoDetectDevicesPromise;

	/**
	 *
	 * @param {typeof import('systeminformation')} systemInformation
	 * @param {boolean} [autoMapping=true]
	 * @param {boolean} [useOptimalProfile=true]
	 */
	static autoDetectDevices(systemInformation, autoMapping=true, useOptimalProfile=true)
	{
		if(!this.#autoDetectDevicesPromise)
		{
			this.#autoDetectDevicesPromise = new Promise((resolve) =>
			{
				const diskLayoutPromise = systemInformation.diskLayout().then(diskLayout =>
				{
					for(let i = diskLayout.length; i--;)
					{
						const dl = diskLayout[i];
						const sd = StorageDevice.getFromId(dl.device);

						sd.applyDiskLayoutData(dl);
					}
					return Promise.resolve();
				});


				const blockDevicesPromise = systemInformation.blockDevices().then(blockDevices =>
				{
					const promises = [];
					for(let i = blockDevices.length; i--;)
					{
						const bd = blockDevices[i];
						/** @type {LogicalVolume} */
						let vol;
						promises.push(fs.promises.stat(bd.mount, bigIntStatsOptions).then(stats =>
						{
							vol = LogicalVolume.getFromStatsDeviceID(stats.dev);
							vol.stats = stats;
							vol.setBlockDeviceData(bd, bd.mount);
							return diskLayoutPromise;
						}).then(()=>
						{
							if(autoMapping)
							{
								if(bd.device) vol.hostDevice = StorageDevice.getFromId(bd.device);
								else vol.hostDevice = StorageDevice.getFromId(`unknown ${unknowDeviceCount++}`);
							}

							if(autoMapping && useOptimalProfile)
							{
								const sd = vol.hostDevice;
								const statsBlockSize = Number(vol.stats.blksize);
								const ioProfile = vol.ioProfile;
								let maxConcurrentReads = ioProfile.maxConcurrentReads;
								let minChunkSize = ioProfile.minChunkSize;
								const type = sd.type.toLowerCase();
								const interfaceType = sd.interfaceType.toLowerCase();
								if(type === "ssd" || type === "nvme" || type === "virtual" || type === "tmpfs" || type === "lvm")
								{
									switch (interfaceType)
									{
										case "fc":
										case "fibre channel":
											maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
											minChunkSize = 64 * 1024;
											break;
										case "nvme":
											maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
											minChunkSize = 64 * 1024;
											break;
										case "sata":
										case "usb_4":
										case "thunderbolt":
											maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
											minChunkSize = 64 * 1024;
											break;
										case "usb":
										case "usb_3":
											maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
											minChunkSize = 128 * 1024;
											break;
										case "usb_2":
											maxConcurrentReads = cpuLength > 2 ? 2 : cpuLength;
											minChunkSize = 128 * 1024;
											break;
										default:
											maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
											minChunkSize = 64 * 1024;
									}
								}
								else if(type === "network")
								{
									switch(interfaceType)
									{
										case "infiniband":
											maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
											minChunkSize = 256 * 1024;
											break;
										case "ethernet":
											maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
											minChunkSize = 256 * 1024;
											break;
										case "iscsi":
											maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
											minChunkSize = 256 * 1024;
											break;
										case "smb":
										case "cifs":
											maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
											minChunkSize = 256 * 1024;
											break;
										default:
											maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
											minChunkSize = 512 * 1024;
									}
								}
								else if(type === "advanced" || type === "mpath" || type === "multipath")
								{
									switch(interfaceType)
									{
										case "fc":
										case "fibre channel":
											maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
											minChunkSize = 64 * 1024;
											break;
										case "sata":
										case "sas":
										case "pcie":
										case "nvme":
											maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
											minChunkSize = 64 * 1024;
											break;
										default:
											maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
											minChunkSize = 128 * 1024;
									}
								}
								else if(type === "hd" || type === "hdd" || type === "sas" || type === "scsi")
								{
									switch(interfaceType)
									{
										case "fc":
										case "fibre channel":
										case "sas":
										case "scsi":
										case "scsi-host-adapter":
										case "raid":
											maxConcurrentReads = cpuLength > 3 ? 3 : cpuLength;
											minChunkSize = getOptimalChunkSize(256 * 1024, sd);
											break;
										case "sata":
											maxConcurrentReads = cpuLength > 2 ? 2 : cpuLength;
											minChunkSize = getOptimalChunkSize(128 * 1024, sd);
											break;
										case "ide":
										case "atapi":
										case "ata":
										case "pata":
										case "eide":
										case "usb":
										default:
											maxConcurrentReads = 1;
											minChunkSize = getOptimalChunkSize(128 * 1024, sd);
											break;
									}
								}
								else if(type === "tape")
								{
									maxConcurrentReads = 1;
									switch(interfaceType)
									{
										case "sas":
										case "fc":
										case "fibre channel":
											minChunkSize = getOptimalChunkSize(512 * 1024, sd);
											break;
										case "lto-xx":
										default:
											minChunkSize = getOptimalChunkSize(1024 * 1024, sd);
											break;
									}
								}
								else if(type === "cd-rom" || type === "dvd-rom" || type === "bd-rom")
								{
									maxConcurrentReads = 1;
									switch(interfaceType)
									{
										case "sata":
										case "ide":
										case "atapi":
										case "usb":
											minChunkSize = 256 * 1024;
											break;
										default:
											minChunkSize = 512 * 1024;
											break;
									}
								}
								else if(type === "floppy")
								{
									maxConcurrentReads = 1;
									minChunkSize = getOptimalChunkSize(128 * 1024, sd);
								}
								else if(type === "fuse" || type === "crypto" || type === "vboxsf" || type === "vmhgfs")
								{
									maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
									minChunkSize = 256 * 1024;
								}
								else if(type === "virtio")
								{
									maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
									minChunkSize = 64 * 1024;
								}
								else if(type === "zfs" || type === "md" || type === "btrfs")
								{
									maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
									minChunkSize = 64 * 1024;
								}
								else if(type === "loop")
								{
									maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
									minChunkSize = 64 * 1024;
								}
								else if(type === "pipe" || type === "serial")
								{
									maxConcurrentReads = 1;
									minChunkSize = 128 * 1024;
								}
								minChunkSize = statsBlockSize > minChunkSize ? statsBlockSize : minChunkSize;

								ioProfile.maxConcurrentReads = maxConcurrentReads;
								ioProfile.minChunkSize = minChunkSize;
							}
							return Promise.resolve();
						}).catch(()=>Promise.resolve()));
					}

					return Promise.all(promises).then(()=>
					{
						this.#autoDetectDevicesPromise = null;
						resolve();
					});
				});
			});
		}
		return this.#autoDetectDevicesPromise;
	}

	/** @type {number} */
	memoryTTL;

	/** @type {number} */
	fileTTL;

	static set debug(bool)
	{
		if(bool)
		{
			Logger = require("./log");
			Logger.TimeLimitedFileCache = TimeLimitedFileCache;
			this.log = [];
			this.stacks = [];
		}
		else
		{
			Logger = null;
		}
	}

	/** @type {string[]} debug プロパティが true の時、直前の処理のログメッセージが入ります */
	static log = null;

	/** @type {string[]} debug プロパティが true の時、直前の処理のスタック（CallSite インスタンス）が入ります */
	static stacks = null;

	/** @type {string} */
	directory;

	/** @type {Object.<TimeLimitedEntity>} */
	#children = {};

	constructor()
	{
		if(!TimeLimitedFileCache.#enableConstruction) throw new Error("new TimeLimitedFileCache() は禁止されてますよ。初期化処理をちゃんとしたいので、TimeLimitedFileCache.fromDirectory() メソッドで TimeLimitedFileCache インスタンスを取得してください");
	}

	/**
	 *
	 * @param {string} fileName
	 * @param {number} [maxStreamBufferSize=16384]
	 * @return {Promise<ReadStreamAgent>}
	 */
	readAsStream(fileName, maxStreamBufferSize = 16384)
	{
		if(typeof this.#children[fileName] === "undefined")
		{
			if(fileName.includes(path.sep)) throw FILE_NAME_DIRECTORY_SEPARATOR_ERROR;
			this.#children[fileName] = new TimeLimitedEntity(this, fileName);
		}
		return this.#children[fileName].readAsStream(maxStreamBufferSize);
	}

	/**
	 *
	 * @param {string} fileName
	 * @param {Buffer|ArrayBuffer|TypedArray|string} buffer
	 * @param {boolean} [waitForClose=true]
	 * @return {Promise<WriteResultKey>} ファイルへの書き込みが成功した際に resolve され、また、ファイルの内容と同一の buffer が渡され更新が必要ない場合も resolve されます。
	 */
	writeAsBuffer(fileName, buffer, waitForClose=true)
	{
		return new Promise((resolve, reject)=>
		{
			fileNameCheck(fileName);
			buffer = normalizeToBuffer(buffer);
			const fullPath = path.join(this.directory, fileName);
			if(typeof entityKeyFromPath[fullPath] !== "undefined")
			{
				const entityKey = entityKeyFromPath[fullPath];

				if(typeof this.#children[entityKey] !== "undefined")
				{
					const result = this.#children[entityKey].preWriteCheck(buffer);
					if(result === TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE)
						return resolve(result);
				}
			}
		});
	}

	/**
	 *
	 * @param {string} fileName
	 * @param {number} [maxStreamBufferSize=16384]
	 * @param {number} [writeStreamErrorTimeout=TimeLimitedFileCache.writeStreamErrorTimeout]
	 * @return {Promise<WriteStreamAgent|TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST|symbol>}
	 * @see {TimeLimitedFileCache.writeStreamErrorTimeout}
	 */
	writeAsStream(fileName, maxStreamBufferSize = 16384, writeStreamErrorTimeout = TimeLimitedFileCache.writeStreamErrorTimeout)
	{
		if(typeof this.#children[fileName] === "undefined")
		{
			if(fileName.includes(path.sep)) throw FILE_NAME_DIRECTORY_SEPARATOR_ERROR;
			this.#children[fileName] = new TimeLimitedEntity(this, fileName);
		}
		return this.#children[fileName].writeAsStream(maxStreamBufferSize, writeStreamErrorTimeout);
	}
}

const fileNameCheck = (fileName)=>
{
	if(!checkedFileName.has(fileName))
	{
		if(fileName.includes(path.sep)) throw FILE_NAME_DIRECTORY_SEPARATOR_ERROR;
		else checkedFileName.add(fileName);
	}
}
/**
 *
 * @param {Logger} logger
 * @return {Promise<void>}
 */
const acquireGlobalFileHandleSlot = (logger)=>
{
	return new Promise((resolve)=>
	{
		if(openFileHandles.size < TimeLimitedFileCache.maxOpenFileHandles)
			resolve();
		else
		{
			logger?.out(Logger.READ_QUEUE_DUE_TO_GLOBAL_READ_LIMIT);

			for(const entity of openFileHandles.keys())
			{
				if(!entity.isBusy)
				{
					const fileHandle = openFileHandles.get(entity);
					return releaseFileHandle(entity, fileHandle, FILE_HANDLE_CLOSE_REASON.NEWER_REQUEST, resolve, logger);
				}
			}
			
			fileHandleReleaseWait.push(resolve);
		}

		if(logger) console.log("acquire openFileHandles : " + openFileHandles.size);
	});
}

/**
 *
 * @param {TimeLimitedEntity} entity
 * @param {fs.FileHandle} [fileHandle]
 * @param {Logger} logger
 */
const shouldReleaseFileHandle = (entity, fileHandle, logger) =>
{
	if(fileHandleReleaseWait.length)
	{
		const next = fileHandleReleaseWait.shift();
		if(!fileHandle) fileHandle = openFileHandles.get(entity);
		
		releaseFileHandle(entity, fileHandle, FILE_HANDLE_CLOSE_REASON.WAITING_NEWER_REQUEST, next, logger);
	}
}

const releaseFileHandle = (entity, fileHandle, reason, resolve, logger) =>
{
	entity.isBusy = true;
	entity.isClosing = true;
	closeFileHandle(fileHandle, FILE_HANDLE_CLOSE_REASON.NEWER_REQUEST, logger).then(()=>
	{
		openFileHandles.delete(entity);
		entity.isBusy = false;
		entity.isClosing = false;
		logger?.out(/*todo: ファイルハンドルに空きが出来たため、ファイルハンドルが取得出来ました*/)
		resolve();
	});
}

class Entity
{
	/** @type {Object.<Entity>} */
	static fromEntityKey;

	/** @type {string} */
	entityKey;

	/** @type {Set<FileSystemEntry>} */
	entries;

	/** @type {LogicalVolume} */
	logicalVolume;

	/**
	 *
	 * @param {typeof Entity} EntityClass
	 * @param {fs.BigIntStats} stats
	 * @return {Entity|TimeLimitedEntity|DirectoryEntity}
	 */
	static getEntityFromStats(EntityClass, stats)
	{
		const entityKey = `${stats.dev}:${stats.ino}:${stats.ctimeMs}`;

		const fromEntityKey = EntityClass.fromEntityKey;

		if(typeof fromEntityKey[entityKey] === "undefined")
			fromEntityKey[entityKey] = new EntityClass(entityKey);

		fromEntityKey[entityKey].logicalVolume = LogicalVolume.getFromStatsDeviceID(stats.dev);
		return fromEntityKey[entityKey];
	}

	constructor(entityKey)
	{
		this.entityKey = entityKey;
		this.entries = new Set();
	}
}

class FileSystemEntry
{
	/** @type {string} */
	fullPath;

	/** @type {Logger} */
	#logger;

	get entityKey() { return entityFromEntry.get(this)?.entityKey || "まだ実体キーが取得されていません"; }

	/**
	 *
	 * @param {typeof Entity} EntityClass
	 * @param {FileSystemEntry} entry
	 * @param {Entity} [newEntity]
	 * @return {boolean} isUpdateEntity
	 */
	static updateEntity(EntityClass, entry, newEntity)
	{
		const oldEntity = entityFromEntry.get(entry);
		if(oldEntity !== newEntity)
		{
			if(oldEntity)
			{
				oldEntity.entries.delete(entry);
				if(oldEntity.entries.size <= 0)
					delete EntityClass.fromEntityKey[oldEntity.entityKey];
			}
			entityFromEntry.set(entry, newEntity);
			newEntity.entries.add(entry);
			return true;
		}
		return false;
	}

	constructor(fullPath)
	{
		this.fullPath = fullPath;
	}
}

class CacheDirectory extends FileSystemEntry
{
	/** @type {Object.<CacheDirectory>} */
	static directoryFromFullPath = {};

	/** @type {Map<CacheDirectory, Promise<DirectoryEntity, Error>>} */
	static #acquiringEntity = new Map();

	/**
	 *
	 * @param {CacheDirectory} cacheDirectory
	 * @param {Logger} [logger]
	 * @param {boolean} [create]
	 * @return {Promise<DirectoryEntity, Error>}
	 */
	static acquireEntity(cacheDirectory, logger, create)
	{
		const acquiringEntity = CacheDirectory.#acquiringEntity;
		if(!acquiringEntity.has(cacheDirectory))
		{
			acquiringEntity.set(cacheDirectory, new Promise((resolve, reject)=>
			{
				fs.promises.stat(cacheDirectory.fullPath, bigIntStatsOptions)
				.catch(error=>
				{
					let message;
					if(error.code === "ENOENT")
					{
						if(create)
						{
							return fs.promises.mkdir(cacheDirectory.fullPath, { recursive: true })
							.catch(error=>
							{
								let message;
								if(error.code === "EACCES" || error.code === "EPERM")
									message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリを作成しようとしましたが権限の関係で作成する事が出来ませんでした";
								else if(error.code === "EROFS")
									message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリを作成しようとしましたが、読み取り専用のディレクトリのようで作成する事が出来ませんでした";
								else if(error.code === "ENOSPC")
									message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリを作成しようとしましたが、空き容量が足りないみたいです";
								else if(error.code === "EIO")
									message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリを作成しようとしましたが、ハードウェアの故障みたいなエラーが出ました";
								else
									message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリを作成しようとしましたが、不明なエラーが発生しました。エラーコードなどでググってみて、原因を調査してみてください";

								error.message += message;
								console.error(message);
							})
							.then(()=>
							{
								logger?.out("ディレクトリが存在しなかったため、作成しました");
								return fs.promises.stat(cacheDirectory.fullPath, bigIntStatsOptions);
							});
						}
						else message = "存在しないディレクトリを指定しました。ディレクトリを自動で作成したい場合は TimeLimitedFileCache.fromDirectory() の引数 create に true を指定してください";
					}
					else if(error.code === "ENOTDIR")
						message = "TimeLimitedFileCache.fromDirectory() に指定したディレクトリパスの途中にファイルが混じっているみたいです";
					else if(error.code === "ELOOP")
						message = "TimeLimitedFileCache.fromDirectory() に指定したディレクトリがシンボリックリンクで無限ループされているか、OS がディレクトリ実体に辿り着けないくらいリンク回数が多すぎる可能性があります";
					else if(error.code === "ENAMETOOLONG")
						message = "TimeLimitedFileCache.fromDirectory() に指定したディレクトリのフルパスの文字数が OS の制限を超えているみたいです";
					else if(error.code === "EACCES" || error.code === "EPERM")
						message = "TimeLimitedFileCache.fromDirectory() に指定したディレクトリが権限の関係でアクセスする事が出来ませんでした";
					else if(error.code === "EIO")
						message = "TimeLimitedFileCache.fromDirectory() に指定されたパスの確認をしてみたところ、ハードウェアの故障みたいなエラーが出ました";
					else
						message = "ディレクトリパス確認時に不明なエラーが発生しました。エラーコードなどからエラーの内容をググったりして調べてみてください";

					error.message += message;
					reject(error);
					console.error(message);
				})
				.then(stats=>
				{
					if(stats.isDirectory())
					{
						const entity = Entity.getEntityFromStats(DirectoryEntity, stats);
						resolve(entity);
					}
					else
					{
						const message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリパスでは無くファイルパスを指定しているみたいです";
						const error = new Error(message);
						reject(error);
						console.error(error);
					}
				})
				.finally(() =>
				{
					acquiringEntity.delete(cacheDirectory);
				});
			}));
		}
		return acquiringEntity.get(cacheDirectory);
	}

	/** @type {Object.<TimeLimitedFile>} */
	#files = {};

	/** @type {Logger} */
	#logger;

	/**
	 *
	 * @param {string} fileName
	 * @param {boolean} [waitForClose=true]
	 * @return {Promise<Buffer, Error>}
	 */
	readAsBuffer(fileName, waitForClose=true)
	{
		return this.#getFile(fileName).readAsBuffer(waitForClose);
	}

	writeAsBuffer(fileName, buffer, waitForClose=true)
	{
		return this.#getFile(fileName).writeAsBuffer(buffer, waitForClose);
	}

	/** @return {number} */
	get memoryTTL() { return entityFromEntry.get(this).memoryTTL; }

	/** @return {number} */
	get fileTTL() { return entityFromEntry.get(this).fileTTL; }


	/**
	 *
	 * @param {string} fileName
	 * @return {TimeLimitedFile}
	 */
	#getFile(fileName)
	{
		if(typeof this.#files[fileName] === "undefined")
		{
			fileNameCheck(fileName);
			this.#files[fileName] = new TimeLimitedFile(this, path.join(this.fullPath, fileName));
		}
		return this.#files[fileName];
	}

	setMemoryTTL(memoryTTL, updateTTL = false)
	{
		entityFromEntry.get(this).memoryTTL = memoryTTL;
	}

	setFileTTL(fileTTL, updateTTL = false)
	{
		entityFromEntry.get(this).fileTTL = fileTTL;
	}

	constructor(fullPath)
	{
		super(fullPath);
		if(Logger) this.#logger = new Logger(this);
	}
}

class DirectoryEntity extends Entity
{
	/** @type {Object.<DirectoryEntity>} */
	static fromEntityKey = {};

	/** @type {Set<CacheDirectory>} */
	entries;

	/** @type {number} */
	memoryTTL = 10_000;

	/** @type {number} */
	fileTTL = 600_000;

	/** @type {Object.<TimeLimitedEntity>} */
	#fileEntities = {};

	updateMemoryTTL()
	{

	}

	updateFileTTL()
	{

	}

	constructor(entityKey)
	{
		super(entityKey);
	}
}

class TimeLimitedFile extends FileSystemEntry
{
	/** @type {CacheDirectory} */
	parent;

	/** @type {string} */
	fullPath;

	/** @type {Promise<{entity:TimeLimitedEntity, fileHandle:FileHandle}, Error>} */
	#acquirePromise;

	/** @type {NodeJS.Timeout|number} */
	#fileTimeLimit;

	/** @type {Map<boolean, Promise<Buffer|null, Error>>} */
	#readAsBufferPromise = new Map();

	/** @type {Promise<{fileHandle:fs.FileHandle, buffer:Buffer}|null, Error>} */
	#readPromise;

	/** @type {Set<AbortController>} */
	abortControllers = new Set();

	/** @type {Logger} */
	#logger;

	/** @type {Promise<fs.BigIntStats|fs.Stats, Error>} */
	#fsStatPromise;

	/**
	 *
	 * @param {CacheDirectory} parent
	 * @param {string} fullPath
	 */
	constructor(parent, fullPath)
	{
		super(fullPath);
		this.parent = parent;
		if(Logger) this.#logger = new Logger(this);
	}

	/**
	 * @return {Promise<{entity:TimeLimitedEntity, fileHandle?:FileHandle}, Error>}
	 */
	#acquire()
	{
		if(!this.#acquirePromise)
		{
			this.#acquirePromise = new Promise((resolve, reject)=>
			{
				fs.stat(this.fullPath, bigIntStatsOptions, (error, stats)=>
				{
					if(error)
					{
						let fileHandle;
						if(error.code === "ENOENT")
						{
							this.#getFileHandle("w+")
							.then((fh)=>
							{
								fh.read().then()
								fileHandle = fh;
								return fh.stat(bigIntStatsOptions);
							}).then(stats=>
							{
								this.#acquirePromise = null;
								const entity = Entity.getEntityFromStats(TimeLimitedEntity, stats);
								resolve({entity, fileHandle});
							}).catch(error =>
							{
								reject(error);
							});
						}
						else
						{
							this.#acquirePromise = null;
							return reject(error);
						}
					}

					const entity = Entity.getEntityFromStats(TimeLimitedEntity, stats);
					resolve({entity});
				});
			});
		}
		return this.#acquirePromise;
	}

	/**
	 *
	 * @return {Promise<BigIntStats|any>}
	 */
	#getFileStats()
	{
		if(!this.#fsStatPromise)
		{
			this.#fsStatPromise = fs.promises.stat(this.fullPath, bigIntStatsOptions);
			this.#fsStatPromise.finally(()=>
			{
				this.#fsStatPromise = null;
			});
		}
		return this.#fsStatPromise;
	}

	/**
	 *
	 * @param {string} flags
	 * @return {Promise<fs.FileHandle, Error>}
	 * @deprecated
	 */
	#getFileHandle(flags)
	{
		//todo: FileHandle を FileEntity にキャッシュさせる。 Stats は FileHandle から取らない
		return new Promise((resolve, reject)=>
		{
			acquireGlobalFileHandleSlot(this.#logger).then(()=>
			{
				return fs.promises.open(this.fullPath, flags);
			}).then((fileHandle)=>
			{
				TimeLimitedFile.openFileHandles.add(fileHandle);
				resolve(fileHandle);
			}).catch(error =>
			{
				reject(error);
			})
		})
	}

	#getAbortController(onAbortMessage)
	{
		const abortController = new AbortController();
		const signal = abortController.signal;
		const onAbort = ()=>
		{
			this.abortControllers.delete(abortController);
			signal.removeEventListener("abort", onAbort);
			if(this.#logger) onAbortMessage(signal);
		}
		signal.addEventListener("abort", onAbort);
		this.abortControllers.add(abortController);
		return abortController;
	}

	/**
	 *
	 * @param {boolean} waitForClose
	 * @return {Promise<Buffer|null, Error|Error[]>}
	 */
	readAsBuffer(waitForClose)
	{
		this.#updateFileTimeLimit();

		if(!this.#readPromise)
		{
			const abortController = this.#getAbortController((signal)=>
			{
				/** @type {TimeLimitedFile} */
				const file = signal.reason;
				this.#logger.out(Logger.READ_BUFFER_ABORTED + " " + file.fullPath + " への書き込みが発生しました");
			});
			const signal = abortController.signal;

			this.#readPromise = new Promise((resolve, reject)=>
			{
				/** @type {fs.FileHandle} */
				let fileHandle;
				let skip, canceled;

				const onOpenError = error =>
				{
					if(error.code === "ENOENT")
					{
						resolve(null);
						canceled = true;
					}
					else
					{
						reject(error);
						this.#logger?.out(/*todo: ファイル読み取りオープン時にエラー*/);
					}
				}

				const onAbort = ()=>
				{
					resolve({buffer: entityFromEntry.get(this).memoryCache});
					skip = true;
				}

				const onReadFileComplete = buffer =>
				{
					if(canceled || skip) {}
					else if(Buffer.isBuffer(buffer))
					{
						this.#updateFileTimeLimit();
						resolve({buffer, fileHandle});
					}
					else if(buffer === null) resolve({buffer});
					else this.#logger?.out("ここの処理に来ちゃダメ");
				}

				const onReadFileError = error =>
				{
					closeFileHandle(fileHandle, FILE_HANDLE_CLOSE_REASON.READ_ERROR, this.#logger);
					reject(error);
				}

				const onFinally = ()=>
				{
					this.#readPromise = null;
					this.abortControllers.delete(abortController);
				}

				/** @type {TimeLimitedEntity} */
				const entity = entityFromEntry.get(this);
				if(!entity)
				{
					this.#getFileStats()
					.catch(onOpenError)
					.then(stats=>
					{
						if(canceled) return;

						if(signal.aborted) return onAbort();

						/** @type {TimeLimitedEntity} */
						const entity = Entity.getEntityFromStats(TimeLimitedEntity, stats);
						FileSystemEntry.updateEntity(TimeLimitedEntity, this, entity);
						statsFromEntity.set(entity, stats);

						const buffer = entity.readFromMemory(this.#logger);
						if(Buffer.isBuffer(buffer))
						{
							skip = true;
							this.#updateFileTimeLimit();
							return resolve({buffer});
						}

						if(openFileHandles.has(entity)) return Promise.resolve();
						return entity.activateFileHandle(this.fullPath, "r", this.#logger);
					}).catch(error =>
					{
						reject(error);
					}).then(()=>
					{
						if(canceled || skip) return;

						if(signal.aborted) return onAbort(fileHandle);

						//todo: 並列 read に置き換える！！！！！
						return entity.readFromFile(signal, this.#logger);

					}).then(onReadFileComplete)
					.catch(onReadFileError)
					.finally(onFinally);
				}
				else
				{
					const buffer = entity.readFromMemory(this.#logger);
					if(Buffer.isBuffer(buffer))
					{
						this.#updateFileTimeLimit();
						resolve({buffer});
					}
					else if(buffer === null)
					{

						//todo: entity.readFromFile(this.#logger) に切り替える！！！
						this.#getFileHandle("r")
						.catch(onOpenError)
						.then(fh =>
						{
							if(canceled) return;

							if(signal.aborted) return skip = true;

							fileHandle = fh;
							return fileHandle.readFile({signal});
						}).then(onReadFileComplete)
						.catch(onReadFileError)
						.finally(onFinally);
					}
					else this.#logger?.out("ここの処理に来ちゃダメ");
				}
			});
		}

		if(!this.#readAsBufferPromise.has(waitForClose))
		{
			this.#readAsBufferPromise.set(waitForClose, new Promise((resolve, reject)=>
			{
				/** @type {fs.FileHandle} */
				let fileHandle;
				let returnBuffer, isSuccess;
				this.#readPromise.then(successResult =>
				{
					if(successResult === null) return resolve(null);

					fileHandle = successResult.fileHandle;
					if(Buffer.isBuffer(successResult.buffer))
					{
						isSuccess = true;
						returnBuffer = successResult.buffer;
					}
					else this.#logger?.out("ここの処理に来ちゃダメ");

					if(!waitForClose)
						resolve(returnBuffer);

				}).catch(reject)
				.finally(()=>
				{
					/** @type {TimeLimitedEntity} */
					const entity = entityFromEntry.get(this);
					const fileHandle = openFileHandles.get(entity);
					if(fileHandle)
						shouldReleaseFileHandle(entity, fileHandle, this.#logger);

					if(TimeLimitedFile.openFileHandles.has(fileHandle))
					{
						TimeLimitedFile.openFileHandles.delete(fileHandle)
						fileHandle.close().then(()=>
						{
							if(waitForClose) resolve(returnBuffer);
						})
						.catch(reject)
						.finally(()=>
						{
							this.#readAsBufferPromise.delete(waitForClose);
							shouldReleaseFileHandle(this.#logger);
							if(isSuccess) this.#updateFileTimeLimit();
						});
					}
					else
					{
						if(isSuccess) this.#updateFileTimeLimit();
						this.#readAsBufferPromise.delete(waitForClose);
						if(waitForClose) resolve(returnBuffer);
					}
				});
			}));
		}
		return this.#readAsBufferPromise.get(waitForClose);
	}

	writeAsBuffer(buffer, waitForClose)
	{
		return new Promise((resolve, reject)=>
		{
			const writeSkip = entityFromEntry.get(this)?.updateMemoryCache(buffer, this.#logger);
			if(writeSkip) return resolve(writeSkip);

			const abortController = this.#getAbortController((signal)=>
			{
				const file = signal.reason;
				this.#logger.out(Logger.WRITE_BUFFER_ABORT + " " + file.fullPath + " への書き込みが発生しました");
			});
			const signal = abortController.signal;

			this.#acquire().then(({entity, fileHandle})=>
			{
				if(FileSystemEntry.updateEntity(TimeLimitedEntity, this, entity))
				{
					// #acquire() で取得した entity が現在保持している entity と違った場合この処理に来る
					const writeSkip = entity.updateMemoryCache(buffer, this.#logger);
					if(writeSkip)
					{
						if(fileHandle) closeFileHandle(fileHandle, "w", this.#logger);
						return resolve(writeSkip);
					}
				}

				if(signal.aborted)
				{
					this.#logger?.out(Logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
					if(fileHandle) closeFileHandle(fileHandle, "w", this.#logger);
					return resolve(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);
				}

				let writePromise;

				if(fileHandle)
					writePromise = entity.writeToFile(buffer, fileHandle, abortController, this.#logger);
				else
				{
					writePromise = this.#getFileHandle("w").then(fh=>
					{
						fileHandle = fh;
						if(signal.aborted)
						{
							this.#logger?.out(Logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
							closeFileHandle(fileHandle, "w", this.#logger);
							return resolve(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);
						}
						return entity.writeToFile(buffer, fileHandle, abortController, this.#logger);
					}).catch(error=>
					{
						reject(error);
					});
				}

				let returnData, isSuccess;
				writePromise.then(result=>
				{
					returnData = result;
					isSuccess = true;
					if(!waitForClose) resolve(result);
				}).catch(error=>
				{
					reject(error);
				}).finally(()=>
				{
					if(TimeLimitedFile.openFileHandles.has(fileHandle))
					{
						TimeLimitedFile.openFileHandles.delete(fileHandle);
						fileHandle.close().then(()=>
						{
							if(waitForClose) resolve(returnData);
						}).catch(error=>
						{
							reject(error);
						}).finally(()=>
						{
							if(isSuccess) this.#updateFileTimeLimit();
							shouldReleaseFileHandle(this.#logger);
						});
					}
				});
			});
		});
	}

	/**
	 *
	 */
	#updateFileTimeLimit()
	{
		if(this.#fileTimeLimit) clearTimeout(this.#fileTimeLimit);
		if(entityFromEntry.get(this))
			this.#fileTimeLimit = setTimeout(this.#removeCacheFile, this.parent.fileTTL, this);
	}

	/**
	 *
	 * @param {TimeLimitedFile} file
	 */
	#removeCacheFile = (file)=>
	{
		/** @type {TimeLimitedEntity} */
		const entity = entityFromEntry.get(file);
		entity.entries.delete(file);
		if(entity.entries.size <= 0)
			delete TimeLimitedEntity.fromEntityKey[entity.entityKey];

		fs.promises.unlink(file.fullPath).catch(error=>
		{
			file.#logger?.out(Logger.REMOVE_CACHE_FILE_FAILED);
			console.error(error);
		}).then(()=>
		{
			file.#logger?.out(Logger.REMOVE_CACHE_FILE);
		});

		entityFromEntry.delete(file);
		file.fullPath = void 0;
		file.#fileTimeLimit = null;
	}
}

class TimeLimitedEntity extends Entity
{
	/** @type {Object.<TimeLimitedEntity>} */
	static fromEntityKey = {};

	/** @type {Set<TimeLimitedFile>} */
	entries;

	/** @type {Buffer|null} */
	#memoryCache;

	/** @type {fs.FileHandle} */
	#fileHandle;

	/** @return {Buffer|null} */
	get memoryCache() { return this.#memoryCache; }

	/** @type {NodeJS.Timeout|number} */
	#memoryTimeLimit;

	/** @type {Promise<void, Error>} */
	#openFileHandlePromise;

	/** @type {boolean} */
	isBusy;
	
	/** @type {boolean} */
	isClosing;

	/** @type {BigIntStats} */
	#stats;

	/**
	 *
	 * @param {string} filePath
	 * @param {"r"|"w"} flags
	 * @param {Logger} logger
	 * @return {Promise<void>}
	 */
	activateFileHandle(filePath, flags, logger)
	{
		const fileHandle = openFileHandles.get(this);
		if(fileHandle) return Promise.resolve();

		if(!this.#openFileHandlePromise)
		{
			this.isBusy = true;
			this.#openFileHandlePromise = new Promise((resolve, reject) =>
			{
				acquireGlobalFileHandleSlot(logger).then(()=>
				{
					return fs.promises.open(filePath, "r+");
				}).catch(error =>
				{
					if(error.code === "ENOENT")
					{
						if(flags === "r") return null;
						else return fs.promises.open(filePath, "w+");
					}
					return reject(error);
				}).then(fileHandle =>
				{
					openFileHandles.set(this, fileHandle);
					resolve();
				}).catch(reject)
				.finally(()=>
				{
					this.#openFileHandlePromise = null;
				});
			});
		}
		return this.#openFileHandlePromise;
	}

	/**
	 *
	 * @param {Logger} logger
	 * @return {Buffer|null}
	 */
	readFromMemory(logger)
	{
		//todo: useInMemoryCache と maxMemoryCacheSize とかを踏まえて設計を考えるといいかも！！
		if(Buffer.isBuffer(this.#memoryCache))
		{
			this.#updateMemoryTimeLimit(logger);
			logger?.out(Logger.READ_FROM_MEMORY_CACHE, this.#memoryCache);

			return this.#memoryCache;
		}
		else return null;
	}

	readFromFile(signal, logger)
	{
		return new Promise((resolve, reject) =>
		{
			const fileHandle = openFileHandles.get(this);
			const stats = statsFromEntity.get(this);
			let statsPromise;
			if(!stats) statsPromise = fileHandle.stat(bigIntStatsOptions);
			else statsPromise = Promise.resolve(stats);

			statsPromise.then(stats =>
			{
				const fileSize = stats.size;
				const logicalVolume = this.logicalVolume;
				const device = logicalVolume.hostDevice;
				const ioProfile = logicalVolume.ioProfile;
				const chunkSize = ioProfile.minChunkSize;
				const reads = ioProfile.maxConcurrentReads;
				const buffer = Buffer.alloc(Number(fileSize));
				const map = new WeakMap();
			});
		});
	}

	#readFromDevice()
	{

	}

	updateMemoryCache(buffer, logger)
	{
		this.#updateMemoryTimeLimit(logger);
		if(Buffer.isBuffer(this.#memoryCache) || this.#memoryCache.equals(buffer))
		{
			logger?.out(Logger.WRITE_SKIPPED_DATA_UNCHANGED);
			return TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE;
		}
		else
		{
			this.writeToMemory(buffer, logger);
			this.entries.forEach(file=>
			{
				const abortControllers = file.abortControllers;
				abortControllers.forEach(abortController=>
				{
					abortController.abort(file);
					abortControllers.delete(abortController);
				})
			});
		}
	}

	writeToMemory(buffer, logger)
	{
		this.#memoryCache = buffer;
		logger?.out(Logger.UPDATED_MEMORY_CACHE);
	}

	/**
	 *
	 * @param {Buffer} buffer
	 * @param {fs.FileHandle} fileHandle
	 * @param {AbortController} abortController
	 * @param {Logger} logger
	 * @return {Promise<WriteResultKey, Error>}
	 */
	writeToFile(buffer, fileHandle, abortController, logger)
	{
		return new Promise((resolve, reject)=>
		{
			fileHandle.writeFile(buffer, {signal: abortController.signal}).then(()=>
			{
				resolve(TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY);
				//todo: logger?.out(書き込みが完了した)
			}).catch(error=>
			{
				if(error.code === "ABORT_ERR")
				{
					logger?.out(/*todo: 書き込み中に新しい書き込みリクエストが来たため書き込みを中断*/);
					resolve(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);
				}
				else
				{
					logger?.out(/*todo: 書き込み中に失敗した*/);
					reject(error);
				}
			});
		});
	}

	#updateMemoryTimeLimit(logger)
	{
		if(this.#memoryTimeLimit) clearTimeout(this.#memoryTimeLimit);
		this.#memoryTimeLimit = setTimeout(this.#removeMemoryCache, this.parent.memoryTTL, this, logger);
	}

	#removeMemoryCache = (entity, logger)=>
	{
		entity.#memoryCache = null;
		entity.#memoryTimeLimit = null;

		logger?.out(Logger.REMOVE_MEMORY_CACHE);
	}

	constructor(entityKey)
	{
		super(entityKey);
	}
}

class LogicalVolume
{
	/** @type {Object.<LogicalVolume>} */
	static fromStatsDeviceId = {};

	static getFromStatsDeviceID(statsDeviceId)
	{
		if(typeof LogicalVolume.fromStatsDeviceId[statsDeviceId] === "undefined")
			LogicalVolume.fromStatsDeviceId[statsDeviceId] = new LogicalVolume(statsDeviceId);

		return LogicalVolume.fromStatsDeviceId[statsDeviceId];
	}

	/** @type {BigIntStats} */
	stats;

	/** @type {IOProfile} */
	ioProfile;

	/** @type {BigInt} */
	#statsDeviceId;

	/** @return {BigInt} */
	get statsDeviceId() { return this.#statsDeviceId; }

	/** @type {StorageDevice} */
	hostDevice;

	/**
	 * @type {Map<string, BlockDevicesData>}
	 * @see {@link https://github.com/sebhildebrandt/systeminformation/blob/master/lib/index.d.ts}
	 */
	#blockDevicesData = new Map();

	/**
	 *
	 * @param {string} [alias]
	 * @return {BlockDevicesData}
	 * @see {@link https://github.com/sebhildebrandt/systeminformation/blob/master/lib/index.d.ts}
	 */
	getBlockDevicesData(alias)
	{
		if(typeof alias !== "undefined") return this.#blockDevicesData.get(alias);
		else return this.#blockDevicesData.values().next().value;
	}

	/**
	 *
	 * @param {BlockDevicesData} blockDeviceData
	 * @param {string|null} [alias=null]
	 */
	setBlockDeviceData(blockDeviceData, alias=null)
	{
		this.#blockDevicesData.set(alias, blockDeviceData);
	}

	/**
	 *
	 * @param {BigInt} statsDeviceId
	 */
	constructor(statsDeviceId)
	{
		this.#statsDeviceId = statsDeviceId;
		this.ioProfile = new IOProfile(statsDeviceId);
		LogicalVolume.fromStatsDeviceId[statsDeviceId] = this;
	}
}

class StorageDevice
{
	/** @type {Map<string, StorageDevice>} */
	static devices = new Map();

	static getFromId(uid)
	{
		if(!StorageDevice.devices.has(uid))
			StorageDevice.devices.set(uid, new StorageDevice(uid));

		return StorageDevice.devices.get(uid);
	}

	/** @type {Set<Promise>} */
	currentReaders = new Set();

	/** @type {string} */
	#id;
	/** @return {string} */
	get id() { return this.#id; }
	/** @param {string} newId */
	set id(newId)
	{
		this.#checkId(newId);
		StorageDevice.devices.delete(this.#id);

		StorageDevice.devices.set(newId, this);
		this.#id = newId;
	}

	/** @type {string} */
	device;
	/** @type {string} */
	type;
	/** @type {string} */
	name;
	/** @type {string} */
	vendor;
	/** @type {number} */
	size;
	/** @type {number} */
	bytesPerSector;
	/** @type {number} */
	totalCylinders;
	/** @type {number} */
	totalHeads;
	/** @type {number} */
	totalSectors;
	/** @type {number} */
	totalTracks;
	/** @type {number} */
	tracksPerCylinder;
	/** @type {number} */
	sectorsPerTrack;
	/** @type {string} */
	firmwareRevision;
	/** @type {string} */
	serialNum;
	/** @type {string} */
	interfaceType;
	/** @type {string} */
	smartStatus;
	/** @type {number|null} */
	temperature;
	/** @type {SmartData} */
	smartData;

	applyDiskLayoutData(diskLayoutData)
	{
		for(const key in diskLayoutData)
		{
			this[key] = diskLayoutData[key];
		}
	}

	#checkId(id)
	{
		if(StorageDevice.devices.has(id))
			throw new Error("既に同一 id の StorageDevice インスタンスが存在しています。指定された id:" + id);
	}

	constructor(id)
	{
		this.#checkId(id);

		this.#id = id;

		StorageDevice.devices.set(id, this);
	}
}


class IOProfile
{
	/**
	 * @typedef {string|number|BigInt} ProfileName
	 */

	/** @type {Object.<IOProfile>} */
	static profiles = {};

	static checkProfileName(name)
	{
		if(typeof IOProfile.profiles[name] !== "undefined")
			throw new Error("指定された名前の I/O プロファイルは既に存在しています");
	}

	/** @type {ProfileName} */
	#name;

	/** @return {ProfileName} */
	get name() { return this.#name; }
	set name(value)
	{
		IOProfile.checkProfileName(value);
		delete IOProfile.profiles[this.#name];
		IOProfile.profiles[value] = this;
		this.#name = value;
	}

	/**
	 *
	 * @param {ProfileName} newProfileName
	 * @return {IOProfile}
	 */
	clone(newProfileName)
	{
		IOProfile.checkProfileName(newProfileName);
		const profile = new IOProfile(newProfileName);
		profile.maxConcurrentReads = this.maxConcurrentReads;
		profile.minChunkSize = this.minChunkSize;
		profile.abortTiming = this.abortTiming;
		return profile;
	}

	/**
	 * 物理デバイスに対しての最大同時並行読取数
	 * @type {number}
	 */
	maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;


	/**
	 * 1回の読み取り命令に対しての最低読み取りチャンクサイズ。
	 * 並列読取りが得意なデバイス（SSD/NVMe/RAMDisk）では 64 KB、
	 * 並列読取りが苦手なデバイス（HDDなど）では 128 KB が推奨らしい
	 * @type {number}
	 */
	minChunkSize = 128 * 1024;

	/**
	 * 読み書き時の中断のチャンスが最大何回あるか
	 * @type {number}
	 */
	abortTiming = 3;

	/**
	 *
	 * @param {ProfileName} name
	 */
	constructor(name)
	{
		IOProfile.checkProfileName(name);
		IOProfile.profiles[name] = this;
		this.#name = name;
	}
}

class ReadStreamAgent extends EventEmitter
{
	/** @type {TimeLimitedEntity} */
	#parent;

	/** @type {Promise<ReadStreamAgent>} */
	#endPromise;

	/** @type {ReadStreamEndOptions|null} */
	#endOptions = {removeDataEventListener:false, waitForClose:false};

	#globalReadSlotReleased = false;

	#opened = false;

	#ready = false;

	#end = false;

	#data = false;

	/**
	 *
	 * @param {TimeLimitedEntity} manager
	 */
	#releaseGlobalReadSlotOnce = (manager)=>
	{
		if(!this.#globalReadSlotReleased)
		{
			this.#globalReadSlotReleased = true;
			shouldReleaseFileHandle(manager);
		}
	}

	/**
	 * @typedef {Object} ReadStreamAgentOptions
	 * @property {function(ReadStreamAgent):void} resolve
	 * @property {(reasons?:any)=>void} reject
	 * @property {number} [maxStreamBufferSize]
	 * @property {function(ReadStreamAgent):void} streamReadyResolve
	 * @property {(reasons?:any)=>void} streamInitFailedReject
	 */

	/**
	 *
	 * @param {fs.ReadStream} readStream
	 * @param {TimeLimitedEntity} parent
	 * @param {Promise<ReadStreamAgent>} promise
	 * @param {ReadStreamAgentOptions} options
	 */
	constructor(readStream, parent, promise, options)
	{
		super();
		/** @type {function(ReadStreamAgent):void} */
		const resolve = options.resolve;
		/** @type {(reasons?:any)=>void} */
		const reject = options.reject;
		/** @type {function(ReadStreamAgent): void} */
		const streamReadyResolve = options.streamReadyResolve;
		/** @type {(reasons?:any)=>void} */
		const streamInitFailedReject = options.streamInitFailedReject;

		this.#parent = parent;
		const self = this;
		this.#endPromise = promise;
		const onReadStreamData = (data) =>
		{
			this.#data = true;

			if(Logger)
				Logger.log(this.#parent, Logger.READ_STREAM_CHUNK_READ);

			self.emit("data", data);
		}
		const onEnd = ()=>
		{
			this.#end = true;
			if(Logger)
				Logger.log(this.#parent, Logger.READ_STREAM_COMPLETE);

			if(self.#endOptions.removeDataEventListener)
				self.removeAllListeners("data");

			readStream.off("data", onReadStreamData);
			readStream.close();
			self.emit("end");

			if(!self.#endOptions.waitForClose)
			{
				this.#releaseGlobalReadSlotOnce(this.#parent);
				resolve(self);
			}
		}
		const onClose = ()=>
		{
			if(Logger)
				Logger.log(this.#parent, Logger.READ_STREAM_CLOSED);

			readStream.off("data", onReadStreamData);
			readStream.off("end", onEnd);
			readStream.off("error", onError);
			readStream.off("open", onOpen);
			readStream.off("ready", onReady);
			self.emit("close");

			if(self.#endOptions.waitForClose)
			{
				this.#releaseGlobalReadSlotOnce(this.#parent);
				resolve(self);
			}
		}
		const onError = (error) =>
		{
			if(Logger)
			{
				Logger.errors[error.code] = error;
				Logger.log(this.#parent, Logger.READ_STREAM_ERROR, error);
			}

			readStream.off("data", onReadStreamData);
			readStream.off("end", onEnd);
			readStream.off("open", onOpen);
			readStream.off("ready", onReady);
			readStream.close();
			self.emit("error", error);
			this.#releaseGlobalReadSlotOnce(this.#parent);

			if(!this.#opened)
			{
				//todo: ここから！！！！
			}
			reject({error, readStreamAgent:self});
		}
		const onOpen = ()=>
		{
			this.#opened = true;
		}
		const onReady = ()=>
		{
			if(Logger)
				Logger.log(this.#parent, Logger.READ_STREAM_READY);

			this.#ready = true;
		}

		readStream.on("data", onReadStreamData);
		readStream.once("end", onEnd);
		readStream.once("close", onClose);
		readStream.once("error", onError);
		readStream.once("open", onOpen);
		readStream.once("ready", onReady);
	}

	/**
	 * @typedef {Object} ReadStreamEndOptions
	 * @property {boolean} [removeDataEventListener=false]
	 * @property {boolean} [waitForClose=false]
	 */

	/**
	 * @param {ReadStreamEndOptions|null} [options=null]
	 * @return {Promise<ReadStreamAgent>}
	 */
	end(options)
	{
		this.#endOptions = options || this.#endOptions;
		return this.#endPromise;
	}
}

class WriteStreamAgent extends EventEmitter
{
	/** @type {fs.WriteStream} */
	#writeStream;

	/** @type {TimeLimitedEntity} */
	#parent;

	/** @type {boolean} */
	waitForClose;

	/** @type {number} */
	writeStreamErrorTimeout;

	/**
	 *
	 * @param {fs.WriteStream} writeStream
	 * @param {TimeLimitedEntity} parent
	 * @param {number} writeStreamErrorTimeout
	 */
	constructor(writeStream, parent, writeStreamErrorTimeout)
	{
		super();
		this.#parent = parent;
		this.#writeStream = writeStream;
		this.writeStreamErrorTimeout = writeStreamErrorTimeout;
	}

	/**
	 *
	 * @param {Buffer|ArrayBuffer|TypedArray|string} buffer
	 * @return {Promise<WriteStreamAgent|{error:Error, agent:WriteStreamAgent}>}
	 */
	write(buffer)
	{
		return new Promise((resolve, reject)=>
		{
			if(Logger)
				Logger.log(this.#parent, Logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);

			const onError = error =>
			{
				if(Logger)
					Logger.log(this.#parent, Logger.WRITE_STREAM_CHUNK_WRITE_ERROR, error);

				reject({error, agent:this});
			}

			this.#writeStream.once("error", onError);

			if(this.#writeStream.write(normalizeToBuffer(buffer)))
			{
				if(Logger)
					Logger.log(this.#parent, Logger.WRITE_STREAM_CHUNK_ACCEPTED);

				this.#writeStream.off("error", onError);
				resolve(this);
			}
			else
			{
				if(Logger)
					Logger.log(this.#parent, Logger.WRITE_STREAM_BUFFER_FULL);

				this.#writeStream.once("drain", ()=>
				{
					if(Logger)
						Logger.log(this.#parent, Logger.WRITE_STREAM_DRAINED);

					this.#writeStream.off("error", onError);
					resolve(this);
				});
			}
		});
	}

	/**
	 * @typedef {Object} WriteStreamEndOptions
	 * @property {boolean} [waitForClose=true]
	 */

	/**
	 *
	 * @param {WriteStreamEndOptions|null} [options=null]
	 * @return {Promise<WriteStreamAgent|{error:Error, agent:WriteStreamAgent}>|void}
	 */
	end(options=null)
	{
		return new Promise((resolve, reject)=>
		{
			options = options || {waitForClose: true};

			this.waitForClose = options.waitForClose;

			if(Logger)
				Logger.log(this.#parent, Logger.WRITE_STREAM_FINISH_REQUESTED);

			const onFinish = ()=>
			{
				if(Logger)
					Logger.log(this.#parent, Logger.WRITE_STREAM_ALL_DATA_COMPLETED);

				this.#writeStream.off("error", onFinishError);
				this.#writeStream.once("close", onClose);
				this.#writeStream.once("error", onCloseError);

				if(!options.waitForClose)
					resolve(this);
			}
			const onClose = ()=>
			{
				this.#writeStream.off("finish", onFinish);
				this.#writeStream.off("error", onFinishError);

				if(options.waitForClose)
					resolve(this);
			}
			const onFinishError = error=>
			{
				if(Logger)
					Logger.log(this.#parent, Logger.WRITE_STREAM_FINISH_ERROR, error);

				this.#writeStream.off("finish", onFinish);
				reject({error, agent:this});
			}
			const onCloseError = error =>
			{
				if(Logger)
					Logger.log(this.#parent, Logger.WRITE_STREAM_CLOSE_ERROR, error);

				this.#writeStream.off("close", onClose);
				reject({error, agent:this});
			}
			this.#writeStream.once("finish", onFinish);
			this.#writeStream.once("error", onFinishError);
			this.#writeStream.end();
		});

	}
}

/**
 *
 * @param {Buffer|ArrayBuffer|TypedArray|string} input
 * @return {Buffer}
 */
const normalizeToBuffer = (input)=>
{
	if(Buffer.isBuffer(input)) return input;
	if(ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	if(input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
	if(typeof input === "string") return Buffer.from(input);
	throw new Error("TimeLimitedFileCache の writeAsBuffer() 及び writeAsStream() の write() メソッドに渡せる書き込み用データの型は Buffer, ArrayBuffer, TypedArray, string のいずれかのみになります");
}

class AbortError extends Error
{
	constructor(message) {
		super(message);
		this.name = "AbortError";
	}
}

module.exports = TimeLimitedFileCache;
