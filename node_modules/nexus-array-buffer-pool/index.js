import * as internal from "./internals.js";

if(process.env.NODE_ENV === "test")
	(globalThis).internal = internal;

import {
	WorkerClass,
	isResizableArrayBufferSupported,
	mainExternalMemory, updateMainExternalMemory, setMainExternalMemory,
	allocatorExternalMemory,
	reserveAllocationMemory, setReserveAllocationMemory,
	isAllocatorBusy,
	allocateQueue,
	allocator, setAllocator,
	dirname, requestClean, isCleaningRequested, setIsCleaningRequested, isAllocatingRequested,
	setIsAllocatingRequested, requestAllocate, dispatchDetach, dispatchSettle, setReserveExpansionMemory,
	reserveExpansionMemory, cleaningMemory, calculateSlabThresholds, onAllocatorReady, onCleanerReady, acquireResult,
	slabThresholds, ACQUIRE_VIEW_CLASS_ERROR, viewClassCheck, ttlArrayBufferSet,
} from "./internals.js";

updateMainExternalMemory();
setAllocator(new WorkerClass(path.join(dirname, "lib/alloc.js"), {workerData: {externalMemory: allocatorExternalMemory}}));

allocator.on("message", onAllocatorReady);

import {
	cleanerExternalMemory, cleanerGCHintView,
	isCleanerBusy, setIsCleanerBusy,
	cleanRequestQueue,
	cleaningStatus,
	requestCleanerSyncV8ExternalTimeout, setRequestCleanerSyncV8ExternalTimeout,
	requestCleanerSyncV8External,
	isExternalMemoryCritical,
	cleaner, setCleaner,
	internalCleaningStatuses,
} from "./internals.js";

setCleaner(new WorkerClass(path.join(dirname, "lib/clean.js"), {workerData: {externalMemory: cleanerExternalMemory, gcHintView: cleanerGCHintView}}));

cleaner.on("message", onCleanerReady);

class CleaningStatus
{
	get id() { return this.#internal.id; }

	get endpoint() { return this.#internal.endpoint; }

	get state() { return this.#internal.state; }

	get byteLength() { return this.#internal.byteLength; }

	/** @type {()=>void|null} */
	onDetach;
	/** @type {()=>void|null} */
	onSettled;
	/** @type {(error: Error)=>void|null} */
	onError;

	get error() { return this.#internal.error; }

	/** @type {InternalCleaningStatus} */
	#internal;

	/** @return {DetachWatcher} */
	get detached(){ return this.#internal.detached; }

	constructor(internalStatus) {
		this.#internal = internalStatus;
		cleaningStatus.get(internalStatus).push(this);
	}
}

class InternalCleaningStatus
{
	/** @type {string} */
	id;
	/** @type {number} */
	byteLength;
	/** @type {"pool"|"gc"|"void"} */
	endpoint;
	/** @type {"queued"|"cleaning"|"done"|"error"} */
	state;
	/** @type {Array<(resolve: ()=>void)=>void>} */
	onDetaches;
	/** @type {Array<(resolve: ()=>void)=>void>} */
	onSettles;
	/** @type {Array<(reject: (error: Error)=>void)=>void>} */
	onErrors;
	/** @type {Error|null} */
	error;
	/** @type {bigint} */
	expansion = 0n;
	/** @type {DetachWatcher} */
	#detached;
	/** @return {DetachWatcher} */
	get detached()
	{
		if(!this.#detached)
		{
			this.onDetaches = [];
			this.#detached = new DetachWatcher(this);
		}
		return this.#detached;
	}
	/** @type {SettledWatcher|null} */
	settled;

	constructor(id)
	{
		this.id = id;
		cleaningStatus.set(this, []);
	}
}

class DetachWatcher
{
	/** @type {InternalCleaningStatus} */
	parent;
	then(resolve, reject)
	{
		const parent = this.parent;
		if(parent.state === "error") reject?.(parent.error);
		else if(parent.state !== "queued") resolve?.();
		else {
			if(resolve) parent.onDetaches.push(resolve);
		}
		return this;
	}

	/** @return {SettledWatcher} */
	get done()
	{
		const parent = this.parent;
		if(!parent.settled)
		{
			parent.onSettles = [];
			parent.onErrors = [];
			parent.settled = new SettledWatcher(parent);
		}
		return parent.settled;
	}

	/** @param {InternalCleaningStatus} parent */
	constructor(parent) {
		this.parent = parent;
	}
}

class SettledWatcher
{
	/** @type {InternalCleaningStatus} */
	parent;
	then(resolve, reject)
	{
		const parent = this.parent;
		if(parent.state === "error") reject?.(parent.error);
		else if(parent.state === "done") resolve?.();
		else {
			if(resolve) parent.onSettles.push(resolve);
			if(reject) parent.onErrors.push(reject);
		}
		return this;
	}

	/** @param {InternalCleaningStatus} parent */
	constructor(parent) { this.parent = parent; }
}

import {
	getSlabIndex,
	permissionCheck,
	minArrayBufferSize, setMinArrayBufferSize,
	slabGrowthFactor, setSlabGrowthFactor,
	maxArrayBufferSize, setMaxArrayBufferSize,
	maxPoolClasses, setMaxPoolClasses,
	gcPolicyThreshold, setGcPolicyThreshold,
	arrayBufferTTL, setArrayBufferTTL
} from "./internals.js";

class FinalNABPPolicy
{
	/** default: 1024
	 * @return {bigint} */
	get minArrayBufferSize() { return minArrayBufferSize; }

	/** default: 1.25
	 * @return {number} */
	get slabGrowthFactor() { return slabGrowthFactor; }

	/** default: 搭載メインメモリ容量の10％ もしくは搭載メインメモリ容量の10％ が 4GB 以上であれば 4GB
	 * @return {bigint} */
	get maxArrayBufferSize() { return maxArrayBufferSize; }

	/** @return {uint} */
	get maxPoolClasses() { return maxPoolClasses; }

	/** default: 搭載メインメモリ容量の50％
	 * @return {bigint} */
	get gcPolicyThreshold() { return gcPolicyThreshold; }

	/**
	 * マイナスの場合はプールされた ArrayBuffer の生存期間が無限になり、gcPolicyThreshold のみが削除トリガーとなる
	 * @default: 300000（5 minutes）
	 * @return {uint} */
	get arrayBufferTTL() { return arrayBufferTTL; }
}

import {
	MAX_POOL_CLASSES_LIMIT
} from "./internals.js";

class NABPPolicy extends FinalNABPPolicy
{
	/** @param {number} value */
	set slabGrowthFactor(value) { if(permissionCheck()) setSlabGrowthFactor(value); }

	/** @param {number|bigint} value */
	set maxArrayBufferSize(value) { if(permissionCheck()) setMaxArrayBufferSize(BigInt(value)); }

	/** @param {number|bigint} value */
	set minArrayBufferSize(value) { if(permissionCheck()) setMinArrayBufferSize(BigInt(value)); }

	/** @param {uint} value */
	set maxPoolClasses(value) { if(permissionCheck()) setMaxPoolClasses(value); }

	/** @param {number|bigint} value */
	set gcPolicyThreshold(value) { if(permissionCheck()) setGcPolicyThreshold(BigInt(value)); }

	/** @param {uint} value */
	set arrayBufferTTL(value) { if(permissionCheck()) setArrayBufferTTL(value); }
}

import {
	singleton, setSingleton,
	cycleCount, setCycleCount,
	pool,
	policy, setPolicy
} from "./internals.js";
import path from "path";
import * as self from "./internals.js";

setPolicy(new NABPPolicy());

export class NexusArrayBufferPool
{
	/**
	 * ArrayBuffer のプール戦略に関する設定が出来ます。必ず NexusArrayBufferPool をインスタンス化する前に設定変更を終わらせてください。
	 * NexusArrayBufferPool をインスタンス化した後は NexusArrayBufferPool.policy(NABPPolicy インスタンス)にアクセス出来なくなります。
	 * プール戦略に関する設定内容をインスタンス化後に取得したい場合は、NexusArrayBufferPool インスタンスの policy プロパティにアクセスしてください。
	 * @return {NABPPolicy|null} */
	static get policy(){ return policy; }

	/** @type {FinalNABPPolicy} */
	#policy;

	/**
	 * プール戦略に関する設定内容を取得出来ます。各設定内容も読み取り専用です。
	 * @readonly
	 * @return {FinalNABPPolicy} */
	get policy() { return this.#policy; }

	/** @return {bigint} */
	get totalExternalMemory() { return mainExternalMemory + cleanerExternalMemory[0] + allocatorExternalMemory[0] + reserveAllocationMemory + reserveExpansionMemory + cleaningMemory; }

	/**
	 * @param {ArrayBuffer} arrayBuffer
	 * @param {"pool"|"gc"} [endpoint="pool"]
	 * @return {CleaningStatus} */
	free(arrayBuffer, endpoint="pool")
	{
		setCycleCount(cycleCount + 1);
		if(cycleCount % 5 === 0)
			updateMainExternalMemory();

		if(requestCleanerSyncV8ExternalTimeout)
		{
			clearTimeout(requestCleanerSyncV8ExternalTimeout);
			setRequestCleanerSyncV8ExternalTimeout(null);
		}

		/** @type {InternalCleaningStatus} */
		let internalStatus;
		const byteLength = arrayBuffer.byteLength;
		const maxByteLength = arrayBuffer.resizable ? arrayBuffer.maxByteLength : byteLength;

		if(!byteLength && !arrayBuffer.maxByteLength)
		{
			internalStatus = new InternalCleaningStatus("_-useless-_");
			internalStatus.state = "done";
			internalStatus.endpoint = "void";
			queueMicrotask(()=>
			{
				dispatchDetach(internalStatus);
				dispatchSettle(internalStatus);
			});
			return new CleaningStatus(internalStatus);
		}

		if(maxByteLength < slabThresholds[0])
		{
			if(typeof arrayBuffer.transfer === "function")
			{
				internalStatus = new InternalCleaningStatus("_-useless-_");
				internalStatus.endpoint = "gc";
				if(arrayBuffer.resizable) arrayBuffer.resize(0);
				arrayBuffer.transfer();
				internalStatus.state = "done";
				queueMicrotask(()=>
				{
					dispatchDetach(internalStatus);
					dispatchSettle(internalStatus);
				});
				return new CleaningStatus(internalStatus);
			}
			else endpoint = "gc";
		}

		/** @type {RequestCleanDetail} */
		let request;

		if(!cleanRequestQueue.has(arrayBuffer))
		{
			const id = Math.random().toString(36).substring(2);
			internalStatus = new InternalCleaningStatus(id);
			internalCleaningStatuses.set(id, internalStatus);

			if(typeof arrayBuffer.transfer === "function")
			{
				arrayBuffer = arrayBuffer.transfer();
				dispatchDetach(internalStatus);
			}

			request = {buffer: arrayBuffer, id};

			internalStatus.state = "queued";
			cleanRequestQueue.set(arrayBuffer, request);
			if(!isCleanerBusy && !isCleaningRequested)
			{
				queueMicrotask(requestClean);
				setIsCleaningRequested(true);
			}
		}
		else
		{
			request = cleanRequestQueue.get(arrayBuffer);
			internalStatus = internalCleaningStatuses.get(request.id);
		}

		if(endpoint !== "gc")
			request.returnToPool = maxByteLength < maxArrayBufferSize && (this.totalExternalMemory + BigInt(maxByteLength)) < gcPolicyThreshold;
		else
			request.returnToPool = false;

		internalStatus.endpoint = request.returnToPool ? "pool" : "gc";

		if(request.returnToPool)
		{
			/** @type {bigint} */
			const expansionGap = BigInt(maxByteLength - byteLength);

			if(internalStatus.expansion !== expansionGap)
				setReserveExpansionMemory(reserveExpansionMemory + (expansionGap - internalStatus.expansion));

			internalStatus.expansion = expansionGap;
		}
		else internalStatus.expansion = 0n;

		internalStatus.byteLength = byteLength;

		return new CleaningStatus(internalStatus);
	}

	/**
	 * @template {new()=>any} T
	 * @param {number|bigint} byteLength
	 * @param {T} [ViewClass=ArrayBuffer]
	 * @param {number|bigint} [maxByteLength]
	 * @return {Promise<T>}
	 */
	acquire(byteLength, ViewClass=ArrayBuffer, maxByteLength)
	{
		return new Promise((resolve, reject)=>
		{
			byteLength = BigInt(byteLength);
			if(maxByteLength) maxByteLength = BigInt(maxByteLength);

			if(!viewClassCheck(ViewClass)) reject(ACQUIRE_VIEW_CLASS_ERROR);

			setCycleCount(cycleCount + 1);
			if(cycleCount % 5 === 0)
				updateMainExternalMemory();

			let slabIndex;


			if(!isResizableArrayBufferSupported && maxByteLength)
				maxByteLength = 0n;

			if(!maxByteLength)
			{
				slabIndex = getSlabIndex(byteLength);
				if(pool[slabIndex]?.size)
				{
					const arrayBuffer = pool[slabIndex].values().next().value;
					pool[slabIndex].delete(arrayBuffer);
					if(arrayBufferTTL >= 0) ttlArrayBufferSet.delete(arrayBuffer);
					return resolve(acquireResult(ViewClass, arrayBuffer, byteLength));
				}
			}
			else
			{
				slabIndex = getSlabIndex(maxByteLength);
				if(pool[slabIndex]?.size)
				{
					for(const arrayBuffer of pool[slabIndex])
					{
						if(typeof arrayBuffer.resize === "function")
						{
							pool[slabIndex].delete(arrayBuffer);
							if(arrayBufferTTL >= 0) ttlArrayBufferSet.delete(arrayBuffer);
							return resolve(acquireResult(ViewClass, arrayBuffer, byteLength));
						}
					}
				}
			}

			const totalExternalMemory = this.totalExternalMemory;
			if(totalExternalMemory + byteLength > gcPolicyThreshold)
			{
				Atomics.store(cleanerGCHintView, 0, 0);
				cleaner.postMessage({command: "trueExternalMemory"});
				return reject(`NexusArrayBufferPool の限界メモリ容量ルール（gcPolicyThreshold: ${gcPolicyThreshold}）を超える容量の新規 ArrayBuffer 作成依頼だったため、ArrayBuffer を作成しませんでした。現在の把握メモリ容量: ${totalExternalMemory}, 依頼された容量: ${byteLength}`);
			}

			if(isExternalMemoryCritical(totalExternalMemory))
			{
				if(Atomics.load(cleanerGCHintView, 0))
				{
					Atomics.store(cleanerGCHintView, 0, 0);
					cleaner.postMessage({command: "trueExternalMemory"});
				}
			}

			setReserveAllocationMemory(reserveAllocationMemory + byteLength);
			const id = Math.random().toString(36).substring(2);

			if(isResizableArrayBufferSupported && !maxByteLength)
				maxByteLength = slabThresholds[slabIndex];

			/** @type {RequestAllocDetail} */
			const request = {id, byteLength, maxByteLength};
			allocateQueue.push({request, ViewClass, resolve, reject});
			if(!isAllocatorBusy && !isAllocatingRequested)
			{
				setIsAllocatingRequested(true);
				queueMicrotask(requestAllocate);
			}
		});
	}

	constructor()
	{
		if(singleton)
			throw new Error(internal.SINGLETON_ERROR);

		const errors = [];
		if(slabGrowthFactor <= 1)
			errors.push(internal.SLAB_GROWTH_FACTOR_TOO_SMALL_ERROR);

		if(maxArrayBufferSize > internal.MAX_ARRAY_BUFFER_SIZE_LIMIT)
			errors.push(internal.MAX_ARRAY_BUFFER_SIZE_TOO_LARGE_ERROR);

		if(maxArrayBufferSize < minArrayBufferSize)
			errors.push(internal.MAX_ARRAY_BUFFER_SIZE_TOO_SMALL_ERROR);

		if(minArrayBufferSize < 1)
			errors.push(internal.MIN_ARRAY_BUFFER_SIZE_TOO_SMALL_ERROR);

		// calculateMaxPoolClasses();
		calculateSlabThresholds();
		if(typeof maxPoolClasses === "number")
		{
			if(maxPoolClasses < 1)
				errors.push(internal.MAX_POOL_CLASSES_TOO_SMALL_ERROR);

			if(maxPoolClasses > MAX_POOL_CLASSES_LIMIT)
				errors.push(internal.MAX_POOL_CLASSES_TOO_LARGE_ERROR);
		}
		else setMaxPoolClasses(MAX_POOL_CLASSES_LIMIT);

		if(gcPolicyThreshold < 1)
			errors.push(internal.GC_POLICY_THRESHOLD_TOO_SMALL_ERROR);

		if(gcPolicyThreshold > internal.GC_POLICY_THRESHOLD_LIMIT)
			errors.push(internal.GC_POLICY_THRESHOLD_TOO_LARGE_ERROR);

		if(errors.length) throw new Error(errors.join("\n"));

		this.#policy = new FinalNABPPolicy();
		setPolicy(null)
		setSingleton(this);

	}
}

export default NexusArrayBufferPool;