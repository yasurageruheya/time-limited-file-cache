import {parentPort, workerData} from "worker_threads";
import v8 from "v8";
/** @type {BigUint64Array} */
const externalMemory = workerData.externalMemory;
/** @type {Uint8Array} */
const gcHintView = workerData.gcHintView;

externalMemory[0] = BigInt(v8.getHeapStatistics().external_memory);

const gcRegistry = new FinalizationRegistry(byteLength=>
{
	Atomics.store(gcHintView, 0, 1);
});

parentPort.on("message", /** @param {RequestClean|RequestTrueExternalMemory} message */(message) =>
{
	// externalMemory[0] = BigInt(v8.getHeapStatistics().external_memory);
	switch (message.command)
	{
		case "trueExternalMemory":
			externalMemory[0] = BigInt(v8.getHeapStatistics().external_memory);
			return;
		case "clean":
			const requests = message.requests;
			/** @type {ResponseCleanDetail[]} */
			const response = [];
			const returnBuffers = [];
			for(let i = requests.length; i--;)
			{
				const req = requests[i];
				const buffer = req.buffer;
				try {
					let bytesGap;
					if(buffer.maxByteLength !== undefined)
						bytesGap = buffer.maxByteLength - buffer.byteLength;

					if(req.returnToPool)
					{
						const view = new Uint8Array(buffer);
						view.fill(0);
						if(bytesGap)
						{
							// ここでは ResizableArrayBuffer の膨張分を把握メモリに加算せず、メインスレッド側で事前に膨張分を把握しておいてもらう
							// externalMemory[0] += BigInt(bytesGap);
							buffer.resize(buffer.maxByteLength);
						}

						response.push({id: req.id, buffer});
						returnBuffers.push(buffer);
					}
					else
					{
						if(bytesGap)
						{
							externalMemory[0] -= BigInt(buffer.byteLength);
							buffer.resize(0);
						}
						else gcRegistry.register(buffer, buffer.byteLength);
					}
				} catch (error) {
					//このブロックに入ってきた時は Out of Memory の可能性が高い
					try {
						if (buffer.maxByteLength !== undefined) {
							externalMemory[0] -= BigInt(buffer.byteLength);
							buffer.resize(0);
						}
					} catch (ignore) {
						// ここでのエラーは無視（既に壊れているか、resizable でない場合など）
					}
					response.push({id: req.id, error});
				}
			}
			parentPort.postMessage({response}, returnBuffers);
			externalMemory[0] = BigInt(v8.getHeapStatistics().external_memory);
			break;
	}
});

parentPort.postMessage("ready");