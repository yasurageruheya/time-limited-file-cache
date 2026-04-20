import * as fs from "node:fs";
import {NexusArrayBufferPool} from "nexus-array-buffer-pool";

import {bigIntStatsOptions, getOptimalChunkSize, nexus, setNexus} from "./internals.js";

class TimeLimitedFileCache
{
	static maxFileHandleCache = 128;

	static fileHandleCacheTTL = 10000;

	/** @type {typeof import("systeminformation")}} */
	static systemInformation = null;

	/** @type {Promise<void>} */
	static #autoDetectDevicesPromise;

	/**
	 *
	 * @param {NexusArrayBufferPool} nexusArrayBufferPool
	 */
	static initialize(nexusArrayBufferPool)
	{
		setNexus(nexusArrayBufferPool);
	}

	static autoDetectDevices(systemInformation=null, autoMapping=true, useOptimalProfile=true)
	{
		if(systemInformation) this.systemInformation = systemInformation;
		if(!this.#autoDetectDevicesPromise)
		{
			this.#autoDetectDevicesPromise = async()=> {
				try {
					const diskLayoutPromise = systemInformation.diskLayout().then(diskLayout =>
					{
						for(let i = diskLayout.length; i--;)
						{
							const dl = diskLayout[i];
							const sd = StorageDevice.getFromId(dl.device);

							sd.applyDiskLayoutData(dl);
						}
						return Promise.resolve();
					});


					const blockDevicesPromise = systemInformation.blockDevices().then(blockDevices =>
					{
						const promises = [];
						for(let i = blockDevices.length; i--;)
						{
							const bd = blockDevices[i];
							/** @type {LogicalVolume} */
							let vol;
							promises.push(fs.promises.stat(bd.mount, bigIntStatsOptions).then(stats =>
							{
								vol = LogicalVolume.getFromStatsDeviceID(stats.dev);
								vol.stats = stats;
								vol.setBlockDeviceData(bd, bd.mount);
								return diskLayoutPromise;
							}).then(()=>
							{
								if(autoMapping)
								{
									if(bd.device) vol.hostDevice = StorageDevice.getFromId(bd.device);
									else vol.hostDevice = StorageDevice.getFromId(`unknown ${unknowDeviceCount++}`);
								}

								if(autoMapping && useOptimalProfile)
								{
									const sd = vol.hostDevice;
									const statsBlockSize = Number(vol.stats.blksize);
									const ioProfile = vol.ioProfile;
									let maxConcurrentReads = ioProfile.maxConcurrentReads;
									let minChunkSize = ioProfile.minChunkSize;
									const type = sd.type.toLowerCase();
									const interfaceType = sd.interfaceType.toLowerCase();
									if(type === "ssd" || type === "nvme" || type === "virtual" || type === "tmpfs" || type === "lvm")
									{
										switch (interfaceType)
										{
											case "fc":
											case "fibre channel":
												maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
												minChunkSize = 64 * 1024;
												break;
											case "nvme":
												maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
												minChunkSize = 64 * 1024;
												break;
											case "sata":
											case "usb_4":
											case "thunderbolt":
												maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
												minChunkSize = 64 * 1024;
												break;
											case "usb":
											case "usb_3":
												maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
												minChunkSize = 128 * 1024;
												break;
											case "usb_2":
												maxConcurrentReads = cpuLength > 2 ? 2 : cpuLength;
												minChunkSize = 128 * 1024;
												break;
											default:
												maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
												minChunkSize = 64 * 1024;
										}
									}
									else if(type === "network")
									{
										switch(interfaceType)
										{
											case "infiniband":
												maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
												minChunkSize = 256 * 1024;
												break;
											case "ethernet":
												maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
												minChunkSize = 256 * 1024;
												break;
											case "iscsi":
												maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
												minChunkSize = 256 * 1024;
												break;
											case "smb":
											case "cifs":
												maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
												minChunkSize = 256 * 1024;
												break;
											default:
												maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
												minChunkSize = 512 * 1024;
										}
									}
									else if(type === "advanced" || type === "mpath" || type === "multipath")
									{
										switch(interfaceType)
										{
											case "fc":
											case "fibre channel":
												maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
												minChunkSize = 64 * 1024;
												break;
											case "sata":
											case "sas":
											case "pcie":
											case "nvme":
												maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
												minChunkSize = 64 * 1024;
												break;
											default:
												maxConcurrentReads = cpuLength > 8 ? 8 : cpuLength;
												minChunkSize = 128 * 1024;
										}
									}
									else if(type === "hd" || type === "hdd" || type === "sas" || type === "scsi")
									{
										switch(interfaceType)
										{
											case "fc":
											case "fibre channel":
											case "sas":
											case "scsi":
											case "scsi-host-adapter":
											case "raid":
												maxConcurrentReads = cpuLength > 3 ? 3 : cpuLength;
												minChunkSize = getOptimalChunkSize(256 * 1024, sd);
												break;
											case "sata":
												maxConcurrentReads = cpuLength > 2 ? 2 : cpuLength;
												minChunkSize = getOptimalChunkSize(128 * 1024, sd);
												break;
											case "ide":
											case "atapi":
											case "ata":
											case "pata":
											case "eide":
											case "usb":
											default:
												maxConcurrentReads = 1;
												minChunkSize = getOptimalChunkSize(128 * 1024, sd);
												break;
										}
									}
									else if(type === "tape")
									{
										maxConcurrentReads = 1;
										switch(interfaceType)
										{
											case "sas":
											case "fc":
											case "fibre channel":
												minChunkSize = getOptimalChunkSize(512 * 1024, sd);
												break;
											case "lto-xx":
											default:
												minChunkSize = getOptimalChunkSize(1024 * 1024, sd);
												break;
										}
									}
									else if(type === "cd-rom" || type === "dvd-rom" || type === "bd-rom")
									{
										maxConcurrentReads = 1;
										switch(interfaceType)
										{
											case "sata":
											case "ide":
											case "atapi":
											case "usb":
												minChunkSize = 256 * 1024;
												break;
											default:
												minChunkSize = 512 * 1024;
												break;
										}
									}
									else if(type === "floppy")
									{
										maxConcurrentReads = 1;
										minChunkSize = getOptimalChunkSize(128 * 1024, sd);
									}
									else if(type === "fuse" || type === "crypto" || type === "vboxsf" || type === "vmhgfs")
									{
										maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
										minChunkSize = 256 * 1024;
									}
									else if(type === "virtio")
									{
										maxConcurrentReads = cpuLength > 32 ? 32 : cpuLength;
										minChunkSize = 64 * 1024;
									}
									else if(type === "zfs" || type === "md" || type === "btrfs")
									{
										maxConcurrentReads = cpuLength > 16 ? 16 : cpuLength;
										minChunkSize = 64 * 1024;
									}
									else if(type === "loop")
									{
										maxConcurrentReads = cpuLength > 4 ? 4 : cpuLength;
										minChunkSize = 64 * 1024;
									}
									else if(type === "pipe" || type === "serial")
									{
										maxConcurrentReads = 1;
										minChunkSize = 128 * 1024;
									}
									minChunkSize = statsBlockSize > minChunkSize ? statsBlockSize : minChunkSize;

									ioProfile.maxConcurrentReads = maxConcurrentReads;
									ioProfile.minChunkSize = minChunkSize;
								}
								return Promise.resolve();
							}).catch(()=>Promise.resolve()));
						}

						return Promise.all(promises).then(()=>
						{
							this.#autoDetectDevicesPromise = null;
							resolve();
						});
				} catch (error) {
					throw error;
				} finally {
					this.#autoDetectDevicesPromise = null;
				}
			}
		}
		return this.#autoDetectDevicesPromise;
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