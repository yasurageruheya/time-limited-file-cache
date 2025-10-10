/** @type {TextDecoder} */
const decoder = new TextDecoder();

const customPrepareStackTrace = (error, structuredStackTrace)=>
{
	const lastCallSite = structuredStackTrace[1];
	return lastCallSite.getFileName() + " : " + lastCallSite.getLineNumber();
}

class Log
{
	static getStack = ()=>
	{
		const original = Error.prepareStackTrace;
		Error.prepareStackTrace = customPrepareStackTrace;
		const obj = {};
		Error.captureStackTrace(obj, Log.getStack);
		const message = obj.stack;
		Error.prepareStackTrace = original;
		return message;
	}

	/**
	 *
	 * @param {TimeLimitManager|{filePath:string}} manager
	 * @param {*} args
	 */
	static log(manager, ...args)
	{
		const message = manager.filePath + " : " + args.join(" ");
		manager.parent.log.push(message);
		const stack = Log.getStack();
		manager.parent.stacks.push(stack);
		console.log(stack + " " + message);
	}

	/**
	 *
	 * @param {Buffer} buffer
	 * @return {string}
	 */
	static outputDataForLog(buffer)
	{
		if(buffer.byteLength <= 8) return decoder.decode(buffer);
		return decoder.decode(buffer.subarray(0, 8)) + "... bytes: " + buffer.byteLength;
	}

	/** ファイルシステムから読み取り中です。Promise キャッシュを返します */
	static READ_FROM_PROMISE = "ファイルシステムから読み取り中です。Promise キャッシュを返します";

	/** メモリキャッシュに値があったのでそれを Promise に渡します */
	static READ_FROM_MEMORY_CACHE = "メモリキャッシュに値があったのでそれを Promise に渡します";

	/** ファイル読み取りでエラーが発生しました。 */
	static READ_BUFFER_ERROR = "ファイル読み取りでエラーが発生しました。";

	/** メモリキャッシュに値が無かったため、ファイルシステムから読み取りを開始します */
	static READ_START_FROM_FILE_SYSTEM = "メモリキャッシュに値が無かったため、ファイルシステムから読み取りを開始します";

	/** ファイルシステムからの読み取り処理が完了しました */
	static READ_COMPLETE_FROM_FILE_SYSTEM = "ファイルシステムからの読み取り処理が完了しました";

	/** ファイルからの読み取りが完了しましたが、読み取り完了までの間にメモリキャッシュが更新されていたため、メモリキャッシュの値を返します */
	static READ_COMPLETE_FROM_FILE_SYSTEM_BUT_MEMORY_CACHE_UPDATED = "ファイルからの読み取りが完了しましたが、読み取り完了までの間にメモリキャッシュが更新されていたため、メモリキャッシュの値を返します";

	/** 読み取ろうとしたファイルがストリームによる書き込み中のため、ファイルシステムからの読み取りを待機し、書き込み完了後に読み取りを開始します */
	static READ_QUEUE = "読み取ろうとしたファイルがストリームによる書き込み中のため、ファイルシステムからの読み取りを待機し、書き込み完了後に読み取りを開始します";

	/** ストリームによる書き込みが完了したため、ファイルシステムからの読み取りを開始します */
	static READ_START_DUE_TO_WRITE_STREAM_COMPLETE = "ストリームによる書き込みが完了したため、ファイルシステムからの読み取りを開始します";

	/** ストリームによる書き込み完了後に、メモリキャッシュが更新されたため、ファイルシステムからの読み取りをスキップし、メモリキャッシュの値を返します */
	static READ_SKIPPED_DUE_TO_MEMORY_CACHE_UPDATE_AFTER_STREAM_WRITE = "ストリームによる書き込み完了後に、メモリキャッシュが更新されたため、ファイルシステムからの読み取りをスキップし、メモリキャッシュの値を返します";

	/** ファイルディスクリプタの全体の上限に達したため、ファイル読み取りはキューに入りました */
	static READ_QUEUE_DUE_TO_GLOBAL_READ_LIMIT = "ファイルディスクリプタの全体の上限に達したため、ファイル読み取りはキューに入りました";

	/** 1ファイル当たりのファイルディスクリプタの上限に達したため、ファイル読み取りはキューに入りました */
	static READ_QUEUE_DUE_TO_FILE_READ_LIMIT = "1ファイル当たりのファイルディスクリプタの上限に達したため、ファイル読み取りはキューに入りました";

	/** 1ファイル当たりのファイルディスクリプタの上限に達したため、読み取りストリームはキューに入りました */
	static READ_STREAM_QUEUE_DUE_TO_FILE_READ_LIMIT = "1ファイル当たりのファイルディスクリプタの上限に達したため、読み取りストリームはキューに入りました";

	/** 読み取りストリームの準備が出来ました */
	static READ_STREAM_READY = "読み取りストリームの準備が出来ました";

	/** ストリームがデータを読み取りました */
	static READ_STREAM_CHUNK_READ = "ストリームがデータを読み取りました";

	/** 読み取りストリームが全てのデータの読み取りを完了しました */
	static READ_STREAM_COMPLETE = "読み取りストリームが全てのデータの読み取りを完了しました";

	/** 読み取りストリームが閉じられました */
	static READ_STREAM_CLOSED = "読み取りストリームが閉じられました";

	/** ファイルが書き込み中のため、ストリームによる読み取りはキューに入りました */
	static READ_STREAM_QUEUED_DUE_TO_WRITING = "ファイルが書き込み中のため、ストリームによる読み取りはキューに入りました";

	/** 読み取りストリームでエラーが発生しました。 */
	static READ_STREAM_ERROR = "読み取りストリームでエラーが発生しました。";

	/** ファイルが読み取り中のため、データの書き込みはキューに入りました */
	static WRITE_QUEUED_DUE_TO_READING = "ファイルが読み取り中のため、データの書き込みはキューに入りました";

	/** ファイルが書き込み中のため、データの書き込みはキューに入りました */
	static WRITE_QUEUED_DUE_TO_WRITING = "ファイルが書き込み中のため、データの書き込みはキューに入りました";

	/** ファイルが読み取り中のため、書き込みストリームは遅れて取得されます */
	static WRITE_STREAM_QUEUED_DUE_TO_FILE_READING = "ファイルが読み取り中のため、書き込みストリームは遅れて取得されます";

	/** ファイルが書き込み中のため、書き込みストリームは遅れて取得されます */
	static WRITE_STREAM_QUEUED_DUE_TO_FILE_WRITING = "ファイルが書き込み中のため、書き込みストリームは遅れて取得されます";

	/** メモリキャッシュの値が更新されました */
	static UPDATED_MEMORY_CACHE = "メモリキャッシュの値が更新されました";

	/** メモリキャッシュの更新に合わせて、読み取り中の Promise の解決に値が渡されました */
	static RESOLVE_READ_QUEUE = "メモリキャッシュの更新に合わせて、読み取り中の Promise の解決に値が渡されました";

	/** ファイルへの書き込みを開始します */
	static WRITE_START = "ファイルへの書き込みを開始します";

	/** ファイル書き込みでエラーが発生しました。 */
	static WRITE_BUFFER_ERROR = "ファイル書き込みでエラーが発生しました。";

	/** ファイルへの書き込みが終わったので、新しいデータをファイルへ書き込み開始します */
	static WRITE_START_FROM_QUEUE_AFTER_WRITE = "ファイルへの書き込みが終わったので、新しいデータをファイルへ書き込み開始します";

	/** ファイルからの読み取りが終わったので、新しいデータをファイルへ書き込み開始します */
	static WRITE_START_FROM_QUEUE_AFTER_READ = "ファイルからの読み取りが終わったので、新しいデータをファイルへ書き込み開始します";

	/** 書き込みストリームの準備が出来ました */
	static WRITE_STREAM_READY = "書き込みストリームの準備が出来ました";

	/** 書き込みストリームでエラーが発生しました。 */
	static WRITE_STREAM_ERROR = "書き込みストリームでエラーが発生しました。";

	/** ストリームでデータ（チャンク）を書き込みます */
	static WRITE_STREAM_CHUNK_WRITE_BEGIN = "ストリームでデータ（チャンク）を書き込みます";

	/** ストリームでデータ（チャンク）を書き込み中にエラーが発生しました。 */
	static WRITE_STREAM_CHUNK_WRITE_ERROR = "ストリームでデータ（チャンク）を書き込み中にエラーが発生しました。";

	/** ストリームでデータ（チャンク）が全て内部バッファに転送されました */
	static WRITE_STREAM_CHUNK_ACCEPTED = "ストリームでデータ（チャンク）が全て内部バッファに転送されました";

	/** 書き込みストリームの内部バッファが満杯になりました */
	static WRITE_STREAM_BUFFER_FULL = "書き込みストリームの内部バッファが満杯になりました";

	/** 書き込みストリームの内部バッファが空になり、次のデータ（チャンク）を受け入れる準備が整いました */
	static WRITE_STREAM_DRAINED = "書き込みストリームの内部バッファが空になり、次のデータ（チャンク）を受け入れる準備が整いました";

	/** 書き込みストリームを完了します */
	static WRITE_STREAM_FINISH_REQUESTED = "書き込みストリームを完了します";

	/** 書き込みストリームを完了しようとした時にエラーが発生しました */
	static WRITE_STREAM_FINISH_ERROR = "書き込みストリームを完了しようとした時にエラーが発生しました";

	/** ストリームで全てのデータの書き込みが完了しました */
	static WRITE_STREAM_ALL_DATA_COMPLETED = "ストリームで全てのデータの書き込みが完了しました";

	/** ファイルへの書き込みが終わったので、書き込みストリームを取得できます */
	static WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_WRITE = "ファイルへの書き込みが終わったので、書き込みストリームを取得できます";

	/** ファイルからの読み取りが終わったので、書き込みストリームを取得できます */
	static WRITE_STREAM_STARTED_FROM_QUEUE_AFTER_FILE_READ = "ファイルからの読み取りが終わったので、書き込みストリームを取得できます";

	/** 書き込みストリームが閉じられました */
	static WRITE_STREAM_CLOSED = "書き込みストリームが閉じられました";

	/** 書き込みストリームを閉じようとした時にエラーが発生しました */
	static WRITE_STREAM_CLOSE_ERROR = "書き込みストリームを閉じようとした時にエラーが発生しました";

	/** ファイルへの書き込みが完了しました */
	static WRITE_COMPLETE_TO_FILE_SYSTEM = "ファイルへの書き込みが完了しました";

	/** 書き込み待機中に新しいデータの書き込み要求が発生したため、古い書き込み要求はスキップされました */
	static WRITE_SKIPPED_DUE_TO_NEW_WRITE = "書き込み待機中に新しいデータの書き込み要求が発生したため、古い書き込み要求はスキップされました";

	/** 書き込み待機中に新しいデータの書き込み要求が発生したため、古い書き込みストリームの要求はスキップされました */
	static WRITE_STREAM_SKIPPED_DUE_TO_NEW_WRITE = "書き込み待機中に新しいデータの書き込み要求が発生したため、古い書き込みストリームの要求はスキップされました";

	/** 書き込みしようとしたデータがファイルの内容と同一のため、ファイルシステムへの書き込みはされませんでした */
	static WRITE_SKIPPED_DATA_UNCHANGED = "書き込みしようとしたデータがファイルの内容と同一のため、ファイルシステムへの書き込みはされませんでした";

	/** ファイルから読み取ったデータでメモリキャッシュの値を更新しました */
	static UPDATED_MEMORY_CACHE_AFTER_READ_FROM_FILE = "ファイルから読み取ったデータでメモリキャッシュの値を更新しました";

	/** 最後のアクセスから memoryTTL に指定された時間が経過したため、メモリキャッシュを削除しました */
	static REMOVE_MEMORY_CACHE = "最後のアクセスから memoryTTL に指定された時間が経過したため、メモリキャッシュを削除しました";

	/** 最後のアクセスから fileTTL に指定された時間が経過したため、キャッシュファイルの削除を開始します */
	static REMOVE_START_CACHE_FILE ="最後のアクセスから fileTTL に指定された時間が経過したため、キャッシュファイルの削除を開始します"

	/** 最後のアクセスから fileTTL に指定された時間が経過しましたが、ストリームによる読み取り／書き込みが行われているため、キャッシュファイルの削除をスキップします */
	static SKIP_REMOVE_FILE_DUE_TO_ACTIVE_READ_OR_WRITE = "最後のアクセスから fileTTL に指定された時間が経過しましたが、ストリームによる読み取り／書き込みが行われているため、キャッシュファイルの削除をスキップします";

	/** キャッシュファイルを削除しました */
	static REMOVE_CACHE_FILE = "キャッシュファイルを削除しました";

	/** キャッシュファイルの削除に失敗しました */
	static REMOVE_CACHE_FILE_FAILED = "キャッシュファイルの削除に失敗しました";

	/** メモリキャッシュもキャッシュファイルも存在しませんでした */
	static NON_EXIST_CACHE = "メモリキャッシュもキャッシュファイルも存在しませんでした";

	/** GLOBAL_WAIT_ITEM_MUST_BE_FUNCTION */
	static GLOBAL_WAIT_ITEM_MUST_BE_FUNCTION = "GLOBAL_WAIT_ITEM_MUST_BE_FUNCTION";

	/** #readings: promise not found in finalize */
	static PROMISE_NOT_FOUND_IN_FINALIZE = "#readings: promise not found in finalize";

	/** currentGlobalReadings underflow */
	static CURRENT_GLOBAL_READINGS_UNDERFLOW = "currentGlobalReadings underflow";
}

module.exports = Log;