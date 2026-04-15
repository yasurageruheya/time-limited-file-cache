import * as self from "./internals.js";
import * as fsp from "node:fs/promises";
import {NexusArrayBufferPool} from "nexus-array-buffer-pool";
import TimeLimitedFileCache from "./index.js";

/** @type {typeof Logger} */
export let Logger;

/** @type {Set<FileEntity>} */
export const fileHandleOpeningEntities = new Set();

export const bigIntStatsOptions = {bigint: true};

export const FILE_NAME_DIRECTORY_SEPARATOR_ERROR = new Error(`引数 fileName にディレクトリセパレータ文字列(${path.sep})が含まれていました。正しいファイル名を指定してください`);

/** @type {NexusArrayBufferPool} */
export let nexus;

export const setNexus = (nexusArrayBufferPool) => {
	nexus = nexusArrayBufferPool;
}

/**
 * @typedef {Object} FileHandleCloseReason
 * @property {symbol} STAT_ERROR_OCCURRED
 * @property {symbol} READ_ERROR
 * @property {symbol} WRITE_ERROR
 * @property {symbol} NEWER_REQUEST
 * @property {symbol} WAITING_NEWER_REQUEST
 */

/**
 * @typedef {FileHandleCloseReason[keyof FileHandleCloseReason]} FileHandleCloseReasonKey
 */

/** @type {FileHandleCloseReason} */
export const FILE_HANDLE_CLOSE_REASON = Object.freeze({
	STAT_ERROR_OCCURRED: Symbol(),
	READ_ERROR: Symbol(),
	WRITE_ERROR: Symbol(),
	NEWER_REQUEST: Symbol(),
	WAITING_NEWER_REQUEST: Symbol(),
});



export const globalFileHandleSlot = async() =>
{
	if(TimeLimitedFileCache.maxFileHandleCache < fileHandleOpeningEntities.size)
	{
		const openings = fileHandleOpeningEntities.values();
		const first = openings.next().value;
		let opened = first;
		while (opened)
		{
			if(!opened.reading)
			{
				fileHandleOpeningEntities.delete(opened);
				await opened.closeFileHandle();
				return null;
			}
			opened = openings.next().value;
		}

		//todo: globalFileHandleSlot() が2回同時に呼ばれた場合、2回とも同じ entity の busy の完了を待つ事になってしまう
		//todo: Geminiの話しを読む！！！
		await first.reading;
		fileHandleOpeningEntities.delete(first);
		await first.closeFileHandle();
		return null;
	}
	else return null;
}

/** @type {Map<string, CacheFile>} */
export const cacheFiles = new Map();

export const fileRemoveOptions = {force: true};

export class CacheFile
{
	static fromFullPath(fullPath)
	{
		if(!cacheFiles.has(fullPath))
			cacheFiles.set(fullPath, new CacheFile(fullPath));
		return cacheFiles.get(fullPath);
	}
	/** @type {Promise<FileEntity>} */
	#entity;
	/** @type {string} */
	fullPath;

	/** @type {Promise<fs.BigIntStats>} */
	#cacheStats;

	/** @type {NodeJS.Timeout|number} */
	#fileTimeout;

	/** @type {FileEntity} */
	#currentEntity;

	get stats()
	{
		if(!this.#cacheStats)
		{
			this.#cacheStats = (async() => {
				try {
					return await fsp.stat(this.fullPath, self.bigIntStatsOptions);
				} catch (error) {
					throw error
				} finally {
					this.#cacheStats = null
				}
			})();
		}

		return this.#cacheStats;
	}

	get entity() {
		if(!this.#entity)
		{
			this.#entity = (async() => {
				try {
					const stats = await this.stats;
					const entityKey = `${stats.dev}:${stats.ino}:${stats.ctimeMs}`;
					if(this.#currentEntity)
					{
						if(this.#currentEntity.entityKey === entityKey)
							return this.#currentEntity;
						else {
							this.#currentEntity.unlinkFile(this).then();
							return null;
						}
					}

					const entity = self.FileEntity.fromStats(entityKey, stats);
					entity.fullPath = this.fullPath;
					entity.files.add(this);
					return entity;
				} catch (error) {
					throw error;
				} finally {
					this.#entity = null
				}
			})();
		}

		return this.#entity;
	}

	#readAsBufferPromise;

	readAsBuffer(memoryTTL, fileTTL)
	{
		if(!this.#readAsBufferPromise)
		{
			this.#readAsBufferPromise = (async ()=>
			{
				try {
					const entity = await this.entity;
					const buffer = await entity.readAsBuffer(this, memoryTTL);
					this.#updateFileTimeLimit(fileTTL);
					return buffer;
				} catch (error) {
					if(error.code === "ENOENT") return null;
					else throw error;
				} finally {
					this.#readAsBufferPromise = null
				}
			})();
		}
		return this.#readAsBufferPromise
	}

	writeAsBuffer(data, memoryTTL, fileTTL)
	{

	}

	#updateFileTimeLimit(ttl)
	{
		if(this.#fileTimeout) clearTimeout(this.#fileTimeout);
		if(ttl < 0) return;
		this.#fileTimeout = setTimeout(async() => {
			fsp.rm(this.fullPath, fileRemoveOptions).then();
			this.#fileTimeout = null;

			const entity = await this.entity;
			entity.unlinkFile(this).then();
		})
	}

	constructor(fullPath)
	{
		this.fullPath = fullPath;
	}
}

/** @type {Map<string, FileEntity>} */
export const fileEntities = new Map();

export class FileEntity
{
	static fromStats(entityKey, stats)
	{
		if(!fileEntities.has(entityKey))
			fileEntities.set(entityKey, new FileEntity(entityKey, stats.dev));
		const entity = fileEntities.get(entityKey);
		entity.stats = stats;
		return fileEntities.get(entityKey);
	}

	/** @type {Set<CacheFile>} */
	files = new Set();

	/** @type {string} */
	fullPath;

	/** @type {module:fs.BigIntStats} */
	stats;

	/** @type {LogicalVolume} */
	logicalVolume;

	/** @type {Promise<FileHandle>} */
	#fileHandlePromise;

	/** @type {boolean} todo:このフラグ要る？？？ */
	#fileHandleOpened;

	/** @type {Buffer} */
	#memoryCache;

	/** @type {NodeJS.Timeout|number} */
	#memoryTimeout;

	/** @type {Promise<void>|null} */
	reading = null;

	/** @type {Promise<void>|null} */
	writing = null;

	/** @type {boolean} */
	closingReserved = false;


	/**
	 *
	 * @param {CacheFile} file
	 * @return {Promise<void>}
	 */
	unlinkFile(file) {
		this.files.delete(file);
		if(!this.files.size)
		{
			fileEntities.delete(this.entityKey);
			if(this.#fileHandlePromise)
				return this.closeFileHandle();
			else return Promise.resolve();
		}
	}

	/** @type {null|Promise<void>} */
	#closeFileHandlePromise;

	/** @return {Promise<void>} */
	closeFileHandle()
	{
		if(!this.#closeFileHandlePromise)
		{
			this.#closeFileHandlePromise = (async()=> {
				try {
					const fh = await this.#fileHandlePromise;
					return fh.close();
				} catch (error) {
					throw error;
				} finally {
					this.#fileHandlePromise = null;
					this.#closeFileHandlePromise = null;
				}
			})();
		}
		return this.#closeFileHandlePromise;
	}

	openFileHandle = ()=>
	{
		if(!this.#fileHandlePromise)
		{
			this.#fileHandlePromise = (async() =>
			{
				try {
					const fileHandle = await fsp.open(this.fullPath, "r+");
					fileHandleOpeningEntities.add(this);
					this.#fileHandleOpened = true;
					return fileHandle;
				} catch (error) {
					if(error.code === "ENOENT") {
						try {
							const fileHandle = await fsp.open(this.fullPath, "w+");
							fileHandleOpeningEntities.add(this);
							this.#fileHandleOpened = true;
							return fileHandle;
						} catch (error) {
							this.#fileHandleOpened = false;
							throw error;
						}
					}
					else throw error;
				}
			})();
		}

		return this.#fileHandlePromise;
	}

	#updateMemoryTimeLimit(ttl)
	{
		if(this.#memoryTimeout) clearTimeout(this.#memoryTimeout);
		if(ttl < 0) return;
		this.#memoryTimeout = setTimeout(() => {
			nexus.free(this.#memoryCache.buffer);
			this.#memoryCache = null;
			delete this.#memoryCache;
		}, ttl);
	}

	/** @type {Promise<Buffer>} */
	#readAsBufferPromise;

	/**
	 *
	 * @param file
	 * @param memoryTTL
	 * @return {Promise<Buffer>}
	 */
	readAsBuffer(file, memoryTTL) {
		//todo: Gemini の話しを読む！！！！
		//todo: Node.js レイヤーにキャッシュする容量の閾値を設定する？？
		if(this.#memoryCache)
		{
			this.#updateMemoryTimeLimit(memoryTTL);
			return Promise.resolve(this.#memoryCache);
		}

		if(this.#readAsBufferPromise) return this.#readAsBufferPromise;

		//todo: PhysicalDrive と連携して並列アクセスの制御をしなきゃ

		return this.#readAsBufferPromise = (async() => {
			try { //A
				const previousBusy = this.reading;
				let release;
				//todo: new Promise するしかないのかな？？
				this.reading = new Promise(resolve => {release = resolve;});
				try { //B
					if(previousBusy) await previousBusy;
					if(!this.#fileHandlePromise) await self.globalFileHandleSlot();
					const fileHandle = await this.openFileHandle();
					if(!this.stats) this.stats = await fileHandle.stat(self.bigIntStatsOptions);
					const buffer = await nexus.acquire(this.stats.size, Buffer);
					//todo: 並列 read とかをするかどうかの話ってどうなったんだっけ？？
					await fileHandle.read(buffer, 0, Number(this.stats.size), 0);
					this.#memoryCache = buffer;
					this.#updateMemoryTimeLimit(memoryTTL);
					return buffer;
				} finally {
					release();
					this.reading = null;
				}
			} catch (error) {
				throw error;
			} finally {
				this.#readAsBufferPromise = null;
			}
		})();
	}

	writeAsBuffer(file, data, memoryTTL) {
		return new Promise((resolve, reject) => {
			if(this.#memoryCache)
			{
				if(this.#memoryCache.equals(data)) return resolve();
				else nexus.free(this.#memoryCache.buffer);
			}

			this.#memoryCache = data;

			if(!this.#fileHandlePromise)
			{

			}

			let fileHandle;
			this.#fileHandlePromise.then(fh => {
				fileHandle = fh;
				if(this.reading) return this.reading;
				else return Promise.resolve();
			})
		})
	}

	constructor(entityKey, deviceId)
	{
		this.entityKey = entityKey;
		this.logicalVolume = LogicalVolume.fromDeviceId(deviceId);
	}
}

/** @type {Map<bigint, LogicalVolume>} */
export const logicalVolumes = new Map();

export class LogicalVolume
{
	static fromDeviceId(deviceId)
	{
		if(!logicalVolumes.has(deviceId))
			logicalVolumes.set(deviceId, new LogicalVolume(deviceId));
		return logicalVolumes.get(deviceId);
	}

	physicalDrive = new PhysicalDrive();

	deviceId;

	constructor(deviceId) {
		this.deviceId = deviceId;
	}
}

export class PhysicalDrive
{
	maxConcurrency = 2;

	running = 0;

	queues = [];

	async assign(taskFn)
	{
		if(this.running.length >= this.maxConcurrency)
			await new Promise(resolve => this.queues.push(resolve));

		this.running++;
		try {
			return await taskFn();
		} catch (error) {
			throw error;
		} finally {
			this.running--;
			if(this.queues.length > 0)
				this.queues.shift()();
		}
	}

	constructor() {

	}
}