const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

/** @type {Object.<string>} */
const entityKeyFromPath = {};
/** @type {Object.<Set<string>>} */
const pathsFromEntityKey = {};
/** @type {Object.<TimeLimitedEntity>} */
const managerFromFullPath = {};
/** @type {Object.<TimeLimitedEntity>} */
const managerFromEntityKey = {};

/** @type {Set<string>} */
const checkedFileName = new Set();

/** @type {Set<string>} */
const checkedDirectoryPath = new Set();

/** @type {Object.<TimeLimitedFileCache>} */
const cacheFromEntityKey = {};

/** @type {typeof Logger} */
let Logger;


const globalReadWait = [];
let currentGlobalReadings = 0;

const FILE_NAME_DIRECTORY_SEPARATOR_ERROR = new Error(`引数 fileName にディレクトリセパレータ文字列(${path.sep})が含まれていました。正しいファイル名を指定してください`);

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


	/**
	 *
	 * @type {WriteResultType}
	 */
	static WRITE_RESULT = Object.freeze({
		SKIPPED_SAME_AS_MEMORY_CACHE: Symbol(),
		CANCELED_BY_NEWER_REQUEST: Symbol(),
		COMPLETED_SUCCESSFULLY: Symbol()
	});

	static #enableConstruction = false;

	static maxConcurrentReadsGlobal = 16;

	static maxConcurrentReadsPerFile = 4;

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
	 * @param {string} directory
	 * @param {boolean} [create=false]
	 * @param {number} [memoryTTL=10_000]
	 * @param {number} [fileTTL=600_000]
	 * @return {Promise<TimeLimitedFileCache|{error:Error, message:string}>}
	 */
	static fromDirectory(directory, create=false, memoryTTL=10_000, fileTTL=600_000)
	{
		if(!checkedDirectoryPath.has(directory))
		{
			if(!path.isAbsolute(directory))
				throw new Error("TimeLimitedFileCache.fromDirectory() に指定するディレクトリパスは絶対パスで指定してください");

			checkedDirectoryPath.add(directory);
		}

		/** @type {CacheDirectory} */
		let directoryInstance;
		if(typeof CacheDirectory.directoryFromFullPath[directory] !== "undefined")
			directoryInstance = CacheDirectory.directoryFromFullPath[directory];


		if(!path.isAbsolute(directory))
			throw new Error("TimeLimitedFileCache.fromDirectory() に指定するディレクトリパスは絶対パスで指定してください");

		let cache;
		if(typeof entityKeyFromPath[directory] === "undefined")
		{
			TimeLimitedFileCache.#enableConstruction = true;
			cache = new TimeLimitedFileCache();//todo 既に別なパスに同じ実体がいないか何処かでチェックしなきゃ
			TimeLimitedFileCache.#enableConstruction = false;
		}
		else cache = cacheFromEntityKey[entityKeyFromPath[directory]];

		cache.memoryTTL = memoryTTL;
		cache.fileTTL = fileTTL;

		return cache.#initialize(directory, create);
	}

	/** @type {number} */
	memoryTTL;

	/** @type {number} */
	fileTTL;

	maxConcurrentReadsPerFile = TimeLimitedFileCache.maxConcurrentReadsPerFile;

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

	/**
	 *
	 * @param {string} fullPath
	 * @param {string} fileName
	 * @param {"r"|"w"} flags
	 * @return {Promise<{manager:TimeLimitedEntity, fileHandle:FileHandle}|Error>}
	 */
	#getTimeLimitManager(fullPath, fileName, flags)
	{
		return new Promise((resolve, reject)=>
		{
			/** @type {FileHandle} */
			let fileHandle;

			fs.promises.open(fullPath, flags)
			.catch(error =>
			{
				if(error) return reject(error);
			})
			.then(fh =>
			{
				fileHandle = fh;
				return fh.stat({bigint: true});
			})
			.catch(error =>
			{
				if(error) return reject(error);
			})
			.then(stats =>
			{
				const dev = typeof stats.dev === "bigint" ? stats.dev : BigInt(stats.dev);
				const ino = typeof stats.ino === "bigint" ? stats.ino : BigInt(stats.ino);
				const entityKey = `${dev}:${ino}`;

				if(typeof managerFromEntityKey[entityKey] !== "undefined")
				{

				}
				else
				{
					const manager = new TimeLimitedEntity(this, entityKey, fileName);
					managerFromEntityKey[entityKey] = manager;
					managerFromFullPath[fullPath] = manager;
					if(typeof entityKeyFromPath[fullPath] !== "undefined")
					{
						const oldEntityKey = entityKeyFromPath[fullPath];
						pathsFromEntityKey[oldEntityKey].delete(fullPath);
					}
					entityKeyFromPath[fullPath] = entityKey;
					if(typeof pathsFromEntityKey[entityKey] === "undefined")
				}

				if(entityKeyFromPath[fullPath] && entityKeyFromPath[fullPath] !== entityKey)
				{
					const paths = pathsFromEntityKey[entityKey];
					paths.forEach(path => {
						delete entityKeyFromPath[path];
						paths.delete(path);
					});
				}
				entityKeyFromPath[fullPath] = entityKey;
				if(typeof pathsFromEntityKey[entityKey] === "undefined")
					pathsFromEntityKey[entityKey] = new Set();

				pathsFromEntityKey[entityKey].add(fullPath);

				if(typeof this.#children[entityKey] === "undefined")
					this.#children[entityKey] = new TimeLimitedEntity(this, entityKey, fileName);

				resolve({manager:this.#children[entityKey], fileHandle});
			});
		});
	}

	constructor()
	{
		if(!TimeLimitedFileCache.#enableConstruction) throw new Error("new TimeLimitedFileCache() は禁止されてますよ。初期化処理をちゃんとしたいので、TimeLimitedFileCache.fromDirectory() メソッドで TimeLimitedFileCache インスタンスを取得してください");
	}

	/** @type {Map<boolean, Promise<TimeLimitedFileCache>>} */
	#initializeCache = new Map();

	/** @type {string} */
	#entityKey;

	/**
	 *
	 * @param {string} directory
	 * @param {boolean} create
	 * @return {Promise<TimeLimitedFileCache|{error:Error, message:string}>}
	 */
	#initialize(directory, create)
	{
		if(!this.#initializeCache.has(create))
		{
			this.#initializeCache.set(create, new Promise((resolve, reject)=>
			{
				fs.stat(directory, {bigint: true}, (error, stats)=>
				{
					if(error)
					{
						let message;
						if(error.code === "ENOENT")
						{
							if(create)
							{
								fs.mkdir(directory, {recursive: true}, (error)=>
								{
									if(!error)
									{
										if(Logger)
											Logger.log({filePath: this.directory}, "ディレクトリが存在しなかったため、作成しました");

										resolve(this);
									}
									else
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

										reject({error, message});
										console.error(message);
									}
									this.#initializeCache.delete(create);
								});
								return;
							}
							else
							{
								message = "存在しないディレクトリを指定しました。ディレクトリを自動で作成したい場合は TimeLimitedFileCache.fromDirectory() の引数 create に true を指定してください";
							}
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

						reject({error, message});
						console.error(message);
						this.#initializeCache.delete(create);
					}
					else
					{
						if(stats.isDirectory())
						{
							const newEntityKey = this.#entityKey = `${stats.dev}:${stats.ino}`;
							cacheFromEntityKey[newEntityKey] = this;
							if(typeof entityKeyFromPath[directory] !== "undefined")
							{
								const oldEntityKey = entityKeyFromPath[directory];
								pathsFromEntityKey[oldEntityKey].delete(directory);
							}
							entityKeyFromPath[directory] = newEntityKey;
							if(typeof pathsFromEntityKey[newEntityKey] === "undefined")
								pathsFromEntityKey[newEntityKey] = new Set();

							pathsFromEntityKey[newEntityKey].add(directory);//todo 設計レベルで考えなきゃ！！！！
							this.directory = directory;
							resolve(this);
						}
						else
						{
							const message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリパスでは無くファイルパスを指定しているみたいです";
							const error = new Error(message);
							reject({error, message});
							console.error(error);
						}
						this.#initializeCache.delete(create);
					}
				});
			}));
		}
		return this.#initializeCache.get(create);
	}

	/**
	 *
	 * @param {string} fileName
	 * @param {boolean} [waitForClose=true]
	 * @return {Promise<Buffer|null,Error>}
	 */
	readAsBuffer(fileName, waitForClose=true)
	{
		return new Promise((resolve, reject)=>
		{
			fileNameCheck(fileName);
			const fullPath = path.join(this.directory, fileName);
			if(typeof managerFromFullPath[fullPath] !== "undefined")
			{
				const manager = managerFromFullPath[fullPath];
				const result = manager.readAsBufferFromMemory();
				if(result !== null) return resolve(result);
			}
			/*if(typeof entityKeyFromPath[fullPath] !== "undefined")
			{
				const entityKey = entityKeyFromPath[path.join(this.directory, fileName)];

				if(typeof this.#children[entityKey] !== "undefined")
				{
					const result = this.#children[entityKey].readAsBufferFromMemory();
					if(result !== null) return resolve(result);
				}
			}*/

			this.#getTimeLimitManager(fullPath, fileName, "r").then(({manager, fileHandle})=>
			{
				resolve(manager.readAsBufferFromFile(fileHandle, waitForClose));
			}).catch((error)=>
			{
				if(error.code === "ENOENT")
				{
					if(Logger)
						Logger.log({filePath: this.directory + path.sep + fileName}, Logger.NON_EXIST_CACHE);

					resolve(null);
				}
				else reject(error);
			})
		});
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

			this.#getTimeLimitManager(fullPath, fileName, "w").then(({manager, fileHandle})=>
			{
				resolve(manager.writeAsBuffer(fileHandle, buffer, waitForClose));
			}).catch((error)=>
			{
				reject(error);
			})
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
 * @param {TimeLimitedFile} timeLimitedFile
 * @param {Logger} logger
 * @return {Promise<void>}
 */
const acquireGlobalReadSlot = (timeLimitedFile, logger)=>
{
	return new Promise((resolve)=>
	{
		if(currentGlobalReadings < TimeLimitedFileCache.maxConcurrentReadsGlobal)
		{
			currentGlobalReadings++;
			resolve();
		}
		else
		{
			logger?.out(Logger.READ_QUEUE_DUE_TO_GLOBAL_READ_LIMIT);

			globalReadWait.push(resolve);
		}

		if(logger) console.log("acquire currentGlobalReadings : " + currentGlobalReadings);
	});
};

/**
 *
 * @param {TimeLimitedEntity} timeLimitedFile
 */
// const releaseGlobalReadSlot = (manager) =>
/**
 *
 * @param {TimeLimitedFile} timeLimitedFile
 * @param {Logger} logger
 */
const releaseGlobalReadSlot = (timeLimitedFile, logger) =>
{
	if(globalReadWait.length)
	{
		const next = globalReadWait.shift();
		if(typeof next === 'function') next();
		else logger?.out(Logger.GLOBAL_WAIT_ITEM_MUST_BE_FUNCTION);
	}
	else
	{
		if(currentGlobalReadings > 0) currentGlobalReadings--;
		else logger?.out(Logger.CURRENT_GLOBAL_READINGS_UNDERFLOW)
	}

	if(logger) console.log("release currentGlobalReadings : " + currentGlobalReadings);
}

class Entity
{
	/** @type {string} */
	entityKey;

	/** @type {Set<FileSystemEntry>} */
	entries = new Set();

	constructor(entityKey)
	{
		this.entityKey = entityKey;
	}
}

class FileSystemEntry
{
	/** @type {Entity} */
	#entity;

	/** @type {string} */
	fullPath;

	constructor(fullPath)
	{
		this.fullPath = fullPath;
	}
}

class CacheDirectory extends FileSystemEntry
{

	/** @type {Object.<CacheDirectory>} */
	static directoryFromFullPath = {};

	/** @type {DirectoryEntity} */
	#entity;

	/**
	 *
	 * @param {string} fileName
	 * @param {boolean} [waitForClose=true]
	 * @return {Promise<Buffer, Error>}
	 */
	readAsBuffer(fileName, waitForClose=true)
	{
		return this.#entity.readAsBuffer(fileName, waitForClose);
	}


	writeAsBuffer(fileName, buffer, waitForClose=true)
	{
		return this.#entity.writeAsBuffer(fileName, buffer, waitForClose);
	}

	/** @return {number} */
	get memoryTTL() { return this.#entity.memoryTTL; }

	/** @return {number} */
	get fileTTL() { return this.#entity.fileTTL; }

	setMemoryTTL(memoryTTL, updateTTL = false)
	{
		this.#entity.memoryTTL = memoryTTL;
	}

	setFileTTL(fileTTL, updateTTL = false)
	{
		this.#entity.fileTTL = fileTTL;
	}

	constructor(fullPath)
	{
		super(fullPath);
	}
}

class DirectoryEntity extends Entity
{
	/** @type {Object.<DirectoryEntity>} */
	static fromEntityKey = {};

	/** @type {Object.<TimeLimitedFile>} */
	#files = {};

	/** @type {number} */
	memoryTTL = 10_000;

	/** @type {number} */
	fileTTL = 600_000;

	/**
	 *
	 * @param {string} fileName
	 * @param {boolean} waitForClose
	 * @return {Promise<Buffer, Error>}
	 */
	readAsBuffer(fileName, waitForClose)
	{
		return this.#getFile(fileName).readAsBuffer(waitForClose);
	}


	writeAsBuffer(fileName, buffer, waitForClose)
	{
		return this.#getFile(fileName).writeAsBuffer(buffer, waitForClose);
	}

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

	constructor(entityKey)
	{
		super(entityKey);
	}
}

class TimeLimitedFile extends FileSystemEntry
{
	/** @type {CacheDirectory} */
	parent;

	/** @type {TimeLimitedEntity} */
	#entity;

	/** @type {string} */
	fullPath;

	/** @type {Promise<{entity:TimeLimitedEntity, fileHandle:FileHandle}, Error>} */
	#acquirePromise;

	/** @type {NodeJS.Timeout|number} */
	#fileTimeLimit;

	/** @type {Promise<Buffer, Error>} */
	#readAsBufferPromise;

	get entityKey() { return this.#entity?.entityKey || "まだ実体キーが取得されていません"; }

	/**
	 *
	 * @param {boolean} waitForClose
	 * @return {Promise<Buffer, Error>}
	 */
	readAsBuffer(waitForClose)
	{
		let logger; if(Logger) logger = new Logger(this);
		this.#updateTimeLimit(logger);
		if(!this.#readAsBufferPromise)
		{
			this.#readAsBufferPromise = new Promise((resolve, reject)=>
			{
				if(!this.#entity)
				{
					this.#acquire().then(({fileHandle})=>
					{
						return this.#readAsBuffer(waitForClose, logger, fileHandle);
					}).then(resolve).catch(reject).finally(()=>
					{
						this.#readAsBufferPromise = null;
					});
				}
				else
				{
					this.#readAsBuffer(waitForClose, logger, null)
					.then(resolve).catch(reject).finally(()=>
					{
						this.#readAsBufferPromise = null;
					});
				}
			});
		}
		return this.#readAsBufferPromise;
	}

	#readAsBuffer(waitForClose, logger, fileHandle)
	{
		return new Promise((resolve, reject)=>
		{
			const result = this.#entity.readFromMemory(waitForClose, logger);
			if(result === null)
			{
				acquireGlobalReadSlot(this, logger).then(()=>
				{
					let readPromise;
					if(fileHandle) readPromise = this.#entity.readFromFileHandle(fileHandle, waitForClose, logger);
					else readPromise = this.#readFromFullPath(waitForClose, logger);

					readPromise.then(resolve).catch(reject).finally(()=>
					{
						releaseGlobalReadSlot(this, logger);
					});
				})
			}
			else if(result instanceof Promise)
			{
				result.then(resolve).catch(reject);
			}
			else resolve(result);
		});
	}

	#readFromFullPath(waitForClose, logger)
	{
		return new Promise((resolve, reject)=>
		{
			fs.promises.open(this.fullPath, "r").then((fileHandle)=>
			{
				return this.#entity.readFromFileHandle(fileHandle, waitForClose, logger, true);
			}).then(data=>
			{
				resolve(data);
			}).catch(error =>
			{
				if(error.code === "ENOENT") resolve(null);
				else reject(error);
			});
		});
	}


	writeAsBuffer(buffer, waitForClose)
	{
		return new Promise((resolve, reject)=>
		{
			let logger; if(Logger) logger = new Logger(this);
			this.#updateTimeLimit(logger);
			this.#acquire().then(({fileHandle})=>
			{
				//todo ここら辺から！！！！設計がちゃんと煮詰まってないよ！！！！
			})
		});
	}

	constructor(parent, fullPath)
	{
		super(fullPath);
		this.parent = parent;
	}

	/**
	 *
	 * @return {Promise<{entity:TimeLimitedEntity, fileHandle:FileHandle}, Error>}
	 */
	#acquire()
	{
		if(!this.#acquirePromise)
		{
			this.#acquirePromise = new Promise((resolve, reject)=>
			{
				fs.stat(this.fullPath, {bigint: true}, (error, stats)=>
				{
					if(error)
					{
						let fileHandle;
						if(error.code === "ENOENT")
						{
							fs.promises.open(this.fullPath, "w+").then((fh)=>
							{
								fileHandle = fh;
								return fh.stat({bigint: true});
							}).then(stats=>
							{
								this.#acquirePromise = null;
								resolve({entity: this.#getEntityFromStats(stats), fileHandle});
							}).catch(error =>
							{
								reject(error);
							});
						}
						else return reject(error);
					}

					this.#acquirePromise = null;
					resolve({entity: this.#getEntityFromStats(stats)});
				});
			});
		}
		return this.#acquirePromise;
	}

	/**
	 *
	 * @param {fs.BigIntStats} stats
	 * @return {TimeLimitedEntity}
	 */
	#getEntityFromStats(stats)
	{
		const entityKey = `${stats.dev}:${stats.ino}`;

		const fromEntityKey = TimeLimitedEntity.fromEntityKey;

		if(typeof fromEntityKey[entityKey] === "undefined")
			fromEntityKey[entityKey] = new TimeLimitedEntity(entityKey);

		const entity = fromEntityKey[entityKey];

		if(this.#entity !== entity)
		{
			if(typeof this.#entity !== "undefined")
			{
				this.#entity.entries.delete(this);
				if(this.#entity.entries.size <= 0)
					delete fromEntityKey[this.#entity.entityKey];
			}
			this.#entity = entity;
			entity.entries.add(this);
		}

		return entity;
	}

	#updateTimeLimit()
	{
		if(this.#fileTimeLimit) clearTimeout(this.#fileTimeLimit);
		this.#fileTimeLimit = setTimeout(this.#removeCacheFile, this.parent.fileTTL, this);
	}

	#removeCacheFile = (file)=>
	{
		file.#entity.entries.delete(file);
		if(file.#entity.entries.size <= 0)
			delete TimeLimitedEntity.fromEntityKey[this.#entity.entityKey];

		file.#entity = null;
		file.fullPath = null;
		file.#fileTimeLimit = null;
	}
}

class TimeLimitedEntity extends Entity
{
	/** @type {Object.<TimeLimitedEntity>} */
	static fromEntityKey = {};

	/** @type {Buffer} */
	#memoryCache;

	/** @type {Map<boolean, Promise<Buffer, Error>>} */
	#readFromFileHandlePromise = new Map();

	/** @type {NodeJS.Timeout|number} */
	#memoryTimeLimit;

	readFromMemory(waitForClose, logger)
	{
		if(this.#memoryCache)
		{
			this.#updateTimeLimit(logger);
			logger?.out(Logger.READ_FROM_MEMORY_CACHE, this.#memoryCache);

			return this.#memoryCache;
		}
		else if(this.#readFromFileHandlePromise.has(waitForClose))
		{
			logger.out(Logger.READ_FROM_PROMISE);

			return this.#readFromFileHandlePromise.get(waitForClose);
		}
		else return null;
	}

	/**
	 *
	 * @param {fs.FileHandle} fileHandle
	 * @param {boolean} waitForClose
	 * @param {Logger} logger
	 * @param {boolean} [overwritePromise]
	 * @return {Promise<Buffer, Error>}
	 */
	readFromFileHandle(fileHandle, waitForClose, logger, overwritePromise)
	{
		if(!this.#readFromFileHandlePromise.has(waitForClose))
		{
			this.#readFromFileHandlePromise.set(waitForClose, new Promise((resolve, reject)=>
			{
				let returnData, returnError;
				fileHandle.readFile().catch((error)=>
				{
					returnError = error;
					if(!waitForClose)
					{
						reject(error);
						this.#readFromFileHandlePromise.delete(waitForClose);
					}

					logger?.out(Logger.READ_BUFFER_READ_ERROR);
				}).then(data =>
				{
					this.#memoryCache = data;
					this.#updateTimeLimit(logger);
					returnData = data;
					if(!waitForClose)
					{
						resolve(data);
						this.#readFromFileHandlePromise.delete(waitForClose);
					}
				}).finally(()=>
				{
					fileHandle.close().then(()=>
					{
						if(waitForClose)
						{
							if(returnError) reject(returnError);
							else if(returnData) resolve(returnData);
							else console.log("ここの処理に来ちゃダメです");
						}
					}).catch(error=>
					{
						if(waitForClose) reject(error);

						logger?.out(Logger.READ_BUFFER_CLOSE_ERROR);
					}).finally(()=>
					{
						if(waitForClose) this.#readFromFileHandlePromise.delete(waitForClose);
					});
				})
			}));
		}

		return this.#readFromFileHandlePromise.get(waitForClose);
	}

	#updateTimeLimit(logger)
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

class TimeLimitedEntity_
{

	/** @type {TimeLimitedFileCache} */
	parent;

	/** @type {string} */
	filePath;

	/** @type Set<string> */
	paths = new Set();

	/** @type {Buffer} */
	#memoryCache;

	/** @type {number} */
	maxConcurrentReads;

	/** @type {NodeJS.Timeout|number} */
	#memoryTimeLimit;

	/** @type {NodeJS.Timeout|number} */
	#fileTimeLimit;

	/** 書込み中で書込み完了の resolve を出す Promise インスタンスが入ります
	 * @type {Promise<undefined>}  */
	#writingToFile;

	/** 各種読み取り系 readAsBuffer() の Promise インスタンスと、readAsStream() の Promise インスタンス達が入ります
	 *  @type {Promise[]}  */
	#readingsFromFile = [];

	/** readAsBuffer() でメモリキャッシュが無くて、ファイルの内容を読み取る処理に入った時の Promise インスタンス が入ります
	 *  @type {Promise.<Buffer|undefined>}  */
	#readPromise;

	/** #readPromise の resolve が入ります。writeAsBuffer でメモリが更新されたら強制的に resolve させるためです
	 * @type {(value:Buffer) => void}  */
	#readingAsBuffer;

	/** writeAsBuffer() や writeAsStream() で書込み待機中になった Promise インスタンス用の resolve が入っています
	 * @type {(value:WriteResultKey) => void}  */
	#pendingWrite;

	/** @type {Set<TimeLimitedFile>} */
	sourceFiles = new Set();

	/**
	 * @typedef {object} ReadFuncOptions
	 */

	/**
	 * @typedef {ReadFuncOptions} ReadBufferFuncOptions
	 * @property {FileHandle} fileHandle
	 * @property {boolean} waitForClose
	 * @property {(value:Buffer)=>void} resolve
	 * @property {(reason?:any)=>void} reject
	 */

	/**
	 * @typedef {ReadFuncOptions} ReadStreamFuncOptions
	 * @property {number} [maxStreamBufferSize]
	 * @property {(readStreamAgent:ReadStreamAgent)=>void} streamReadyResolve
	 * @property {(reasons?:any)=>void} streamInitFailedReject
	 */

	/** @type {Array.<{readFunc:(options:ReadFuncOptions)=>any, options:ReadFuncOptions}>} */
	#readWait = [];

	/** @type {string} */
	entityKey;

	/**
	 *
	 * @param {TimeLimitedFileCache} parent
	 * @param {string} entityKey
	 * @param {string} fileName
	 * @param {string} fullPath
	 */
	constructor(parent, entityKey, fileName, fullPath)
	{
		this.parent = parent;
		this.maxConcurrentReads = parent.maxConcurrentReadsPerFile;
		this.filePath = path.join(parent.directory, fileName);
		this.paths.add(fullPath);
		this.entityKey = entityKey;
	}

	/**
	 *
	 * @return {Promise<Buffer|null>|Buffer|null}
	 */
	readAsBufferFromMemory()
	{
		if(this.#memoryCache)
		{
			this.#updateTimeLimit();
			if(Logger)
				Logger.log(this, Logger.READ_FROM_MEMORY_CACHE, Logger.outputDataForLog(this.#memoryCache));
			return this.#memoryCache;
		}
		else if(this.#readPromise)
		{
			if(Logger)
				Logger.log(this, Logger.READ_FROM_PROMISE);

			return this.#readPromise;
		}
		else return null;
	}

	/**
	 * @param {FileHandle} fileHandle
	 * @param {boolean} waitForClose
	 * @return {Promise<Buffer|Error>}
	 */
	readAsBufferFromFile(fileHandle, waitForClose)
	{
		this.#readPromise = new Promise((resolve, reject) =>
		{
			/** @type {ReadBufferFuncOptions} */
			const options = {fileHandle, waitForClose, resolve, reject};
			this.#readingAsBuffer = resolve;

			if(!this.#writingToFile)
			{
				this.#readAsBufferFromFile(options);
			}
			else
			{
				this.#writingToFile.then(()=>
				{
					if(this.#readingAsBuffer && this.#readingAsBuffer === resolve)
					{
						if(Logger)
							Logger.log(this, Logger.READ_START_DUE_TO_WRITE_STREAM_COMPLETE);

						this.#readAsBufferFromFile(options);
					}
					else if(Logger)
						Logger.log(this, Logger.READ_SKIPPED_DUE_TO_MEMORY_CACHE_UPDATE_AFTER_STREAM_WRITE);
				});

				if(Logger)
					Logger.log(this, Logger.READ_QUEUE);
			}
		});
		const onAfterSettle = ()=>
		{
			this.#readingAsBuffer = null;
			if(this.#readWait.length)
			{
				const wait = this.#readWait.shift();
				wait.readFunc(wait.options);
			}
		}
		this.#readPromise.then(onAfterSettle, onAfterSettle);

		return this.#readPromise;
	}

	/**
	 *
	 * @param {ReadBufferFuncOptions} options
	 */
	#readAsBufferFromFile(options)
	{
		const len = this.#readingsFromFile.length;
		if(len < this.maxConcurrentReads)
			this.#readAsBufferFuncFromFile(options);
		else
		{
			if(Logger)
				Logger.log(this, Logger.READ_QUEUE_DUE_TO_FILE_READ_LIMIT);

			this.#readWait.push({readFunc: (options)=>this.#readAsBufferFuncFromFile(options), options});
		}
	}

	/**
	 *
	 * @param {ReadBufferFuncOptions} options
	 */
	#readAsBufferFuncFromFile(options)
	{
		const fileHandle = options.fileHandle;
		const parentResolve = options.resolve;
		const parentReject = options.reject;
		const waitForClose = options.waitForClose;
		this.#memoryCache = null;

		if(Logger)
			Logger.log(this, Logger.READ_START_FROM_FILE_SYSTEM);

		const fileReading = new Promise((resolve) =>
		{
			let returnData, returnError;
			acquireGlobalReadSlot(this).then(()=>
			{
				fileHandle.readFile().then(data=>
				{
					if(!this.#memoryCache)
					{
						this.#memoryCache = data;
						if(Logger)
						{
							Logger.log(this, Logger.READ_COMPLETE_FROM_FILE_SYSTEM, Logger.outputDataForLog(data));
							Logger.log(this, Logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
						}
					}
					else
					{
						if(Logger)
						{
							Logger.log(this, Logger.READ_COMPLETE_FROM_FILE_SYSTEM, Logger.outputDataForLog(data));
							Logger.log(this, Logger.READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED, Logger.outputDataForLog(this.#memoryCache));
						}
					}
					returnData = this.#memoryCache;

				}).catch(error=>
				{
					if(!this.#memoryCache)
					{
						if(Logger)
							Logger.log(this, Logger.READ_BUFFER_ERROR, error);

						returnError = error;
					}
					else
					{
						returnData = this.#memoryCache;
						if(Logger)
							Logger.log(this, Logger.READ_FROM_MEMORY_CACHE, Logger.outputDataForLog(this.#memoryCache));
					}
				}).finally(()=>
				{
					const index = this.#readingsFromFile.indexOf(fileReading);
					if(index >= 0) this.#readingsFromFile.splice(index, 1);
					else if(Logger)
						Logger.log(this, Logger.PROMISE_NOT_FOUND_IN_FINALIZE);

					this.#readPromise = null;
					this.#updateTimeLimit();

					if(!waitForClose)
					{
						if(returnError) parentReject(returnError);
						else
						{
							parentResolve(returnData);
							releaseGlobalReadSlot(this);
							resolve();
						}
					}

					return fileHandle.close();
				}).then(()=>
				{
					if(waitForClose)
					{
						if(returnError) parentReject(returnError);
						else
						{
							parentResolve(returnData);
							releaseGlobalReadSlot(this);
							resolve();
						}
					}
				});
			});
		});

		this.#readingsFromFile.push(fileReading);
	}

	/**
	 *  @param {number} maxStreamBufferSize
	 * @return {Promise<ReadStreamAgent>}
	 */
	readAsStream(maxStreamBufferSize)
	{
		return new Promise((resolve, reject)=>
		{
			this.#tryCreateReadStreamAgent(maxStreamBufferSize, resolve, reject);
		});
	}

	#tryCreateReadStreamAgent(maxStreamBufferSize, resolve, reject)
	{
		if(!this.#writingToFile)
		{
			this.#createReadStreamAgent(maxStreamBufferSize, resolve, reject);
		}
		else
		{
			if(Logger)
				Logger.log(this, Logger.READ_STREAM_QUEUED_DUE_TO_WRITING);

			this.#writingToFile.then(()=>
			{
				this.#tryCreateReadStreamAgent(maxStreamBufferSize, resolve, reject);
				// this.#createReadStreamAgent(maxStreamBufferSize, resolve, reject);
			})
		}
	}

	#createReadStreamAgent(maxStreamBufferSize, streamReadyResolve, streamInitFailedReject)
	{
		if(this.#readingsFromFile.length < this.maxConcurrentReads)
			this.#createReadStreamAgentFunc({maxStreamBufferSize, streamReadyResolve, streamInitFailedReject});
		else
		{
			if(Logger)
				Logger.log(this, Logger.READ_STREAM_QUEUE_DUE_TO_FILE_READ_LIMIT);

			this.#readWait.push({readFunc: (options)=>this.#createReadStreamAgentFunc(options), options:{maxStreamBufferSize, streamReadyResolve, streamInitFailedReject}});
		}
	}

	/**
	 *
	 * @param {ReadFuncOptions} options
	 */
	#createReadStreamAgentFunc(options)
	{
		const fileReading = new Promise((resolve, reject) =>
		{
			acquireGlobalReadSlot(this).then(()=>
			{
				const maxStreamBufferSize = options.maxStreamBufferSize;
				options.resolve = resolve;
				options.reject = reject;

				if(Logger)
					Logger.log(this, Logger.READ_STREAM_READY);

				/** @type {fs.ReadStream} */
				const readStream = fs.createReadStream(this.filePath, {highWaterMark: maxStreamBufferSize});

				readStream.once("close", ()=>
				{
					this.#updateTimeLimit();
				});
				// streamReadyResolve(new ReadStreamAgent(readStream, this, promise, _resolve, _reject));
				new ReadStreamAgent(readStream, this, fileReading, resolve, reject);

				const finalize = ()=>
				{
					const index = this.#readingsFromFile.indexOf(fileReading);
					if(index >= 0) this.#readingsFromFile.splice(index, 1);
					else if(Logger)
						Logger.log(this, Logger.PROMISE_NOT_FOUND_IN_FINALIZE);

					if(this.#readWait.length)
					{
						const wait = this.#readWait.shift();
						wait.readFunc(wait.options);
					}
				}
				fileReading.then(finalize, finalize);
			});
		})

		this.#readingsFromFile.push(fileReading);
	}

	preWriteCheck(buffer)
	{
		if(this.#pendingWrite)
		{
			this.#pendingWrite(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);

			if(Logger)
				Logger.log(this, Logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		}

		if(this.#memoryCache && this.#memoryCache.byteLength === buffer.byteLength && this.#memoryCache.equals(buffer))
		{
			this.#updateTimeLimit();
			this.#pendingWrite = null;

			if(Logger)
				Logger.log(this, Logger.WRITE_SKIPPED_DATA_UNCHANGED);

			return TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE;
		}
		return false;
	}

	/**
	 * @param {FileHandle} fileHandle
	 * @param {Buffer|ArrayBuffer|TypedArray|string} buffer
	 * @param {boolean} waitForClose
	 * @return {Promise<WriteResultKey|Error>}
	 */
	writeAsBuffer(fileHandle, buffer, waitForClose)
	{
		return new Promise((resolve, reject)=>
		{
			this.#updateTimeLimit();

			this.#pendingWrite = resolve;

			if(!this.#readingsFromFile.length && !this.#writingToFile)
			{
				this.#writeAsBuffer(fileHandle, buffer, resolve, reject, waitForClose);
			}
			else if(this.#readingsFromFile.length)
			{
				if(Logger)
					Logger.log(this, Logger.WRITE_QUEUED_DUE_TO_READING, Logger.outputDataForLog(buffer));

				Promise.allSettled(this.#readingsFromFile).then(()=>
				{
					if(this.#pendingWrite === resolve)
					{
						if(Logger)
							Logger.log(this, Logger.WRITE_START_FROM_QUEUE_AFTER_READ, Logger.outputDataForLog(buffer));

						this.#writeAsBuffer(fileHandle, buffer, resolve, reject, waitForClose);
					}
				});
			}
			else if(this.#writingToFile)
			{
				if(Logger)
					Logger.log(this, Logger.WRITE_QUEUED_DUE_TO_WRITING, Logger.outputDataForLog(buffer));

				this.#writingToFile.then(()=>
				{
					if(this.#pendingWrite === resolve)
					{
						if(Logger)
							Logger.log(this, Logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);

						this.#writeAsBuffer(fileHandle, buffer, resolve, reject, waitForClose);
					}
				});
			}

			this.#memoryCache = buffer;
			if(Logger)
				Logger.log(this, Logger.UPDATED_MEMORY_CACHE, Logger.outputDataForLog(buffer));

			if(this.#readingAsBuffer)
			{
				if(Logger)
					Logger.log(this, Logger.RESOLVE_READ_QUEUE);

				this.#readingAsBuffer(buffer);
			}
		});

	}

	/**
	 * @param {FileHandle} fileHandle
	 * @param {Buffer|string} buffer
	 * @param {(result:typeof TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY)=>void} parentResolve
	 * @param {(reasons?:Error)=>void} parentReject
	 * @param {boolean} waitForClose
	 */
	#writeAsBuffer(fileHandle, buffer, parentResolve, parentReject, waitForClose)
	{
		this.#pendingWrite = null;

		this.#writingToFile = new Promise(resolve=>
		{
			let returnData, returnError;
			if(Logger)
				Logger.log(this, Logger.WRITE_START);

			fileHandle.writeFile(buffer).then(()=>
			{
				returnData = TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY;

				if(Logger)
					Logger.log(this, Logger.WRITE_COMPLETE_TO_FILE_SYSTEM);

			}).catch(error=>
			{
				returnError = error;
				if(Logger)
					Logger.log(this, Logger.WRITE_BUFFER_ERROR, error);

				parentReject(error);

			}).finally(()=>
			{
				this.#writingToFile = null;
				this.#updateTimeLimit();

				if(!waitForClose)
				{
					if(returnData) parentResolve(returnData);
					else if(returnError) parentReject(returnError);
					resolve();
				}
				return fileHandle.close();
			}).then(()=>
			{
				if(waitForClose)
				{
					if(returnData) parentResolve(returnData);
					else if(returnError) parentReject(returnError);
					resolve();
				}
			});
		});
	}

	/**
	 * @param {number} maxStreamBufferSize
	 * @param {number} writeStreamErrorTimeout
	 * @return {Promise<WriteStreamAgent|TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST>}
	 */
	writeAsStream(maxStreamBufferSize, writeStreamErrorTimeout)
	{
		return new Promise(resolve=>
		{
			if(this.#pendingWrite)
			{
				this.#pendingWrite(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);

				if(Logger)
					Logger.log(this, Logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
			}
			this.#pendingWrite = resolve;

			if(!this.#readingsFromFile.length && !this.#writingToFile)
			{
				resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
			}
			else if(this.#readingsFromFile.length)
			{
				if(Logger)
					Logger.log(this, Logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);

				Promise.allSettled(this.#readingsFromFile).then(()=>
				{
					if(this.#pendingWrite === resolve)
					{
						if(Logger)
							Logger.log(this, Logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);

						resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
					}
				});
			}
			else if(this.#writingToFile)
			{
				if(Logger)
					Logger.log(this, Logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);

				this.#writingToFile.then(()=>
				{
					if(this.#readingsFromFile.length)
					{
						if(Logger)
							Logger.log(this, Logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);

						Promise.allSettled(this.#readingsFromFile).then(()=>
						{
							if(this.#pendingWrite === resolve)
							{
								if(Logger)
									Logger.log(this, Logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);

								resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
							}
						});
					}
					else if(this.#pendingWrite === resolve)
					{
						if(Logger)
							Logger.log(this, Logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);

						resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
					}
				});
			}
		});
	}

	/**
	 *
	 * @param {number} maxStreamBufferSize
	 * @param {number} writeStreamErrorTimeout
	 * @return {WriteStreamAgent}
	 */
	#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout)
	{
		this.#pendingWrite = null;
		this.#memoryCache = null;

		if(Logger)
			Logger.log(this, Logger.WRITE_STREAM_READY);

		const writeStream = fs.createWriteStream(this.filePath, {highWaterMark: maxStreamBufferSize});
		const writeStreamAgent = new WriteStreamAgent(writeStream, this, writeStreamErrorTimeout);
		const writing = new Promise(resolve=>
		{
			let finalizeTimer;
			const finalize = ()=>
			{
				this.#updateTimeLimit();
				resolve();
				if(this.#writingToFile === writing) this.#writingToFile = null;
			}

			writeStream.once("close", ()=>
			{
				if(Logger)
					Logger.log(this, Logger.WRITE_STREAM_CLOSED);

				if(finalizeTimer)
				{
					clearTimeout(finalizeTimer);
					finalizeTimer = null;
				}
				finalize();

				writeStream.removeAllListeners("drain");
				writeStream.removeAllListeners("finish");
				writeStream.removeAllListeners("error");
			});

			writeStream.once("finish", ()=>
			{
				if(!writeStreamAgent.waitForClose) finalize();
			});

			writeStream.once("error", (error=null) =>
			{
				if(!writeStreamAgent.waitForClose) finalize();
				else finalizeTimer = setTimeout(finalize, writeStreamAgent.writeStreamErrorTimeout);

				if(Logger)
					Logger.log(this, Logger.WRITE_STREAM_ERROR, error);

				writeStreamAgent.emit("error", error);
				try { writeStream.close(); } catch (error) { }
			});
		});
		this.#writingToFile = writing;
		return writeStreamAgent;
	}

	#updateTimeLimit()
	{
		if(this.#memoryTimeLimit) clearTimeout(this.#memoryTimeLimit);
		this.#memoryTimeLimit = setTimeout(this.#removeMemoryCache, this.parent.memoryTTL, this);
		if(this.#fileTimeLimit) clearTimeout(this.#fileTimeLimit);
		this.#fileTimeLimit = setTimeout(this.#removeCacheFile, this.parent.fileTTL, this);
	}

	/**
	 *
	 * @param {TimeLimitedEntity_} target
	 */
	#removeMemoryCache(target)
	{
		target.#memoryCache = null;
		target.#memoryTimeLimit = null;

		if(Logger)
			Logger.log(target, Logger.REMOVE_MEMORY_CACHE);
	}

	/**
	 *
	 * @param {TimeLimitedEntity_} target
	 */
	#removeCacheFile(target)
	{
		target.#fileTimeLimit = null;

		if(target.#readingsFromFile.length || target.#writingToFile)
		{
			if(Logger)
				Logger.log(target, Logger.SKIP_REMOVE_FILE_DUE_TO_ACTIVE_READ_OR_WRITE);
		}
		else
		{
			if(Logger)
				Logger.log(target, Logger.REMOVE_START_CACHE_FILE);
			fs.rm(target.filePath, (error) =>
			{
				if(error && Logger)
					Logger.log(target, Logger.REMOVE_CACHE_FILE_FAILED, error);
				else if(Logger)
					Logger.log(target, Logger.REMOVE_CACHE_FILE);
			});
		}
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
			releaseGlobalReadSlot(manager);
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
module.exports = TimeLimitedFileCache;
