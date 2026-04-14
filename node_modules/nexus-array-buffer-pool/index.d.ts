import {internalCleaningStatuses} from "./internals";


export interface RequestAllocDetail
{
	id: string;
	byteLength: bigint;
	maxByteLength?: bigint;
}

export interface RequestAlloc
{
	requests: RequestAllocDetail[];
}

export interface QueuedRequestAlloc
{
	request: RequestAllocDetail;
	ViewClass: { new(...args: any[]): any } | typeof ArrayBuffer;
	resolve: (buffer: ArrayBuffer) => void;
	reject: (error: Error) => void;
}

export interface ResponseAllocDetail
{
	id: string;
	buffer: ArrayBuffer;
	error?: Error;
	byteLength: bigint;
}

export interface ResponseAlloc
{
	response: ResponseAllocDetail[];
}

export interface RequestCleanDetail
{
	id: string;
	buffer: ArrayBuffer;
	returnToPool?: boolean;
}

export interface RequestClean
{
	command: "clean";
	requests: RequestCleanDetail[];
}

export interface ResponseClean
{
	response: ResponseCleanDetail[];
}

export interface ResponseCleanDetail
{
	id: string;
	buffer: ArrayBuffer;
	error?: Error;
}

export class CleaningStatus
{
	get id(): string;
	get endpoint(): "gc"|"pool"|"void";
	get state(): "queued"|"cleaning"|"done"|"error";
	get byteLength(): number;
	onDetach?: () => void;
	onSettled?: () => void;
	onError?: (error: Error) => void;
	get error():Error|null;
	get detached():DetachWatcher;
}

export class DetachWatcher
{
	then:(resolve:()=>void, reject?:((error:Error)=>void))=>DetachWatcher;
	get done():SettledWatcher;
}

export class SettledWatcher
{
	then:(resolve:()=>void, reject?:((error:Error)=>void))=>SettledWatcher;
}

export interface RequestTrueExternalMemory
{
	command: "trueExternalMemory";
}

export interface FinalNABPPolicy
{
	readonly minArrayBufferSize: bigint;
	readonly slabGrowthFactor: number;
	readonly maxArrayBufferSize: bigint;
	readonly maxPoolClasses: number;
	readonly gcPolicyThreshold: bigint;
	readonly arrayBufferTTL: number;
}

export interface NABPPolicy
{
	minArrayBufferSize:number|bigint;
	slabGrowthFactor:number;
	maxArrayBufferSize:number|bigint;
	maxPoolClasses:number;
	gcPolicyThreshold:number|bigint;
	arrayBufferTTL:number;
}

export class NexusArrayBufferPool
{
	static get policy(): NABPPolicy|null;
	get policy():FinalNABPPolicy;
	get totalExternalMemory():bigint;
	free(arrayBuffer: ArrayBuffer): CleaningStatus;
	acquire(byteLength: number|bigint): Promise<ArrayBuffer>;
	acquire(byteLength: number|bigint, ViewClass:typeof Buffer, maxByteLength?: number|bigint): Promise<Buffer>;
	acquire<T extends new (buffer: ArrayBuffer, byteOffset: number, byteLength: number) => any>(byteLength: number|bigint, ViewClass:T, maxByteLength?: number|bigint): Promise<InstanceType<T>>;
	constructor()
}