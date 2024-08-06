const TimeLimitedFileCache = require('./index');
const path = require("node:path");
const logger = require("./log");

const dirName = path.join("r:", 'downloads');
const fileName = "test";
const filePath = path.join(dirName, fileName);

const memoryTTL = 100;
const fileTTL = 500;

const fileCache = TimeLimitedFileCache.fromDirectory(dirName, memoryTTL, fileTTL);

const decoder = new TextDecoder();

let count = 0;
const estimateLog = [];

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
	for(let i=0; i<length; i++)
	{
		if(estimateLog[i] !== fileCache.log[i])
		{
			console.log(i, ":\n予想のログ : ", estimateLog[i], "\n実際のログ : ", fileCache.log[i], "\n", fileCache.stacks[i]);
			count++;
		}
	}
	estimateLog.length = 0;
	fileCache.log.length = 0;
}

fileCache.debug = true;

console.log("=== file write テスト ====");
const promise = fileCache.write(fileName, str);
estimateLog.push(filePath + " : " + logger.WRITE_START);
estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
compareLog();
promise.then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();
	console.log("=== memory read テスト ====");
	const promise = fileCache.read("test");
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();
	return promise;
}).then(data=>
{
	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
	compareLog();

	console.log("=== file write -> memory read テスト ====");
	nextData();
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();
	fileCache.read(fileName).then(data=>
	{
		estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
		compareLog();
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});

	return promise
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== memory read -> file write テスト ====");

	fileCache.read(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + (+str - 1) + "");
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== memory read -> memory read テスト ====");
	fileCache.read(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();
	const promise = fileCache.read(fileName);
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(data=>
{
	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
	compareLog();

	console.log("=== file write -> file write テスト ====");

	nextData();
	fileCache.write(fileName, str).then(()=>
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
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	console.log("=== file write -> file write -> memory read テスト ====");

	nextData();
	fileCache.write(fileName, str).then(()=>
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
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	fileCache.read(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
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
	fileCache.write(fileName, str).then(()=>
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
	fileCache.write(fileName, str).then(()=>
	{
		console.log("※※※このログは write B の完了を通知するログですが、 write C の", str, "が書き込み終わったログでもあります。", writeB_str, "は、実際にはファイルには書き込まれていません");
		estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	nextData();
	console.log("  === write C ===", str);
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("※※※このログは write C の完了を通知するログです。 write B の完了もハンドルされていなければならないので、 write B のログも出ている事を確認してください");
	compareLog();

	console.log("=== remove memory テスト ====");
	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read テスト ====");
	const promise = fileCache.read(fileName);
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	return promise;
}).then(data=>
{
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
	estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);
	compareLog();

	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file write テスト ====");
	fileCache.read(fileName).then(data=>
	{
		// write メソッドによりメモリキャッシュの値が既に更新されているため、ファイルの内容を元にメモリキャッシュを更新する処理は走らないはず
		// estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
		estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_START);

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();
	nextData();
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file read テスト ====");
	console.log("  === read A ====");
	fileCache.read(fileName).then(data=>
	{
		console.log("read A 完了後の Promise.resolve, read B 完了後の Promise.resolve のログも出力されなければならない", data);
		estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
		estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	console.log("  === read B ====");
	const promise = fileCache.read(fileName);
	estimateLog.push(filePath + " : " + logger.READ_FROM_PROMISE);
	compareLog();

	return promise;
}).then(data=>
{
	console.log("read B 完了後の Promise.resolve, read A 完了後の Promise.resolve のログも出力されなければならない。read A も read B も同じ Promise インスタンスからの resolve なので、必ず同一データが引数から出力されるはず", data);
	estimateLog.push("受け取ったデータ : " + str);
	fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file read -> file write テスト ====");
	console.log("  === read A ====");
	fileCache.read(fileName).then(data=>
	{
		console.log("read A 完了後の Promise.resolve, read B 完了後の Promise.resolve のログも出力されなければならない", data);
		// estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
		estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_START);

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	console.log("  === read B ====");
	fileCache.read(fileName).then(data=>
	{
		console.log("read B 完了後の Promise.resolve, read A 完了後の Promise.resolve のログも出力されなければならない。read A も read B も同じ Promise インスタンスからの resolve なので、必ず同一データが引数から出力されるはず", data);
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_PROMISE);
	compareLog();

	nextData();
	console.log("  === write A ====");
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();
	return promise;
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.WRITE_COMPLETE_TO_FILE_SYSTEM);
	compareLog();

	return waitMemoryRemoved();
}).then(()=>
{
	estimateLog.push(filePath + " : " + logger.REMOVE_MEMORY_CACHE);
	compareLog();

	console.log("=== file read -> file write -> memory read テスト ====");
	console.log("  === read A ====");
	fileCache.read(fileName).then(data=>
	{
		console.log("read A 完了後の Promise.resolve, read B 完了後の Promise.resolve のログも出力されなければならない。read A はファイルシステムからの読み取り完了後なので read B より後に出力されるが、read B と同じ値が取得されるはず", data);
		// estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE);
		estimateLog.push(filePath + " : " + logger.READ_COMPLETE_FROM_FILE_SYSTEM + " " + str);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_START);

		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	nextData();
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	console.log("  === read B ====");
	fileCache.read(fileName).then(data=>
	{
		console.log("read B 完了後の Promise.resolve, read A 完了後の Promise.resolve のログも出力されなければならない。read B はメモリキャッシュからの読み取りなので read A よりも先に表示されるが、取得される値は同じはず", data);
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
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
	const promise = fileCache.read(fileName);
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
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_START);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	fileCache.read(fileName).then(data=>
	{
		estimateLog.push("受け取ったデータ : " + str);
		fileCache.log.push("受け取ったデータ : " + decoder.decode(data));
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
	fileCache.read(fileName).then(data=>
	{
		console.log("  === read A の完了 ==== data:", data);
		estimateLog.push(filePath + " : " + logger.READ_FROM_MEMORY_CACHE + " " + str);
		estimateLog.push(filePath + " : " + logger.WRITE_START_FROM_QUEUE_AFTER_READ);
		estimateLog.push(filePath + " : " + logger.WRITE_START);
		compareLog();
	});
	estimateLog.push(filePath + " : " + logger.READ_START_FROM_FILE_SYSTEM);
	compareLog();

	nextData();

	console.log("  === write A ====");
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();
	return promise;
}).then(()=>
{
	console.log("  === write A の完了 ====");
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
	fileCache.read(fileName).then(data=>
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
	const promise = fileCache.read(fileName);
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
	fileCache.write(fileName, str).then(()=>
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
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.FILE_ACCESS_ERROR_ON_WRITE + " " + str);
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
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("  === write A の完了 ====");
	compareLog();

	console.log("=== 同一データ書き込み. file write -> file write テスト ====");
	console.log("  === write A ====");
	fileCache.write(fileName, str).then(()=>
	{
		console.log("  === write A の完了 ====");
	});
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	console.log("  === write B ====");
	const promise = fileCache.write(fileName, str);
	estimateLog.push(filePath + " : " + logger.WRITE_SKIPPED_DATA_UNCHANGED);
	estimateLog.push(filePath + " : " + logger.UPDATED_MEMORY_CACHE + " " + str);
	compareLog();

	return promise;
}).then(()=>
{
	console.log("  === write B の完了 ====");
	compareLog();
	console.log("エラーカウント:", count);
});
compareLog();


