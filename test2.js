const si = require("systeminformation");
const TimeLimitedFileCache = require("./index");
const fs = require('fs');

TimeLimitedFileCache.autoDetectDevices(si).then(()=>
{
	console.log();
});