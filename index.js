import * as fs from "node:fs";
import {NexusArrayBufferPool} from "nexus-array-buffer-pool";

import {nexus, setNexus} from "./internals.js";

class TimeLimitedFileCache
{
	static maxFileHandleCache = 128;

	static fileHandleCacheTTL = 10000;

	/**
	 *
	 * @param {NexusArrayBufferPool} nexusArrayBufferPool
	 */
	static initialize(nexusArrayBufferPool)
	{
		setNexus(nexusArrayBufferPool);
	}

	static getLogicalVolume(fullPath)
	{

	}

	readAsBuffer(fullPath, memoryTTL, fileTTL)
	{

	}

	writeAsBuffer(fullPath, data, memoryTTL, fileTTL)
	{

	}

	constructor()
	{

	}
}

export default TimeLimitedFileCache;