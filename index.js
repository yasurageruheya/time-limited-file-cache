const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

/** @type {Object.<string>} */
const entityKeyFromPath = {};
/** @type {Object.<Set<string>>} */
const pathsFromEntityKey = {};

/** @type {Set<string>} */
const checked = new Set();

/** @type {Object.<TimeLimitedFileCache>} */
const caches = {};

/** @type {typeof Log} */
let logger;

let decoder;


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
	 * 書き込みストリームによる処理の時に、ストリームが正しく閉じられなかった場合などに、強制的に次の読み取り／書き込みに処理が渡す際の待機ミリ秒数。
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
		if(typeof caches[directory] === "undefined")
		{
			TimeLimitedFileCache.#enableConstruction = true;
			caches[directory] = new TimeLimitedFileCache(directory);
			TimeLimitedFileCache.#enableConstruction = false;
		}

		const cache = caches[directory];

		cache.memoryTTL = memoryTTL;
		cache.fileTTL = fileTTL;

		return caches[directory].#initialize(create)
	}

	/** @type {number} */
	memoryTTL;

	/** @type {number} */
	fileTTL;

	maxConcurrentReadsPerFile = TimeLimitedFileCache.maxConcurrentReadsPerFile;

	set debug(bool)
	{
		if(bool)
		{
			logger = require("./log");
			decoder = new TextDecoder();
			this.log = [];
			this.stacks = [];
		}
		else
		{
			logger = null;
		}
	}

	/** @type {string[]} debug プロパティが true の時、直前の処理のログメッセージが入ります */
	log = null;

	/** @type {string[]} debug プロパティが true の時、直前の処理のスタック（CallSite インスタンス）が入ります */
	stacks = null;

	/** @type {string} */
	directory;

	/** @type {Object.<TimeLimitManager>} */
	#children = {};

	/**
	 *
	 * @param {TimeLimitManager} manager
	 */
	#onRemoveChild(manager)
	{
		delete this.#children[manager.entityKey];
	}

	/**
	 *
	 * @param {string} fileName
	 * @param {"r"|"w"} flags
	 * @return {Promise<{manager:TimeLimitManager, fileHandle:FileHandle}|Error>}
	 */
	#getTimeLimitManager(fileName, flags)
	{
		const fullPath = path.join(this.directory, fileName);
		return new Promise((resolve, reject)=>
		{
			if(!checked.has(fileName))
			{
				if(fileName.includes(path.sep)) throw FILE_NAME_DIRECTORY_SEPARATOR_ERROR;
				else checked.add(fileName);
			}

			/** @type {FileHandle} */
			let fileHandle;
			fs.promises.open(fullPath, flags)
			.catch(error =>
			{
				if(error) return reject(error); //todo Promise の中断方法の確認！！！ Copilotに聞く！！
			})
			.then(fh =>
			{
				fileHandle = fh;

				if(flags === "r" && entityKeyFromPath[fullPath])
					resolve({manager: this.#children[entityKeyFromPath[fullPath]], fileHandle});
				else return fh.stat({bigint: true});
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
					this.#children[entityKey] = new TimeLimitManager(this, entityKey, fileName, this.#onRemoveChild);

				resolve({manager:this.#children[entityKey], fileHandle});
			});
		});
	}

	constructor(directory)
	{
		if(!TimeLimitedFileCache.#enableConstruction) throw new Error("new TimeLimitedFileCache() は禁止されてますよ。初期化処理をちゃんとしたいので、TimeLimitedFileCache.fromDirectory() メソッドで TimeLimitedFileCache インスタンスを取得してください");

		this.directory = directory;
		caches[directory] = this;
	}

	/** @type {Map<boolean, Promise<TimeLimitedFileCache>>} */
	#initializeCache = new Map();

	/**
	 *
	 * @param {boolean} create
	 * @return {Promise<TimeLimitedFileCache|{error:Error, message:string}>}
	 */
	#initialize(create)
	{
		if(!this.#initializeCache.has(create))
		{
			this.#initializeCache.set(create, new Promise((resolve, reject)=>
			{
				fs.stat(this.directory, (error, stats)=>
				{
					if(error)
					{
						if(!create)
						{
							const message = "存在しないディレクトリを指定しました。ディレクトリを自動で作成したい場合は TimeLimitedFileCache.fromDirectory() の引数 create に true を指定してください";
							reject({error, message});
							console.error(message);
							this.#initializeCache.delete(create);
						}
						else
						{
							fs.mkdir(this.directory, {recursive: true}, (error)=>
							{
								if(!error)
								{
									if(logger)
										logger.log({filePath: this.directory}, "ディレクトリが存在しなかったため、作成しました");

									resolve(this);
								}
								else
								{
									const message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリを作成しようとしましたが作成できませんでした";
									reject({error, message});
									console.error(message);
								}
								this.#initializeCache.delete(create);
							});
						}
					}
					else
					{
						if(stats.isDirectory()) resolve(this);
						else
						{
							const message = "TimeLimitedFileCache.fromDirectory() メソッドで、ディレクトリパスでは無くファイルパスを指定しています";
							reject({error: new Error(message), message});
							console.error(message);
						}
						this.#initializeCache.delete(create);
					}
				})
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
			const fullPath = path.join(this.directory, fileName);
			if(typeof entityKeyFromPath[fullPath] !== "undefined")
			{
				const key = entityKeyFromPath[fullPath];
				const result = this.#children[key].readFromMemory();
				if(result !== null) return resolve(result);


			}
			this.#getTimeLimitManager(fileName, "r").then(({manager, fileHandle})=>
			{
				resolve(manager.readAsBuffer(fileHandle, waitForClose));
			}).catch((error)=>
			{
				if(error.code === "ENOENT")
				{
					if(logger)
						logger.log({filePath: this.directory + path.sep + fileName}, logger.NON_EXIST_CACHE);

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
			this.#children[fileName] = new TimeLimitManager(this, fileName);
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
			this.#getTimeLimitManager(fileName, "w").then(({manager, fileHandle})=>
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
			this.#children[fileName] = new TimeLimitManager(this, fileName);
		}
		return this.#children[fileName].writeAsStream(maxStreamBufferSize, writeStreamErrorTimeout);
	}
}

/**
 *
 * @param {TimeLimitManager} manager
 * @return {Promise<void>}
 */
const acquireGlobalReadSlot = (manager)=>
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
			if(logger)
				logger.log(manager, logger.READ_QUEUE_DUE_TO_GLOBAL_READ_LIMIT);

			globalReadWait.push(resolve);
		}

		if(logger)
			console.log("acquire currentGlobalReadings : " + currentGlobalReadings);
	});
};

/**
 *
 * @param {TimeLimitManager} manager
 */
const releaseGlobalReadSlot = (manager) =>
{
	if(globalReadWait.length)
	{
		const next = globalReadWait.shift();
		if(typeof next === 'function') next();
		else if(logger)
			logger.log(manager, logger.GLOBAL_WAIT_ITEM_MUST_BE_FUNCTION);
	}
	else
	{
		if(currentGlobalReadings > 0) currentGlobalReadings--;
		else if(logger)
			logger.log(manager, logger.CURRENT_GLOBAL_READINGS_UNDERFLOW)
	}

	if(logger)
		console.log("release currentGlobalReadings : " + currentGlobalReadings);
};

class TimeLimitManager
{
	/** @type {TimeLimitedFileCache} */
	parent;

	/** @type {string} */
	filePath;

	/** @type {string} */
	entityKey;

	/** @type {Buffer} */
	#data;

	/** @type {NodeJS.Timeout|number} */
	#memoryTimeLimit;

	/** @type {number} */
	maxConcurrentReads;

	/** @type {NodeJS.Timeout|number} */
	#fileTimeLimit;

	/** @type {Promise<undefined>} 書込み中で書込み完了の resolve を出す Promise インスタンスが入ります */
	#writing;

	/** @type {Promise[]} 各種読み取り系 readAsBuffer() の Promise インスタンスと、readAsStream() の Promise インスタンス達が入ります */
	#readings = [];

	/** @type {Promise.<Buffer|undefined>} readAsBuffer() でメモリキャッシュが無くて、ファイルの内容を読み取る処理に入った時の Promise インスタンス が入ります */
	#readPromise;

	/** @type {(value:Buffer) => void} #readPromise の resolve が入ります。writeAsBuffer でメモリが更新されたら強制的に resolve させるためです */
	#readingAsBuffer;

	/** @type {(value:WriteResultKey) => void} writeAsBuffer() や writeAsStream() で書込み待機中になった Promise インスタンス用の resolve が入っています */
	#pendingWrite;

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

	#onRemove;

	/**
	 *
	 * @param {TimeLimitedFileCache} parent
	 * @param {string} key
	 * @param {string} fileName
	 * @param {(manager:TimeLimitManager)=>void} onRemove
	 */
	constructor(parent, key, fileName, onRemove)
	{
		this.parent = parent;
		this.entityKey = key;
		this.maxConcurrentReads = parent.maxConcurrentReadsPerFile;
		this.filePath = path.join(parent.directory, fileName);
		this.#onRemove = onRemove;
	}

	/**
	 *
	 * @return {Promise<Buffer|null>|Buffer|null}
	 */
	readFromMemory()
	{
		if(this.#data)
		{
			this.#updateTimeLimit();
			if(logger)
				logger.log(this, logger.READ_FROM_MEMORY_CACHE, logger.outputDataForLog(this.#data));
			return this.#data;
		}
		else if(this.#readPromise)
		{
			if(logger)
				logger.log(this, logger.READ_FROM_PROMISE);

			return this.#readPromise;
		}
		else return null;
	}

	/**
	 * @param {FileHandle} fileHandle
	 * @param {boolean} waitForClose
	 * @return {Promise<Buffer|Error>}
	 */
	readAsBuffer(fileHandle, waitForClose)
	{
		this.#readPromise = new Promise((resolve, reject) =>
		{
			/** @type {ReadBufferFuncOptions} */
			const options = {fileHandle, waitForClose, resolve, reject};
			this.#readingAsBuffer = resolve;

			if(!this.#writing)
			{
				this.#readAsBuffer(options);
			}
			else
			{
				this.#writing.then(()=>
				{
					if(this.#readingAsBuffer && this.#readingAsBuffer === resolve)
					{
						if(logger)
							logger.log(this, logger.READ_START_DUE_TO_WRITE_STREAM_COMPLETE);

						this.#readAsBuffer(options);
					}
					else if(logger)
						logger.log(this, logger.READ_SKIPPED_DUE_TO_MEMORY_CACHE_UPDATE_AFTER_STREAM_WRITE);
				});

				if(logger)
					logger.log(this, logger.READ_QUEUE);
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
	#readAsBuffer(options)
	{
		const len = this.#readings.length;
		if(len < this.maxConcurrentReads)
			this.#readAsBufferFunc(options);
		else
		{
			if(logger)
				logger.log(this, logger.READ_QUEUE_DUE_TO_FILE_READ_LIMIT);

			this.#readWait.push({readFunc: (options)=>this.#readAsBufferFunc(options), options});
		}
	}

	/**
	 *
	 * @param {ReadBufferFuncOptions} options
	 */
	#readAsBufferFunc(options)
	{
		const fileHandle = options.fileHandle;
		const parentResolve = options.resolve;
		const parentReject = options.reject;
		const waitForClose = options.waitForClose;
		this.#data = null;

		if(logger)
			logger.log(this, logger.READ_START_FROM_FILE_SYSTEM);

		const fileReading = new Promise((resolve) =>
		{
			let returnData, returnError;
			acquireGlobalReadSlot(this).then(()=>
			{
				fileHandle.readFile().then(data=>
				{
					if(!this.#data)
					{
						this.#data = data;
						if(logger)
						{
							logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM, logger.outputDataForLog(data));
							logger.log(this, logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
						}
					}
					else
					{
						if(logger)
						{
							logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM, logger.outputDataForLog(data));
							logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED, logger.outputDataForLog(this.#data));
						}
					}
					returnData = this.#data;

				}).catch(error=>
				{
					if(!this.#data)
					{
						if(logger)
							logger.log(this, logger.READ_BUFFER_ERROR, error);

						returnError = error;
					}
					else
					{
						returnData = this.#data;
						if(logger)
							logger.log(this, logger.READ_FROM_MEMORY_CACHE, logger.outputDataForLog(this.#data));
					}
				}).finally(()=>
				{
					const index = this.#readings.indexOf(fileReading);
					if(index >= 0) this.#readings.splice(index, 1);
					else if(logger)
						logger.log(this, logger.PROMISE_NOT_FOUND_IN_FINALIZE);

					this.#readPromise = null;
					this.#updateTimeLimit();

					if(!waitForClose)
					{
						if(returnError) parentReject(returnError);
						else
						{
							parentResolve(returnData);
							releaseGlobalReadSlot(this);
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
						}
					}
				});
			});
		});

		this.#readings.push(fileReading);
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
		if(!this.#writing)
		{
			this.#createReadStreamAgent(maxStreamBufferSize, resolve, reject);
		}
		else
		{
			if(logger)
				logger.log(this, logger.READ_STREAM_QUEUED_DUE_TO_WRITING);

			this.#writing.then(()=>
			{
				this.#tryCreateReadStreamAgent(maxStreamBufferSize, resolve, reject);
				// this.#createReadStreamAgent(maxStreamBufferSize, resolve, reject);
			})
		}
	}

	#createReadStreamAgent(maxStreamBufferSize, streamReadyResolve, streamInitFailedReject)
	{
		if(this.#readings.length < this.maxConcurrentReads)
			this.#createReadStreamAgentFunc({maxStreamBufferSize, streamReadyResolve, streamInitFailedReject});
		else
		{
			if(logger)
				logger.log(this, logger.READ_STREAM_QUEUE_DUE_TO_FILE_READ_LIMIT);

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

				if(logger)
					logger.log(this, logger.READ_STREAM_READY);

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
					const index = this.#readings.indexOf(fileReading);
					if(index >= 0) this.#readings.splice(index, 1);
					else if(logger)
						logger.log(this, logger.PROMISE_NOT_FOUND_IN_FINALIZE);

					if(this.#readWait.length)
					{
						const wait = this.#readWait.shift();
						wait.readFunc(wait.options);
					}
				}
				fileReading.then(finalize, finalize);
			});
		})

		this.#readings.push(fileReading);
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
			const buf = normalizeToBuffer(buffer);

			this.#updateTimeLimit();

			if(this.#pendingWrite)
			{
				this.#pendingWrite(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);

				if(logger)
					logger.log(this, logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
			}

			if(this.#data && this.#data.byteLength === buf.byteLength && this.#data.equals(buf))
			{
				this.#pendingWrite = null;

				if(logger)
					logger.log(this, logger.WRITE_SKIPPED_DATA_UNCHANGED);

				resolve(TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE);
			}
			else
			{
				this.#pendingWrite = resolve;

				if(!this.#readings.length && !this.#writing)
				{
					this.#writeAsBuffer(fileHandle, buf, resolve, reject, waitForClose);
				}
				else if(this.#readings.length)
				{
					if(logger)
						logger.log(this, logger.WRITE_QUEUED_DUE_TO_READING, logger.outputDataForLog(buf));

					Promise.allSettled(this.#readings).then(()=>
					{
						if(this.#pendingWrite === resolve)
						{
							if(logger)
								logger.log(this, logger.WRITE_START_FROM_QUEUE_AFTER_READ, logger.outputDataForLog(buf));

							this.#writeAsBuffer(fileHandle, buf, resolve, reject, waitForClose);
						}
					});
				}
				else if(this.#writing)
				{
					if(logger)
						logger.log(this, logger.WRITE_QUEUED_DUE_TO_WRITING, logger.outputDataForLog(buf));

					this.#writing.then(()=>
					{
						if(this.#pendingWrite === resolve)
						{
							if(logger)
								logger.log(this, logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);

							this.#writeAsBuffer(fileHandle, buf, resolve, reject, waitForClose);
						}
					});
				}

				this.#data = buf;
				if(logger)
					logger.log(this, logger.UPDATED_MEMORY_CACHE, logger.outputDataForLog(buf));

				if(this.#readingAsBuffer)
				{
					if(logger)
						logger.log(this, logger.RESOLVE_READ_QUEUE);

					this.#readingAsBuffer(buf);
				}
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

		this.#writing = new Promise(resolve=>
		{
			if(logger)
				logger.log(this, logger.WRITE_START);

			fileHandle.writeFile(buffer).then(()=>
			{
				parentResolve(TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY);

				if(logger)
					logger.log(this, logger.WRITE_COMPLETE_TO_FILE_SYSTEM);

			}).catch(error=>
			{
				if(logger)
					logger.log(this, logger.WRITE_BUFFER_ERROR, error);

				parentReject(error);

			}).finally(()=>
			{
				this.#writing = null;
				this.#updateTimeLimit();

				if(!waitForClose) resolve();
				return fileHandle.close();
			}).then(()=>
			{
				if(waitForClose) resolve();
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

				if(logger)
					logger.log(this, logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
			}
			this.#pendingWrite = resolve;

			if(!this.#readings.length && !this.#writing)
			{
				resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
			}
			else if(this.#readings.length)
			{
				if(logger)
					logger.log(this, logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);

				Promise.allSettled(this.#readings).then(()=>
				{
					if(this.#pendingWrite === resolve)
					{
						if(logger)
							logger.log(this, logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);

						resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
					}
				});
			}
			else if(this.#writing)
			{
				if(logger)
					logger.log(this, logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);

				this.#writing.then(()=>
				{
					if(this.#readings.length)
					{
						if(logger)
							logger.log(this, logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);

						Promise.allSettled(this.#readings).then(()=>
						{
							if(this.#pendingWrite === resolve)
							{
								if(logger)
									logger.log(this, logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);

								resolve(this.#createWriteStreamAgent(maxStreamBufferSize, writeStreamErrorTimeout));
							}
						});
					}
					else if(this.#pendingWrite === resolve)
					{
						if(logger)
							logger.log(this, logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);

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
		this.#data = null;

		if(logger)
			logger.log(this, logger.WRITE_STREAM_READY);

		const writeStream = fs.createWriteStream(this.filePath, {highWaterMark: maxStreamBufferSize});
		const writeStreamAgent = new WriteStreamAgent(writeStream, this, writeStreamErrorTimeout);
		const writing = new Promise(resolve=>
		{
			let finalizeTimer;
			const finalize = ()=>
			{
				this.#updateTimeLimit();
				resolve();
				if(this.#writing === writing) this.#writing = null;
			}

			writeStream.once("close", ()=>
			{
				if(logger)
					logger.log(this, logger.WRITE_STREAM_CLOSED);

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

				if(logger)
					logger.log(this, logger.WRITE_STREAM_ERROR, error);

				writeStreamAgent.emit("error", error);
				try { writeStream.close(); } catch (error) { }
			});
		});
		this.#writing = writing;
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
	 * @param {TimeLimitManager} target
	 */
	#removeMemoryCache(target)
	{
		target.#data = null;
		target.#memoryTimeLimit = null;

		if(logger)
			logger.log(target, logger.REMOVE_MEMORY_CACHE);
	}

	/**
	 *
	 * @param {TimeLimitManager} target
	 */
	#removeCacheFile(target)
	{
		target.#fileTimeLimit = null;

		if(target.#readings.length || target.#writing)
		{
			if(logger)
				logger.log(target, logger.SKIP_REMOVE_FILE_DUE_TO_ACTIVE_READ_OR_WRITE);
		}
		else
		{
			if(logger)
				logger.log(target, logger.REMOVE_START_CACHE_FILE);
			fs.rm(target.filePath, (error) =>
			{
				if(error && logger)
					logger.log(target, logger.REMOVE_CACHE_FILE_FAILED, error);
				else if(logger)
					logger.log(target, logger.REMOVE_CACHE_FILE);
			});

			const entityKey = target.entityKey;
			const paths = pathsFromEntityKey[entityKey];
			paths.forEach(path =>
			{
				delete entityKeyFromPath[path];
				paths.delete(path);
			});

			target.#onRemove(target);
		}
	}
}

class ReadStreamAgent extends EventEmitter
{
	/** @type {TimeLimitManager} */
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
	 * @param {TimeLimitManager} manager
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
	 * @param {TimeLimitManager} parent
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

			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_CHUNK_READ);

			self.emit("data", data);
		}
		const onEnd = ()=>
		{
			this.#end = true;
			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_COMPLETE);

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
			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_CLOSED);

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
			if(logger)
				logger.errors[error.code] = error;

			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_ERROR, error);

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
			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_READY);

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

	/** @type {TimeLimitManager} */
	#parent;

	/** @type {boolean} */
	waitForClose;

	/** @type {number} */
	writeStreamErrorTimeout;

	/**
	 *
	 * @param {fs.WriteStream} writeStream
	 * @param {TimeLimitManager} parent
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
			if(logger)
				logger.log(this.#parent, logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);

			const onError = error =>
			{
				if(logger)
					logger.log(this.#parent, logger.WRITE_STREAM_CHUNK_WRITE_ERROR, error);

				reject({error, agent:this});
			}

			this.#writeStream.once("error", onError);

			if(this.#writeStream.write(normalizeToBuffer(buffer)))
			{
				if(logger)
					logger.log(this.#parent, logger.WRITE_STREAM_CHUNK_ACCEPTED);

				this.#writeStream.off("error", onError);
				resolve(this);
			}
			else
			{
				if(logger)
					logger.log(this.#parent, logger.WRITE_STREAM_BUFFER_FULL);

				this.#writeStream.once("drain", ()=>
				{
					if(logger)
						logger.log(this.#parent, logger.WRITE_STREAM_DRAINED);

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

			if(logger)
				logger.log(this.#parent, logger.WRITE_STREAM_FINISH_REQUESTED);

			const onFinish = ()=>
			{
				if(logger)
					logger.log(this.#parent, logger.WRITE_STREAM_ALL_DATA_COMPLETED);

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
				if(logger)
					logger.log(this.#parent, logger.WRITE_STREAM_FINISH_ERROR, error);

				this.#writeStream.off("finish", onFinish);
				reject({error, agent:this});
			}
			const onCloseError = error =>
			{
				if(logger)
					logger.log(this.#parent, logger.WRITE_STREAM_CLOSE_ERROR, error);

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
