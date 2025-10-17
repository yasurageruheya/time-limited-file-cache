const TimeLimitedFileCache = require('./index');
const path = require("node:path");
/** @type {typeof Log} */
const logger = require("./log");

const dirName = path.join("r:", 'downloads');
const fileName = "test";
const filePath = path.join(dirName, fileName);

const memoryTTL = 600;
const fileTTL = 1100;

/** @type {TimeLimitedFileCache} */
let fileCache;

const data1A = Buffer.alloc(1, 'A');
const data16383A = Buffer.alloc(16383, 'A');
const data16383x2A = Buffer.concat([data16383A, data16383A]);
const data16384A = Buffer.alloc(16384, 'A');
const data1B = Buffer.alloc(1, 'B');
const data16383B = Buffer.alloc(16383, 'B');

/** @type {Object.<Buffer<ArrayBuffer>>} */
const buffers = {};

buffers.data1A = data1A;
buffers.data16383A = data16383A;
buffers.data16384A = data16384A;
buffers.data1B = data1B;
buffers.data16383B = data16383B;

/**
 *
 * @param buffer
 * @return {string}
 */
const checkBinary = buffer =>
{
	for(const key in buffers)
	{
		if(buffers[key].equals(buffer))
		{
			return key;
		}
	}
	return "undefined";
};

let count = 0;
const estimateLog = [];

const oldValues = [];

let str = "1";

const nextData = ()=>
{
	str = (+str+1)+"";
}

const waitMemoryRemoved = ()=>
{
	return new Promise(resolve =>
	{
		setTimeout(resolve, memoryTTL + 10);
	})
}

const estimateWriteCompleteSuccessfully = (result)=>
{
	estimateLog.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY が入っていました");
	if(result === TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY)
		fileCache.log.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY が入っていました");
	else
		fileCache.log.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.COMPLETED_SUCCESSFULLY が入っていませんでした");
}

const estimateWriteCanceledByNewerRequest = result =>
{
	estimateLog.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST が入っていました");
	if(result === TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST)
		fileCache.log.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST が入っていました");
	else
		fileCache.log.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.CANCELED_BY_NEWER_REQUEST が入っていませんでした");
}

const estimateWriteSkippedSameAsMemoryCache = result =>
{
	estimateLog.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE が入っていました");
	if(result === TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE)
		fileCache.log.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE が入っていました");
	else
		fileCache.log.push("then の引数に TimeLimitedFileCache.WRITE_RESULT.SKIPPED_SAME_AS_MEMORY_CACHE が入っていませんでした");
}

const waitFileRemoved = ()=>
{
	return new Promise(resolve =>
	{
		setTimeout(resolve, fileTTL + 100);
	});
}

const compareLog = ()=>
{
	const length = estimateLog.length >= fileCache.log.length ? estimateLog.length : fileCache.log.length;
	let errorCount = 0;
	for(let i=0; i<length; i++)
	{
		if(estimateLog[i] !== fileCache.log[i])
		{
			console.log(i, ":\n予想のログ : ", estimateLog[i], "\n実際のログ : ", fileCache.log[i], "\n", fileCache.stacks[i]);
			errorCount++;
		}
	}
	count += errorCount;
	const a = errorCount ? "*!*" : "***";
	console[errorCount ? "error" : "log"](`${a} ログチェック後のエラー数：${errorCount} ${a} ${logger.getStack()}`);
	estimateLog.length = 0;
	fileCache.log.length = 0;
}

TimeLimitedFileCache.fromDirectory(dirName, false, memoryTTL, fileTTL).then(timeLimitedFileCache=>
{
	fileCache = timeLimitedFileCache;
	fileCache.debug = true;

	console.log("=== file write テスト ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();
	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();
	console.log("=== memory read テスト ====");
	const promise = fileCache.readAsBuffer("test");
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();
	return promise;
}).then(data=>
{
	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
	compareLog();

	console.log("=== file write -> memory read テスト ====");
	nextData();
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();
	fileCache.readAsBuffer(fileName).then(data=>
	{
		estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
		compareLog();
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});

	return promise
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== memory read -> file write テスト ====");

	fileCache.readAsBuffer(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + (+str - 1) + "");
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== memory read -> memory read テスト ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();
	const promise = fileCache.readAsBuffer(fileName);
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(data=>
{
	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
	compareLog();

	console.log("=== file write -> file write テスト ====");

	nextData();
	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_WRITING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== file write -> file write -> memory read テスト ====");

	nextData();
	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_WRITING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	fileCache.readAsBuffer(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== file write -> file write -> file write テスト ====");

	nextData();
	console.log("  === write A ===", str);
	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	const writeB_str = str;
	console.log("  === write B ===", str);
	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		console.log("※※※このログは write B の完了を通知するログですが、 write C の", str, "が書き込み終わったログでもあります。", writeB_str, "は、実際にはファイルには書き込まれていません");
	});
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_WRITING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	console.log("  === write C ===", str);
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_WRITING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("※※※このログは write C の完了を通知するログです。 write B の完了もハンドルされていなければならないので、 write B のログも出ている事を確認してください");
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== remove memory テスト ====");
	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read テスト ====");
	const promise = fileCache.readAsBuffer(fileName);
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	return promise;
}).then(data=>
{
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
	compareLog();

	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file write テスト ====");
	oldValues[0] = str;
	fileCache.readAsBuffer(fileName).then(data=>
	{
		// writeAsBuffer メソッドによりメモリキャッシュの値が既に更新されているため、
		// ファイルの内容を元にメモリキャッシュを更新する処理は走らないし、
		// writeAsBuffer 直後に readAsBuffer の Promise は解決されているので、
		// このタイミングで logger 定数メッセージのログは出ないはず
		estimateLog.push("受け取ったデータ：" + str);
		fileCache.log.push("受け取ったデータ：" + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();
	nextData();
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_READING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	estimateLog.push(filePath + " : " + logger.RESOLVE_READ_QUEUE);
	compareLog();

	return promise;
}).then(()=>
{
	// readAsBuffer の Promise 解決はファイルの読み取り完了前に終わっているはずなので、
	// ここにファイル読み取り完了後のログが来るはず
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + oldValues[0]);
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file read テスト ====");
	console.log("  === read A ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("read A 完了後の Promise.resolve, read B 完了後の Promise.resolve のログも出力されなければならない", data);
		estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	console.log("  === read B ====");
	const promise = fileCache.readAsBuffer(fileName);
	estimateLog.push(filePath + " : " + logger.READ_FROM_PROMISE);
	compareLog();

	return promise;
}).then(data=>
{
	console.log("read B 完了後の Promise.resolve, read A 完了後の Promise.resolve のログも出力されなければならない。read A も read B も同じ Promise インスタンスからの resolve なので、必ず同一データが引数から出力されるはず", data);
	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file read -> file write テスト ====");
	console.log("  === read A ====");
	oldValues[0] = str;
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("read A 完了後の Promise.resolve, read B 完了後の Promise.resolve のログも出力されなければならない", data);
		// estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	console.log("  === read B ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("read B 完了後の Promise.resolve, read A 完了後の Promise.resolve のログも出力されなければならない。read A も read B も同じ Promise インスタンスからの resolve なので、必ず同一データが引数から出力されるはず", data);
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_PROMISE);
	compareLog();

	nextData();
	console.log("  === write A ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_READING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	estimateLog.push(filePath + " : " + logger.RESOLVE_READ_QUEUE);
	compareLog();
	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + oldValues[0]);
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	oldValues[0] = str;
	console.log("=== file read -> file write -> memory read テスト ====");
	console.log("  === read A ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("read A 完了後の Promise.resolve, read B 完了後の Promise.resolve のログも出力されなければならない。read A はファイルシステムからの読み取り完了後なので read B より後に出力されるが、read B と同じ値が取得されるはず", logger.outputDataForLog(data));

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	nextData();
	console.log("  === write ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_READING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	estimateLog.push(filePath + " : " + logger.RESOLVE_READ_QUEUE);
	compareLog();

	console.log("  === read B ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("read B 完了後の Promise.resolve, read A 完了後の Promise.resolve のログも出力されなければならない。read B はメモリキャッシュからの読み取りなので read A よりも先に表示されるが、取得される値は同じはず", logger.outputDataForLog(data));
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + oldValues[0]);
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== remove file テスト ====");

	return waitFileRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	estimateLog.push(filePath + " : " + logger.REMOVE_START_CACHE_FILE);
	estimateLog.push(filePath + " : " + logger.REMOVE_CACHE_FILE);
	compareLog();

	console.log("=== file read テスト ====");
	const promise = fileCache.readAsBuffer(fileName);
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();
	return promise;
}).then(data=>
{
	estimateLog.push(filePath + " : " + logger.NON_EXIST_CACHE);
	compareLog();

	estimateLog.push("受け取ったデータ : " + undefined);
	fileCache.log.push("受け取ったデータ : " + data);
	compareLog();

	console.log("=== キャッシュファイル無. file write -> memory read テスト ====");
	nextData();
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	fileCache.readAsBuffer(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();
	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	return waitFileRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	estimateLog.push(filePath + " : " + logger.REMOVE_START_CACHE_FILE);
	estimateLog.push(filePath + " : " + logger.REMOVE_CACHE_FILE);
	compareLog();

	console.log("=== キャッシュファイル無. file read -> file write テスト ====");

	console.log("  === read A ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("  === read A の完了 ==== data:", data);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	nextData();

	console.log("  === write A ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_READING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	estimateLog.push(filePath + " : " + logger.RESOLVE_READ_QUEUE);
	compareLog();
	return promise;
}).then(()=>
{
	console.log("  === write A の完了 ====");
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ + " " + str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	return waitFileRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	estimateLog.push(filePath + " : " + logger.REMOVE_START_CACHE_FILE);
	estimateLog.push(filePath + " : " + logger.REMOVE_CACHE_FILE);
	compareLog();

	console.log("=== キャッシュファイル無. file read -> file read テスト ====");
	console.log("  === read A ====");
	fileCache.readAsBuffer(fileName).then(data=>
	{
		console.log("  === read A の完了 ====");
		estimateLog.push(filePath + " : " + logger.NON_EXIST_CACHE);
		compareLog();

		estimateLog.push("受け取ったデータ : " + undefined);
		fileCache.log.push("受け取ったデータ : " + data);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	console.log("  === read B ====");
	const promise = fileCache.readAsBuffer(fileName);
	estimateLog.push(filePath + " : " + logger.READ_FROM_PROMISE);
	return promise;
}).then(data=>
{
	console.log("  === read B の完了 ====");
	estimateLog.push("受け取ったデータ : " + undefined);
	fileCache.log.push("受け取ったデータ : " + data);
	compareLog();

	console.log("=== キャッシュファイル無. file write -> file write テスト ====");
	nextData();
	console.log("  === write A ====");
	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		console.log("  === write A の完了 ====");
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	console.log("  === write B ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_WRITING + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("  === write B の完了 ====");
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== 同一データ書き込み. file write テスト ====");
	console.log("  === write A ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("  === write A の完了 ====");
	compareLog();

	console.log("=== 同一データ書き込み. file write -> file write テスト ====");
	console.log("  === write A ====");
	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		console.log("  === write A の完了 ====");
	});
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);
	compareLog();

	console.log("  === write B ====");
	const promise = fileCache.writeAsBuffer(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("  === write B の完了 ====");
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,383 バイト テスト ====");
	return fileCache.writeAsStream(fileName, 16384);
}).then((writeStreamAgent)=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	return writeStreamAgent.write(data16383A);
}).then(writeStreamAgent=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	compareLog();

	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,384 バイト テスト ====");
	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	return writeStreamAgent.write(data16384A);
}).then(writeStreamAgent=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_DRAINED);
	compareLog();

	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,383 * 2 / 16,384 バイト テスト ====");
	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	writeStreamAgent.write(data16383A).then(()=>
	{
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	compareLog();

	const promise = writeStreamAgent.write(data16383A);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
	compareLog();

	return promise;
}).then(writeStreamAgent=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_DRAINED);
	compareLog();

	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,383/16,384 バイト => read stream(waitForClose:true) テスト ====");

	const writePromise = fileCache.writeAsStream(fileName, 16384);

	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	writePromise.then(writeStreamAgent =>
	{
		compareLog();

		return writeStreamAgent.write(data16383A);
	}).then(writeStreamAgent=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		compareLog();

		return writeStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);

		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	const readPromise = fileCache.readAsStream(fileName, 16384);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
	compareLog();

	return readPromise;

}).then(readStreamAgent =>
{
	compareLog();

	readStreamAgent.once("data", data=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16383A));
		compareLog();
	});

	return readStreamAgent.end({waitForClose: true});

}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== read stream(waitForClose:true) => write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.readAsStream(fileName).then(readStreamAgent=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data16383A));
			compareLog();
		});

		return readStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	return fileCache.writeAsStream(fileName);
}).then(writeStreamAgent =>
{
	compareLog();
	return writeStreamAgent.write(data16383A);
}).then(writeStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	compareLog();

	return writeStreamAgent.end({waitForClose: true});
}).then(() =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,384/16,383 バイト => read stream(waitForClose:true) 16,384/16,383 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16383).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		compareLog();

		return writeStreamAgent.write(data16384A);
	}).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_DRAINED);
		compareLog();

		return writeStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);

		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	return fileCache.readAsStream(fileName, 16383);
}).then(readStreamAgent =>
{
	compareLog();

	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16383A));
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data1A));
			compareLog();
		})
	});

	return readStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== read stream(waitForClose:false) 16,384/16,384 バイト => read stream(waitForClose:true) 16,384/16,383 バイト テスト ====");

	return fileCache.readAsStream(fileName, 16384);
}).then(readStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
	compareLog();

	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16384A));
		compareLog();
	});

	return readStreamAgent.end();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	compareLog();

	return fileCache.readAsStream(fileName, 16383);
}).then(readStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
	compareLog();

	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16383A));
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data1A));
			compareLog();
		});
	});

	return readStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== read stream(waitForClose:false) 16,384/16,384 バイト, read stream(waitForClose:true) 16,384/16,383 バイト テスト ====");

	const readPromise = fileCache.readAsStream(fileName, 16383);
	compareLog();

	readPromise.then(readStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data16383A));
			compareLog();

			readStreamAgent.once("data", data =>
			{
				estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
				fileCache.log.push("バイナリ : " + checkBinary(data));
				estimateLog.push("バイナリ : " + checkBinary(data1A));
				compareLog();
			});
		});

		return readStreamAgent.end();
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		// estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		compareLog();
	});

	return fileCache.readAsStream(fileName, 16384);
}).then(readStreamAgent =>
{
	// ↓ 先に readAsStream() した方の then で2回 READ_STREAM_READY が出るので、ここでは出ない
	// estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
	compareLog();

	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16384A));
		compareLog();
	});

	return readStreamAgent.end({waitForClose: true});
}).then(()=>
{
	// ↓ 先に readAsStream().end した方の then で2回 READ_STREAM_COMPLETE が出るので、ここでは出ない
	// estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	// ↓ これは2回目の waitForClose:true の READ_STREAM_CLOSED
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:false) 16,383/16,384 バイト => read stream(waitForClose:true) 16,384/16,383 バイト テスト ====");

	const writePromise = fileCache.writeAsStream(fileName, 16384);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	writePromise.then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		compareLog();

		return writeStreamAgent.write(data16383A);
	}).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		// estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		compareLog();

		return writeStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	return fileCache.readAsStream(fileName, 16384);
}).then(readStreamAgent =>
{
	// ↓ これは書き込みストリームの end().then の方のタイミングで出る
	// estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
	compareLog();

	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16383A));
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data1A));
			compareLog();
		})
	});

	return readStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:false) 16,383/16,384 バイト, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		compareLog();

		return writeStreamAgent.write(data16383A);
	}).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		compareLog();

		return writeStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent =>
{
	// ↓ これは 1 回目の writeAsStream().end().then のタイミングで出る
	// estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	return writeStreamAgent.write(data16383A);
}).then(writeStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	compareLog();

	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,384/16,383 バイト, write stream(waitForClose:true) 16,384/16,383 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16383).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		compareLog();

		return writeStreamAgent.write(data16384A);
	}).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_DRAINED);
		compareLog();

		return writeStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16383);
}).then(writeStreamAgent =>
{
	// ↓ これは 1 回目の writeStream().end().then のタイミングで出る
	// estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();

	return writeStreamAgent.write(data16384A);
}).then(writeStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_DRAINED);
	compareLog();

	return writeStreamAgent.end({waitForClose: true});
}).then(() =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:false) 16,383 * 2 / 16,384 バイト, write stream(waitForClose:true) 16,383 * 2 / 16,384 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent =>
{
	compareLog();

	writeStreamAgent.write(data16383A).then();
	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:false) 16,383 * 2 / 16,384 バイト, read stream(waitForClose:false) 16,383*2/16,383 バイト, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	fileCache.readAsStream(fileName, 16383).then(readStreamAgent =>
	{
		compareLog();
		readStreamAgent.once("data", data=>
		{
			estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data16383A));
			compareLog();

			readStreamAgent.once("data", data =>
			{
				estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
				fileCache.log.push("バイナリ : " + checkBinary(data));
				estimateLog.push("バイナリ : " + checkBinary(data16383A));
				compareLog();
			});
		});

		return readStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent =>
{
	compareLog();

	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: false});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	compareLog();

	console.log("=== write stream(waitForClose:false) 16,383 * 2 / 16,384 バイト, write stream(waitForClose:false) 16,383/16,384 バイト, read stream(waitForClose:true) 16,383*2/16,383 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		// ここで捕捉されるログは 2 回目の writeAsStream のログ
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		compareLog();
	});

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		// ここで捕捉されるログは 1 回目の writeAsStream のログ
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		// ここで捕捉されるのは readAsStream のログ
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	return fileCache.readAsStream(fileName, 16383);
}).then(readStreamAgent =>
{
	compareLog();

	readStreamAgent.once("data", data=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16383A));
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data16383A));
			compareLog();
		});
	});

	return readStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,383 * 2 / 16,384 バイト, write stream(waitForClose:true) 16,383/16,384 バイト, read stream(waitForClose:true) 16,383/16,383 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: true});
	}).then(() =>
	{
		// waitForClose: true でも 2 回目の writeAsStream のログはここに来ちゃう。でも処理順はきちんとしてる
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		compareLog();
	});

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		// waitForClose: true でも 1 回目の writeAsStream のログはここに来ちゃう。でも処理順はきちんとしてる
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUED_DUE_TO_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: true});
	}).then(() =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	return fileCache.readAsStream(fileName, 16383);
}).then(readStreamAgent =>
{
	compareLog();

	readStreamAgent.once("data", data=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + checkBinary(data));
		estimateLog.push("バイナリ : " + checkBinary(data16383A));
		compareLog();
	});

	return readStreamAgent.end({waitForClose: true});
}).then(() =>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	console.log("=== read stream(waitForClose:true) 16,383/16,383 バイト, write stream() ←スキップされるはず, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.readAsStream(fileName, 16383).then(readStreamAgent =>
	{
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data16383A));
			compareLog();
		});

		return readStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	fileCache.writeAsStream(fileName, 16384).then(result =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);

		estimateWriteCanceledByNewerRequest(result);

		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16834);
}).then(writeStreamAgent =>
{
	compareLog();
	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== read stream(waitForClose:false) 16,383/16,383 バイト, write stream() ←スキップされるはず, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.readAsStream(fileName, 16383).then(readStreamAgent =>
	{
		compareLog();

		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + checkBinary(data));
			estimateLog.push("バイナリ : " + checkBinary(data16383A));
			compareLog();
		});

		return readStreamAgent.end({waitForClose: false});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	fileCache.writeAsStream(fileName, 16384).then(result =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);

		estimateWriteCanceledByNewerRequest(result);

		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent =>
{
	compareLog();

	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,383*2/16,384 バイト, write stream() ←スキップされるはず, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.writeAsStream(fileName, 16384).then(writeStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		compareLog();

		writeStreamAgent.write(data16383A).then();
		writeStreamAgent.write(data16383A).then();
		return writeStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	fileCache.writeAsStream(fileName, 16384).then(result =>
	{
		// waitForClose: true でも 1 回目の writeAsStream のログはここに来ちゃう。でも処理順はきちんとしてる
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_BUFFER_FULL);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);

		estimateWriteCanceledByNewerRequest(result);

		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent =>
{
	compareLog();
	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== write stream(waitForClose:true) 16,383*2/16,384*2 バイト ※内部バッファが満杯にならない（'drain' イベントは発生しない）はず ====");

	return fileCache.writeAsStream(fileName, 16384 * 2);
}).then(writeStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);

	writeStreamAgent.write(data16383A).then();
	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== file read, write stream() ←スキップされるはず, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.readAsBuffer(fileName).then(() =>
	{
		estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + logger.outputDataForLog(data16383x2A));
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);

		compareLog();
	});
	
	fileCache.writeAsStream(fileName, 16384).then(result =>
	{
		// readAsBuffer 完了前に書き込みキャンセルが発生するため、ここに読み取り開始のログが来る
		estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_READING);

		estimateWriteCanceledByNewerRequest(result);

		compareLog();
	});
	
	return fileCache.writeAsStream(fileName, 16384);
}).then(writeStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
	compareLog();
	
	writeStreamAgent.write(data16383A).then();
	return writeStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== file write, write stream(waitForClose:true) 16,383/16,384 バイト テスト ====");

	fileCache.writeAsBuffer(fileName, str).then(()=>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_READY);
		compareLog();
	});

	return fileCache.writeAsStream(fileName, 16384);

}).then(writeFileAgent =>
{
	compareLog();

	writeFileAgent.write(data16383A).then();
	return writeFileAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_WRITE_BEGIN);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CHUNK_ACCEPTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_FINISH_REQUESTED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_ALL_DATA_COMPLETED);
	estimateLog.push(filePath + " : " + logger.WRITE_STREAM_CLOSED);
	compareLog();

	console.log("=== file write, write stream() ←スキップされるはず, 同一値 file write ←スキップされるはず テスト ====");

	nextData();

	const writePromise = fileCache.writeAsBuffer(fileName, str);

	fileCache.writeAsStream(fileName, 16384).then(result =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);

		estimateWriteCanceledByNewerRequest(result);

		compareLog();
	});

	fileCache.writeAsBuffer(fileName, str).then(result =>
	{
		estimateWriteSkippedSameAsMemoryCache(result);

		compareLog();
	});

	return writePromise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== memory read, read stream(waitForClose:false), memory read テスト ====");

	fileCache.readAsBuffer(fileName).then(data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
		estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});

	const readPromise = fileCache.readAsStream(fileName, 16384);

	fileCache.readAsBuffer(fileName).then(data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + logger.outputDataForLog(data));
		compareLog();
	});

	return readPromise;
}).then(readStreamAgent =>
{
	compareLog();
	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + logger.outputDataForLog(data));
		estimateLog.push("バイナリ : " + str);
		compareLog();
	});

	return readStreamAgent.end({waitForClose: false});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	compareLog();

	return waitFileRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	estimateLog.push(filePath + " : " + logger.REMOVE_START_CACHE_FILE);
	estimateLog.push(filePath + " : " + logger.REMOVE_CACHE_FILE);
	compareLog();

	console.log("=== file write, write stream() ←スキップされるはず, file write テスト ====");
	nextData();

	fileCache.writeAsBuffer(fileName, str).then(result =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		estimateWriteCompleteSuccessfully(result);

		compareLog();
	});

	fileCache.writeAsStream(fileName, 16834).then(result =>
	{
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + (+str - 1));
		estimateLog.push(filePath + " : " + logger.WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING);
		estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DUE_TO_NEW_WRITE);
		estimateLog.push(filePath + " : " + logger.WRITE_QUEUED_DUE_TO_WRITING + " " + str);
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
		estimateWriteCanceledByNewerRequest(result);

		compareLog();
	});

	nextData();
	return fileCache.writeAsBuffer(fileName, str);
}).then(result =>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);

	estimateWriteCompleteSuccessfully(result);

	compareLog();

	console.log("=== read stream(waitForClose: true) * 5 テスト ====");

	fileCache.readAsStream(fileName, 16384).then(readStreamAgent =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_QUEUE_DUE_TO_FILE_READ_LIMIT);
		let i = 4;
		while(i--)
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		}
		compareLog();
		readStreamAgent.once("data", data =>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
			fileCache.log.push("バイナリ : " + logger.outputDataForLog(data));
			estimateLog.push("バイナリ : " + str);
			compareLog();
		});
		return readStreamAgent.end({waitForClose: true});
	}).then(()=>
	{
		let i = 4;
		while (i--)
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
		}
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
		estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
		compareLog();
	});

	let i = 3;
	while(i--)
	{
		fileCache.readAsStream(fileName, 16384).then(readStreamAgent =>
		{
			compareLog();
			readStreamAgent.once("data", data =>
			{
				estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
				fileCache.log.push("バイナリ : " + logger.outputDataForLog(data));
				estimateLog.push("バイナリ : " + str);
				compareLog();
			});
			return readStreamAgent.end({waitForClose: true});
		}).then(()=>
		{
			estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
			compareLog();
		});
	}

	return fileCache.readAsStream(fileName, 16384);
}).then(readStreamAgent =>
{
	readStreamAgent.once("data", data =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_CHUNK_READ);
		fileCache.log.push("バイナリ : " + logger.outputDataForLog(data));
		estimateLog.push("バイナリ : " + str);
		compareLog();
	});
	return readStreamAgent.end({waitForClose: true});
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_COMPLETE);
	estimateLog.push(filePath + " : " + logger.READ_STREAM_CLOSED);
	compareLog();

	return waitFileRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	estimateLog.push(filePath + " : " + logger.REMOVE_START_CACHE_FILE);
	estimateLog.push(filePath + " : " + logger.REMOVE_CACHE_FILE);
	compareLog();

	console.log("=== 存在しないファイルに対して read stream(waitForClose: true) テスト ====");

	return fileCache.readAsStream(fileName, 16384);
}).then(readStreamAgent =>
{
	estimateLog.push(filePath + " : " + logger.READ_STREAM_READY);
	compareLog();
	readStreamAgent.once("error", error =>
	{
		estimateLog.push(filePath + " : " + logger.READ_STREAM_ERROR + " " + error);
		compareLog();
	})

	console.log("エラーカウント:", count);
}).catch(result =>
{
	console.log("!!!!", result);
});
// compareLog();


