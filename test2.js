const si = require("systeminformation");
const TimeLimitedFileCache = require("./index.bak.js");
const fs = require('fs');

TimeLimitedFileCache.autoDetectDevices(si).then(()=>
{
	console.log();
});