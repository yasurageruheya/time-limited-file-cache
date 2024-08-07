const fs = require('fs');
const path = require('path');

/** @type {Object.<TimeLimitedFileCache>} */
const caches = {};

/** @type {typeof Log} */
let logger;

let decoder;

class TimeLimitedFileCache
{
	static #enableConstruction = false;

	/**
	 *
	 * @param {string} directory
	 * @param {number} [memoryTTL]
	 * @param {number} [fileTTL]
	 * @return {TimeLimitedFileCache}
	 */
	static fromDirectory(directory, memoryTTL, fileTTL)
	{
		TimeLimitedFileCache.#enableConstruction = true;
		if(typeof caches[directory] === "undefined") caches[directory] = new TimeLimitedFileCache(directory);
		TimeLimitedFileCache.#enableConstruction = false;

		const cache = caches[directory];
		if(typeof memoryTTL !== "undefined") cache.memoryTTL = memoryTTL;
		if(typeof fileTTL !== "undefined") cache.fileTTL = fileTTL;
		return cache;
	}

	/** @type {number} */
	memoryTTL = 10_0000;

	/** @type {number} */
	fileTTL = 600_000;

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

	/**
	 *
	 * @param {string} fileName
	 * @return {Promise<ArrayBuffer|undefined>}
	 */
	read(fileName)
	{
		if(typeof this.#children[fileName] === "undefined") this.#children[fileName] = new TimeLimitManager(this, fileName);
		return this.#children[fileName].read();
	}

	/**
	 *
	 * @param {string} fileName
	 * @param {Buffer|ArrayBuffer|TypedArray|string} buffer
	 * @return {Promise<undefined>} ファイルへの書き込みが成功した時は resolve され、ファイルが使用中で書き込みが後回しにされた場合、またはファイルの内容と同一の buffer が渡され更新が必要ない場合は reject されます。
	 */
	write(fileName, buffer)
	{
		if(typeof this.#children[fileName] === "undefined") this.#children[fileName] = new TimeLimitManager(this, fileName);
		return this.#children[fileName].write(buffer);
	}
}

class TimeLimitManager
{
	/** @type {TimeLimitedFileCache} */
	parent;

	/** @type {string} */
	filePath;

	/** @type {Promise.<ArrayBuffer|undefined>} */
	#readPromise;

	/** @type {ArrayBuffer} */
	#data;

	/** @type {NodeJS.Timeout|number} */
	#memoryTimeLimit;

	/** @type {NodeJS.Timeout|number} */
	#fileTimeLimit;

	/** @type {boolean} */
	#isFileAccessing = false;

	/** @type {function(buffer:ArrayBuffer|undefined):void} */
	#readQueue = null;

	/** @type {{arrayBuffer:ArrayBuffer, resolves:function[]}|null} */
	#writeQueue = null;

	/**
	 *
	 * @param {TimeLimitedFileCache} parent
	 * @param {string} fileName
	 */
	constructor(parent, fileName)
	{
		this.parent = parent;
		this.filePath = path.join(parent.directory, fileName);
	}

	/**
	 *
	 * @return {Promise<ArrayBuffer|undefined>}
	 */
	read()
	{
		if(this.#data)
		{
			this.#updateTimeLimit();
			return new Promise((resolve) =>
			{
				resolve(this.#data);

				if(logger)
					logger.log(this, logger.READ_FROM_MEMORY_CACHE, decoder.decode(this.#data));
			});
		}
		else if(this.#readPromise)
		{
			if(logger)
				logger.log(this, logger.READ_FROM_PROMISE);
		}
		else
		{
			this.#readPromise = new Promise((resolve) =>
			{
				if(!this.#isFileAccessing)
				{
					this.#isFileAccessing = true;
					this.#data = null;

					if(logger)
						logger.log(this, logger.READ_START_FROM_FILE_SYSTEM);

					fs.readFile(this.filePath, (error, data) =>
					{
						this.#isFileAccessing = false;

						if(!this.#data)
						{
							this.#readPromise = null;
							if(error)
							{
								if(logger)
									logger.log(this, logger.NON_EXIST_CACHE);
								// return reject(error);
								return resolve();
							}

							this.#data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
							resolve(this.#data);
							if(logger)
							{
								logger.log(this, logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
								logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM, decoder.decode(this.#data));
							}
						}
						else if(error)
						{
							resolve(this.#data);
							if(logger)
								logger.log(this, logger.READ_FROM_MEMORY_CACHE, decoder.decode(this.#data));
						}
						else
						{
							resolve(this.#data);
							if(logger)
								logger.log(this, logger.READ_COMPLETE_FROM_FILE_SYSTEM, decoder.decode(this.#data));
						}

						if(this.#writeQueue)
						{
							if(logger)
								logger.log(this, logger.WRITE_START_FROM_QUEUE_AFTER_READ);

							this.#write(new Uint8Array(this.#writeQueue.arrayBuffer), this.#writeQueue.resolves);
							this.#writeQueue = null;
						}
						this.#readPromise = null;
						this.#updateTimeLimit();
					});
				}
				else
				{
					this.#readQueue = resolve;
					queueMicrotask(()=>
					{
						this.#readPromise = null;
					});

					if(logger)
						logger.log(this, logger.READ_QUEUE);
				}
			});
		}

		return this.#readPromise;
	}

	/**
	 *
	 * @param {Buffer|ArrayBuffer|TypedArray|string} buffer
	 * @return {Promise<*>|*}
	 */
	write(buffer)
	{
		return new Promise((resolve)=>
		{
			// if(!(buffer instanceof ArrayBuffer)) buffer = buffer.buffer;
			// const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
			buffer = buffer.buffer ? buffer.buffer : buffer;
			const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer.toString());
			this.#updateTimeLimit();
			if(!this.#isFileAccessing)
			{
				const newArray = new Uint8Array(arrayBuffer);
				if(!this.#data)
				{
					this.#write(newArray, [resolve]);
				}
				else
				{
					const oldArray = new Uint8Array(this.#data);
					const newLength = newArray.length;
					if(newLength !== oldArray.length)
						this.#write(newArray, [resolve]);
					else
					{
						let isDifference = true;
						for(let i=0; i<newLength; i++)
						{
							if(newArray[i] !== oldArray[i])
							{
								this.#write(newArray, [resolve]);
								isDifference = false;
								break;
							}
						}

						if(isDifference)
						{
							if(logger)
								logger.log(this, logger.WRITE_SKIPPED_DATA_UNCHANGED);

							resolve();
						}
					}
				}
			}
			else
			{
				if(logger)
					logger.log(this, logger.FILE_ACCESS_ERROR_ON_WRITE, decoder.decode(arrayBuffer));

				const resolves = this.#writeQueue ? [resolve, ...this.#writeQueue.resolves] : [resolve];
				this.#writeQueue = {arrayBuffer, resolves};
			}

			this.#data = arrayBuffer;
			if(logger)
				logger.log(this, logger.UPDATED_MEMORY_CACHE, decoder.decode(arrayBuffer));

			if(this.#readQueue)
			{
				this.#readQueue(arrayBuffer);
				this.#readQueue = null;

				if(logger)
					logger.log(this, logger.RESOLVE_READ_QUEUE);
			}
		})

	}

	/**
	 *
	 * @param {TypedArray} typedArray
	 * @param {function[]} resolves
	 */
	#write(typedArray, resolves)
	{

		this.#isFileAccessing = true;
		if(logger)
			logger.log(this, logger.WRITE_START);
		fs.writeFile(this.filePath, typedArray, (error) =>
		{
			this.#isFileAccessing = false;
			if(error) throw error;
			const length = resolves.length;
			for(let i=0; i<length; i++) { resolves[i](); }
			if(logger)
				logger.log(this, logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
			this.#updateTimeLimit();
			if(this.#writeQueue)
			{
				if(logger)
					logger.log(this, logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);

				this.#write(new Uint8Array(this.#writeQueue.arrayBuffer), this.#writeQueue.resolves);
				this.#writeQueue = null;
			}

			if(this.#readQueue)
			{
				this.#readQueue(typedArray.buffer);
				this.#readQueue = null;

				if(logger)
					logger.log(this, logger.RESOLVE_READ_QUEUE);
			}
		});
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
		if(logger)
			logger.log(target, logger.REMOVE_START_CACHE_FILE);
		fs.rm(target.filePath, (error) =>
		{
			if(error) throw error;
			if(logger)
				logger.log(target, logger.REMOVE_CACHE_FILE);
		})
	}
}

module.exports = TimeLimitedFileCache;