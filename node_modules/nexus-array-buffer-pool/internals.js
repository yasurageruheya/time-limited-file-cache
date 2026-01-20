import * as self from "./internals.js";

import os from "os";

const TypedArray = Object.getPrototypeOf(Uint8Array);

export const TOTAL_MEMORY = os.totalmem();

export const _4GB = 4_294_967_296n;

export const DEFAULT_MIN_ARRAY_BUFFER_SIZE = 1024n;

export const DEFAULT_SLAB_GROWTH_FACTOR = 1.25;

export const MAX_ARRAY_BUFFER_SIZE_LIMIT = BigInt(Math.floor(TOTAL_MEMORY * .5));

export const GC_POLICY_THRESHOLD_LIMIT = BigInt(Math.floor(TOTAL_MEMORY * .9));

export const MAX_ARRAY_BUFFER_SIZE_GUIDE = BigInt(Math.floor(TOTAL_MEMORY * .1));

export const DEFAULT_MAX_ARRAY_BUFFER_SIZE = MAX_ARRAY_BUFFER_SIZE_GUIDE > _4GB ? _4GB : MAX_ARRAY_BUFFER_SIZE_GUIDE;

export const DEFAULT_GC_POLICY_THRESHOLD = BigInt(TOTAL_MEMORY * .5);

export const DEFAULT_ARRAY_BUFFER_TTL = 5 * 1000 * 60;

/** @type {number} */
export let slabGrowthFactor = DEFAULT_SLAB_GROWTH_FACTOR;
/** @param {number} value */
export const setSlabGrowthFactor = (value)=> slabGrowthFactor = value;
/** @type {bigint} */
export let maxArrayBufferSize = DEFAULT_MAX_ARRAY_BUFFER_SIZE;
/** @param {bigint} value */
export const setMaxArrayBufferSize = (value)=> maxArrayBufferSize = value;

/** @type {bigint} */
export let minArrayBufferSize = DEFAULT_MIN_ARRAY_BUFFER_SIZE;
/** @param {bigint} value */
export const setMinArrayBufferSize = (value)=> minArrayBufferSize = value;
/** @type {uint} */
export let maxPoolClasses;
/** @param {uint} value */
export const setMaxPoolClasses = (value)=> maxPoolClasses = value;
/** @type {bigint} */
export let gcPolicyThreshold = DEFAULT_GC_POLICY_THRESHOLD;
/** @param {bigint} value */
export const setGcPolicyThreshold = (value)=> gcPolicyThreshold = value;
/** @type {uint} */
export let arrayBufferTTL = DEFAULT_ARRAY_BUFFER_TTL;
/** @param {uint} value */
export const setArrayBufferTTL = (value) => arrayBufferTTL = value;

/** @type {uint} */
export let MAX_POOL_CLASSES_LIMIT;

export const calculateMaxPoolClasses = () => {
	MAX_POOL_CLASSES_LIMIT = Math.ceil((Math.log(maxArrayBufferSize) - Math.log(minArrayBufferSize)) / Math.log(slabGrowthFactor)) + 1;
}


export const SINGLETON_ERROR = "NexusArrayBufferPool はシングルトンインスタンスを原則に利用してください。複数個の NexusArrayBufferPool インスタンスの作成を禁止しています";

export const MIN_ARRAY_BUFFER_SIZE_TOO_SMALL_ERROR = "minArrayBufferSize の値は 1 以上を設定してください";

export const SLAB_GROWTH_FACTOR_TOO_SMALL_ERROR = "slabGrowthFactor(スラブサイズ段階率) は 1 より大きい値を設定してください";

export const MAX_ARRAY_BUFFER_SIZE_TOO_LARGE_ERROR = `maxArrayBufferSize の値はこのシステムのメモリリミット(${MAX_ARRAY_BUFFER_SIZE_LIMIT})以下までにしてください(搭載メインメモリ容量:${TOTAL_MEMORY} の50％)`;

export const MAX_ARRAY_BUFFER_SIZE_TOO_SMALL_ERROR = `maxArrayBufferSize の値は minArrayBufferSize(${minArrayBufferSize})以上を設定してください`;

export const MAX_POOL_CLASSES_TOO_SMALL_ERROR = "maxPoolClasses(スラブサイズスロット数) の値は 1 以上を設定してください";

export const MAX_POOL_CLASSES_TOO_LARGE_ERROR = `maxPoolClasses(スラブサイズスロット数) は現在の minArrayBufferSize(${minArrayBufferSize}), maxArrayBufferSize(${maxArrayBufferSize}), slabGrowthFactor(${slabGrowthFactor}) の設定値では ${MAX_POOL_CLASSES_LIMIT} の値までしか設定できません`;

export const GC_POLICY_THRESHOLD_TOO_SMALL_ERROR = `gcPolicyThreshold の値は 1 以上を設定してください`;

export const GC_POLICY_THRESHOLD_TOO_LARGE_ERROR = `gcPolicyThreshold の値は搭載メインメモリ容量の90%(${GC_POLICY_THRESHOLD_LIMIT})までにしてください`;

export const ACQUIRE_VIEW_CLASS_ERROR = "acquire() の引数 ViewClass に指定出来るのは、Buffer クラス または ArrayBuffer クラス または DataView クラス または TypedArray サブクラス(Uint8Array 等) のみになります";

import { fileURLToPath } from 'url';
import { dirname as pathDirname } from 'path';
export const dirname = pathDirname(fileURLToPath(import.meta.url));

export const isResizableArrayBufferSupported = typeof ArrayBuffer.prototype.resize === "function";

import v8 from "v8";
import {Worker} from "worker_threads";
import {CleaningStatus} from "./index.d.ts";
/** @type {typeof Worker} */
export let WorkerClass = Worker;
export const setWorkerClass = (value)=> WorkerClass = value;

/** @type {BigInt} */
export let mainExternalMemory;

export const updateMainExternalMemory = ()=>
{
	mainExternalMemory = BigInt(v8.getHeapStatistics().external_memory);
}
/** @param {bigint} value */
export const setMainExternalMemory = (value)=> mainExternalMemory = BigInt(value);

export const allocatorExternalMemory = new BigUint64Array(new SharedArrayBuffer(BigUint64Array.BYTES_PER_ELEMENT));

/** @type {bigint} */
export let reserveAllocationMemory = 0n;
/** @param {bigint} value */
export const setReserveAllocationMemory = (value)=> reserveAllocationMemory = value;

export let isAllocatorBusy = true;
export const setIsAllocatorBusy = (value)=> isAllocatorBusy = value;

/** @type {QueuedRequestAlloc[]} */
export const allocateQueue = [];

/** @type {Map<string, {ViewClass:{ new(...args: any[]): any } | typeof ArrayBuffer ,resolve:(buffer:ArrayBuffer)=>void, reject:(error:Error)=>void}>} */
export const nowAllocating = new Map();

/** @type {Worker} */
export let allocator;
/** @param {Worker} value */
export const setAllocator = (value)=> allocator = value;

/**
 *
 * @param {ResponseAlloc} message
 */
export const onAllocate = (message)=>
{
	const response = message.response;
	for(let i = response.length; i--;)
	{
		const detail = response[i];
		const {id, buffer, error, byteLength} = detail;

		reserveAllocationMemory -= byteLength;

		const {ViewClass, resolve, reject} = nowAllocating.get(id);
		nowAllocating.delete(id);

		if(error) reject(error);
		else
		{
			mainExternalMemory += byteLength;
			resolve(self.acquireResult(ViewClass, buffer, byteLength));
		}
	}

	if(allocateQueue.length)
	{
		/** @type {RequestAllocDetail[]} */
		const requests = [];
		while(allocateQueue.length)
		{
			const queue = allocateQueue.pop();
			requests.push(queue.request);
			nowAllocating.set(queue.request.id, {resolve: queue.resolve, reject: queue.reject});
		}
		allocator.postMessage({requests});
	}
	else isAllocatorBusy = false;
}

export let isAllocatingRequested = false;
export const setIsAllocatingRequested = (value)=> isAllocatingRequested = value;

export const requestAllocate = ()=>
{
	/** @type {RequestAllocDetail[]} */
	const requests = [];
	while(allocateQueue.length)
	{
		const queue = allocateQueue.pop();
		requests.push(queue.request);
		const {ViewClass, resolve, reject} = queue;
		nowAllocating.set(queue.request.id, {ViewClass, resolve, reject});
	}
	isAllocatorBusy = true;
	allocator.postMessage({requests});
	isAllocatingRequested = false;
}
let allocatorReadyResolve;
export const allocatorReady = new Promise(resolve=>allocatorReadyResolve = resolve);
export const onAllocatorReady = (message)=>
{
	if(message === "ready")
	{
		isAllocatorBusy = false;
		if(allocateQueue.length) self.requestAllocate();
		allocator.off("message", self.onAllocatorReady);
		allocator.on("message", self.onAllocate);
		allocatorReadyResolve();
	}
}

export const viewClassCheck = (ViewClass)=>
{
	return ViewClass === ArrayBuffer ||
		typeof Buffer !== 'undefined' && ViewClass === Buffer ||
		Object.getPrototypeOf(ViewClass) === TypedArray ||
		ViewClass === DataView;
}

/**
 * @template {new()=>any} T
 * @param {T} ViewClass
 * @param arrayBuffer
 * @param byteLength
 * @return {InstanceType<T>}
 */
export const acquireResult = (ViewClass, arrayBuffer, byteLength) =>
{
	byteLength = Number(byteLength);
	if(arrayBuffer.resizable && byteLength !== arrayBuffer.byteLength)
	{
		setMainExternalMemory(mainExternalMemory - BigInt(arrayBuffer.byteLength - byteLength));
		arrayBuffer.resize(byteLength);
	}

	if(ViewClass === ArrayBuffer) return arrayBuffer;
	else if(typeof Buffer !== 'undefined' && ViewClass === Buffer)
		return Buffer.from(arrayBuffer);
	else if(Object.getPrototypeOf(ViewClass) === TypedArray || ViewClass === DataView)
		return new ViewClass(arrayBuffer, 0, byteLength);
	else throw new Error("このエラーが出たら nexus-array-buffer-pool のバグです");
}

/** @type {BigUint64Array} */
export const cleanerExternalMemory = new BigUint64Array(new SharedArrayBuffer(BigUint64Array.BYTES_PER_ELEMENT));
/** @type {Uint8Array} */
export const cleanerGCHintView = new Uint8Array(new SharedArrayBuffer(1));

/** @type {bigint} */
export let reserveExpansionMemory = 0n;
/** @param {bigint} value */
export const setReserveExpansionMemory = (value)=> reserveExpansionMemory = value;

/** @type {bigint} */
export let cleaningMemory = 0n;
/** @param {bigint} value */
export const setCleaningMemory = (value)=> cleaningMemory = value;

export let isCleanerBusy = true;
export const setIsCleanerBusy = (value)=>  isCleanerBusy = value;

/** @type {Map<ArrayBuffer, RequestCleanDetail>} */
export const cleanRequestQueue = new Map();
/** @type {WeakMap<InternalCleaningStatus, CleaningStatus[]>} */
export const cleaningStatus = new WeakMap();

/** @type {NodeJS.Timeout|number|null} */
export let requestCleanerSyncV8ExternalTimeout;
export const setRequestCleanerSyncV8ExternalTimeout = (value)=> requestCleanerSyncV8ExternalTimeout = value;

/** @return {NodeJS.Timeout|number} */
export const requestCleanerSyncV8External = () =>
{
	return setTimeout(()=>
	{
		if(isExternalMemoryCritical(singleton.totalExternalMemory))
		{
			Atomics.store(cleanerGCHintView, 0, 0);
			cleaner.postMessage({command: "trueExternalMemory"});
		}

		requestCleanerSyncV8ExternalTimeout = self.requestCleanerSyncV8External();
	}, 30000);
}

export const isExternalMemoryCritical = (totalExternalMemory)=>
{
	return (BigInt(gcPolicyThreshold) - totalExternalMemory) < maxArrayBufferSize / 5n;
}


/** @type {Worker} */
export let cleaner;
/** @param {Worker} value */
export const setCleaner = (value)=> cleaner = value;


/** @param {ResponseClean} message */
export const onCleaned = (message)=>
{
	const response = message.response;
	isCleanerBusy = false;

	let batchBuffers;
	let ttlTimeout;
	if(arrayBufferTTL >= 0)
	{
		batchBuffers = [];
		ttlTimeout = Date.now() + arrayBufferTTL;
	}

	for(let i = response.length; i--;)
	{
		const res = response[i];
		const internalStatus = internalCleaningStatuses.get(res.id);
		const byteLength = BigInt(internalStatus.byteLength);
		const expansion = internalStatus.expansion;
		cleaningMemory -= byteLength;
		reserveExpansionMemory -= expansion;
		const statuses = cleaningStatus.get(internalStatus);
		if(res.error)
		{
			internalStatus.state = "error";
			internalStatus.error = res.error;
			const length = statuses.length;
			for(let j = 0; j < length; j++) statuses[j].onError?.(res.error);
			if(internalStatus.onErrors)
			{
				const onErrors = internalStatus.onErrors;
				internalStatus.onErrors = null;
				internalStatus.onSettles = null;
				const length = onErrors.length;
				for(let j = 0; j <length; j++) onErrors[j](res.error);
			}
		}
		else
		{
			mainExternalMemory += byteLength + expansion;
			const buffer = res.buffer;
			let index = self.getPoolSlabIndex(buffer.byteLength);
			if(!pool[index]) pool[index] = new Set();
			pool[index].add(buffer);

			if(ttlTimeout)
			{
				ttlArrayBufferSet.add(buffer);
				batchBuffers.push({buffer, slabIndex: index});
			}

			internalStatus.state = "done";
			self.dispatchSettle(internalStatus);
		}
		internalCleaningStatuses.delete(res.id);
	}

	if(ttlTimeout)
	{
		if(batchBuffers.length)
		{
			let finalTimeout = ttlTimeout;
			while(ttlStatus.has(finalTimeout)) {
				finalTimeout++; // キーの重複を避けるための微調整
			}
			ttlStatus.set(finalTimeout, batchBuffers);
			if(!ttlTimeoutTicket) ttlTimeoutTicket = setTimeout(self.ttlCheck, arrayBufferTTL);
		}
	}

	if(cleanRequestQueue.size) {
		if (!isCleaningRequested) self.requestClean();
	} else {
		requestCleanerSyncV8ExternalTimeout = self.requestCleanerSyncV8External();
	}
}
let cleanerReadyResolve;
export const cleanerReady = new Promise(resolve=>cleanerReadyResolve = resolve);
export const onCleanerReady = (message)=>
{
	if(message === "ready")
	{
		isCleanerBusy = false;
		if(cleanRequestQueue.size) self.requestClean();

		cleaner.off("message", self.onCleanerReady);
		cleaner.on("message", self.onCleaned);
		cleanerReadyResolve();
	}
}

/** @type {Map<string, InternalCleaningStatus>} */
export const internalCleaningStatuses = new Map();

export let isCleaningRequested = false;
export const setIsCleaningRequested = (value)=> isCleaningRequested = value;

export const requestClean = ()=>
{
	const requests = [...cleanRequestQueue.values()];
	/** @type {RequestClean} */
	const message = {command: "clean", requests};
	Atomics.store(cleanerGCHintView, 0, 0);
	cleaner.postMessage(message, [...cleanRequestQueue.keys()]);
	isCleanerBusy = true;
	for(let i = requests.length; i--;)
	{
		const internalStatus = internalCleaningStatuses.get(requests[i].id);
		internalStatus.state = "cleaning";
		self.dispatchDetach(internalStatus);
		cleaningMemory += BigInt(internalStatus.byteLength);
		if(internalStatus.endpoint === "gc")
		{
			internalStatus.state = "done";
			self.dispatchSettle(internalStatus);
			internalCleaningStatuses.delete(internalStatus.id);
		}
	}
	cleanRequestQueue.clear();
	isCleaningRequested = false;
}

/** @param {InternalCleaningStatus} internalStatus */
export const dispatchDetach = (internalStatus)=>
{
	const statuses = cleaningStatus.get(internalStatus);
	const length = statuses.length;
	for(let j = 0; j < length; j++) statuses[j].onDetach?.();
	if(internalStatus?.onDetaches)
	{
		const onDetaches = internalStatus.onDetaches;
		internalStatus.onDetaches = null;
		const length = onDetaches.length;
		for(let j = 0; j < length; j++) onDetaches[j]();
	}
}

/** @param {InternalCleaningStatus} internalStatus */
export const dispatchSettle = (internalStatus)=>
{
	const statuses = cleaningStatus.get(internalStatus);
	const length = statuses.length;
	for (let j = 0; j < length; j++) statuses[j].onSettled?.();
	if(internalStatus?.onSettles)
	{
		const onSettles = internalStatus.onSettles;
		internalStatus.onSettles = null;
		internalStatus.onErrors = null;
		const length = onSettles.length;
		for(let j = 0; j < length; j++) onSettles[j]();
	}
}

/** @type {Set<ArrayBuffer>} */
export const ttlArrayBufferSet = new Set();

/** @type {Map<NodeJS.Timeout|number, Array<{buffer:ArrayBuffer, slabIndex:number}>>} */
export const ttlStatus = new Map();

/** @type {NodeJS.Timeout|number} */
export let ttlTimeoutTicket;

export const ttlCheck = ()=>
{
	const [timeout, first] = ttlStatus.entries().next().value;
	for(let i = first.length; i--;)
	{
		const {buffer, slabIndex} = first[i];
		if(ttlArrayBufferSet.delete(buffer))
		{
			pool[slabIndex].delete(buffer);
			singleton.free(buffer, "gc");
		}
	}

	ttlStatus.delete(timeout);

	if(ttlStatus.size)
	{
		const nextTimeout = ttlStatus.keys().next().value;
		const timeout = nextTimeout - Date.now();
		ttlTimeoutTicket = setTimeout(self.ttlCheck, timeout >= 0 ? timeout : 0);
	}
	else ttlTimeoutTicket = null;
}

/** @type {BigUint64Array} */
export let slabThresholds;

export const calculateSlabThresholds = () => {
	const thresholds = [];
	const factor = slabGrowthFactor > 1 ? slabGrowthFactor : DEFAULT_SLAB_GROWTH_FACTOR;
	const factorNum = BigInt(Math.round(factor * 1_000_000_000));
	let current = minArrayBufferSize;
	const max = maxArrayBufferSize;

	thresholds.push(current);
	while (current < max) {
		let next = (current * factorNum) / 1_000_000_000n;
		if(next <= current) next = current + 1n;

		if (next >= max) {
			thresholds.push(max);
			break;
		}
		thresholds.push(next);
		current = next;
	}
	MAX_POOL_CLASSES_LIMIT = thresholds.length;
	slabThresholds = new BigUint64Array(thresholds);
};

export const getPoolSlabIndex = (size) => {
	const s = BigInt(size);
	if (s < slabThresholds[1]) return 0;

	// 二分探索でインデックスを特定
	let low = 0;
	let high = slabThresholds.length - 1;

	while (low <= high) {
		const mid = (low + high) >>> 1;
		if (slabThresholds[mid] < s) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	low = slabThresholds[low] === s ? low : low - 1;
	// low が「size を収容できる最小のスラブインデックス」になる
	return low < maxPoolClasses ? low : maxPoolClasses - 1;
}

/**
 *
 * @param {number|bigint} size
 * @return {number}
 */
export const getSlabIndex = (size) => {
	const s = BigInt(size);
	if (s <= slabThresholds[0]) return 0;

	// 二分探索でインデックスを特定
	let low = 0;
	let high = slabThresholds.length - 1;

	while (low <= high) {
		const mid = (low + high) >>> 1;
		if (slabThresholds[mid] < s) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	// low が「size を収容できる最小のスラブインデックス」になる
	return low < maxPoolClasses ? low : maxPoolClasses - 1;
};

export const customPrepareStackTrace = (error, structuredStackTrace)=> {
	const lastCallSite = structuredStackTrace[1];
	return lastCallSite.getFileName();
}

export const extractPathFromStackFrame = ()=> {
	const original = Error.prepareStackTrace;
	Error.prepareStackTrace = self.customPrepareStackTrace;
	const obj = {};
	Error.captureStackTrace(obj, self.extractPathFromStackFrame);
	/** @type {string} */
	const message = obj.stack;
	Error.prepareStackTrace = original;
	return message;
}

export const permissionCheck = ()=>
{
	if(self.extractPathFromStackFrame().includes('/node_modules/'))
	{
		console.warn("依存ライブラリ内での NexusArrayBufferPool プーリングポリシーの設定変更は許可されていません。設定はアプリケーションのトップレベルなどで行ってください。この呼び出しによるプーリングポリシーの変更は無視されます。");
		return false;
	}
	return true;
}

/** @type {NexusArrayBufferPool} */
export let singleton;
/** @param {NexusArrayBufferPool} value */
export const setSingleton = (value)=> singleton = value;

export let cycleCount = 0;
/** @param {number} value */
export const setCycleCount = (value)=> cycleCount = value;

/** @type {Set<ArrayBuffer>[]} */
export const pool= [];

/** @type {NABPPolicy|null} */
export let policy;
/** @param {NABPPolicy|null} value */
export const setPolicy = (value)=> policy = value;
