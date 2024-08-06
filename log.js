let getStack;

const customPrepareStackTrace = (error, structuredStackTrace)=>
{
	const lastCallSite = structuredStackTrace[1];
	const firstCallSite = structuredStackTrace[structuredStackTrace.length - 1];
	return  firstCallSite.getFileName() + " : " + firstCallSite.getLineNumber()
	+ " ･･･> " + lastCallSite.getFileName() + " : " + lastCallSite.getLineNumber();
}

getStack = ()=>
{
	const original = Error.prepareStackTrace;
	Error.prepareStackTrace = customPrepareStackTrace;
	const obj = {};
	Error.captureStackTrace(obj, getStack);
	const message = obj.stack;
	Error.prepareStackTrace = original;
	return message;
}

class Log
{
	/**
	 *
	 * @param {TimeLimitManager} manager
	 * @param {*} args
	 */
	static log(manager, ...args)
	{
		const message = manager.filePath + " : " + args.join(" ");
		manager.parent.log.push(message);
		const stack = getStack();
		manager.parent.stacks.push(stack);
		console.log(stack + " " + message);
	}

	static READ_FROM_PROMISE = "ファイルシステムから読み取り中です。Promise キャッシュを返します";

	static READ_FROM_MEMORY_CACHE = "メモリキャッシュに値があったのでそれを Promise に渡します";

	static READ_START_FROM_FILE_SYSTEM = "メモリキャッシュに値が無かったため、ファイルシステムから読み取りを開始します";

	static READ_COMPLETE_FROM_FILE_SYSTEM = "ファイルシステムからの読み取り処理が完了されました";

	static READ_QUEUE = "#この処理には来ないはずです# ファイルシステムに書き込み中のため、ファイルシステムからの読み取りを中断し、書き込み完了後に Promise 解決に値を渡します"

	static FILE_ACCESS_ERROR_ON_WRITE = "ファイルが読み取り中または書き込み中のため、データの書き込みはキューに入りました";

	static UPDATED_MEMORY_CACHE = "メモリキャッシュの値が更新されました";

	static RESOLVE_READ_QUEUE = "メモリキャッシュの更新に合わせて、読み取り中の Promise の解決に値が渡されました";

	static WRITE_START = "ファイルへの書き込みを開始します";

	static WRITE_START_FROM_QUEUE_AFTER_WRITE = "ファイルへの書き込みが終わったので、新しいデータをファイルへ書き込み開始します";

	static WRITE_START_FROM_QUEUE_AFTER_READ = "ファイルからの読み取りが終わったので、新しいデータをファイルへ書き込み開始します";

	static WRITE_COMPLETE_TO_FILE_SYSTEM = "ファイルへの書き込みが完了しました";

	static WRITE_SKIPPED_DATA_UNCHANGED = "書き込みしようとしたデータがファイルの内容と同一のため、ファイルシステムへの書き込みはされませんでした";

	static UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE = "ファイルから読み取ったデータでメモリキャッシュの値を更新しました";

	static REMOVE_MEMORY_CACHE = "最後のアクセスから memoryTTL に指定された時間が経過したため、メモリキャッシュを削除しました";

	static REMOVE_START_CACHE_FILE ="最後のアクセスから fileTTL に指定された時間が経過したため、キャッシュファイルの削除を開始します"

	static REMOVE_CACHE_FILE = "キャッシュファイルを削除しました";

	static NON_EXIST_CACHE = "メモリキャッシュもキャッシュファイルも存在しませんでした";
}

module.exports = Log;