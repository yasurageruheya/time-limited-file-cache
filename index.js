const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

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
	 * @return {Promise<Buffer|undefined>}
	 */
	readAsBuffer(fileName)
	{
		if(typeof this.#children[fileName] === "undefined")
		{
			if(fileName.includes(path.sep)) throw FILE_NAME_DIRECTORY_SEPARATOR_ERROR;
			this.#children[fileName] = new TimeLimitManager(this, fileName);
		}
		return this.#children[fileName].readAsBuffer();
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
	 * @return {Promise<WriteResultKey>} ファイルへの書き込みが成功した際に resolve され、また、ファイルの内容と同一の buffer が渡され更新が必要ない場合も resolve されます。
	 */
	writeAsBuffer(fileName, buffer)
	{
		if(typeof this.#children[fileName] === "undefined")
		{
			if(fileName.includes(path.sep)) throw FILE_NAME_DIRECTORY_SEPARATOR_ERROR;
			this.#children[fileName] = new TimeLimitManager(this, fileName);
		}
		return this.#children[fileName].writeAsBuffer(buffer);
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
	#reading;

	/** @type {(value:WriteResultKey) => void} writeAsBuffer() や writeAsStream() で書込み待機中になった Promise インスタンス用の resolve が入っています */
	#pendingWrite;

	/**
	 * @typedef {object} ReadFuncOptions
	 * @property {number} [maxStreamBufferSize]
	 * @property {(value?:any)=>void} resolve
	 * @property {(reasons?:any)=>void} reject
	 */

	/** @type {Array.<{readFunc:(options:ReadFuncOptions)=>any, options:ReadFuncOptions}>} */
	#readWait = [];

	/**
	 *
	 * @param {TimeLimitedFileCache} parent
	 * @param {string} fileName
	 */
	constructor(parent, fileName)
	{
		this.parent = parent;
		this.maxConcurrentReads = parent.maxConcurrentReadsPerFile;
		this.filePath = path.join(parent.directory, fileName);
	}

	/**
	 *
	 * @return {Promise<Buffer|Error>}
	 */
	readAsBuffer()
	{
		if(this.#data)
		{
			this.#updateTimeLimit();
			return new Promise((resolve) =>
			{
				resolve(this.#data);

				if(logger)
					logger.log(this, logger.READ_FROM_MEMORY_CACHE, logger.outputDataForLog(this.#data));
			});
		}
		else if(this.#readPromise)
		{
			if(logger)
				logger.log(this, logger.READ_FROM_PROMISE);
		}
		else
		{
			this.#readPromise = new Promise((resolve, reject) =>
			{
				this.#reading = resolve;

				if(!this.#writing)
				{
					this.#readAsBuffer(resolve, reject);
				}
				else
				{
					this.#writing.then(()=>
					{
						if(this.#reading && this.#reading === resolve)
						{
							if(logger)
								logger.log(this, logger.READ_START_DUE_TO_WRITE_STREAM_COMPLETE);

							this.#readAsBuffer(resolve, reject);
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
				this.#reading = null;
				if(this.#readWait.length)
				{
					const wait = this.#readWait.shift();
					wait.readFunc(wait.options);
				}
			}
			this.#readPromise.then(onAfterSettle, onAfterSettle);
		}

		return this.#readPromise;
	}

	#readAsBuffer(resolve, reject)
	{
		const len = this.#readings.length;
		if(len < this.maxConcurrentReads)
			this.#readAsBufferFunc({resolve, reject});
		else
		{
			if(logger)
				logger.log(this, logger.READ_QUEUE_DUE_TO_FILE_READ_LIMIT);

			this.#readWait.push({readFunc: (options)=>this.#readAsBufferFunc(options), options: {resolve, reject}});
		}
	}

	/**
	 *
	 * @param {ReadFuncOptions} options
	 */
	#readAsBufferFunc(options)
	{
		const parentResolve = options.resolve;
		const parentReject = options.reject;
		this.#data = null;

		if(logger)
			logger.log(this, logger.READ_START_FROM_FILE_SYSTEM);

		const fileReading = new Promise((resolve) =>
		{
			acquireGlobalReadSlot(this).then(()=>
			{
				fs.readFile(this.filePath, (error, data) =>
				{
					resolve();
					releaseGlobalReadSlot(this);

					const index = this.#readings.indexOf(fileReading);
					if(index >= 0) this.#readings.splice(index, 1);
					else if(logger)
						logger.log(this, logger.PROMISE_NOT_FOUND_IN_FINALIZE);

					if(!this.#data)
					{
						if(error)
						{
							if(error.code === "ENOENT")
							{
								if(logger)
									logger.log(this, logger.NON_EXIST_CACHE);

								parentResolve();
							}
							else
							{
								if(logger)
									logger.log(this, logger.READ_BUFFER_ERROR, error);

								parentReject(error);
							}
						}
						else
						{
							this.#data = data;
							parentResolve(this.#data);
							if(logger)
							{
								logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM, logger.outputDataForLog(data));
								logger.log(this, logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
							}
						}
					}
					else if(error)
					{
						parentResolve(this.#data);
						if(logger)
							logger.log(this, logger.READ_FROM_MEMORY_CACHE, logger.outputDataForLog(this.#data));
					}
					else
					{
						parentResolve(this.#data);
						if(logger)
						{
							logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM, logger.outputDataForLog(data));
							logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED, logger.outputDataForLog(this.#data));
						}
					}

					this.#readPromise = null;
					this.#updateTimeLimit();
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
			/*if(!this.#writing)
			{
				this.#createReadStreamAgent(maxStreamBufferSize, resolve, reject);
			}
			else
			{
				if(logger)
					logger.log(this, logger.READ_STREAM_QUEUED_DUE_TO_WRITING);

				this.#writing.then(()=>
				{
					this.#createReadStreamAgent(maxStreamBufferSize, resolve, reject);
				})
			}*/
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

	#createReadStreamAgent(maxStreamBufferSize, resolve, reject)
	{
		if(this.#readings.length < this.maxConcurrentReads)
			this.#createReadStreamAgentFunc({maxStreamBufferSize, resolve, reject});
		else
		{
			if(logger)
				logger.log(this, logger.READ_STREAM_QUEUE_DUE_TO_FILE_READ_LIMIT);

			this.#readWait.push({readFunc: (options)=>this.#createReadStreamAgentFunc(options), options:{maxStreamBufferSize, resolve, reject}});
		}
	}

	#createReadStreamAgentFunc(options)
	{
		const fileReading = new Promise((resolve, reject) =>
		{
			acquireGlobalReadSlot(this).then(()=>
			{
				const maxStreamBufferSize = options.maxStreamBufferSize;
				const streamCreatedResolve = options.resolve;

				if(logger)
					logger.log(this, logger.READ_STREAM_READY);

				/** @type {fs.ReadStream} */
				const readStream = fs.createReadStream(this.filePath, {highWaterMark: maxStreamBufferSize});

				readStream.once("close", ()=>
				{
					this.#updateTimeLimit();
				});
				// streamCreatedResolve(new ReadStreamAgent(readStream, this, promise, _resolve, _reject));
				streamCreatedResolve(new ReadStreamAgent(readStream, this, fileReading, resolve, reject));

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
	 *
	 * @param {Buffer|ArrayBuffer|TypedArray|string} buffer
	 * @return {Promise<WriteResultKey|Error>}
	 */
	writeAsBuffer(buffer)
	{
		return new Promise((resolve, reject)=>
		{
			const buf = normalizeToBuffer(buffer);

			this.#updateTimeLimit();

			if(this.#data && this.#data.byteLength === buf.byteLength && this.#data.equals(buf))
			{
				if(logger)
					logger.log(this, logger.WRITE_SKIPPED_DATA_UNCHANGED);

				resolve(TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE);
			}
			else
			{
				if(this.#pendingWrite)
				{
					if(logger)
						logger.log(this, logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);

					this.#pendingWrite(TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST);
				}
				this.#pendingWrite = resolve;

				if(!this.#readings.length && !this.#writing)
				{
					this.#writeAsBuffer(buf, resolve, reject);
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

							this.#writeAsBuffer(buf, resolve, reject);
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

							this.#writeAsBuffer(buf, resolve, reject);
						}
					});
				}

				this.#data = buf;
				if(logger)
					logger.log(this, logger.UPDATED_MEMORY_CACHE, logger.outputDataForLog(buf));

				if(this.#reading)
				{
					if(logger)
						logger.log(this, logger.RESOLVE_READ_QUEUE);

					this.#reading(buf);
				}
			}
		});

	}

	/**
	 *
	 * @param {Buffer|string} buffer
	 * @param {(result:typeof TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY)=>void} parentResolve
	 * @param {(reasons?:Error)=>void} parentReject
	 */
	#writeAsBuffer(buffer, parentResolve, parentReject)
	{
		this.#pendingWrite = null;

		this.#writing = new Promise(resolve=>
		{
			if(logger)
				logger.log(this, logger.WRITE_START);

			fs.writeFile(this.filePath, buffer, (error) =>
			{
				resolve();
				this.#writing = null;

				if(error)
				{
					if(logger)
						logger.log(this, logger.WRITE_BUFFER_ERROR, error);

					parentReject(error);
				}
				else
				{
					parentResolve(TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY);

					if(logger)
						logger.log(this, logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
				}

				this.#updateTimeLimit();
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
					logger.log(this, logger.WRITE_STREAM_SKIPPED_DUE_TO_NEW_WRITE);
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
	 *
	 * @param {fs.ReadStream} readStream
	 * @param {TimeLimitManager} parent
	 * @param {Promise<ReadStreamAgent>} promise
	 * @param {(readStreamAgent:ReadStreamAgent)=>void} resolve
	 * @param {(reasons?:any)=>void} reject
	 */
	constructor(readStream, parent, promise, resolve, reject)
	{
		super();
		this.#parent = parent;
		const self = this;
		this.#endPromise = promise;
		const onReadStreamData = (data) =>
		{
			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_CHUNK_READ);

			self.emit("data", data);
		}
		const onEnd = ()=>
		{
			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_COMPLETE);

			if(self.#endOptions.removeDataEventListener)
				self.removeAllListeners("data");

			readStream.off("data", onReadStreamData);
			readStream.off("error", onError);
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
			self.emit("close");

			if(self.#endOptions.waitForClose)
			{
				this.#releaseGlobalReadSlotOnce(this.#parent);
				resolve(self);
			}
		}
		const onError = (error) =>
		{
			readStream.off("data", onReadStreamData);
			readStream.off("end", onEnd);
			readStream.close();
			self.emit("error", error);
			this.#releaseGlobalReadSlotOnce(this.#parent);

			if(logger)
				logger.log(this.#parent, logger.READ_STREAM_ERROR, error);

			reject({error, readStreamAgent:self});
		}

		readStream.on("data", onReadStreamData);
		readStream.once("end", onEnd);
		readStream.once("close", onClose);
		readStream.once("error", onError);
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
