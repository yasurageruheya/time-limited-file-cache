import {parentPort, workerData} from "worker_threads";
import v8 from "v8";
/** @type {BigUint64Array} */
const externalMemory = workerData.externalMemory;

externalMemory[0] = BigInt(v8.getHeapStatistics().external_memory);

parentPort.on("message", /** @param {RequestAlloc} message */message =>
{
	const buffers = [];
	/** @type {RequestAllocDetail[]} */
	const requests = message.requests;
	/** @type {ResponseAllocDetail[]} */
	const response = [];

	for(let i = requests.length; i--;)
	{
		/** @type {RequestAllocDetail} */
		const request = requests[i];
		const {id, byteLength, maxByteLength} = request;
		let buffer;
		try
		{
			if(maxByteLength)
				buffer = new ArrayBuffer(byteLength, {maxByteLength});
			else
				buffer = new ArrayBuffer(byteLength);

			buffers.push(buffer);
			response.push({id, buffer, byteLength: BigInt(byteLength)});
		}
		catch (error)
		{
			response.push({id, error, byteLength: BigInt(byteLength)});
		}
	}

	parentPort.postMessage({response}, buffers);
	externalMemory[0] = BigInt(v8.getHeapStatistics().external_memory);
});

parentPort.postMessage("ready");